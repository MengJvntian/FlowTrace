#!/usr/bin/env node
/**
 * bin/sync-bundle.js — 让**客户端侧配置**与**清单**保持一致（t47）
 *
 * 修的结构性问题：`trace.manifest.json`（Gateway 侧上游集合）与
 * `dsh-bundle-mcp-trace/cordis.patch.yml`（客户端侧 `- insert:` 条目集合）原本靠人工保持一致。
 * 于是出现过真实事故：清单里加了 gmail、`npm run status` 显示 `[就绪] gmail`，
 * **但 bundle 里没有 gmail 条目** → 客户端根本没有 `mcp__gmail__*` 工具。
 * 症状是「工具凭空消失」，用户从现象推不出原因。
 *
 * 本命令：读清单 → 逐上游生成/校验 bundle 条目 → **默认只打印差异**（dry-run）→ `--write` 才落盘。
 *   · 落盘只允许写**仓库内**的 bundle 文件（写 `~/.dsh/**`、`~/.codex/**` 一律 exit 2）；
 *   · **保留人工注释**：只增删/替换 `- insert:` 列表里的条目，其余字节原样保留；
 *     条目自己的尾部注释（例如「刻意不设 failOnStartupError」）也会跟着条目保留；
 *   · **幂等**：同一份清单连跑两次，第二次报「无差异」且文件字节不变。
 *
 * 与既有工具的分工（--help 与 docs/user/troubleshooting.md 都写明）：
 *   setup        = 环境自检 + 发现/导入你现有的 agent 配置
 *   wrap-config  = 把一个应用**包进** Gateway（生成三个客户端的包装配置）
 *   sync-bundle  = 让**客户端侧配置**与清单保持一致（本命令）
 *
 * 退出码：0 成功（含「无差异」与「已写入」）/ 1 未捕获异常 / 2 用法或配置错误 / 3 找不到文件
 */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { DEFAULT_MANIFEST_PATH, loadManifest } from '../src/gateway/manifest.js';
import { readApplicationCatalog } from '../src/adapters/application_catalog.js';
import { BEGIN, generateRoutes, routingTargets, inspectSource } from '../src/setup/application_routing.js';
import { routerSpec, generateRouterRoutes } from '../src/setup/router_routes.js';
import { parseDshPatch } from '../src/setup/import_agents.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** 仓库根。 */
export const REPO_ROOT = path.resolve(HERE, '..');
/** bundle 内的 patch 文件（客户端侧配置）。 */
export const BUNDLE_PATCH_RELATIVE = path.join('dsh-bundle-mcp-trace', 'cordis.patch.yml');
/** DSH mcp-client 插件名。 */
export const DSH_CLIENT_NAME = '@deepseek-ai/dsh-mcp-client';
/** 缺省工具调用超时（毫秒）。 */
export const DEFAULT_TOOL_TIMEOUT_MS = 120000;

/** @param {string} text */
function out(text) {
  process.stdout.write(`${text}\n`);
}
/** @param {string} text */
function log(text) {
  process.stderr.write(`${text}\n`);
}

/** @returns {string} */
export function usage() {
  return [
    '用法: node bin\\sync-bundle.js [选项]',
    '',
    '作用：让**客户端侧配置**（DSH bundle 的 `- insert:` 条目）与清单 trace.manifest.json 保持一致。',
    '      清单里加了上游、而客户端没加条目时，症状是「工具凭空消失」（mcp__<server>__* 不出现）。',
    '',
    '选项：',
    `  --manifest <path>   清单路径（缺省 ${DEFAULT_MANIFEST_PATH}）`,
    `  --bundle <path>     bundle 的 patch 路径（缺省 ${BUNDLE_PATCH_RELATIVE}，只允许仓库内）`,
    '  --write             真的落盘（缺省只打印差异，dry-run）',
    '  --json              机器可读输出（含 missing / extra / matching / snippets）',
    '  --help              本说明',
    '',
    '落盘规则：',
    '  · 只写**仓库内**的 bundle 文件；写 `~/.dsh/**`、`~/.codex/**` 或任何仓库外路径一律 exit 2；',
    '  · 已由 application Gateway routes 管理的 bundle 只读检查；更新须走 agent-routing prepare/apply 的网关就绪检查；',
    '  · **保留人工注释**：只增删/替换 `- insert:` 列表里的条目，文件其余部分逐字节保留；',
    '    条目自己的尾部注释会跟着条目保留（例如「刻意不设 failOnStartupError」）；',
    '  · 清单里没有、而 bundle 里多出来的条目会被**删除**（它会连不上任何 Gateway 路径）——dry-run 会先列出来；',
    '  · 幂等：同一份清单连跑两次，第二次输出「无差异」且文件字节不变。',
    '',
    '与既有工具的分工：',
    '  setup        = 环境自检 + 发现/导入你现有的 agent 配置',
    '  wrap-config  = 把一个应用**包进** Gateway（生成三客户端包装配置）',
    '  sync-bundle  = 让**客户端侧配置**与清单保持一致（本命令）',
    '',
    '⚠️ 落盘 ≠ 生效：bundle 是按安装时快照生效的。改完 cordis.patch.yml 必须',
    '   经插件管理器**重新安装/更新该 bundle 并重启客户端**，客户端才会拿到新条目。',
    '   只改文件不重装，症状仍是「没有工具」——这正是本次事故的第二个原因。',
    '',
    '退出码：0 成功 / 1 未捕获异常 / 2 用法或配置错误 / 3 文件不存在',
  ].join('\n');
}

/** 解析参数。 @param {string[]} argv */
export function parseArgs(argv) {
  /** @type {string[]} */
  const errors = [];
  /** @type {Record<string, any>} */
  const options = { help: false, manifestPath: DEFAULT_MANIFEST_PATH, bundlePath: BUNDLE_PATCH_RELATIVE, write: false, json: false };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    const eq = token.startsWith('--') ? token.indexOf('=') : -1;
    const name = eq > 0 ? token.slice(0, eq) : token;
    const inline = eq > 0 ? token.slice(eq + 1) : null;
    const take = () => {
      if (inline !== null) return inline;
      const next = argv[index + 1];
      if (next === undefined || next.startsWith('--')) {
        errors.push(`${name} 缺少取值`);
        return null;
      }
      index += 1;
      return next;
    };
    if (name === '--help') options.help = true;
    else if (name === '--write') options.write = true;
    else if (name === '--json') options.json = true;
    else if (name === '--manifest' || name === '--bundle') {
      const value = take();
      if (value !== null) {
        if (name === '--manifest') options.manifestPath = value;
        else options.bundlePath = value;
      }
    } else if (token.startsWith('-')) errors.push(`未知参数：${token}（用 --help 查看用法）`);
  }
  return { ok: errors.length === 0, options, errors };
}

/** 目标路径是否在仓库内。 @param {string} target */
export function isInsideRepo(target) {
  const relative = path.relative(REPO_ROOT, path.resolve(REPO_ROOT, target));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

/**
 * 从清单上游生成 bundle 条目（客户端只连本地路径，令牌/授权都在 Gateway 侧）。
 * @param {Array<Record<string, any>>} upstreams
 * @param {{port: number, toolTimeoutMs?: number}} input
 */
export function buildEntries(upstreams, input) {
  return upstreams.map((upstream) => ({
    id: `mcp-trace-${upstream.serverName}`,
    name: DSH_CLIENT_NAME,
    serverName: upstream.serverName,
    transport: 'streamable-http',
    url: `http://127.0.0.1:${input.port}${input.client ? '/' + input.client : ''}${upstream.path}`,
    toolCallTimeoutMs: upstream.timeoutMs ?? input.toolTimeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS,
  }));
}

/**
 * 从 bundle 文本里解析现有 `- insert:` 条目（只认我们生成的形状），
 * 同时把每个条目的**尾部注释**原样记下来（写回时要保留）。
 * @param {string} text
 */
export function parseBundleEntries(text) {
  const lines = text.split(/\r?\n/);
  const insertIndex = lines.findIndex((line) => /^-\s*insert:\s*$/.test(line));
  if (insertIndex === -1) return { insertIndex: -1, itemIndent: 4, items: [], startLine: -1, endLine: -1 };
  // 条目缩进：第一个以 `- id:` 开头的行
  let itemIndent = 4;
  for (let index = insertIndex + 1; index < lines.length; index += 1) {
    const match = /^(\s*)-\s*id:/.exec(lines[index]);
    if (match) {
      itemIndent = match[1].length;
      break;
    }
    if (lines[index].trim() !== '' && !/^\s/.test(lines[index])) break;
  }
  const startLine = insertIndex + 1;
  /** @type {Array<Record<string, any>>} */
  const items = [];
  let index = startLine;
  // 列表范围：直到遇到「非空且顶格」的行为止
  let endLine = lines.length;
  for (let cursor = startLine; cursor < lines.length; cursor += 1) {
    const line = lines[cursor];
    if (line.trim() !== '' && !/^\s/.test(line)) {
      endLine = cursor;
      break;
    }
  }
  while (index < endLine) {
    const startMatch = /^(\s*)-\s*id:\s*(.+?)\s*$/.exec(lines[index]);
    if (!startMatch) {
      index += 1;
      continue;
    }
    const itemStart = index;
    index += 1;
    /** @type {string[]} */
    const body = [];
    while (index < endLine && !/^\s*-\s*id:/.test(lines[index])) {
      body.push(lines[index]);
      index += 1;
    }
    const raw = body.join('\n');
    const serverName = /serverName:\s*([^\s#]+)/.exec(raw)?.[1] ?? null;
    const url = /url:\s*([^\s#]+)/.exec(raw)?.[1]?.replace(/^['"]|['"]$/g, '') ?? null;
    const transport = /transport:\s*([^\s#]+)/.exec(raw)?.[1] ?? null;
    const timeout = Number(/toolCallTimeoutMs:\s*(\d+)/.exec(raw)?.[1]);
    // 尾部注释：条目块里**最后一段**连续的注释/空行（属于「这个条目的说明」）
    const bodyLines = lines.slice(itemStart + 1, index);
    let commentFrom = bodyLines.length;
    for (let cursor = bodyLines.length - 1; cursor >= 0; cursor -= 1) {
      const trimmed = bodyLines[cursor].trim();
      if (trimmed === '' || trimmed.startsWith('#')) commentFrom = cursor;
      else break;
    }
    const trailingComments = bodyLines.slice(commentFrom);
    items.push({
      id: startMatch[2].replace(/^['"]|['"]$/g, ''),
      serverName,
      url,
      transport,
      toolCallTimeoutMs: Number.isFinite(timeout) ? timeout : null,
      trailingComments,
      rawBlock: lines.slice(itemStart, index).join('\n'),
    });
  }
  return { insertIndex, itemIndent, items, startLine, endLine };
}

/** 渲染一个条目块（YAML）。 @param {Record<string, any>} entry @param {number} indent @param {string[]} [trailingComments] */
export function renderEntry(entry, indent, trailingComments = []) {
  const pad = ' '.repeat(indent);
  const inner = ' '.repeat(indent + 2);
  const deep = ' '.repeat(indent + 4);
  /** @type {string[]} */
  const lines = [
    `${pad}- id: ${entry.id}`,
    `${inner}name: '${entry.name}'`,
    `${inner}config:`,
    `${deep}serverName: ${entry.serverName}`,
    `${deep}transport: ${entry.transport}`,
    `${deep}url: ${entry.url}`,
    `${deep}toolCallTimeoutMs: ${entry.toolCallTimeoutMs}`,
  ];
  // 条目自带的**注释**原样保留（不得清掉人工说明）；空行不保留（由渲染统一控制，保证幂等）
  for (const comment of trailingComments) if (comment.trim().startsWith('#')) lines.push(comment);
  return lines;
}

/**
 * 计算差异。
 * @param {Array<Record<string, any>>} desired
 * @param {Array<Record<string, any>>} existing
 */
export function diffEntries(desired, existing) {
  const existingByName = new Map(existing.map((item) => [item.serverName, item]));
  const desiredNames = new Set(desired.map((item) => item.serverName));
  const missing = desired.filter((item) => !existingByName.has(item.serverName));
  const matching = desired.filter((item) => {
    const found = existingByName.get(item.serverName);
    return found && found.url === item.url && found.transport === item.transport;
  });
  const changed = desired.filter((item) => {
    const found = existingByName.get(item.serverName);
    return found && !(found.url === item.url && found.transport === item.transport);
  });
  const extra = existing.filter((item) => !desiredNames.has(item.serverName));
  return { missing, matching, changed, extra };
}

/**
 * 生成"清单 → Codex / VS Code"片段（客户端只连本地 Gateway 路径，令牌不落到客户端）。
 * 注意：**不得出现 `<...>` 占位符**（本项目占位符守卫会拒绝这类值）；需要用户自己填的地方用注释说明。
 * @param {Array<Record<string, any>>} entries
 * @param {{node: string, gateway: string}} paths
 * @param {Array<Record<string, any>>} [upstreams] 清单里的上游（用来填真实 command/args）
 */
export function buildSnippets(entries, paths, upstreams = []) {
  const byName = new Map(upstreams.map((upstream) => [upstream.serverName, upstream]));
  /** @type {string[]} */
  const codex = [];
  for (const entry of entries) {
    const upstream = byName.get(entry.serverName) ?? {};
    const isStdio = upstream.transport === 'stdio';
    codex.push(`# ${entry.serverName}（清单里是 ${upstream.transport ?? '?'} 上游）：`);
    if (isStdio && upstream.command) {
      const args = [
        paths.gateway,
        '--upstream-command',
        upstream.command,
        ...(upstream.args ?? []).flatMap((arg) => ['--upstream-arg', String(arg)]),
        '--upstream-app',
        entry.serverName,
        '--gateway-id',
        `gw-${entry.serverName}`,
      ];
      codex.push(`[mcp_servers.${entry.serverName}-trace]`);
      codex.push(`command = '${paths.node}'`);
      codex.push(`args = [${args.map((arg) => `'${arg}'`).join(', ')}]`);
      codex.push(`cwd = '${REPO_ROOT}'`);
      codex.push('');
      continue;
    }
    // 远端 HTTP 上游：Codex 侧走 HTTP 的写法本会话未验证 —— 如实标注，不编造语法
    codex.push(`# 远端 HTTP 上游：Codex 侧请直接用 Gateway 的本地路径（下面是其地址）；`);
    codex.push(`# 请使用 applications/agent-routing 的路由安装入口生成客户端配置。`);
    codex.push(`#   ${entry.url}`);
    codex.push('');
  }
  const vscode = {
    servers: Object.fromEntries(
      entries.map((entry) => [`${entry.serverName}-trace`, { type: 'http', url: entry.url }]),
    ),
  };
  return { codex: codex.join('\n'), vscode: JSON.stringify(vscode, null, 2) };
}

async function main() {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.options.help) {
    out(usage());
    process.exit(0);
  }
  if (!parsed.ok) {
    for (const error of parsed.errors) log(`[sync-bundle] 配置错误：${error}`);
    log(usage());
    process.exit(2);
  }
  const options = parsed.options;

  // 只允许写仓库内（写用户 ~/.dsh、~/.codex 一律拒绝）
  if (!isInsideRepo(options.bundlePath)) {
    log(`[sync-bundle] 拒绝写入仓库外的路径：${options.bundlePath}`);
    log('  → bundle 是仓库内的文件；`~/.dsh/**`、`~/.codex/**` 由客户端自己的插件管理器维护，本工具绝不代写');
    process.exit(2);
  }
  const bundlePath = path.resolve(REPO_ROOT, options.bundlePath);

  if (fs.existsSync(bundlePath) && fs.readFileSync(bundlePath, 'utf8').includes(BEGIN)) {
    // The managed bundle may be linked into a live client. Binding owns its writes.
    if (options.write) {
      log('[sync-bundle] 应用路由 bundle 请通过 agent-routing prepare/apply 更新；同步器只读检查，不覆盖客户端入口。');
      process.exit(2);
    }
    const activePath = path.resolve(REPO_ROOT, options.manifestPath);
    let manifest, targets;
    try {
      manifest = JSON.parse(fs.readFileSync(activePath, 'utf8'));
      const preferencesFile = path.join(REPO_ROOT, 'applications/preferences.json');
      const preferences = fs.existsSync(preferencesFile)
        ? JSON.parse(fs.readFileSync(preferencesFile, 'utf8')) : { disabled: [] };
      targets = routingTargets(manifest, readApplicationCatalog(path.join(REPO_ROOT, 'applications')), preferences);
    } catch {
      log('[sync-bundle] 清单错误：无法读取或应用路由结构不合法。');
      process.exit(2);
    }
    const mocks = manifest.upstreams.filter(item => item.upstreamApp.startsWith('mock-')).map(item => ({ ...item,
      codex: `http://127.0.0.1:${manifest.http.port}/codex${item.path}`,
      dsh: `http://127.0.0.1:${manifest.http.port}/dsh${item.path}` }));
    const desired = [...targets, ...mocks];
    const entries = buildEntries(manifest.upstreams.filter(item => desired.some(target => target.serverName === item.serverName)), { port: manifest.http.port, client: 'dsh' });
    const original = fs.readFileSync(bundlePath, 'utf8');
      if (original.includes('run-application-router.ps1')) {
        for (const target of targets) target.router = { dsh: routerSpec(target, 'dsh', REPO_ROOT, activePath) };
        const report = inspectSource({ client: 'dsh', file: bundlePath, text: original }, targets);
        const matched = targets.filter(target => report.entries.filter(row => row.app === target.id && row.status === 'gateway').length === 1);
        const parsedServers = parseDshPatch(original).servers;
        const missing = targets.filter(target => !parsedServers.some(server => server.raw_name === target.serverName)).map(target => ({ serverName: target.serverName }));
        const changed = targets.filter(target => !matched.includes(target) && !missing.some(row => row.serverName === target.serverName)).map(target => ({ serverName: target.serverName }));
        const extra = parsedServers.filter(server => !desired.some(target => target.serverName === server.raw_name)).map(server => ({ serverName: server.raw_name }));
        const payload = { ok: true, route_mode: 'application-router', manifest: path.relative(REPO_ROOT, activePath), entries,
          semantically_equal: report.status === 'read' && missing.length + changed.length + extra.length === 0,
          matching: matched.map(target => target.serverName), missing, changed, extra, will_write: false,
          snippets: { codex: generateRouterRoutes(targets, 'codex', REPO_ROOT, activePath),
            vscode: JSON.stringify({ servers: Object.fromEntries(entries.map(item => [item.serverName, { type: 'http', url: item.url }])) }, null, 2) } };
        out(options.json ? JSON.stringify(payload) : payload.semantically_equal ? '应用开关路由与正式清单一致。' : '应用开关路由有差异；请通过 agent-routing prepare --router / apply 更新。');
        process.exit(0);
      }
    const diff = diffEntries(entries, parseBundleEntries(original).items);
    const next = generateRoutes(desired, 'dsh');
    const payload = { ok: true, manifest: path.relative(REPO_ROOT, activePath), entries,
      missing: diff.missing, extra: diff.extra, changed: diff.changed,
      matching: diff.matching.map(item => item.serverName),
      semantically_equal: diff.missing.length + diff.extra.length + diff.changed.length === 0,
      file_changed: next !== original, will_write: options.write,
      snippets: { codex: generateRoutes(desired, 'codex'), vscode: JSON.stringify({ servers: Object.fromEntries(entries.map(item => [item.serverName, { type: 'http', url: item.url }])) }, null, 2) } };
    if (options.json) out(JSON.stringify(payload));
    else out(payload.semantically_equal ? '应用 bundle 与正式清单一致。' : '应用 bundle 有差异；请重新绑定 Agent 网关入口。');
    process.exit(0);
  }

  const loaded = loadManifest({ manifestPath: options.manifestPath, cwd: REPO_ROOT });
  if (!loaded.ok) {
    for (const error of loaded.errors) log(`[sync-bundle] 清单错误：${error}`);
    log('[sync-bundle] → 先修 trace.manifest.json（或 node bin\\setup.js 看环境自检）');
    process.exit(2);
  }
  if (!fs.existsSync(bundlePath)) {
    log(`[sync-bundle] 找不到 bundle 文件：${bundlePath}`);
    process.exit(3);
  }
  const manifest = loaded.manifest;
  const original = fs.readFileSync(bundlePath, 'utf8');
  const originalHadCrlf = original.includes('\r\n');
  const text = original.replace(/\r\n/g, '\n');
  const bundle = parseBundleEntries(text);
  if (bundle.insertIndex === -1) {
    log(`[sync-bundle] bundle 里找不到 \`- insert:\` 列表：${bundlePath}`);
    log('  → 该文件必须是 bundle 形状（顶层 `- insert:` 包裹条目）；本工具不会自作主张改结构');
    process.exit(2);
  }

  const entries = buildEntries(manifest.upstreams, { port: manifest.http.port });
  const diff = diffEntries(entries, bundle.items);
  const snippets = buildSnippets(entries, { node: process.execPath, gateway: path.join(REPO_ROOT, 'bin', 'gateway.js') }, manifest.upstreams);

  // ── 生成新的条目区（只替换列表内条目，其余字节保留）──────────────────────
  const keepComments = new Map(bundle.items.map((item) => [item.serverName, item.trailingComments]));
  /** @type {string[]} */
  const rendered = [];
  entries.forEach((entry, position) => {
    if (position > 0) rendered.push('');
    rendered.push(...renderEntry(entry, bundle.itemIndent, keepComments.get(entry.serverName) ?? []));
  });
  const before = text.split('\n');
  const nextLines = [...before.slice(0, bundle.startLine), ...rendered, ...before.slice(bundle.endLine)];
  const nextText = nextLines.join('\n');
  const changed = nextText !== text;
  const payload = {
    ok: true,
    manifest: path.relative(REPO_ROOT, options.manifestPath),
    bundle: path.relative(REPO_ROOT, options.bundlePath),
    experiment_run_id: manifest.experiment_run_id ?? manifest.experimentRunId ?? null,
    manager_port: manifest.http.port,
    entries,
    missing: diff.missing.map((item) => ({ serverName: item.serverName, url: item.url })),
    changed: diff.changed.map((item) => ({ serverName: item.serverName, url: item.url })),
    extra: diff.extra.map((item) => ({ serverName: item.serverName, url: item.url })),
    matching: diff.matching.map((item) => item.serverName),
    will_write: options.write,
    file_changed: changed,
    snippets,
  };

  if (!options.json) {
    out(`清单：${options.manifestPath}    bundle：${options.bundlePath}`);
    out(`上游 ${entries.length} 个（端口 ${manifest.http.port}）：${entries.map((entry) => entry.serverName).join(', ')}`);
    out('');
    if (diff.missing.length > 0) {
      out(`❌ 清单里有、bundle 缺（客户端会**漏工具** mcp__<server>__*）：`);
      for (const item of diff.missing) out(`   - ${item.serverName}  → ${item.url}`);
    }
    if (diff.changed.length > 0) {
      out(`⚠️  URL/transport 与清单不一致（客户端会连错地址）：`);
      for (const item of diff.changed) out(`   - ${item.serverName}  → 期望 ${item.url}`);
    }
    if (diff.extra.length > 0) {
      out(`⚠️  bundle 里有、清单已无（会连不上任何 Gateway 路径）：`);
      for (const item of diff.extra) out(`   - ${item.serverName}  ${item.url ?? ''}`);
    }
    if (diff.matching.length > 0) out(`✅ 一致：${diff.matching.map((item) => item.serverName).join(', ')}`);
    out('');
    out('Codex 片段（客户端只连本地 Gateway，令牌不落到客户端）：');
    out(snippets.codex);
    out('VS Code 片段（mcp.json，HTTP 形态）：');
    out(snippets.vscode);
    out('');
    out('⚠️ 落盘 ≠ 生效：bundle 是**按安装时快照**生效的 —— 改完必须经插件管理器**重装/更新 bundle 并重启客户端**。');
  }

  if (options.write) {
    if (!changed) {
      out(options.json ? JSON.stringify({ ...payload, wrote: false, note: '无差异（幂等）' }, null, 2) : '[sync-bundle] 无差异，未写文件（幂等）。');
      process.exit(0);
    }
    const output = originalHadCrlf ? nextText.replace(/\n/g, '\r\n') : nextText;
    fs.writeFileSync(bundlePath, output, 'utf8');
    if (options.json) out(JSON.stringify({ ...payload, wrote: true }, null, 2));
    else out(`[sync-bundle] 已写入 ${options.bundlePath}（保留了人工注释；请按上面的 ⚠️ 重装 bundle）`);
    process.exit(0);
  }

  // 「无差异」按**语义**判断（缺/多/不一致三者皆空），不是按字节：
  // 即使重新格式化会动到空白，只要条目集合与内容一致，对用户就是「一致」。
  const semanticallyEqual = diff.missing.length === 0 && diff.changed.length === 0 && diff.extra.length === 0;
  if (options.json) out(JSON.stringify({ ...payload, semantically_equal: semanticallyEqual }, null, 2));
  else out(
    semanticallyEqual
      ? '[sync-bundle] 客户端配置与清单一致（无差异）。'
      : '[sync-bundle] 以上为差异（dry-run）。确认后加 --write 落盘。',
  );
  process.exit(0);
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1].replace(/\\/g, '/')}`).href) {
  main().catch((error) => {
    process.stderr.write(`[sync-bundle] 未捕获异常：${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exit(1);
  });
}
