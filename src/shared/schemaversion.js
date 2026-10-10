/**
 * src/shared/schemaversion.js — 事件 schema 版本与枚举（F1）
 *
 * 本文件与 `相关实现` 是**同一契约的两面**：schema.md 是人类可读唯一真源，
 * 本文件是机器可读常量。任何字段名/枚举值的改动必须同时改两处，
 * 并升级 `SCHEMA_VERSION`（见 相关实现「变更流程」）。
 */

/** 当前事件 schema 版本（写入每条 runs/calls/events 记录的 schema_version 列）。 */
export const SCHEMA_VERSION = '1.0.0';

/** 本代码库能读写的 schema 版本集合。 */
export const SUPPORTED_SCHEMA_VERSIONS = Object.freeze(['1.0.0']);

/**
 * 规范中映射的 status 枚举（相关实现）。
 * 语义严格区分，禁止把「上游返回 isError」写成 protocol_error，反之亦然。
 */
export const STATUS = Object.freeze({
  OK: 'ok',
  TOOL_ISERROR: 'tool_iserror',
  PROTOCOL_ERROR: 'protocol_error',
  TRANSPORT_ERROR: 'transport_error',
  TIMEOUT: 'timeout',
  VALIDATION_ERROR: 'validation_error',
});

/** 规范 status 值的完整有序列表。 */
export const STATUS_VALUES = Object.freeze(Object.values(STATUS));

/**
 * 兼容别名（仅用于把历史/上游措辞收敛到规范枚举，不新增取值）。
 * 别名命中时返回规范值；未命中且非严格模式时归入 protocol_error 并告警。
 */
export const STATUS_ALIASES = Object.freeze({
  success: STATUS.OK,
  ok: STATUS.OK,
  iserror: STATUS.TOOL_ISERROR,
  tool_error: STATUS.TOOL_ISERROR,
  tool_is_error: STATUS.TOOL_ISERROR,
  'protocol-error': STATUS.PROTOCOL_ERROR,
  'transport-error': STATUS.TRANSPORT_ERROR,
  'validation-error': STATUS.VALIDATION_ERROR,
  cancelled: STATUS.PROTOCOL_ERROR,
  error: STATUS.PROTOCOL_ERROR,
});

/** 事件 phase 枚举。request/response/error 是 tools/call 的成对边界；其余为摘要类事件。 */
export const PHASE = Object.freeze({
  REQUEST: 'request',
  RESPONSE: 'response',
  ERROR: 'error',
  LIFECYCLE: 'gateway_lifecycle',
  INITIALIZE: 'initialize',
  TOOLS_LIST: 'tools_list',
  NOTIFICATION: 'notification',
  OTHER: 'other',
});

/** 规范 phase 值。 */
export const PHASE_VALUES = Object.freeze(Object.values(PHASE));

/** transport 取值（相关实现）。 */
export const TRANSPORT = Object.freeze({
  STDIO: 'stdio',
  STREAMABLE_HTTP: 'streamable-http',
  SSE: 'sse',
  UNKNOWN: 'unknown',
});

export const TRANSPORT_VALUES = Object.freeze(Object.values(TRANSPORT));

/**
 * 已知 MCP 协议版本（实测 @modelcontextprotocol/core@2.2.0 的 SUPPORTED_PROTOCOL_VERSIONS）。
 * 仅作参考/校验；schema 不限制该列取值（未知版本也必须能落库）。
 */
export const KNOWN_MCP_PROTOCOL_VERSIONS = Object.freeze([
  '2025-11-25',
  '2025-06-18',
  '2025-03-26',
  '2024-11-05',
  '2024-10-07',
]);

/**
 * 计划书 §4 要求「逐字覆盖」的最小字段集（17 项）。
 * 相关实现 给出每一项落在哪张表/哪一列，并有测试兜底（tests/store.test.js）。
 */
export const MINIMAL_FIELDS = Object.freeze([
  'event_id',
  'gateway_call_id',
  'experiment_run_id',
  'client_label',
  'gateway_id',
  'upstream_app',
  'tool_name',
  'phase',
  'timestamp_utc',
  'monotonic_duration_ms',
  'request_json',
  'response_json',
  'status',
  'error_kind',
  'protocol_version',
  'transport',
  'schema_version',
]);

/** 单个载荷默认存储上限（字节）；可用 --max-payload-bytes 覆盖。 */
export const DEFAULT_MAX_PAYLOAD_BYTES = 262144;

/** SQLite busy_timeout 默认值（毫秒），保证多进程并发写。 */
export const DEFAULT_BUSY_TIMEOUT_MS = 5000;

/** meta 表中「写入失败计数」的键名（CLI 用 trace stats 读出）。 */
export const META_WRITE_FAILURES = 'trace_write_failures';

/** meta 表中 schema 版本键名。 */
export const META_SCHEMA_VERSION = 'schema_version';

/**
 * @param {unknown} value
 * @returns {boolean}
 */
export function isSupportedSchemaVersion(value) {
  return typeof value === 'string' && SUPPORTED_SCHEMA_VERSIONS.includes(value);
}

/**
 * 把任意输入收敛到规范 status 枚举。
 * @param {unknown} value
 * @param {{strict?: boolean, onUnknown?: (value: unknown) => void}} [options]
 *   strict=true 时未知值抛 TypeError；否则归入 protocol_error 并通过 onUnknown 告警（不静默）。
 * @returns {string} 规范 status 值
 */
export function normalizeStatus(value, options = {}) {
  const { strict = false, onUnknown } = options;
  if (typeof value === 'string') {
    const raw = value.trim();
    if (STATUS_VALUES.includes(raw)) return raw;
    const lower = raw.toLowerCase();
    if (STATUS_VALUES.includes(lower)) return lower;
    if (Object.prototype.hasOwnProperty.call(STATUS_ALIASES, lower)) return STATUS_ALIASES[lower];
  }
  if (strict) {
    throw new TypeError(
      `未知 status: ${JSON.stringify(value)}；允许值为 ${STATUS_VALUES.join(' / ')}`,
    );
  }
  if (typeof onUnknown === 'function') onUnknown(value);
  return STATUS.PROTOCOL_ERROR;
}

/**
 * phase 归一化：未知 phase 在非严格模式下原样保留（phase 是开放集合，便于扩展），
 * 但必须是非空字符串。
 * @param {unknown} value
 * @param {{strict?: boolean}} [options]
 * @returns {string}
 */
export function normalizePhase(value, options = {}) {
  const { strict = false } = options;
  if (typeof value === 'string' && value.trim() !== '') return value.trim();
  if (strict) throw new TypeError(`phase 必须是非空字符串，实际为 ${JSON.stringify(value)}`);
  return PHASE.OTHER;
}
