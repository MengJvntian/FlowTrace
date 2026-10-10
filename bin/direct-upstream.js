// Explicit OFF fallback. No Collector/SQLite instance: never claim this was monitored.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Server, ProtocolError, INVALID_PARAMS } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { Client } from '@modelcontextprotocol/client';
import { routerContext } from '../src/setup/router_context.js';
import { readMonitoringMode } from '../src/setup/monitoring_mode.js';
import { loadManifest, gatewayConfigFor } from '../src/gateway/manifest.js';
import { createStdioUpstreamTransport, createStreamableHttpUpstreamTransport } from '../src/gateway/transport.js';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2), arg = key => args[args.indexOf(key) + 1];
const ctx = routerContext(root, path.resolve(arg('--manifest')), arg('--app'), 'codex');
if (readMonitoringMode(ctx.modeFile).enforce) throw new Error('Direct fallback disabled');
const raw = { ...ctx.manifest, upstreams: [ctx.target.upstream] };
const loaded = loadManifest({ manifestPath: ctx.manifestFile, manifestText: JSON.stringify(raw), cwd: root });
if (!loaded.ok) { process.stderr.write('Direct application configuration unavailable.\n'); process.exit(3); }
const config = gatewayConfigFor(loaded.manifest.upstreams[0], {});
config.upstreamStderrDisabled = true;
const client = new Client({ name: 'flowtrace-explicit-unmonitored', version: '1.0' });
const transport = config.upstreamUrl ? createStreamableHttpUpstreamTransport(config) : createStdioUpstreamTransport(config);
await client.connect(transport, { timeout: 60000 });
const server = new Server({ name: 'flowtrace-direct-' + ctx.target.serverName, version: '1.0' }, { capabilities: { tools: {} } });
server.setRequestHandler('tools/list', request => client.listTools(request.params, { timeout: 30000 }));
server.setRequestHandler('tools/call', async request => {
  routerContext(root, ctx.manifestFile, ctx.target.id, 'codex');
  if (readMonitoringMode(ctx.modeFile).enforce) throw new ProtocolError(INVALID_PARAMS, '强制监控已开启，直连请求未执行');
  return client.callTool(request.params, undefined, { timeout: 120000 });
});
server.onclose = () => { void client.close(); };
await server.connect(new StdioServerTransport());
