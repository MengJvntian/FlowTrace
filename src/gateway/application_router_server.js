import { Server, ProtocolError, INVALID_PARAMS } from '@modelcontextprotocol/server';
export const ROUTER_STATUS_TOOL = 'trace_monitoring_status';
export function createApplicationRouterServer({ name, tools, router, status }) {
  if (tools.some(tool => tool.name === ROUTER_STATUS_TOOL)) throw new Error('Reserved router status tool collision');
  const server = new Server({ name, version: '1.0' }, { capabilities: { tools: {} } });
  server.setRequestHandler('tools/list', async () => ({ tools: [...tools, { name: ROUTER_STATUS_TOOL,
    description: '查看强制监控开关及当前应用连接状态（不读取业务数据）',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }, annotations: { readOnlyHint: true } }] }));
  server.setRequestHandler('tools/call', async (request, extra) => {
    if (request.params.name === ROUTER_STATUS_TOOL) {
      const state = await status();
      return { content: [{ type: 'text', text: JSON.stringify(state) }], structuredContent: state };
    }
    if (!tools.some(tool => tool.name === request.params.name)) throw new ProtocolError(INVALID_PARAMS, 'Unknown application tool');
    return router.call(request.params, { timeout: 120000, signal: extra.signal });
  });
  server.onclose = () => { void router.close(); };
  return server;
}
