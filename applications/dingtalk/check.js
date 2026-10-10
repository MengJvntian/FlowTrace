import fs from 'node:fs';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { DINGTALK_TOOLS } from '../../src/adapters/dingtalk.js';
const client = new Client({ name: 'flowtrace-dingtalk-discovery', version: '1.0' });
try {
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [path.resolve('applications/dingtalk/server.js')],
    env: { DINGTALK_Client_ID: process.env.DINGTALK_CLIENT_ID, DINGTALK_Client_Secret: process.env.DINGTALK_CLIENT_SECRET }, stderr: 'ignore' }));
  const tools = (await client.listTools()).tools;
  if (tools.length !== DINGTALK_TOOLS.length || tools.some(tool => !DINGTALK_TOOLS.some(known => known.name === tool.name))) throw new Error('Unexpected published tool catalogue');
  fs.mkdirSync('demo-data/dingtalk', { recursive: true });
  fs.writeFileSync('demo-data/dingtalk/tools.json', JSON.stringify(tools, null, 2));
  console.log(JSON.stringify({ discovery_ok: true, tools: tools.length, business_verified: false }));
} catch { console.error('DingTalk discovery failed; no credentials were printed.'); process.exitCode = 1; }
finally { await client.close(); }
