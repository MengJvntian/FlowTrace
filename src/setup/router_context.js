import fs from 'node:fs';
import path from 'node:path';
import { readApplicationCatalog } from '../adapters/application_catalog.js';
import { routingTargets } from './application_routing.js';
export function routerContext(root, manifestFile, appId, agent) {
  if (!['codex', 'dsh'].includes(agent)) throw new Error('Unsupported agent');
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  const preferencesFile = path.join(root, 'applications/preferences.json');
  const preferences = fs.existsSync(preferencesFile) ? JSON.parse(fs.readFileSync(preferencesFile, 'utf8')) : { disabled: [] };
  const targets = routingTargets(manifest, readApplicationCatalog(path.join(root, 'applications')), preferences);
  const target = targets.find(item => item.id === appId);
  if (!target) throw new Error('Application is not selected or is disabled');
  return { target, manifest, root, manifestFile: path.resolve(manifestFile), agent,
    modeFile: path.join(root, 'applications/agent-routing/monitoring.json'),
    cacheFile: path.join(root, 'applications/agent-routing/tool-cache', appId + '.json') };
}
export function readToolCache(ctx) {
  try {
    const value = JSON.parse(fs.readFileSync(ctx.cacheFile, 'utf8'));
    if (value.version !== 1 || value.app !== ctx.target.id || value.serverName !== ctx.target.serverName || value.path !== ctx.target.path
      || !Array.isArray(value.tools) || value.tools.some(tool => typeof tool.name !== 'string' || tool.inputSchema?.type !== 'object')) return [];
    return value.tools;
  } catch { return []; }
}
export function writeToolCache(ctx, tools) {
  if (!Array.isArray(tools) || !tools.length || tools.some(tool => typeof tool.name !== 'string' || tool.inputSchema?.type !== 'object')) throw new Error('Invalid tool discovery');
  fs.mkdirSync(path.dirname(ctx.cacheFile), { recursive: true });
  const temporary = ctx.cacheFile + '.' + process.pid + '.tmp';
  fs.writeFileSync(temporary, JSON.stringify({ version: 1, app: ctx.target.id, serverName: ctx.target.serverName,
    path: ctx.target.path, discovered_at: new Date().toISOString(), tools }, null, 2) + '\n');
  fs.renameSync(temporary, ctx.cacheFile);
}
export async function applicationGatewayAvailable(ctx, fetchImpl = fetch) {
  try {
    const response = await fetchImpl(new URL('/healthz', ctx.target[ctx.agent]), { signal: AbortSignal.timeout(1000) });
    if (!response.ok) return false;
    const health = await response.json();
    return health.transport === 'trace-manager' && typeof health.manifest === 'string'
      && path.resolve(health.manifest) === ctx.manifestFile && Array.isArray(health.upstreams)
      && health.upstreams.some(item => item.serverName === ctx.target.serverName && item.path === ctx.target.path
        && item.upstream_ready === true && item.tools_discovery !== 'unavailable' && (item.write_failures ?? 0) === 0);
  } catch { return false; }
}
