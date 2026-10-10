#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { readApplicationCatalog } from '../src/adapters/application_catalog.js';
import { parseDshPatch, parseYamlSubset } from '../src/setup/import_agents.js';
import { routingTargets, generateRoutes, localReadiness, discoverSources, routingReport, checkGateway, codexInstallText, makeEdit, applyEdits } from '../src/setup/application_routing.js';
import { routerSpec, generateRouterRoutes } from '../src/setup/router_routes.js';
import { primeRouterCaches } from '../src/setup/router_cache_prime.js';
import { readMonitoringMode } from '../src/setup/monitoring_mode.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const directory = path.join(root, 'applications/agent-routing');
const planFile = path.join(directory, 'install-plan.json');
const hash = text => crypto.createHash('sha256').update(text).digest('hex');
const read = file => fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;

function context(manifestFile) {
  const manifestText = read(manifestFile);
  const manifest = JSON.parse(manifestText);
  const targets = routingTargets(manifest, readApplicationCatalog(path.join(root, 'applications')),
    JSON.parse(read(path.join(root, 'applications/preferences.json')) ?? '{"disabled":[]}'));
  for (const target of targets) target.router = Object.fromEntries(['codex', 'dsh'].map(client => [client, routerSpec(target, client, root, manifestFile)]));
  return { manifestFile, manifest, targets, sources: discoverSources({ projectRoot: root }), manifestHash: hash(manifestText) };
}

export function buildInstallEdits(ctx) {
  if (!ctx.targets.length) throw new Error('No selected applications in this manifest');
  const edits = [];
  const routes = ctx.routerMode ? (targets, client) => generateRouterRoutes(targets, client, root, ctx.manifestFile) : generateRoutes;
  const user = ctx.sources.find(source => source.client === 'codex' && source.profile === 'user');
  edits.push(makeEdit(user.file, user.missing ? null : user.text, codexInstallText(user.text, ctx.targets, { routeGenerator: routes })));
  const project = ctx.sources.find(source => source.client === 'codex' && source.profile === 'project');
  if (project && !project.missing) edits.push(makeEdit(project.file, project.text, codexInstallText(project.text, ctx.targets, { generate: false })));
  const bundles = ctx.sources.filter(source => source.client === 'dsh' && source.bundle === '@local/mcp-trace-http' && !source.missing);
  if (!bundles.length) throw new Error('DSH has no installed @local/mcp-trace-http bundle; install the project bundle first');
  for (const source of bundles) {
    const servers = parseDshPatch(source.text).servers;
    const patchEntries = parseYamlSubset(source.text).flatMap(item => item.insert ?? [item]);
    if (patchEntries.some(item => item.name !== '@deepseek-ai/dsh-mcp-client')) throw new Error('DSH trace bundle contains unrelated plugins; review before replacing');
    const allowed = new Set(ctx.manifest.upstreams.flatMap(upstream => {
      const base = new URL(ctx.targets[0].dsh);
      return ['', '/dsh', '/codex'].map(prefix => new URL(prefix + upstream.path, base).href);
    }));
    if (servers.some(server => {
      if (server.url && allowed.has(new URL(server.url).href)) return false;
      return !ctx.targets.some(target => server.raw_name === target.serverName
        && server.command === target.router.dsh.command && JSON.stringify(server.args ?? []) === JSON.stringify(target.router.dsh.args));
    })) throw new Error('DSH trace bundle contains custom entries; review before replacing');
    // Preserve only the demo tools previously present in this platform-owned bundle.
    const mocks = ctx.manifest.upstreams.filter(upstream => upstream.upstreamApp?.startsWith('mock-') && servers.some(server => server.raw_name === upstream.serverName))
      .map(upstream => ({ ...upstream, dsh: new URL('/dsh' + upstream.path, ctx.targets[0].dsh).href }));
    if (!edits.some(edit => edit.file === source.file)) edits.push(makeEdit(source.file, source.text, routes([...ctx.targets, ...mocks], 'dsh')));
  }
  const report = routingReport(ctx.sources, ctx.targets);
  const ownedFiles = new Set(bundles.map(source => source.file));
  if (report.sources.some(source => source.client === 'dsh' && !ownedFiles.has(source.source) && source.entries.some(entry => entry.app && entry.status !== 'disabled'))) {
    throw new Error('DSH has application entries outside the platform bundle; review those sources before binding');
  }
  const projectBundle = path.join(root, 'dsh-bundle-mcp-trace/cordis.patch.yml');
  if (!edits.some(edit => edit.file === projectBundle)) edits.push(makeEdit(projectBundle, read(projectBundle), routes(ctx.targets, 'dsh')));
  return edits;
}

async function main() {
  const [mode = 'check', ...args] = process.argv.slice(2);
  if (mode === '--help') {
    console.log('application-routing.js prepare [--router] | preflight | check [--health] [--json] [--strict] | apply [--manifest path]\n默认清单 trace.manifest.json；apply 沿用准备计划的清单。--router 安装可切换的本机入口；准备和检查不修改客户端。');
    return;
  }
  const manifestIndex = args.indexOf('--manifest');
  if (manifestIndex >= 0 && (!args[manifestIndex + 1] || args[manifestIndex + 1].startsWith('--'))) throw new Error('Choose a Gateway manifest');
  const savedPlan = mode === 'apply' ? JSON.parse(read(planFile)) : null;
  const manifestFile = path.resolve(root, manifestIndex >= 0 ? args[manifestIndex + 1] : savedPlan?.manifest_file ?? 'trace.manifest.json');
  const ctx = context(manifestFile);
  ctx.routerMode = mode === 'apply' ? savedPlan?.route_mode === 'application-router' : args.includes('--router');
  if (mode === 'prepare') {
    fs.mkdirSync(directory, { recursive: true });
    const routes = ctx.routerMode ? (targets, client) => generateRouterRoutes(targets, client, root, manifestFile) : generateRoutes;
    fs.writeFileSync(path.join(directory, 'codex.toml'), routes(ctx.targets, 'codex'));
    fs.writeFileSync(path.join(directory, 'dsh.patch.yml'), routes(ctx.targets, 'dsh'));
    let edits = [], blocked = null;
    try {
      if (!localReadiness(ctx.manifest, root).ready) throw new Error('Local upstream entry or authorization is missing; run preflight');
      edits = buildInstallEdits(ctx);
    } catch (error) { blocked = error.message; }
    // Contents of the user's existing files stay in memory; only hashes and paths are saved.
    const plan = { schema: 'application-routing-install/2', route_mode: ctx.routerMode ? 'application-router' : 'gateway', manifest_file: manifestFile, manifest_sha256: ctx.manifestHash,
      targets: ctx.targets.map(({ id, name, codex, dsh }) => ({ id, name, codex, dsh })), blocked,
      edits: edits.map(({ content, ...edit }) => edit) };
    fs.writeFileSync(planFile, JSON.stringify(plan, null, 2) + '\n');
    fs.writeFileSync(path.join(directory, 'report.json'), JSON.stringify(routingReport(ctx.sources, ctx.targets), null, 2) + '\n');
    console.log(`已生成 ${ctx.targets.length} 个应用的连接配置和逐项报告：applications/agent-routing。尚未修改客户端。`);
    if (blocked) console.log('安装计划待处理：' + blocked);
  } else if (mode === 'apply') {
    const plan = JSON.parse(read(planFile));
    if (plan.schema !== 'application-routing-install/2' || plan.blocked || plan.manifest_file !== ctx.manifestFile || plan.manifest_sha256 !== ctx.manifestHash) throw new Error('Prepare the current configuration before applying');
    if (!localReadiness(ctx.manifest, root).ready) throw new Error('Local upstream entry or authorization is missing');
    const edits = buildInstallEdits(ctx);
    if (JSON.stringify(edits.map(({ content, ...edit }) => edit)) !== JSON.stringify(plan.edits)) throw new Error('Configuration changed since preparation; prepare again');
    const gateway = await checkGateway(ctx.targets, fetch, ctx.manifestFile);
    if (!gateway.ready) throw new Error('Gateway is not ready; no client files changed');
    if (ctx.routerMode) await primeRouterCaches(root, ctx.manifestFile, ctx.targets);
    const installed = applyEdits(edits);
    const recordPath = path.join(directory, 'installed.json');
    const history = JSON.parse(read(recordPath) ?? '{"installed":[]}');
    fs.writeFileSync(recordPath, JSON.stringify({ installed: [...history.installed, ...installed], latest_changed_files: installed.length,
      targets: plan.targets, route_mode: plan.route_mode, boundary: 'configured_application_mcp_only' }, null, 2) + '\n');
    console.log(`已更新 ${installed.length} 个配置文件，旧文件已备份。重新加载客户端后生效。`);
  } else if (mode === 'preflight') {
    const report = localReadiness(ctx.manifest, root);
    console.log(JSON.stringify(report, null, 2));
    if (!report.ready) process.exitCode = 3;
  } else if (mode === 'check') {
    const report = routingReport(ctx.sources, ctx.targets);
    const profile = args.includes('--profile') ? args[args.indexOf('--profile') + 1] : null;
    const client = args.includes('--client') ? args[args.indexOf('--client') + 1] : null;
    if (client && !['codex', 'dsh'].includes(client)) throw new Error('Choose codex or dsh');
    if (args.includes('--profile') && (!profile || profile.startsWith('--'))) throw new Error('Choose a DSH profile');
    report.coverage = report.coverage.filter(item => (!client || item.scope.startsWith(client + ':')) &&
      (!profile || !item.scope.startsWith('dsh:') || item.scope === 'dsh:' + profile));
    report.all_configured = report.coverage.length > 0 && report.coverage.every(item => item.status === 'gateway');
    report.manifest_file = ctx.manifestFile;
    const hasRouter = report.sources.some(source => source.entries.some(entry => entry.route_kind === 'switchable_application_router'));
    if (hasRouter) report.monitoring_mode = readMonitoringMode(path.join(directory, 'monitoring.json'));
    if (args.includes('--health')) report.gateway = await checkGateway(ctx.targets, fetch, ctx.manifestFile);
    if (args.includes('--json')) console.log(JSON.stringify(report, null, 2));
    else {
      const labels = { gateway: '已走网关', direct: '存在直连', duplicate: '重复入口', gateway_other_label: '网关入口归属需更新', missing: '未配置', incomplete_scan: '配置来源未全部解析' };
      for (const item of report.coverage) console.log(`${item.scope} · ${item.name}：${labels[item.status]}`);
      console.log(`其他工具或未知入口：${report.unknown_count} 项；它们不计入应用已覆盖。`);
      if (report.gateway) console.log(report.gateway.ready ? '网关与所选应用已就绪。' : '网关或所选应用尚未就绪。');
      if (report.monitoring_mode) console.log(report.monitoring_mode.enforce ? '强制监控开关：开启。' : '强制监控开关：关闭，故障时允许未监控直连；严格监控任务不允许此模式。');
      console.log('检查仅覆盖已扫描配置中的应用 MCP，不覆盖脚本、浏览器和内置连接器。');
    }
    if (args.includes('--strict') && (!report.all_configured || report.gateway?.ready === false || report.monitoring_mode?.enforce === false)) process.exitCode = 3;
  } else throw new Error('Choose prepare, check, or apply');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(() => {
  console.error('应用路由检查或配置更新失败。未将配置内容或凭据写入错误输出；请重新准备并检查安装计划。');
  process.exitCode = 2;
});
