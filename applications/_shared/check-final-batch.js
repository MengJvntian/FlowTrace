// Explicit connection diagnostics only; never claim this is Gateway business acceptance.
import fs from 'node:fs';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { NOTION_TOOLS, GITEE_TOOLS } from '../../src/adapters/final-batch.js';
import { QQ_MAIL_TOOLS } from '../../src/adapters/qq_mail.js';
import { applicationBusinessError } from '../../src/adapters/business_errors.js';
const id = process.argv[2];
if (!['notion', 'gitee', 'qq-mail'].includes(id)) throw new Error('Unsupported application');
const variable = { notion: 'NOTION_TOKEN', gitee: 'GITEE_MCP_TOKEN', 'qq-mail': 'QQ_MAIL_AUTH_CODE' }[id];
if (!process.env[variable]?.trim() || /[\r\n]/u.test(process.env[variable])) throw new Error('Credential missing');
const client = new Client({ name: 'flowtrace-connection-check', version: '1.0' });
try {
  const transport = id !== 'gitee'
    ? new StdioClientTransport({ command: process.execPath, args: ['applications/' + id + '/server.js'], cwd: process.cwd(),
      env: { ...process.env }, stderr: 'ignore' })
    : new StreamableHTTPClientTransport(new URL('https://api.gitee.com/mcp'),
      { requestInit: { headers: { Authorization: 'Bearer ' + process.env[variable] } } });
  await client.connect(transport, { timeout: 30000 });
  const discovered = [];
  let cursor;
  do {
    const result = await client.listTools(cursor ? { cursor } : undefined, { timeout: 30000, cacheMode: 'refresh' });
    discovered.push(...result.tools);
    if (cursor && result.nextCursor === cursor) throw new Error('Repeated discovery cursor');
    cursor = result.nextCursor;
  } while (cursor);
  if (!discovered.length) throw new Error('No tools');
  let accountReadVerified = false;
  if (id === 'notion') {
    if (!discovered.some(tool => tool.name === 'API-get-self')) throw new Error('Account read tool missing');
    const result = await client.callTool({ name: 'API-get-self', arguments: {} }, undefined, { timeout: 30000 });
    if (result.isError || applicationBusinessError(result, id)) throw new Error('Account verification failed');
    const body = JSON.parse(result.content.find(block => block.type === 'text').text);
    if (body.object !== 'user' || !body.id) throw new Error('Account verification response unexpected');
    accountReadVerified = true;
  }
  if (id === 'qq-mail') {
    const result = await client.callTool({ name: 'list_mailboxes', arguments: {} }, undefined, { timeout: 60000 });
    if (result.isError || !Array.isArray(result.structuredContent?.mailboxes) || !result.structuredContent.mailboxes.length) throw new Error('IMAP read failed');
    accountReadVerified = true;
  }
  const folder = 'demo-data/final-batch/' + id;
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(folder + '/tools.json', JSON.stringify(discovered, null, 2) + '\n');
  const known = new Set((id === 'notion' ? NOTION_TOOLS : id === 'qq-mail' ? QQ_MAIL_TOOLS : GITEE_TOOLS).map(tool => tool.name));
  console.log(JSON.stringify({ app: id, discovery_ok: true, tools: discovered.length, account_read_verified: accountReadVerified,
    unknown_tools: discovered.filter(tool => !known.has(tool.name)).map(tool => tool.name), business_verified: false }));
} catch {
  console.error('Connection check failed: check the account token, access and network. Existing saved credentials were not replaced.');
  process.exitCode = 1;
} finally { await client.close(); }
