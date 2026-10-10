/**
 * src/web/audit.js — P3 受控查看原文的审计记录（W1）
 *
 * 设计取舍（写进 相关实现）：
 *   - **内存中的环形缓冲**，不写事件库、不写任何文件：只读边界不允许页面服务留下
 *     可被误认为「采集数据」的持久化痕迹；进程重启即清空，页面顶部会写明这一点。
 *   - 每条记录包含：时间（UTC 毫秒）、动作、目标（event_id / json 路径 / 载荷方向）、
 *     **理由原文**、请求来源（remoteAddress / Host / User-Agent 摘要）。
 *   - 记录里**绝不写入原文值**：只写路径与被脱敏后的预览，避免审计日志本身成为泄露面。
 *   - 上限由 `--audit-max` 控制；超出后丢弃最旧记录并累计 `dropped` 计数（不静默）。
 */
import { randomUUID } from 'node:crypto';

export const AUDIT_ACTIONS = Object.freeze({
  REVEAL_RAW: 'reveal_raw',
  EXPORT_RAW: 'export_raw',
});

/**
 * @typedef {object} AuditEntryInput
 * @property {string} action
 * @property {string} target_kind
 * @property {string} [event_id]
 * @property {string} [gateway_call_id]
 * @property {string} [payload]
 * @property {string} [json_path]
 * @property {string} reason
 * @property {{remote_address?: string|null, host?: string|null, user_agent?: string|null, forwarded_for?: string|null}} [client]
 * @property {Record<string, any>} [detail]
 */

export class AuditLog {
  /**
   * @param {{max?: number, now?: () => string, limitBytes?: number}} [options]
   */
  constructor(options = {}) {
    this.max = Number.isInteger(options.max) && options.max > 0 ? options.max : 200;
    this.now = typeof options.now === 'function' ? options.now : () => new Date().toISOString();
    this.entries = [];
    this.seq = 0;
    this.dropped = 0;
  }

  /**
   * 追加一条审计记录（**不写入原文值**）。
   * @param {AuditEntryInput} input
   * @returns {Record<string, any>} 记录本体（含 audit_id）
   */
  record(input) {
    this.seq += 1;
    const entry = {
      audit_id: `aud_${String(this.seq).padStart(6, '0')}`,
      request_uid: randomUUID(),
      at_utc: this.now(),
      action: String(input.action ?? 'unknown'),
      target_kind: String(input.target_kind ?? 'unknown'),
      event_id: input.event_id ?? null,
      gateway_call_id: input.gateway_call_id ?? null,
      payload: input.payload ?? null,
      json_path: input.json_path ?? null,
      reason: typeof input.reason === 'string' ? input.reason.slice(0, 500) : '',
      client: {
        remote_address: input.client?.remote_address ?? null,
        host: input.client?.host ?? null,
        user_agent: typeof input.client?.user_agent === 'string' ? input.client.user_agent.slice(0, 200) : null,
      },
      detail: input.detail ?? null,
      raw_value_stored: false,
    };
    this.entries.push(entry);
    while (this.entries.length > this.max) {
      this.entries.shift();
      this.dropped += 1;
    }
    return entry;
  }

  /**
   * @param {{limit?: number}} [options]
   * @returns {Array<Record<string, any>>} 最新在前
   */
  list(options = {}) {
    const limit = Number.isFinite(options.limit) ? Math.max(0, Math.trunc(Number(options.limit))) : this.entries.length;
    return [...this.entries].reverse().slice(0, limit);
  }

  /** @returns {number} */
  size() {
    return this.entries.length;
  }

  /**
   * @returns {{count: number, max: number, dropped: number, persisted: false, note: string}}
   */
  summary() {
    return {
      count: this.entries.length,
      max: this.max,
      dropped: this.dropped,
      persisted: false,
      note:
        '审计记录只在内存中（环形缓冲，进程重启清空）：只读边界不允许页面服务持久化数据；' +
        '记录内不保存被查看的原文值，只保存目标路径与理由。',
    };
  }
}
