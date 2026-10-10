/**
 * src/gateway/classify.js — 状态归类与参数预校验（S1）
 *
 * 六类 status（相关实现）在 Gateway 侧的判定入口：
 *
 * | status             | 判定条件                                                        |
 * |--------------------|-----------------------------------------------------------------|
 * | ok                 | 上游返回合法结果且 `isError !== true`                            |
 * | tool_iserror       | 上游返回合法结果但 `isError === true`，且**未**检出参数不合法     |
 * | validation_error   | ① 上游 JSON-RPC 错误码 = INVALID_PARAMS(-32602)；或 ② 上游返回   |
 * |                    | isError 且 Gateway 按工具 inputSchema 检出客户端参数不合法        |
 * | protocol_error     | 其他 JSON-RPC 错误码（-32700/-32600/-32601/其他）                |
 * | transport_error    | 无 JSON-RPC 错误码的异常：连接关闭/管道断开/上游不可用            |
 * | timeout            | 在 --timeout-ms 内未收到上游最终结果                             |
 *
 * 参数预校验是**只读观测**：绝不修改、绝不拦截转发（透明性要求），
 * 只在归类时用来把「客户端参数不合法」与「工具业务失败」区分开。
 * 只对能够确定的 JSON Schema 关键字报违规（required/type/enum/additionalProperties），
 * 无法判断时返回 `checked: false`，绝不凭猜测宣称参数非法。
 */

/** JSON-RPC 错误码（与 SDK 导出的常量一致）。 */
import { applicationBusinessError } from '../adapters/business_errors.js';

export const JSONRPC_ERROR_CODES = Object.freeze({
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
});

/** Gateway 自产错误的 JSON-RPC 错误码（-32000..-32099 为 server error 保留段）。
 *  注意：-32002 会被本 SDK 当作「resource not found」的旧码并改写为 -32602（实测），
 *  所以超时用 -32011，避免与资源语义冲突。 */
export const GATEWAY_ERROR_CODES = Object.freeze({
  UPSTREAM_UNAVAILABLE: -32001,
  UPSTREAM_TIMEOUT: -32011,
});

/** status → error_kind 的对应（相关实现）。 */
export const ERROR_KIND_BY_STATUS = Object.freeze({
  ok: null,
  tool_iserror: 'iserror',
  protocol_error: 'protocol',
  transport_error: 'transport',
  timeout: 'timeout',
  validation_error: 'validation',
});

export const STATUS = Object.freeze({
  OK: 'ok',
  TOOL_ISERROR: 'tool_iserror',
  PROTOCOL_ERROR: 'protocol_error',
  TRANSPORT_ERROR: 'transport_error',
  TIMEOUT: 'timeout',
  VALIDATION_ERROR: 'validation_error',
});

const TRANSPORT_HINTS =
  /connection closed|not connected|epipe|econnreset|econnrefused|broken pipe|transport|socket|stream|aborted|disposed|closed|killed|terminated|eperm|enoent/i;

/**
 * @param {unknown} error
 * @returns {number | null} JSON-RPC 错误码（不存在则为 null）
 */
export function errorCodeOf(error) {
  if (error && typeof error === 'object' && typeof (/** @type {any} */ (error).code) === 'number') {
    return /** @type {any} */ (error).code;
  }
  return null;
}

/**
 * 上游异常 → {status, error_kind}。
 * @param {unknown} error
 * @param {{violations?: Array<Record<string, unknown>> | null, timeout?: boolean, unavailable?: boolean}} [context]
 * @returns {{status: string, error_kind: string | null, code: number | null, message: string, is_jsonrpc_error: boolean}}
 */
export function classifyUpstreamError(error, context = {}) {
  if (context.timeout === true) {
    return {
      status: STATUS.TIMEOUT,
      error_kind: ERROR_KIND_BY_STATUS.timeout,
      code: GATEWAY_ERROR_CODES.UPSTREAM_TIMEOUT,
      message: error instanceof Error ? error.message : String(error),
      is_jsonrpc_error: false,
    };
  }

  if (context.unavailable === true) {
    return {
      status: STATUS.TRANSPORT_ERROR,
      error_kind: ERROR_KIND_BY_STATUS.transport_error,
      code: GATEWAY_ERROR_CODES.UPSTREAM_UNAVAILABLE,
      message: error instanceof Error ? error.message : String(error),
      is_jsonrpc_error: false,
    };
  }

  const code = errorCodeOf(error);
  const message = error instanceof Error ? error.message : String(error);
  const violations = Array.isArray(context.violations) ? context.violations : null;

  if (code !== null) {
    if (code === JSONRPC_ERROR_CODES.INVALID_PARAMS && violations && violations.length > 0) {
      // 已知工具 + 参数确实不满足其 inputSchema → 客户端侧参数不合法
      return {
        status: STATUS.VALIDATION_ERROR,
        error_kind: ERROR_KIND_BY_STATUS.validation_error,
        code,
        message,
        is_jsonrpc_error: true,
      };
    }
    if (code === JSONRPC_ERROR_CODES.INVALID_PARAMS) {
      // 参数错误但无法确认是客户端参数问题（例如未知工具/未知资源）→ 协议错误
      return {
        status: STATUS.PROTOCOL_ERROR,
        error_kind: ERROR_KIND_BY_STATUS.protocol_error,
        code,
        message,
        is_jsonrpc_error: true,
      };
    }
    if (isTransportLikeError(error)) {
      // 例：连接被关闭（SDK 用 -32000 段表示连接级失败）→ 传输错误
      return {
        status: STATUS.TRANSPORT_ERROR,
        error_kind: ERROR_KIND_BY_STATUS.transport_error,
        code,
        message,
        is_jsonrpc_error: false,
      };
    }
    return {
      status: STATUS.PROTOCOL_ERROR,
      error_kind: ERROR_KIND_BY_STATUS.protocol_error,
      code,
      message,
      is_jsonrpc_error: true,
    };
  }

  // 无 JSON-RPC 错误码：连接/进程/管道层面的问题（含 SDK 的 ConnectionClosed）
  return {
    status: STATUS.TRANSPORT_ERROR,
    error_kind: ERROR_KIND_BY_STATUS.transport_error,
    code: null,
    message,
    is_jsonrpc_error: false,
  };
}

/**
 * 是否像「连接/进程/管道」层面的失败（用于把连接关闭类错误与协议错误区分开）。
 * @param {unknown} error
 * @returns {boolean}
 */
export function isTransportLikeError(error) {
  const message = error instanceof Error ? error.message : String(error ?? '');
  const name = error instanceof Error ? error.name : '';
  return TRANSPORT_HINTS.test(`${name} ${message}`);
}

/**
 * 上游「返回了结果」时的状态判定。
 * @param {{isError?: boolean}} result
 * @param {{violations?: Array<Record<string, unknown>> | null}} [context]
 * @returns {{status: string, error_kind: string | null}}
 */
export function classifyToolResult(result, context = {}) {
  const violations = Array.isArray(context.violations) ? context.violations : null;
  if ((result && /** @type {any} */ (result).isError === true) || applicationBusinessError(result, context.upstreamApp)) {
    if (violations && violations.length > 0) {
      return { status: STATUS.VALIDATION_ERROR, error_kind: ERROR_KIND_BY_STATUS.validation_error };
    }
    return { status: STATUS.TOOL_ISERROR, error_kind: ERROR_KIND_BY_STATUS.tool_iserror };
  }
  return { status: STATUS.OK, error_kind: null };
}

/**
 * @param {unknown} value
 * @returns {boolean}
 */
function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * @param {unknown} type
 * @param {unknown} value
 * @returns {boolean | null} null = 无法判断
 */
function matchesType(type, value) {
  switch (type) {
    case 'object':
      return isPlainObject(value);
    case 'array':
      return Array.isArray(value);
    case 'string':
      return typeof value === 'string';
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'integer':
      return Number.isInteger(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'null':
      return value === null;
    default:
      return null;
  }
}

/**
 * @param {unknown} a
 * @param {unknown} b
 * @returns {boolean}
 */
function jsonEquals(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return false;
  if (typeof a === 'object') {
    try {
      return JSON.stringify(a) === JSON.stringify(b);
    } catch {
      return false;
    }
  }
  return false;
}

const SCHEMA_MAX_DEPTH = 8;
/** 只对能确定的关键字报违规；其余（oneOf/anyOf/pattern/format…）一律跳过。 */
const SUPPORTED_TYPES = new Set(['object', 'array', 'string', 'number', 'integer', 'boolean', 'null']);

/**
 * 宽松参数预校验（只读观测）。
 * @param {unknown} inputSchema 工具声明的 JSON Schema
 * @param {unknown} args 客户端传入的 arguments
 * @returns {{checked: boolean, valid: boolean, violations: Array<{path: string, keyword: string, detail: string}>}}
 */
export function validateArgumentsLoose(inputSchema, args) {
  /** @type {Array<{path: string, keyword: string, detail: string}>} */
  const violations = [];

  if (!isPlainObject(inputSchema) || Object.keys(inputSchema).length === 0) {
    return { checked: false, valid: true, violations };
  }

  /**
   * @param {any} schema
   * @param {unknown} value
   * @param {string} path
   * @param {number} depth
   */
  function walk(schema, value, path, depth) {
    if (depth > SCHEMA_MAX_DEPTH || !isPlainObject(schema)) return;

    if (Array.isArray(schema.type)) {
      const results = schema.type.map((t) => matchesType(t, value)).filter((r) => r !== null);
      if (results.length > 0 && !results.some(Boolean)) {
        violations.push({ path, keyword: 'type', detail: `期望 ${schema.type.join('|')}` });
      }
    } else if (typeof schema.type === 'string' && SUPPORTED_TYPES.has(schema.type)) {
      const ok = matchesType(schema.type, value);
      if (ok === false) {
        violations.push({ path, keyword: 'type', detail: `期望 ${schema.type}` });
        return;
      }
    }

    if (Array.isArray(schema.enum) && schema.enum.length > 0) {
      if (!schema.enum.some((candidate) => jsonEquals(candidate, value))) {
        violations.push({ path, keyword: 'enum', detail: `不在枚举值内` });
      }
    }

    if (schema.type === 'object' || isPlainObject(schema.properties) || Array.isArray(schema.required)) {
      const objectValue = isPlainObject(value) ? value : undefined;
      if (objectValue !== undefined) {
        for (const requiredKey of Array.isArray(schema.required) ? schema.required : []) {
          if (!Object.prototype.hasOwnProperty.call(objectValue, requiredKey)) {
            violations.push({
              path: path === '' ? requiredKey : `${path}.${requiredKey}`,
              keyword: 'required',
              detail: '缺少必填字段',
            });
          }
        }
        if (isPlainObject(schema.properties)) {
          for (const [key, childSchema] of Object.entries(schema.properties)) {
            if (Object.prototype.hasOwnProperty.call(objectValue, key)) {
              walk(childSchema, objectValue[key], path === '' ? key : `${path}.${key}`, depth + 1);
            }
          }
        }
        if (schema.additionalProperties === false && isPlainObject(schema.properties)) {
          for (const key of Object.keys(objectValue)) {
            if (!Object.prototype.hasOwnProperty.call(schema.properties, key)) {
              violations.push({
                path: path === '' ? key : `${path}.${key}`,
                keyword: 'additionalProperties',
                detail: 'schema 未声明的字段',
              });
            }
          }
        }
      }
    }
  }

  walk(inputSchema, args === undefined ? {} : args, '', 0);
  return { checked: true, valid: violations.length === 0, violations };
}

/**
 * 违规列表 → 简短摘要（写入 summary_json）。
 * @param {Array<{path: string, keyword: string, detail: string}>} violations
 * @returns {Array<{path: string, keyword: string, detail: string}>}
 */
export function summarizeViolations(violations) {
  return violations.slice(0, 20);
}
