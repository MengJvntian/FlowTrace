// Selected priorities: Google Docs and GitHub. Configuration only; no network.
import fs from 'node:fs';
import assert from 'node:assert/strict';
const manifest = JSON.parse(fs.readFileSync('trace.manifest.json', 'utf8'));
manifest.upstreams.push(...['google-gmail', 'google-calendar'].map(id => JSON.parse(fs.readFileSync(`applications/${id}/application.json`, 'utf8')).upstream));
const docs = JSON.parse(fs.readFileSync('applications/google-gmail/application.json', 'utf8')).upstream;
assert.ok(docs);
Object.assign(docs, { serverName: 'docs', upstreamApp: 'google-docs', gatewayId: 'gw-google-docs', path: '/docs/mcp',
  _说明: '优先接入 Google Docs；真实账户及工具发现待验证。独立凭据目录避免影响 Gmail/Calendar。' });
docs.args[docs.args.indexOf('gmail')] = 'docs';
docs.env.WORKSPACE_MCP_CREDENTIALS_DIR = '${USERPROFILE}/.google_workspace_mcp/credentials-docs';
manifest.upstreams.push(docs, {
  serverName: 'github', upstreamApp: 'github', gatewayId: 'gw-github', path: '/github/mcp',
  transport: 'streamable-http', url: 'https://api.githubcopilot.com/mcp/',
  headers: { Authorization: 'Bearer ${GITHUB_MCP_TOKEN}' },
  _说明: 'GitHub 官方远程 MCP。缺少环境变量即拒绝启动；不会记录授权头值，不读取其他应用的账户令牌。',
});
manifest._readme = '优先应用接入准备：现有 Mail/Calendar/Gmail + Docs/GitHub。独立清单，未自动启动或替换当前服务。';
fs.writeFileSync('config/manifests/trace.manifest.next-apps.json', JSON.stringify(manifest, null, 2) + '\n');
console.log('Prepared config/manifests/trace.manifest.next-apps.json; no services or authorization started.');
