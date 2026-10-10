import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { ApplicationRouter } from '../src/gateway/application_router.js';
import { routerContext, readToolCache, applicationGatewayAvailable } from '../src/setup/router_context.js';
import { readMonitoringMode } from '../src/setup/monitoring_mode.js';
import { createApplicationRouterServer } from '../src/gateway/application_router_server.js';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const arg = key => args[args.indexOf(key) + 1];
const ctx = routerContext(root, path.resolve(arg('--manifest')), arg('--app'), arg('--agent'));
const tools = readToolCache(ctx);
async function connect(transport, timeout) {
  const client = new Client({ name: 'flowtrace-application-router-' + ctx.agent, version: '1.0' });
  try { await client.connect(transport, { timeout }); return client; }
  catch (error) { await client.close().catch(() => {}); throw error; }
}
const router = new ApplicationRouter({
  readMode: () => readMonitoringMode(ctx.modeFile),
  gatewayAvailable: async () => {
    // Re-read selection: removing/disabling an application never authorizes fallback.
    try { routerContext(root, ctx.manifestFile, ctx.target.id, ctx.agent); }
    catch { throw new Error('Application disabled'); }
    return applicationGatewayAvailable(ctx);
  },
  connectGateway: () => connect(new StreamableHTTPClientTransport(new URL(ctx.target[ctx.agent])), 5000),
  connectDirect: () => {
    routerContext(root, ctx.manifestFile, ctx.target.id, ctx.agent);
    return connect(new StdioClientTransport({ command: 'powershell.exe', args: ['-NoProfile', '-File',
      path.join(root, 'tools/run-direct-upstream.ps1'), '-App', ctx.target.id, '-Manifest', ctx.manifestFile], cwd: root, stderr: 'ignore' }), 60000);
  },
  audit: record => {
    const directory = path.join(root, 'demo-data/application-router');
    fs.mkdirSync(directory, { recursive: true });
    fs.appendFileSync(path.join(directory, 'unmonitored.jsonl'), JSON.stringify({ ...record, app: ctx.target.id, agent: ctx.agent }) + '\n');
  },
});
const server = createApplicationRouterServer({ name: 'flowtrace-router-' + ctx.target.serverName, tools, router,
  status: async () => ({ app: ctx.target.id, enforce: readMonitoringMode(ctx.modeFile).enforce,
      gateway_available: await applicationGatewayAvailable(ctx), cached_tools: tools.length,
      boundary: 'managed_application_mcp_only' }),
});
await server.connect(new StdioServerTransport());
process.on('SIGTERM', () => { void server.close(); });
process.on('SIGINT', () => { void server.close(); });
