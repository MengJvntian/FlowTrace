import fs from 'node:fs';
import path from 'node:path';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { googleDataEmail, requireOwnGoogleDataCredential } from './google-data-account.js';
const [app, mode = 'check'] = process.argv.slice(2);
if (!['gmail', 'calendar', 'docs', 'drive', 'sheets'].includes(app) || !['check', 'connect', 'verify'].includes(mode)) throw new Error('Unsupported account entry');
const client = new Client({ name: 'flowtrace-account-entry', version: '1.0' });
try {
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:8790/codex/${app}/mcp`),
    { requestInit: { headers: { 'X-Trace-Task': 'account_connection_' + Date.now() } } }));
  if (mode === 'check') {
    const result = await client.listTools();
    console.log(JSON.stringify({ app, tools: result.tools.length, discovery_ok: true, business_verified: false }));
  } else if (mode === 'verify' && ['drive', 'sheets'].includes(app)) {
    const email = googleDataEmail(); requireOwnGoogleDataCredential(app, email);
    const name = app === 'drive' ? 'list_drive_items' : 'list_spreadsheets';
    const args = app === 'drive' ? { user_google_email: email, page_size: 1, include_items_from_all_drives: false, corpora: 'user' }
      : { user_google_email: email, max_results: 1, corpora: 'user' };
    const result = await client.callTool({ name, arguments: args }, { timeout: 120000 });
    const text = (result.content ?? []).filter(block => block.type === 'text').map(block => block.text).join('\n');
    fs.mkdirSync('demo-data/google-data', { recursive: true });
    fs.writeFileSync(`demo-data/google-data/${app}-account-check.json`, JSON.stringify({ name, args, result }, null, 2));
    if (result.isError || /https:\/\/accounts\.google\.com\/|^Error[:\s]|authentication required/imu.test(text)) throw new Error('Business read failed; inspect the saved account-check result');
    console.log(JSON.stringify({ app, account_read_verified: true, business_readwrite_verified: false }));
  } else if (mode === 'connect') {
    const dirs = ['credentials-' + app, 'credentials-gmail'].map(name => path.join(process.env.USERPROFILE, '.google_workspace_mcp', name));
    const files = dirs.flatMap(dir => fs.existsSync(dir) ? fs.readdirSync(dir).filter(name => /^[^@\s]+@[^@\s]+\.json$/u.test(name)) : []);
    const accounts = [...new Set(files.map(name => name.slice(0, -5)))];
    if (accounts.length !== 1) throw new Error('Expected one configured Google account; configure OAuth client and account first');
    const result = await client.callTool({ name: 'start_google_auth', arguments: { user_google_email: accounts[0], service_name: app } });
    if (result.isError) throw new Error('Google authorization could not start');
    const text = (result.content ?? []).filter(block => block.type === 'text').map(block => block.text).join('\n');
    const url = /https:\/\/accounts\.google\.com\/[^\s<>"\)]+/u.exec(text)?.[0];
    if (!url) throw new Error('No Google authorization link returned; inspect service status');
    console.log(JSON.stringify({ app, authorization_url: url }));
  } else throw new Error('Verify is supported for Drive and Sheets only');
} catch {
  console.error(mode === 'verify'
    ? `Account read not verified. Run applications/google-${app}/connect.bat; if authorization is finished, inspect demo-data/google-data/${app}-account-check.json.`
    : 'Account entry failed. Start the selected Gateway and configure its Google OAuth client first.');
  process.exitCode = 1;
} finally { await client.close(); }
