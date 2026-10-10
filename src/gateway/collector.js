/**
 * src/gateway/collector.js — 采集写入层（S1）
 *
 * 职责：把「一次 tools/call」（请求 → 结果/异常）与「摘要事件 / 生命周期事件」
 * 变成 相关实现 定义的行，交给注入的存储（真实 `TraceStore` 或测试桩）。
 *
 * 关键约束：
 *   - 采集与转发**解耦**：任何写入失败只计数 + 写 stderr，绝不抛出、绝不中断转发；
 *   - 但**不丢事件**：request 事件在转发前写、response/error 事件在拿到结果后写，
 *     两者共用同一个 gateway_call_id；进程被杀导致的物理丢失只能在报告里如实说明；
 *   - `--trace-enabled=false` 时不留原始载荷，但仍记录字节数、digest 与结构摘要；
 *   - 时间一律 UTC ISO-8601 毫秒；耗时一律 performance.now() 差值。
 */
import {
  normalizePayload,
  normalizeToolResult,
  stableStringify,
  summarize,
  truncateString,
} from '../shared/json.js';
import { PHASE, SCHEMA_VERSION, STATUS } from '../shared/schemaversion.js';
import { newGatewayCallId } from '../shared/ids.js';
import { createTimer, nowUtcIso } from '../shared/time.js';
import { ERROR_KIND_BY_STATUS, summarizeViolations } from './classify.js';

/**
 * @typedef {object} CallCollectorOptions
 * @property {any} store 具备 insertCall/insertEvent 的存储（TraceStore 或桩）
 * @property {string} gatewayId
 * @property {string} upstreamApp
 * @property {string | null} [clientLabel]
 * @property {string | null} [experimentRunId]
 * @property {number} [maxPayloadBytes]
 * @property {boolean} [traceEnabled]
 * @property {string} [transport]
 * @property {(message: string) => void} [logger]
 */

export class CallCollector {
  /** @param {CallCollectorOptions} options */
  constructor(options) {
    if (!options || !options.store) throw new TypeError('CallCollector 需要注入 store');
    this.store = options.store;
    this.gatewayId = options.gatewayId;
    this.upstreamApp = options.upstreamApp;
    this.defaultClientLabel = options.clientLabel ?? null;
    this.defaultExperimentRunId = options.experimentRunId ?? null;
    this.attributionProvider = options.attributionProvider ?? (() => null);
    this.maxPayloadBytes = Number.isFinite(options.maxPayloadBytes) ? Number(options.maxPayloadBytes) : 262144;
    this.traceEnabled = options.traceEnabled !== false;
    this.transport = options.transport ?? 'stdio';
    /** 只写 stderr 的日志钩子（Gateway 的 stdout 必须保持纯净）。 */
    this.logger = typeof options.logger === 'function' ? options.logger : CallCollector.defaultLogger;
    this._writeFailures = 0;
    this._eventsWritten = 0;
    this._callsWritten = 0;
    this._clientProtocolVersion = null;
    this._upstreamProtocolVersion = null;
  }

  /** @param {string} message */
  static defaultLogger(message) {
    process.stderr.write(`${message}\n`);
  }

  get clientLabel() {
    return this.attributionProvider()?.clientLabel ?? this.defaultClientLabel;
  }

  get experimentRunId() {
    return this.attributionProvider()?.experimentRunId ?? this.defaultExperimentRunId;
  }

  /** 采集写入失败次数（转发不受影响）。 */
  get writeFailures() {
    return this._writeFailures;
  }

  /** 本进程写入的事件/调用行数（测试与 stderr 诊断用）。 */
  get stats() {
    return {
      events_written: this._eventsWritten,
      calls_written: this._callsWritten,
      write_failures: this._writeFailures,
      trace_enabled: this.traceEnabled,
    };
  }

  /** 客户端与会话协商出的 MCP 协议版本（写入 protocol_version 列）。 */
  get protocolVersion() {
    return this._clientProtocolVersion ?? this._upstreamProtocolVersion ?? null;
  }

  /** @param {string | null | undefined} value */
  setClientProtocolVersion(value) {
    if (typeof value === 'string' && value !== '') this._clientProtocolVersion = value;
  }

  /** @param {string | null | undefined} value */
  setUpstreamProtocolVersion(value) {
    if (typeof value === 'string' && value !== '') this._upstreamProtocolVersion = value;
  }

  /** @returns {string} 新的 gateway_call_id */
  newCallId() {
    return newGatewayCallId();
  }

  /**
   * @param {string} op
   * @param {unknown} error
   * @param {Record<string, unknown>} [context]
   */
  _logFailure(op, error, context = {}) {
    this._writeFailures += 1;
    const detail = error instanceof Error ? error.message : String(error);
    this.logger(
      `[gateway-collect] 采集写入失败 op=${op} gateway_id=${this.gatewayId} ${
        context.gateway_call_id ? `gateway_call_id=${context.gateway_call_id} ` : ''
      }error=${detail}`,
    );
  }

  /**
   * @param {string} op
   * @param {() => any} fn
   * @param {Record<string, unknown>} [context]
   * @returns {any | null}
   */
  _safeWrite(op, fn, context = {}) {
    try {
      const result = fn();
      if (result && typeof result === 'object' && result.ok === false) {
        this._logFailure(op, result.error ?? 'store returned ok:false', context);
        return null;
      }
      return result ?? null;
    } catch (error) {
      this._logFailure(op, error, context);
      return null;
    }
  }

  /**
   * 载荷归一化：截断、字节数、digest，以及 traceEnabled 开关。
   * @param {string | null | undefined} text
   * @returns {{json: string | null, truncated: boolean, byte_size: number, digest: string, omitted: boolean}}
   */
  _payload(text) {
    if (text === null || text === undefined) {
      return { json: null, truncated: false, byte_size: 0, digest: '', omitted: false };
    }
    const normalized = normalizePayload(text, { maxBytes: this.maxPayloadBytes });
    return {
      json: this.traceEnabled ? normalized.json : null,
      truncated: normalized.truncated,
      byte_size: normalized.byte_size,
      digest: normalized.digest,
      omitted: !this.traceEnabled,
    };
  }

  /**
   * 开始一次 tools/call：先落 calls 占位行，再落 phase=request 事件。
   * @param {{toolName: string, method?: string, rawRequestText: string, argumentsValue: unknown,
   *   inputSchema?: unknown, validation?: {checked: boolean, valid: boolean, violations: Array<any>}, gatewayCallId?: string}} params
   * @returns {{gateway_call_id: string, tool_name: string, timer: ReturnType<typeof createTimer>,
   *   started_at_utc: string, validation: any, rawRequestText: string}}
   */
  beginCall(params) {
    const gatewayCallId = params.gatewayCallId ?? this.newCallId();
    const timer = createTimer();
    const startedAtUtc = timer.start_utc;
    const validation = params.validation ?? { checked: false, valid: true, violations: [] };

    const callRow = {
      gateway_call_id: gatewayCallId,
      experiment_run_id: this.experimentRunId,
      client_label: this.clientLabel,
      gateway_id: this.gatewayId,
      upstream_app: this.upstreamApp,
      tool_name: params.toolName,
      method: params.method ?? 'tools/call',
      transport: this.transport,
      protocol_version: this.protocolVersion,
      schema_version: SCHEMA_VERSION,
      timestamp_utc: startedAtUtc,
      status: STATUS.OK,
    };
    const callResult = this._safeWrite('insert_call(request)', () => this.store.insertCall(callRow), {
      gateway_call_id: gatewayCallId,
    });
    if (callResult) this._callsWritten += 1;

    const payload = this._payload(params.rawRequestText);
    const summary = {
      direction: 'request',
      tool_name: params.toolName,
      method: params.method ?? 'tools/call',
      arguments_present: params.argumentsValue !== undefined && params.argumentsValue !== null,
      arguments_structure: summarize(params.argumentsValue ?? {}),
      validation: validation.checked
        ? { checked: true, valid: validation.valid, violations: summarizeViolations(validation.violations) }
        : { checked: false },
      payload: { byte_size: payload.byte_size, digest: payload.digest, truncated: payload.truncated, omitted: payload.omitted },
    };

    const eventResult = this._safeWrite(
      'insert_event(request)',
      () =>
        this.store.insertEvent({
          gateway_call_id: gatewayCallId,
          experiment_run_id: this.experimentRunId,
          client_label: this.clientLabel,
          gateway_id: this.gatewayId,
          upstream_app: this.upstreamApp,
          tool_name: params.toolName,
          method: params.method ?? 'tools/call',
          phase: PHASE.REQUEST,
          timestamp_utc: startedAtUtc,
          request_json: payload.json,
          summary_json: stableStringify(summary),
          truncated: payload.truncated ? 1 : 0,
          byte_size: payload.byte_size,
          status: STATUS.OK,
          protocol_version: this.protocolVersion,
          transport: this.transport,
          schema_version: SCHEMA_VERSION,
        }),
      { gateway_call_id: gatewayCallId },
    );
    if (eventResult) this._eventsWritten += 1;

    return {
      gateway_call_id: gatewayCallId,
      tool_name: params.toolName,
      timer,
      started_at_utc: startedAtUtc,
      validation,
      rawRequestText: params.rawRequestText,
    };
  }

  /**
   * 上游返回结果（成功或 isError 都走这里）。
   * @param {ReturnType<CallCollector['beginCall']>} record
   * @param {{result: unknown, rawResponseText: string, status: string, error_kind?: string | null,
   *   validation?: {checked: boolean, valid: boolean, violations: Array<any>}}} params
   * @returns {{status: string, gateway_call_id: string}}
   */
  endCallWithResult(record, params) {
    const durationMs = record.timer.ms();
    const endedAtUtc = nowUtcIso();
    const status = params.status ?? STATUS.OK;
    const errorKind = params.error_kind ?? ERROR_KIND_BY_STATUS[status] ?? null;
    const validation = params.validation ?? record.validation;
    const payload = this._payload(params.rawResponseText);
    const normalized = normalizeToolResult(params.result, { maxBytes: this.maxPayloadBytes });

    const summary = {
      direction: 'response',
      tool_name: record.tool_name,
      is_error: normalized.is_error,
      content_blocks: normalized.content_blocks,
      text_byte_size: normalized.text_byte_size,
      structured_content_byte_size: normalized.structured_content_byte_size,
      validation: validation.checked
        ? { checked: true, valid: validation.valid, violations: summarizeViolations(validation.violations) }
        : { checked: false },
      payload: { byte_size: payload.byte_size, digest: payload.digest, truncated: payload.truncated, omitted: payload.omitted },
    };
    if (normalized.text !== '') summary.text_preview = truncateString(normalized.text, 512);
    if (normalized.structured_content !== null && normalized.structured_content_byte_size <= this.maxPayloadBytes) {
      try {
        summary.structured_content = JSON.parse(normalized.structured_content);
      } catch {
        summary.structured_content_preview = truncateString(normalized.structured_content, 512);
      }
    }

    this._safeWrite(
      'insert_event(response)',
      () =>
        this.store.insertEvent({
          gateway_call_id: record.gateway_call_id,
          experiment_run_id: this.experimentRunId,
          client_label: this.clientLabel,
          gateway_id: this.gatewayId,
          upstream_app: this.upstreamApp,
          tool_name: record.tool_name,
          method: 'tools/call',
          phase: PHASE.RESPONSE,
          timestamp_utc: endedAtUtc,
          monotonic_duration_ms: durationMs,
          response_json: payload.json,
          summary_json: stableStringify(summary),
          truncated: payload.truncated ? 1 : 0,
          byte_size: payload.byte_size,
          status,
          error_kind: errorKind,
          protocol_version: this.protocolVersion,
          transport: this.transport,
          schema_version: SCHEMA_VERSION,
        }),
      { gateway_call_id: record.gateway_call_id },
    );

    this._safeWrite(
      'insert_call(result)',
      () =>
        this.store.insertCall({
          gateway_call_id: record.gateway_call_id,
          status,
          error_kind: errorKind,
          monotonic_duration_ms: durationMs,
          ended_at_utc: endedAtUtc,
          protocol_version: this.protocolVersion,
        }),
      { gateway_call_id: record.gateway_call_id },
    );

    this._eventsWritten += 1;
    this._callsWritten += 1;
    return { status, gateway_call_id: record.gateway_call_id };
  }

  /**
   * 上游异常/超时/传输死亡（没有可用结果）。
   * @param {ReturnType<CallCollector['beginCall']>} record
   * @param {{error: unknown, status: string, error_kind?: string | null, rawResponseText?: string | null,
   *   code?: number | null, message?: string, validation?: any}} params
   */
  endCallWithError(record, params) {
    const durationMs = record.timer.ms();
    const endedAtUtc = nowUtcIso();
    const status = params.status;
    const errorKind = params.error_kind ?? ERROR_KIND_BY_STATUS[status] ?? null;
    const validation = params.validation ?? record.validation;
    const payload = this._payload(params.rawResponseText ?? null);
    const message = params.message ?? (params.error instanceof Error ? params.error.message : String(params.error ?? ''));

    const summary = {
      direction: 'error',
      tool_name: record.tool_name,
      error: { status, error_kind: errorKind, code: params.code ?? null, message: truncateString(message, 1024) },
      validation: validation.checked
        ? { checked: true, valid: validation.valid, violations: summarizeViolations(validation.violations) }
        : { checked: false },
      payload: { byte_size: payload.byte_size, digest: payload.digest, truncated: payload.truncated, omitted: payload.omitted },
    };

    this._safeWrite(
      'insert_event(error)',
      () =>
        this.store.insertEvent({
          gateway_call_id: record.gateway_call_id,
          experiment_run_id: this.experimentRunId,
          client_label: this.clientLabel,
          gateway_id: this.gatewayId,
          upstream_app: this.upstreamApp,
          tool_name: record.tool_name,
          method: 'tools/call',
          phase: PHASE.ERROR,
          timestamp_utc: endedAtUtc,
          monotonic_duration_ms: durationMs,
          response_json: payload.json,
          summary_json: stableStringify(summary),
          truncated: payload.truncated ? 1 : 0,
          byte_size: payload.byte_size,
          status,
          error_kind: errorKind,
          protocol_version: this.protocolVersion,
          transport: this.transport,
          schema_version: SCHEMA_VERSION,
        }),
      { gateway_call_id: record.gateway_call_id },
    );

    this._safeWrite(
      'insert_call(error)',
      () =>
        this.store.insertCall({
          gateway_call_id: record.gateway_call_id,
          status,
          error_kind: errorKind,
          error_message: truncateString(message, 1024),
          monotonic_duration_ms: durationMs,
          ended_at_utc: endedAtUtc,
          protocol_version: this.protocolVersion,
        }),
      { gateway_call_id: record.gateway_call_id },
    );

    this._eventsWritten += 1;
    this._callsWritten += 1;
  }

  /**
   * 摘要事件：initialize / tools_list / notification / other 等非数据流判断的方法。
   * @param {{phase: string, method?: string | null, requestText?: string | null, responseText?: string | null,
   *   status?: string, errorKind?: string | null, durationMs?: number | null, gatewayCallId?: string | null,
   *   extra?: Record<string, unknown>}} params
   */
  recordSummary(params) {
    const status = params.status ?? STATUS.OK;
    const errorKind = params.errorKind ?? ERROR_KIND_BY_STATUS[status] ?? null;
    const requestPayload = this._payload(params.requestText ?? null);
    const responsePayload = this._payload(params.responseText ?? null);
    const summary = {
      direction: 'summary',
      phase: params.phase,
      method: params.method ?? null,
      ...(params.extra ?? {}),
      request_payload: {
        byte_size: requestPayload.byte_size,
        digest: requestPayload.digest,
        truncated: requestPayload.truncated,
        omitted: requestPayload.omitted,
      },
      response_payload: {
        byte_size: responsePayload.byte_size,
        digest: responsePayload.digest,
        truncated: responsePayload.truncated,
        omitted: responsePayload.omitted,
      },
    };

    const result = this._safeWrite(
      `insert_event(${params.phase})`,
      () =>
        this.store.insertEvent({
          gateway_call_id: params.gatewayCallId ?? null,
          experiment_run_id: this.experimentRunId,
          client_label: this.clientLabel,
          gateway_id: this.gatewayId,
          upstream_app: this.upstreamApp,
          tool_name: null,
          method: params.method ?? null,
          phase: params.phase,
          monotonic_duration_ms: params.durationMs ?? null,
          request_json: requestPayload.json,
          response_json: responsePayload.json,
          summary_json: stableStringify(summary),
          truncated: requestPayload.truncated || responsePayload.truncated ? 1 : 0,
          byte_size: requestPayload.byte_size + responsePayload.byte_size,
          status,
          error_kind: errorKind,
          protocol_version: this.protocolVersion,
          transport: this.transport,
          schema_version: SCHEMA_VERSION,
        }),
    );
    if (result) this._eventsWritten += 1;
    return result;
  }

  /**
   * 生命周期事件（上游启动/退出、Gateway 退出）。
   * @param {{event: string, status?: string, detail?: Record<string, unknown>, pid?: number | null,
   *   exitCode?: number | null, signalCode?: string | null, errorKind?: string | null}} params
   */
  recordLifecycle(params) {
    const status = params.status ?? STATUS.OK;
    const errorKind = params.errorKind ?? ERROR_KIND_BY_STATUS[status] ?? null;
    const detail = {
      event: params.event,
      gateway_id: this.gatewayId,
      upstream_app: this.upstreamApp,
      client_label: this.clientLabel,
      experiment_run_id: this.experimentRunId,
      pid: params.pid ?? null,
      exit_code: params.exitCode ?? null,
      signal_code: params.signalCode ?? null,
      ...(params.detail ?? {}),
    };
    const text = stableStringify(detail);
    const payload = this._payload(text);

    const result = this._safeWrite(
      `insert_event(lifecycle:${params.event})`,
      () =>
        this.store.insertEvent({
          gateway_call_id: null,
          experiment_run_id: this.experimentRunId,
          client_label: this.clientLabel,
          gateway_id: this.gatewayId,
          upstream_app: this.upstreamApp,
          tool_name: null,
          method: null,
          phase: PHASE.LIFECYCLE,
          response_json: payload.json,
          summary_json: stableStringify({ direction: 'lifecycle', ...detail, payload: { byte_size: payload.byte_size, digest: payload.digest, omitted: payload.omitted } }),
          byte_size: payload.byte_size,
          status,
          error_kind: errorKind,
          protocol_version: this.protocolVersion,
          transport: this.transport,
          schema_version: SCHEMA_VERSION,
        }),
    );
    if (result) this._eventsWritten += 1;
    return result;
  }
}
