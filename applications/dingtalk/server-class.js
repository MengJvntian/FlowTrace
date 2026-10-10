import { DingTalkMCPServer } from 'dingtalk-mcp/dist/DingTalkMCPServer.js';
// Upstream otherwise persists tokens inside node_modules. Refresh remains official and automatic.
export class PlatformDingTalkServer extends DingTalkMCPServer {
  constructor() {
    super();
    // Official MCP omits the task-detail GET although it provides the matching DELETE.
    // Reuse that exact path, auth and required arguments; keep official execution/refresh.
    const task = this.tools.find(tool => tool.name === 'deleteTask');
    this.tools.push({ ...task, name: 'getTask', description: '读取钉钉待办详情',
      requestTemplate: { ...task.requestTemplate, method: 'GET' } });
  }
  loadTokenCache() { this.tokenCacheData = null; }
  saveTokenCache(token, expiresIn = 7200) {
    this.tokenCacheData = { access_token: token, expires_at: Date.now() + expiresIn * 1000, app_id: this.appId };
  }
  clearTokenCache() { this.tokenCacheData = null; this.accessToken = null; }
}
