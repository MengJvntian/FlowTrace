import fs from 'node:fs';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { classifyTool } from '../../src/lineage/tools.js';
const report = {};
fs.mkdirSync('demo-data/google-data', { recursive: true });
for (const app of ['drive', 'sheets']) {
  const client = new Client({ name: 'codex-google-data-discovery', version: '1.0' });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:8790/codex/${app}/mcp`)));
    const result = await client.listTools();
    fs.writeFileSync(`applications/google-${app}/tools.json`, JSON.stringify(result.tools, null, 2));
    report[app] = { tools: result.tools.length, business_verified: false,
      unknown: result.tools.filter(tool => classifyTool({ upstream_app: 'google-' + app, tool_name: tool.name }).action === 'unknown').map(tool => tool.name) };
  } finally { await client.close(); }
}
fs.writeFileSync('demo-data/google-data/discovery.json', JSON.stringify(report, null, 2));
console.log(JSON.stringify(report));
