import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { parseCodexConfig, parseDshPatch } from './import_agents.js';

export const BEGIN = '# BEGIN managed application Gateway routes';
export const END = '# END managed application Gateway routes';
const digest = value => crypto.createHash('sha256').update(value).digest('hex');
const json = file => JSON.parse(fs.readFileSync(file, 'utf8'));

export function routingTargets(manifest, apps, preferences = { disabled: [] }) {
  const base = new URL(`http://${manifest.http?.host ?? '127.0.0.1'}:${manifest.http?.port ?? 8790}`);
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname)) throw new Error('Gateway must use a loopback address');
  for (const key of ['serverName', 'path', 'gatewayId']) {
    const values = manifest.upstreams.map(item => item[key]).filter(value => value !== undefined);
    if (new Set(values).size !== values.length) throw new Error(`Duplicate upstream ${key}`);
  }
  if (manifest.upstreams.some(item => /^\/(codex|dsh)(\/|$)/u.test(item.path))) throw new Error('Agent prefixes belong to client URLs, not upstream paths');
  return manifest.upstreams.flatMap(upstream => {
    const app = apps.find(item => item.upstream?.serverName === upstream.serverName && item.upstream?.upstreamApp === upstream.upstreamApp);
    if (!app || preferences.disabled.includes(app.id) || app.status.startsWith('excluded-')) return [];
    if (!/^\/[a-zA-Z0-9_/-]+\/mcp$/.test(upstream.path)) throw new Error('Invalid Gateway application path');
    if (upstream.path !== app.upstream.path) throw new Error('Gateway application path differs from catalogue');
    if (!/^[a-zA-Z0-9_-]{1,26}$/.test(upstream.serverName)) throw new Error('Invalid application server name');
    return [{ id: app.id, name: app.name, serverName: upstream.serverName, path: upstream.path,
      codex: new URL('/codex' + upstream.path, base).href, dsh: new URL('/dsh' + upstream.path, base).href,
      legacy: new URL(upstream.path, base).href, upstream }];
  });
}

export function generateRoutes(targets, client) {
  if (!['codex', 'dsh'].includes(client)) throw new Error('Unsupported client');
  const entries = targets.map(target => client === 'codex'
    ? `[mcp_servers.trace_${target.serverName}]\nurl = ${JSON.stringify(target.codex)}\nenabled = true\nrequired = false\nstartup_timeout_sec = 60\ntool_timeout_sec = 120`
    : `    - id: mcp-trace-${target.serverName}\n      name: '@deepseek-ai/dsh-mcp-client'\n      config:\n        serverName: ${target.serverName}\n        transport: streamable-http\n        url: ${JSON.stringify(target.dsh)}\n        failOnStartupError: false\n        toolCallTimeoutMs: 120000`);
  return BEGIN + '\n' + (client === 'dsh' && entries.length ? '- insert:\n' : '') + entries.join('\n\n') + '\n' + END + '\n';
}

// Read local readiness only. Never refresh a token, launch an upstream or open OAuth.
export function localReadiness(manifest, root, env = process.env) {
  const issues = [];
  for (const upstream of manifest.upstreams) {
    if (upstream.command === 'node') {
      const args = upstream.args ?? [];
      const entry = args[0] === 'tools/node.js' ? args[1] : args[0];
      if (entry && !entry.startsWith('-') && !fs.existsSync(path.resolve(root, upstream.cwd ?? '.', entry))) {
        issues.push({ serverName: upstream.serverName, reason: 'entry_missing' });
      }
    }
    const store = upstream.env?.WORKSPACE_MCP_CREDENTIALS_DIR;
    if (!store) continue;
    const directory = store.replace(/\$\{([^}]+)\}/gu, (_, key) => env[key] ?? '${' + key + '}');
    let authorized = false;
    try {
      for (const name of fs.readdirSync(directory).filter(name => /^[^@\s]+@[^@\s]+\.json$/u.test(name))) {
        const credential = json(path.join(directory, name));
        if (credential.token || credential.refresh_token) { authorized = true; break; }
      }
    } catch { /* Missing or unreadable credentials are not ready. */ }
    if (!authorized) issues.push({ serverName: upstream.serverName, reason: 'authorization_missing' });
  }
  return { ready: issues.length === 0, issues };
}

function withoutManaged(text) {
  if (!text.includes(BEGIN) && !text.includes(END)) return text;
  const start = text.indexOf(BEGIN), end = text.indexOf(END);
  if (start < 0 || end < start || text.indexOf(BEGIN, start + BEGIN.length) !== -1 || text.indexOf(END, end + END.length) !== -1) throw new Error('Invalid managed routing markers');
  return text.slice(0, start) + text.slice(end + END.length).replace(/^\r?\n/, '');
}

// Never expose URL queries, headers, arguments, or parse-error contents in reports.
export function inspectSource(source, targets) {
  if (source.missing) return { client: source.client, profile: source.profile, source: source.file, status: 'missing', entries: [] };
  if (source.client === 'dsh' && !source.text.includes('@deepseek-ai/dsh-mcp-client')) {
    return { client: source.client, profile: source.profile, source: source.file, status: 'no_mcp_entries', entries: [] };
  }
  try {
    const parsed = source.client === 'codex' ? parseCodexConfig(source.text)
      : source.text.trim() === '[]' || !source.text.trim() ? { servers: [], warnings: [] } : parseDshPatch(source.text);
    const rows = parsed.servers.map(server => {
      let target = targets.find(item => [item.serverName, `trace_${item.serverName}`, `${item.serverName}-trace`].includes(server.raw_name));
      let status = 'unknown';
      if (server.url) {
        let url;
        try { url = new URL(server.url); } catch { /* Unknown, not assumed safe. */ }
        const routed = targets.find(item => url && [item[source.client], item.legacy, item.codex, item.dsh].includes(url.href));
        if (routed) {
          target = routed;
          status = url.href === routed[source.client] ? 'gateway' : 'gateway_other_label';
        } else {
          const remote = targets.find(item => item.upstream.url && url && new URL(item.upstream.url).origin === url.origin);
          if (remote) { target = remote; status = 'direct'; }
          else if (target) status = 'direct';
        }
      } else if (target) {
        const router = target.router?.[source.client];
        if (router && server.command?.toLowerCase() === router.command.toLowerCase()
          && JSON.stringify(server.args ?? []) === JSON.stringify(router.args)) {
          status = server.enabled === false ? 'disabled' : 'gateway';
          return { name: server.raw_name, app: target.id, status, entry_id: server.entry_id ?? null,
            route_kind: 'switchable_application_router' };
        }
        // Wrapper scripts are not assumed to monitor calls based on a substring.
        status = 'direct';
      }
      if (server.enabled === false) status = 'disabled';
      return { name: server.raw_name, app: target?.id ?? null, status, entry_id: server.entry_id ?? null };
    });
    return { client: source.client, profile: source.profile, source: source.file,
      status: parsed.warnings.length ? 'partial' : 'read', warning_count: parsed.warnings.length, entries: rows };
  } catch {
    return { client: source.client, profile: source.profile, source: source.file, status: 'unsupported', entries: [] };
  }
}

export function discoverSources({ home = process.env.USERPROFILE || process.env.HOME, projectRoot = process.cwd(),
  installAnchor = path.join(process.env.APPDATA ?? path.join(home, 'AppData/Roaming'), 'npm/node_modules/@deepseek-ai/dsh/package.json') } = {}) {
  const sources = [];
  const seen = new Set();
  function add(file, client, profile, options = {}) {
    const absolute = path.resolve(file), key = `${client}:${profile}:${absolute.toLowerCase()}`;
    if (seen.has(key)) return;
    seen.add(key);
    sources.push({ file: absolute, client, profile, ...options,
      ...(fs.existsSync(absolute) ? { text: fs.readFileSync(absolute, 'utf8') } : { text: '', missing: true }) });
  }
  add(path.join(home, '.codex/config.toml'), 'codex', 'user');
  add(path.join(projectRoot, '.codex/config.toml'), 'codex', 'project');
  const profiles = path.join(home, '.dsh/profiles');
  if (fs.existsSync(profiles)) for (const entry of fs.readdirSync(profiles, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const directory = path.join(profiles, entry.name);
    add(path.join(directory, 'cordis.patch.yml'), 'dsh', entry.name);
    add(path.join(home, '.dsh/cordis.patch.yml'), 'dsh', entry.name);
    const packageFile = path.join(directory, 'package.json');
    if (!fs.existsSync(packageFile)) continue;
    try {
      const manifest = json(packageFile);
      // Only bundles actually selected by the profile are part of this scan.
      for (const name of manifest.dsh?.profile?.bundles ?? []) {
        const spec = manifest.dependencies?.[name];
        let directoryOfBundle = typeof spec === 'string' && /^(link:|file:)/.test(spec)
          ? path.resolve(directory, spec.replace(/^(link:|file:)/, '')) : path.join(directory, 'node_modules', name);
        let bundleFile = path.join(directoryOfBundle, 'package.json');
        if (!fs.existsSync(bundleFile) && fs.existsSync(installAnchor) && name.startsWith('@deepseek-ai/')) {
          try { bundleFile = createRequire(installAnchor).resolve(name + '/package.json'); directoryOfBundle = path.dirname(bundleFile); } catch { /* Report unresolved bundle. */ }
        }
        if (!fs.existsSync(bundleFile)) { sources.push({ file: bundleFile, client: 'dsh', profile: entry.name, missing: true, discovery_error: true, bundle: name }); continue; }
        const bundle = json(bundleFile);
        const patches = bundle.dsh?.bundle?.patch;
        for (const patch of Array.isArray(patches) ? patches : patches ? [patches] : []) {
          if (typeof patch !== 'string') { sources.push({ file: bundleFile, client: 'dsh', profile: entry.name, discovery_error: true, text: '' }); continue; }
          add(path.resolve(directoryOfBundle, patch), 'dsh', entry.name, { bundle: name });
        }
      }
    } catch { sources.push({ file: packageFile, client: 'dsh', profile: entry.name, discovery_error: true, text: '' }); }
  }
  return sources;
}

export function routingReport(sources, targets) {
  const results = sources.map(source => source.discovery_error
    ? { client: source.client, profile: source.profile, source: source.file, status: 'unsupported', entries: [] }
    : inspectSource(source, targets));
  const scopeOf = item => item.client === 'codex' ? 'codex:workspace' : `${item.client}:${item.profile}`;
  const scopes = [...new Set(results.map(scopeOf))];
  const coverage = scopes.flatMap(scope => targets.map(target => {
    const relevant = results.filter(item => scopeOf(item) === scope);
    const entries = relevant.flatMap(item => item.entries).filter(item => item.app === target.id && item.status !== 'disabled');
    const gateways = entries.filter(item => item.status === 'gateway');
    return { scope, app: target.id, name: target.name, gateway_count: gateways.length,
      status: relevant.some(item => ['unsupported', 'partial'].includes(item.status)) ? 'incomplete_scan'
        : entries.some(item => item.status === 'direct') ? 'direct'
        : entries.some(item => item.status === 'gateway_other_label') ? 'gateway_other_label'
        : entries.length > 1 ? 'duplicate' : gateways.length === 1 ? 'gateway' : 'missing' };
  }));
  return { schema: 'application-routing/1', boundary: 'configured_application_mcp_only', sources: results, coverage,
    all_configured: coverage.length > 0 && coverage.every(item => item.status === 'gateway'),
    unknown_count: results.reduce((sum, item) => sum + item.entries.filter(row => row.status === 'unknown').length, 0) };
}

export async function checkGateway(targets, fetchImpl = fetch, manifestFile = null) {
  if (!targets.length) return { ready: false, reason: 'no_selected_applications' };
  try {
    const response = await fetchImpl(new URL('/healthz', targets[0].codex), { signal: AbortSignal.timeout(5000) });
    const health = await response.json();
    if (!response.ok || health.transport !== 'trace-manager' || !Array.isArray(health.upstreams)) return { ready: false, reason: 'not_gateway' };
    if (manifestFile && (!health.manifest || path.resolve(health.manifest) !== path.resolve(manifestFile))) return { ready: false, reason: 'manifest_mismatch' };
    const missing = targets.filter(target => !health.upstreams.some(row => row.serverName === target.serverName && row.path === target.path && row.upstream_ready === true && row.tools_discovery !== 'unavailable')).map(item => item.id);
    return { ready: missing.length === 0, reason: missing.length ? 'applications_unavailable' : 'ready', missing };
  } catch { return { ready: false, reason: 'gateway_unavailable' }; }
}

export function codexInstallText(text, targets, { generate = true, routeGenerator = generateRoutes } = {}) {
  let original = withoutManaged(text);
  const report = inspectSource({ file: 'config.toml', client: 'codex', text: original }, targets);
  if (['unsupported', 'partial'].includes(report.status)) throw new Error('Codex configuration cannot be safely edited');
  const names = new Set(report.entries.filter(item => item.app && item.status !== 'disabled').map(item => item.name));
  for (const target of targets) if (report.entries.some(item => item.name === `trace_${target.serverName}` && !item.app)) throw new Error('Managed server name conflicts with an unrelated tool');
  original = original.replace(/(^\[mcp_servers\.([^\].]+)\][^\n]*\r?\n)([\s\S]*?)(?=^\[|$(?![\s\S]))/gm, (block, header, name, body) => {
    if (!names.has(name)) return block;
    if (name.startsWith('trace_')) throw new Error('Existing managed name without managed markers requires review');
    const next = /^enabled\s*=/m.test(body) ? body.replace(/^enabled\s*=.*$/m, 'enabled = false') : 'enabled = false\n' + body;
    return header + next;
  });
  return original.trimEnd() + '\n' + (generate ? '\n' + routeGenerator(targets, 'codex') : '');
}

export function makeEdit(file, previous, next) {
  return { file: path.resolve(file), before_sha256: previous === null ? null : digest(previous), after_sha256: digest(next), content: next };
}

export function applyEdits(edits) {
  // Validate every source before the first mutation. Keep backup alongside each file.
  for (const edit of edits) {
    const previous = fs.existsSync(edit.file) ? fs.readFileSync(edit.file, 'utf8') : null;
    if ((previous === null ? null : digest(previous)) !== edit.before_sha256) throw new Error('Configuration changed since preparation; prepare again');
    if (digest(edit.content) !== edit.after_sha256) throw new Error('Prepared edit integrity check failed');
  }
  const changed = [];
  try {
    for (const edit of edits) {
      const previous = fs.existsSync(edit.file) ? fs.readFileSync(edit.file) : null;
      if (previous?.toString('utf8') === edit.content) continue;
      fs.mkdirSync(path.dirname(edit.file), { recursive: true });
      const backup = previous === null ? null : edit.file + '.gateway-backup-' + crypto.randomUUID();
      if (backup) fs.copyFileSync(edit.file, backup, fs.constants.COPYFILE_EXCL);
      changed.push({ file: edit.file, previous, backup });
      const temporary = edit.file + '.gateway-' + crypto.randomUUID();
      try { fs.writeFileSync(temporary, edit.content, { flag: 'wx' }); fs.renameSync(temporary, edit.file); }
      finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
    }
  } catch (error) {
    for (const item of changed.reverse()) {
      if (item.previous === null) { if (fs.existsSync(item.file)) fs.unlinkSync(item.file); }
      else fs.writeFileSync(item.file, item.previous);
    }
    throw error;
  }
  return changed.map(({ file, backup }) => ({ file, backup }));
}
