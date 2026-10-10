// A local, always-initializable MCP tool router. Never replay a dispatched call.
export class ApplicationRouter {
  constructor({ readMode, gatewayAvailable, connectGateway, connectDirect, audit = () => {} }) {
    Object.assign(this, { readMode, gatewayAvailable, connectGateway, connectDirect, audit });
    this.gateway = null;
    this.direct = null;
    this.pending = {};
  }
  async connection(kind, factory) {
    if (this[kind]) return this[kind];
    if (!this.pending[kind]) this.pending[kind] = Promise.resolve().then(factory)
      .then(client => { this[kind] = client; return client; }).finally(() => { delete this.pending[kind]; });
    return this.pending[kind];
  }
  async call(params, options = {}) {
    let available = false;
    try { available = await this.gatewayAvailable(); } catch { /* unavailable */ }
    let client;
    let monitored = true;
    if (available) {
      try { client = await this.connection('gateway', () => this.connectGateway()); }
      catch { this.gateway = null; available = false; }
    }
    if (!available) {
      // Read the switch at dispatch time, including after a failed handshake.
      if (this.readMode().enforce !== false) return this.failure('monitoring_required', '强制监控已开启，网关或此应用不可用，操作未执行。普通聊天可继续；修复网关或主动关闭强制监控后再试。');
      try { client = await this.connection('direct', () => this.connectDirect()); }
      catch { this.direct = null; return this.failure('direct_unavailable', '直连接入不可用，操作未执行。请检查已保存账户配置，无需默认重新授权。'); }
      // The user may have switched ON while the direct handshake was pending.
      if (this.readMode().enforce !== false) return this.failure('monitoring_required', '强制监控已开启，已取消本次直连操作；未发送业务请求。');
      monitored = false;
    }
    try {
      const result = await client.callTool(params, undefined, options);
      if (monitored) return result;
      this.note(params.name, result.isError ? 'error' : 'returned');
      return { ...result, content: [...(result.content ?? []), { type: 'text', text: '【未监控】强制监控已关闭，本次经直连执行，没有网关调用记录或字段流向证据。' }],
        _meta: { ...result._meta, flowtrace: { monitored: false, route: 'direct' } } };
    } catch {
      // A write may have reached the service. Do not fall back or retry it.
      if (monitored) { await this.gateway?.close().catch(() => {}); this.gateway = null; }
      else { this.note(params.name, 'outcome_unknown'); await this.direct?.close().catch(() => {}); this.direct = null; }
      return this.failure('outcome_unknown', '调用已提交但未取得确定结果。未自动重试或改走其他入口；写入操作请先核对应用实际结果。');
    }
  }
  failure(code, message) { return { isError: true, content: [{ type: 'text', text: message }], structuredContent: { error_kind: code } }; }
  note(tool, outcome) { try { this.audit({ tool, outcome, monitored: false, at_utc: new Date().toISOString() }); } catch { /* Do not replay business writes on audit failure. */ } }
  async close() { await Promise.allSettled([this.gateway?.close(), this.direct?.close()]); }
}
