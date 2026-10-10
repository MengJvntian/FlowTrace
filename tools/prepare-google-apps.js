// Generate a separate, inactive integration manifest. Does not launch/authenticate.
import fs from 'node:fs';
import assert from 'node:assert/strict';
const manifest = JSON.parse(fs.readFileSync('trace.manifest.json', 'utf8'));
const template = JSON.parse(fs.readFileSync('applications/google-gmail/application.json', 'utf8')).upstream;
assert.ok(template, 'Existing Gmail upstream required');
for (const app of ['drive', 'docs', 'sheets']) {
  const item = structuredClone(template);
  item._说明 = '接入准备；必须先核对账户授权和真实工具列表。不会自动启用。';
  item.serverName = app;
  item.upstreamApp = 'google-' + app;
  item.gatewayId = 'gw-google-' + app;
  item.path = '/' + app + '/mcp';
  item.args[item.args.indexOf('gmail')] = app;
  item.env.WORKSPACE_MCP_CREDENTIALS_DIR = '${USERPROFILE}/.google_workspace_mcp/credentials-' + app;
  manifest.upstreams.push(item);
}
manifest._readme = '独立 Google 多应用接入草案；未替换正在运行的清单。各应用使用独立凭据目录。先验证实际工具列表和授权，再启动。';
fs.writeFileSync('config/manifests/trace.manifest.workspace.json', JSON.stringify(manifest, null, 2) + '\n');
console.log('Prepared config/manifests/trace.manifest.workspace.json; active manifest and credentials unchanged.');
