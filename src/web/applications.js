import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { readApplicationCatalog } from '../adapters/application_catalog.js';
import { classifyTool } from '../lineage/tools.js';
import { collectRunFields } from '../lineage/extract.js';
import { readMonitoringMode } from '../setup/monitoring_mode.js';
import { cachedView } from './view_cache.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export function applicationGuide(id, root = ROOT) {
  const app = readApplicationCatalog(path.join(root, 'applications')).find(app => app.id === id && app.upstream && !app.status.startsWith('excluded-'));
  if (!app) return null;
  return { ok: true, name: app.name, text: fs.readFileSync(path.join(root, 'applications', app.id, 'README.md'), 'utf8') };
}
function json(file, fallback) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; } }
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
}
export function schemaHash(tool) {
  return createHash('sha256').update(JSON.stringify(canonical({ input: tool.inputSchema, output: tool.outputSchema, annotations: tool.annotations }))).digest('hex');
}
export function schemaChanges(baseline, tools) {
  if (!Array.isArray(baseline) || !baseline.length) return { state: 'no_baseline', added: [], removed: [], changed: [] };
  const old = new Map(baseline.map(t => [t.name, schemaHash(t)])), next = new Map(tools.map(t => [t.name, schemaHash(t)]));
  const added = [...next.keys()].filter(n => !old.has(n)), removed = [...old.keys()].filter(n => !next.has(n));
  const changed = [...next.keys()].filter(n => old.has(n) && old.get(n) !== next.get(n));
  return { state: added.length || removed.length || changed.length ? 'changed' : 'unchanged', added, removed, changed };
}
export async function discoverTools(url, timeout = 5000) {
  const client = new Client({ name: 'flowtrace-application-center', version: '1.0' });
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), timeout);
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(url)), { timeout, signal: controller.signal });
    const tools = [], cursors = new Set(); let cursor;
    do {
      const result = await client.listTools(cursor ? { cursor } : undefined, { timeout, signal: controller.signal, cacheMode: 'refresh' });
      tools.push(...result.tools); cursor = result.nextCursor;
      if (cursor && cursors.has(cursor)) throw new Error('Repeated tools cursor');
      if (cursor) cursors.add(cursor);
    } while (cursor);
    if (!tools.length) throw new Error('Empty tool list');
    return tools;
  } finally { clearTimeout(timer); await client.close(); }
}
function accountInfo(app, root) {
  if (app.id.startsWith('google-')) {
    const directory = path.join(process.env.USERPROFILE || '', '.google_workspace_mcp', 'credentials-' + app.upstream.serverName);
    try {
      const names = fs.readdirSync(directory).filter(n => /^[^@\s]+@[^@\s]+\.json$/u.test(n));
      return { configured: names.length > 0, label: names.map(n => n.slice(0, -5)).join('、') || '未绑定', verified_now: false };
    } catch { return { configured: false, label: '未绑定', verified_now: false }; }
  }
  const name = app.id === 'github' ? 'github-readonly' : app.id;
  const file = path.join(process.env.LOCALAPPDATA || '', 'mcp-cross-app-trace', name + '.credential.xml');
  if (!fs.existsSync(file)) return { configured: false, label: '未绑定', verified_now: false };
  // Read only the non-secret username, never decrypt or return credential XML.
  const buffer = fs.readFileSync(file);
  const xml = buffer[0] === 0xff && buffer[1] === 0xfe ? buffer.toString('utf16le') : buffer.toString('utf8');
  const user = /<S N="UserName">([^<]+)<\/S>/u.exec(xml)?.[1];
  return { configured: true, label: user && !['notion', 'gitee'].includes(user) ? user.replaceAll('&amp;', '&') : '已保存应用授权', verified_now: false };
}
export async function applicationStatus(ctx, { root = ROOT, fetchImpl = fetch, discover = discoverTools, live = false } = {}) {
  const preferences = json(path.join(root, 'applications/preferences.json'), { disabled: [] });
  const catalogue = readApplicationCatalog(path.join(root, 'applications')).filter(app => app.upstream && !app.status.startsWith('excluded-'));
  const installed = json(path.join(root, 'applications/agent-routing/installed.json'), {});
  const configuredBase = installed.targets?.find(t => t.codex)?.codex;
  const base = configuredBase ? new URL(configuredBase).origin : 'http://127.0.0.1:8790';
  // Only connect to local gateway addresses, never a URL from a tool schema.
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(new URL(base).hostname)) throw new Error('Application gateway must be local');
  let health;
  if (!ctx.demoMode) {
    try { const response = await fetchImpl(base + '/healthz', { signal: AbortSignal.timeout(1500) }); if (response.ok) health = await response.json(); } catch { /* Offline is a normal state. */ }
  }
  if (health?.transport !== 'trace-manager' || !Array.isArray(health.upstreams)) health = null;
  const history = ctx.store ? cachedView(ctx, 'application-history', () => {
    const calls = ctx.store.listCalls({ order: 'desc', limit: null });
    const fields = collectRunFields(ctx.store.listEvents({ order: 'asc', limit: null }));
    return { calls, fields: [...fields.source_fields, ...fields.sink_fields] };
  }) : { calls: [], fields: [] };
  const rows = [];
  // Bounded concurrency avoids one slow upstream holding every card indefinitely.
  const queue = catalogue.slice();
  async function worker() {
    while (queue.length) {
      const app = queue.shift(), endpoint = health?.upstreams.find(u => u.serverName === app.upstream.serverName && u.path === app.upstream.path);
      const baseline = json(path.join(root, 'applications/agent-routing/tool-cache', app.id + '.json'), {});
      let tools = baseline.tools || [], discovery = 'cached', error = null;
      if (live && endpoint?.upstream_ready && !preferences.disabled.includes(app.id)) {
        try { tools = await discover(base + '/codex' + app.upstream.path); discovery = 'live'; }
        catch { discovery = 'failed'; error = '工具发现失败，请检查应用连接、授权或网络。'; }
      }
      const calls = history.calls.filter(c => c.upstream_app === app.upstream.upstreamApp), recent = calls.find(c => c.status !== 'ok');
      const schema = discovery === 'live' ? schemaChanges(baseline.tools, tools) : { state: 'unverified', added: [], removed: [], changed: [] };
      rows.push({ id: app.id, name: app.name, account: ctx.demoMode ? { configured: false, label: '演示模式（不读取真实账户）', verified_now: false } : accountInfo(app, root), enabled: !preferences.disabled.includes(app.id),
        connection: !health ? 'gateway_offline' : !endpoint ? 'not_loaded' : endpoint.upstream_ready ? 'connected' : 'unavailable',
        tools_state: discovery === 'failed' ? 'unavailable' : discovery === 'live' ? 'available' : 'unverified',
        checked_at: new Date().toISOString(), baseline_at: baseline.discovered_at || null, schema, error,
        recent_failure: recent ? { at: recent.started_at_utc, tool: recent.tool_name, kind: recent.error_kind || recent.status } : null,
        tools: tools.map(tool => {
          const classification = classifyTool({ upstream_app: app.upstream.upstreamApp, tool_name: tool.name });
          const fields = history.fields.filter(f => f.upstream_app === app.upstream.upstreamApp && f.tool_name === tool.name);
          return { name: tool.name, action: classification.action, classification_source: classification.source,
            input_fields: Object.keys(tool.inputSchema?.properties || {}), required: tool.inputSchema?.required || [],
            schema_changed: schema.changed.includes(tool.name), calls: calls.filter(c => c.tool_name === tool.name).length,
            extracted_fields: fields.length, observed_paths: [...new Set(fields.map(f => f.json_path))].slice(0, 12) };
        }) });
    }
  }
  await Promise.all([worker(), worker(), worker()]);
  return { ok: true, gateway_online: Boolean(health), gateway: base, mode: readMonitoringMode(path.join(root, 'applications/agent-routing/monitoring.json')),
    applications: rows.sort((a, b) => a.name.localeCompare(b.name)), checked_at: new Date().toISOString(),
    note: ctx.demoMode ? '虚构数据演示只使用虚构记录，不读取本机真实账户，也不探测真实 Gateway。' : '账户为本机保存配置，不代表本次身份验证；连接、工具发现和业务成功分别展示。字段数为历史实际提取结果，不是全工具覆盖率。' };
}
