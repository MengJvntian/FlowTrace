// Tool IDs verified against official @larksuiteoapi/lark-mcp 0.5.1.
export const FEISHU_MCP_VERSION = '0.5.1';
export const FEISHU_SCOPES = 'offline_access docx:document bitable:app';
export const FEISHU_TOOLS = Object.freeze([
  ['docx.v1.document.create', 'write', '创建飞书文档'],
  ['docx.v1.document.get', 'read', '查看飞书文档信息'],
  ['docx.v1.document.rawContent', 'read', '读取飞书文档正文'],
  ['docx.v1.documentBlock.list', 'read', '查看文档内容块'],
  ['docx.v1.documentBlock.get', 'read', '读取文档内容块'],
  ['docx.v1.documentBlock.batchUpdate', 'write', '更新文档内容块'],
  ['docx.v1.documentBlockChildren.get', 'read', '读取文档子块'],
  ['docx.v1.documentBlockChildren.create', 'write', '追加文档正文'],
  ['docx.v1.documentBlockChildren.batchDelete', 'write', '删除文档内容块'],
  ['bitable.v1.app.create', 'write', '创建多维表格'],
  ['bitable.v1.app.get', 'read', '查看多维表格信息'],
  ['bitable.v1.appTable.create', 'write', '创建数据表'],
  ['bitable.v1.appTable.list', 'read', '查看数据表列表'],
  ['bitable.v1.appTableField.create', 'write', '创建数据表字段'],
  ['bitable.v1.appTableField.list', 'read', '查看数据表字段'],
  ['bitable.v1.appTableRecord.get', 'read', '读取表格记录'],
  ['bitable.v1.appTableRecord.search', 'read', '查询表格记录'],
  ['bitable.v1.appTableRecord.create', 'write', '写入表格记录'],
  ['bitable.v1.appTableRecord.update', 'write', '更新表格记录'],
  ['bitable.v1.appTableRecord.batchCreate', 'write', '批量写入记录'],
  ['bitable.v1.appTableRecord.batchUpdate', 'write', '批量更新记录'],
].map(([api, action, label]) => Object.freeze({ api, name: api.replaceAll('.', '_'), action, label })));

export function feishuBusinessError(result, app) {
  if (app !== 'feishu') return null;
  for (const block of result?.content ?? []) {
    if (block.type !== 'text') continue;
    try {
      const body = JSON.parse(block.text);
      if (Number.isInteger(body?.code) && body.code !== 0) return { code: body.code, message: body.msg ?? body.message ?? '' };
    } catch { /* Plain text isn't a Feishu API status envelope. */ }
  }
  return null;
}

export function withFeishu(manifest) {
  const result = structuredClone(manifest);
  result.upstreams = result.upstreams.filter(item => item.serverName !== 'feishu');
  result.upstreams.push({ serverName: 'feishu', upstreamApp: 'feishu', gatewayId: 'gw-feishu', path: '/feishu/mcp',
    command: 'node', args: ['tools/node.js', 'tools/feishu-mcp.js'],
    env: { FEISHU_APP_ID: '${FEISHU_APP_ID}', FEISHU_APP_SECRET: '${FEISHU_APP_SECRET}', FEISHU_DOMAIN: '${FEISHU_DOMAIN}' },
    _说明: '飞书云文档/多维表格；官方 MCP 0.5.1，固定用户身份；用户主动连接时授权。' });
  result._readme = '现有应用 + 飞书云文档/多维表格；密钥从启动器环境注入。';
  return result;
}
