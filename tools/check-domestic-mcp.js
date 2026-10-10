// Connection/discovery only; account business tests run through Gateway separately.
import fs from 'node:fs';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { TENCENT_DOCS_TOOLS } from '../src/adapters/domestic-docs.js';
if (process.argv[2] && process.argv[2] !== 'tencent-docs') throw new Error('Unsupported application');
const token = process.env.TENCENT_DOCS_TOKEN;
if (!token || !token.trim() || /[\r\n]/u.test(token)) throw new Error('Application credential missing');
const client = new Client({ name: 'flowtrace-connection-discovery', version: '1.0' });
try {
  await client.connect(new StreamableHTTPClientTransport(new URL('https://docs.qq.com/openapi/mcp'),
    { requestInit: { headers: { Authorization: token } } }), { timeout: 30000 });
  const result = await client.listTools();
  const known = new Set(TENCENT_DOCS_TOOLS.map(tool => tool.name));
  fs.mkdirSync('demo-data/domestic-docs', { recursive: true });
  fs.writeFileSync('demo-data/domestic-docs/tencent-docs-tools.json', JSON.stringify(result.tools, null, 2));
  console.log(JSON.stringify({ app: 'tencent-docs', discovery_ok: true, tools: result.tools.length,
    classified: result.tools.filter(tool => known.has(tool.name)).length,
    unknown_tools: result.tools.filter(tool => !known.has(tool.name)).map(tool => tool.name), business_verified: false }));
} catch {
  console.error('Discovery failed. Check the token, network and account access; no credential was printed.');
  process.exitCode = 1;
} finally { await client.close(); }
