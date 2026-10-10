// Start/login official MCP using env credentials, never secrets in argv.
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { FEISHU_TOOLS, FEISHU_SCOPES } from '../src/adapters/feishu.js';
const mode = process.argv[2] ?? 'mcp';
if (!['mcp', 'login', 'check'].includes(mode)) throw new Error('Unsupported Feishu mode');
if (!/^cli_[A-Za-z0-9]+$/u.test(process.env.FEISHU_APP_ID ?? '') || !process.env.FEISHU_APP_SECRET) {
  console.error('Connect Feishu first using connect-feishu.bat.'); process.exit(3);
}
const domain = process.env.FEISHU_DOMAIN ?? 'https://open.feishu.cn';
if (!['https://open.feishu.cn', 'https://open.larksuite.com'].includes(domain)) throw new Error('Unsupported Feishu domain');
process.env.APP_ID = process.env.FEISHU_APP_ID;
process.env.APP_SECRET = process.env.FEISHU_APP_SECRET;
process.env.LARK_DOMAIN = domain;
// Prevent inherited settings from changing the selected account or token mode.
delete process.env.USER_ACCESS_TOKEN;
delete process.env.LARK_TOOLS;
process.env.LARK_TOKEN_MODE = 'user_access_token';
const directory = path.dirname(fileURLToPath(import.meta.url));
const entry = path.resolve(directory, '../node_modules/@larksuiteoapi/lark-mcp/dist/cli.js');
if (mode === 'check') {
  const { authStore } = await import('../node_modules/@larksuiteoapi/lark-mcp/dist/auth/store.js');
  try {
    const token = await authStore.getLocalAccessToken(process.env.APP_ID);
    const saved = token ? await authStore.getToken(token) : null;
    const active = Boolean(saved && (!saved.expiresAt || saved.expiresAt > Date.now() / 1000));
    console.log(JSON.stringify({ configured: true, authorized: active, domain, storedToken: Boolean(token), tokenMetadata: Boolean(saved),
      expiresAt: saved?.expiresAt ?? null, refreshable: Boolean(saved?.extra?.refreshToken) }));
    process.exitCode = active ? 0 : 3;
  } finally { authStore.destroy(); }
} else {
  process.argv = [process.execPath, entry, mode, '--host', 'localhost', '--port', '3000', '--scope', FEISHU_SCOPES];
  if (mode === 'mcp') process.argv.push('--oauth', '--token-mode', 'user_access_token', '--language', 'zh', '--tool-name-case', 'snake', '--tools', FEISHU_TOOLS.map(t => t.api).join(','));
  await import(pathToFileURL(entry).href);
}
