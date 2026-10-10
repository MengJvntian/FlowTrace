/**
 * src/collector/store.js — SQLite 事件库（F1）
 *
 * 唯一真源：`相关实现`。本文件实现其中 runs / calls / events 三张表的读写。
 *
 * 设计要点：
 *   - `node:sqlite` 的 DatabaseSync（同步 API），WAL + busy_timeout + 写重试，
 *     保证**两个 Gateway 进程并发写同一个 db 不丢事件**；
 *   - 所有写入走 `_safeWrite()`：**失败绝不静默** —— stderr 告警 + 进程内计数 +
 *     持久化到 meta 表（键 `trace_write_failures`，CLI `trace stats` 可读出）；
 *   - upsert 使用 `COALESCE(?, 表.列)` 的单语句「补丁式」语义：
 *     calls 行的生命周期是「先写 request，再补 response」，后写只覆盖显式传入的列；
 *   - 返回的行对象使用**数据库原生 snake_case 列名**，与 相关实现 逐字一致。
 */
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { newEventId, newGatewayCallId } from '../shared/ids.js';
import { normalizePayload, parseJsonSafe, stableStringify, truncateString } from '../shared/json.js';
import {
  DEFAULT_BUSY_TIMEOUT_MS,
  DEFAULT_MAX_PAYLOAD_BYTES,
  META_SCHEMA_VERSION,
  META_WRITE_FAILURES,
  SCHEMA_VERSION,
  normalizePhase,
  normalizeStatus,
} from '../shared/schemaversion.js';
import { nowUtcIso, toUtcIso } from '../shared/time.js';

/** 当前 DDL 版本（PRAGMA user_version）。 */
export const DDL_VERSION = 1;

const DDL = [
  `CREATE TABLE IF NOT EXISTS meta (
     key TEXT PRIMARY KEY,
     value TEXT,
     updated_at_utc TEXT NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS runs (
     run_id TEXT PRIMARY KEY,
     experiment_run_id TEXT NOT NULL UNIQUE,
     client_label TEXT,
     started_at_utc TEXT NOT NULL,
     ended_at_utc TEXT,
     notes TEXT,
     schema_version TEXT NOT NULL,
     created_at_utc TEXT NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS idx_runs_experiment_run_id ON runs(experiment_run_id)`,
  `CREATE INDEX IF NOT EXISTS idx_runs_client_label ON runs(client_label)`,
  `CREATE TABLE IF NOT EXISTS calls (
     gateway_call_id TEXT PRIMARY KEY,
     run_id TEXT,
     experiment_run_id TEXT,
     client_label TEXT,
     gateway_id TEXT,
     upstream_app TEXT,
     tool_name TEXT,
     method TEXT NOT NULL DEFAULT 'tools/call',
     timestamp_utc TEXT NOT NULL,
     started_at_utc TEXT NOT NULL,
     ended_at_utc TEXT,
     monotonic_duration_ms REAL,
     status TEXT NOT NULL,
     error_kind TEXT,
     error_message TEXT,
     protocol_version TEXT,
     transport TEXT,
     schema_version TEXT NOT NULL,
     created_at_utc TEXT NOT NULL,
     updated_at_utc TEXT NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS idx_calls_run_id ON calls(run_id)`,
  `CREATE INDEX IF NOT EXISTS idx_calls_experiment_run_id ON calls(experiment_run_id)`,
  `CREATE INDEX IF NOT EXISTS idx_calls_gateway_id ON calls(gateway_id)`,
  `CREATE INDEX IF NOT EXISTS idx_calls_timestamp ON calls(timestamp_utc)`,
  `CREATE TABLE IF NOT EXISTS events (
     event_id TEXT PRIMARY KEY,
     gateway_call_id TEXT,
     run_id TEXT,
     experiment_run_id TEXT,
     client_label TEXT,
     gateway_id TEXT,
     upstream_app TEXT,
     tool_name TEXT,
     method TEXT,
     phase TEXT NOT NULL,
     timestamp_utc TEXT NOT NULL,
     monotonic_duration_ms REAL,
     request_json TEXT,
     response_json TEXT,
     summary_json TEXT,
     truncated INTEGER NOT NULL DEFAULT 0,
     byte_size INTEGER NOT NULL DEFAULT 0,
     status TEXT NOT NULL,
     error_kind TEXT,
     protocol_version TEXT,
     transport TEXT,
     schema_version TEXT NOT NULL,
     created_at_utc TEXT NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS idx_events_gateway_call_id ON events(gateway_call_id)`,
  `CREATE INDEX IF NOT EXISTS idx_events_run_id ON events(run_id)`,
  `CREATE INDEX IF NOT EXISTS idx_events_experiment_run_id ON events(experiment_run_id)`,
  `CREATE INDEX IF NOT EXISTS idx_events_phase ON events(phase)`,
  `CREATE INDEX IF NOT EXISTS idx_events_timestamp ON events(timestamp_utc)`,
  `CREATE INDEX IF NOT EXISTS idx_events_run_timestamp ON events(run_id, timestamp_utc)`,
];

/**
 * 列定义表：`insertSql` 是 VALUES 中的占位表达式（可带默认值），
 * `noUpdate` 表示冲突时保留原值（不进入 DO UPDATE SET）。
 * 未给出 `updateSql` 的列统一使用 `COALESCE(?, 表.列)`（补丁语义：null 不覆盖）。
 */
const CALL_FIELDS = [
  { col: 'gateway_call_id', insertSql: '?', noUpdate: true },
  { col: 'run_id' },
  { col: 'experiment_run_id' },
  { col: 'client_label' },
  { col: 'gateway_id' },
  { col: 'upstream_app' },
  { col: 'tool_name' },
  { col: 'method', insertSql: "COALESCE(?, 'tools/call')" },
  { col: 'timestamp_utc', insertSql: '?', noUpdate: true },
  { col: 'started_at_utc', insertSql: '?', noUpdate: true },
  { col: 'ended_at_utc' },
  { col: 'monotonic_duration_ms' },
  { col: 'status', insertSql: "COALESCE(?, 'ok')" },
  { col: 'error_kind' },
  { col: 'error_message' },
  { col: 'protocol_version' },
  { col: 'transport' },
  { col: 'schema_version', insertSql: '?' },
  { col: 'created_at_utc', insertSql: '?', noUpdate: true },
  { col: 'updated_at_utc', insertSql: '?' },
];

const EVENT_FIELDS = [
  { col: 'event_id', insertSql: '?', noUpdate: true },
  { col: 'gateway_call_id' },
  { col: 'run_id' },
  { col: 'experiment_run_id' },
  { col: 'client_label' },
  { col: 'gateway_id' },
  { col: 'upstream_app' },
  { col: 'tool_name' },
  { col: 'method' },
  { col: 'phase', insertSql: '?' },
  { col: 'timestamp_utc', insertSql: '?', noUpdate: true },
  { col: 'monotonic_duration_ms' },
  { col: 'request_json' },
  { col: 'response_json' },
  { col: 'summary_json' },
  { col: 'truncated', insertSql: 'COALESCE(?, 0)' },
  { col: 'byte_size', insertSql: 'COALESCE(?, 0)' },
  { col: 'status', insertSql: "COALESCE(?, 'ok')" },
  { col: 'error_kind' },
  { col: 'protocol_version' },
  { col: 'transport' },
  { col: 'schema_version', insertSql: '?' },
  { col: 'created_at_utc', insertSql: '?', noUpdate: true },
];

const RUN_FIELDS = [
  { col: 'run_id', insertSql: '?', noUpdate: true },
  { col: 'experiment_run_id', insertSql: '?' },
  { col: 'client_label' },
  { col: 'started_at_utc', insertSql: '?', noUpdate: true },
  { col: 'ended_at_utc' },
  { col: 'notes' },
  { col: 'schema_version', insertSql: '?' },
  { col: 'created_at_utc', insertSql: '?', noUpdate: true },
];

/** 规范化列名 → 允许的 camelCase 别名。 */
const ALIASES = Object.freeze({
  gateway_call_id: 'gatewayCallId',
  run_id: 'runId',
  experiment_run_id: 'experimentRunId',
  client_label: 'clientLabel',
  gateway_id: 'gatewayId',
  upstream_app: 'upstreamApp',
  tool_name: 'toolName',
  timestamp_utc: 'timestampUtc',
  started_at_utc: 'startedAtUtc',
  ended_at_utc: 'endedAtUtc',
  monotonic_duration_ms: 'monotonicDurationMs',
  error_kind: 'errorKind',
  error_message: 'errorMessage',
  protocol_version: 'protocolVersion',
  schema_version: 'schemaVersion',
  created_at_utc: 'createdAtUtc',
  updated_at_utc: 'updatedAtUtc',
  event_id: 'eventId',
  request_json: 'requestJson',
  response_json: 'responseJson',
  summary_json: 'summaryJson',
  byte_size: 'byteSize',
  request: 'request',
  response: 'response',
});

/**
 * @param {unknown} value
 * @returns {string | number | bigint | null | Uint8Array}
 */
function toSqlValue(value) {
  if (value === undefined || value === null) return null;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' || typeof value === 'bigint') return value;
  if (value instanceof Uint8Array) return value;
  if (Date.prototype.isPrototypeOf(value)) return nowUtcIso(/** @type {Date} */ (value));
  return stableStringify(value);
}

/**
 * @param {Record<string, any>} input
 * @param {string} col 规范列名
 * @returns {unknown}
 */
function pick(input, col) {
  if (input === undefined || input === null) return undefined;
  if (Object.prototype.hasOwnProperty.call(input, col) && input[col] !== undefined) return input[col];
  const alias = ALIASES[col];
  if (alias && Object.prototype.hasOwnProperty.call(input, alias) && input[alias] !== undefined) {
    return input[alias];
  }
  return undefined;
}

/**
 * 生成补丁式 upsert SQL。
 * @param {string} table
 * @param {string} keyColumn
 * @param {Array<{col: string, insertSql?: string, noUpdate?: boolean}>} fields
 */
function buildUpsert(table, keyColumn, fields) {
  const columns = fields.map((f) => f.col);
  const placeholders = fields.map((f) => f.insertSql ?? '?');
  const updates = fields
    .filter((f) => f.col !== keyColumn && !f.noUpdate)
    .map((f) => `${f.col} = COALESCE(?, ${table}.${f.col})`);
  const sql =
    `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${placeholders.join(', ')}) ` +
    `ON CONFLICT(${keyColumn}) DO UPDATE SET ${updates.join(', ')}`;
  return sql;
}

const CALL_UPSERT_SQL = buildUpsert('calls', 'gateway_call_id', CALL_FIELDS);
const EVENT_UPSERT_SQL = buildUpsert('events', 'event_id', EVENT_FIELDS);
const RUN_UPSERT_SQL = buildUpsert('runs', 'run_id', RUN_FIELDS);

/**
 * @param {string} table
 * @param {string} keyColumn
 * @param {Array<{col: string, insertSql?: string, noUpdate?: boolean}>} fields
 * @param {Record<string, unknown>} values 已归一化的列值
 * @returns {Array<string|number|bigint|null|Uint8Array>}
 */
function buildUpsertParams(table, keyColumn, fields, values) {
  const params = [];
  for (const f of fields) params.push(toSqlValue(values[f.col]));
  for (const f of fields) {
    if (f.col === keyColumn || f.noUpdate) continue;
    params.push(toSqlValue(values[f.col]));
  }
  return params;
}

const sleepArray = new Int32Array(new SharedArrayBuffer(4));

/**
 * 同步 sleep（SQLITE_BUSY 重试用）。Node 主线程允许 Atomics.wait。
 * @param {number} ms
 */
function sleepSync(ms) {
  Atomics.wait(sleepArray, 0, 0, ms);
}

/**
 * @param {unknown} error
 * @returns {boolean} 是否属于「可重试的锁竞争」
 */
function isBusyError(error) {
  const message = error instanceof Error ? error.message : String(error);
  return /SQLITE_BUSY|SQLITE_LOCKED|database is locked|database table is locked/i.test(message);
}

const RETRYABLE_ATTEMPTS = 6;

/**
 * @param {number} attempt 0-based
 * @returns {number} 毫秒
 */
function retryDelayMs(attempt) {
  return 25 * (attempt + 1);
}

/**
 * 载荷归一化：接受字符串、任意 JSON 值，或 json.js 的归一化结果对象。
 * @param {unknown} value
 * @param {number} maxBytes
 * @returns {{json: string|null, truncated: boolean, byte_size: number, summary: unknown, is_normalized: boolean}}
 */
function coercePayload(value, maxBytes) {
  if (value === undefined || value === null) {
    return { json: null, truncated: false, byte_size: 0, summary: null, is_normalized: false };
  }
  if (typeof value === 'string') {
    const bytes = Buffer.byteLength(value, 'utf8');
    return { json: value, truncated: false, byte_size: bytes, summary: null, is_normalized: false };
  }
  if (typeof value === 'object' && Object.prototype.hasOwnProperty.call(value, 'json')) {
    // json.js normalizePayload / normalizeToolResult 的结果对象
    const normalized = /** @type {Record<string, any>} */ (value);
    return {
      json: normalized.json === undefined ? null : normalized.json,
      truncated: normalized.truncated === true,
      byte_size: Number.isFinite(normalized.byte_size) ? Number(normalized.byte_size) : 0,
      summary: normalized,
      is_normalized: true,
    };
  }
  const normalized = normalizePayload(value, { maxBytes });
  return {
    json: normalized.json,
    truncated: normalized.truncated,
    byte_size: normalized.byte_size,
    summary: normalized.summary,
    is_normalized: false,
  };
}

/**
 * 把（可能被截断的）工具结果归一化结果压缩成有界的 summary_json。
 * @param {Record<string, any>} normalized
 * @param {number} maxBytes
 * @returns {Record<string, unknown>}
 */
function toolResultSummary(normalized, maxBytes) {
  /** @type {Record<string, unknown>} */
  const summary = {};
  if (normalized.summary) summary.structure = normalized.summary;
  if (typeof normalized.text === 'string' && normalized.text !== '') {
    summary.text_preview = truncateString(normalized.text, 512);
    summary.text_byte_size = normalized.text_byte_size ?? Buffer.byteLength(normalized.text, 'utf8');
  }
  if (typeof normalized.structured_content === 'string' && normalized.structured_content !== '') {
    summary.structured_content_byte_size =
      normalized.structured_content_byte_size ?? Buffer.byteLength(normalized.structured_content, 'utf8');
    if (summary.structured_content_byte_size <= maxBytes) {
      const parsed = parseJsonSafe(normalized.structured_content);
      summary.structured_content = parsed.ok ? parsed.value : truncateString(normalized.structured_content, 512);
    } else {
      summary.structured_content = truncateString(normalized.structured_content, 512);
    }
  }
  if (Array.isArray(normalized.content_blocks) && normalized.content_blocks.length > 0) {
    summary.content_blocks = normalized.content_blocks;
  }
  if (normalized.is_error === true) summary.is_error = true;
  if (normalized.truncated === true) summary.truncated = true;
  return summary;
}

/**
 * @typedef {object} TraceStoreOptions
 * @property {number} [busyTimeoutMs]
 * @property {number} [maxPayloadBytes]
 * @property {(message: string, error: unknown) => void} [logFailure] 写入失败告警钩子（默认 stderr）
 * @property {boolean} [autoInit] 构造时立即建表（默认 true）
 */

export class TraceStore {
  /**
   * @param {string} dbPath 数据库文件路径，或 ':memory:'
   * @param {DatabaseSync} db
   * @param {TraceStoreOptions} [options]
   */
  constructor(dbPath, db, options = {}) {
    this.dbPath = dbPath;
    this.db = db;
    this.busyTimeoutMs = Number.isFinite(options.busyTimeoutMs)
      ? Number(options.busyTimeoutMs)
      : DEFAULT_BUSY_TIMEOUT_MS;
    this.maxPayloadBytes = Number.isFinite(options.maxPayloadBytes)
      ? Number(options.maxPayloadBytes)
      : DEFAULT_MAX_PAYLOAD_BYTES;
    this.logFailure = typeof options.logFailure === 'function' ? options.logFailure : TraceStore.defaultLogFailure;
    this._writeFailures = 0;
    this._closed = false;
    this._inTransaction = 0;
    if (options.autoInit !== false) this.init();
  }

  /**
   * @param {string} message
   * @param {unknown} error
   */
  static defaultLogFailure(message, error) {
    const detail = error instanceof Error ? error.stack ?? error.message : String(error);
    process.stderr.write(`[trace-write-failure] ${message}\n${detail}\n`);
  }

  /** 本进程内累计的写入失败次数。 */
  get writeFailures() {
    return this._writeFailures;
  }

  /**
   * 建库/迁移；幂等：可重复调用（同一实例或新进程均安全）。
   * @returns {TraceStore}
   */
  init() {
    const started = Date.now();
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec(`PRAGMA busy_timeout = ${Math.max(0, Math.trunc(this.busyTimeoutMs))}`);
    this.db.exec('PRAGMA synchronous = NORMAL');
    this.db.exec(`PRAGMA user_version = ${DDL_VERSION}`);
    for (const statement of DDL) this.db.exec(statement);
    const now = nowUtcIso();
    this.db
      .prepare(
        `INSERT INTO meta (key, value, updated_at_utc) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at_utc = excluded.updated_at_utc`,
      )
      .run(META_SCHEMA_VERSION, SCHEMA_VERSION, now);
    this._initMs = Date.now() - started;
    return this;
  }

  /**
   * 写入失败统一出口：计数 + 告警 + 持久化计数（尽力而为）。
   * @param {string} op
   * @param {unknown} error
   * @returns {{ok: false, op: string, error: string}}
   */
  _handleWriteFailure(op, error) {
    this._writeFailures += 1;
    const message = error instanceof Error ? error.message : String(error);
    this.logFailure(`op=${op} db=${this.dbPath} error=${message}`, error);
    try {
      this.db
        .prepare(
          `INSERT INTO meta (key, value, updated_at_utc) VALUES (?, '1', ?)
           ON CONFLICT(key) DO UPDATE SET
             value = CAST(CAST(COALESCE(meta.value, '0') AS INTEGER) + 1 AS TEXT),
             updated_at_utc = excluded.updated_at_utc`,
        )
        .run(META_WRITE_FAILURES, nowUtcIso());
    } catch (metaError) {
      this.logFailure(`op=persist_write_failure_counter db=${this.dbPath}`, metaError);
    }
    return { ok: false, op, error: message };
  }

  /**
   * 执行一次写入：带 SQLITE_BUSY 重试；任何异常都不静默。
   * 成功时原样返回 `fn()` 的结果（形如 `{ok: true, ...}`）；失败时返回 `{ok: false, op, error}`。
   * @template {{ok: true}} T
   * @param {string} op
   * @param {() => T} fn
   * @returns {T | {ok: false, op: string, error: string}}
   */
  _safeWrite(op, fn) {
    let lastError;
    for (let attempt = 0; attempt < RETRYABLE_ATTEMPTS; attempt += 1) {
      try {
        return fn();
      } catch (error) {
        lastError = error;
        if (!isBusyError(error)) break;
        if (attempt < RETRYABLE_ATTEMPTS - 1) sleepSync(retryDelayMs(attempt));
      }
    }
    this._handleWriteFailure(op, lastError);
    return { ok: false, op, error: lastError instanceof Error ? lastError.message : String(lastError) };
  }

  /**
   * 在一个 IMMEDIATE 事务中执行 fn（已在外层事务中则直接执行）。
   * @template T
   * @param {() => T} fn
   * @returns {T}
   */
  withTransaction(fn) {
    if (this._inTransaction > 0) return fn();
    this.db.exec('BEGIN IMMEDIATE');
    this._inTransaction += 1;
    try {
      const result = fn();
      this._inTransaction -= 1;
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this._inTransaction -= 1;
      try {
        this.db.exec('ROLLBACK');
      } catch (rollbackError) {
        this.logFailure(`op=rollback db=${this.dbPath}`, rollbackError);
      }
      throw error;
    }
  }

  /**
   * 写入/更新一次调用记录（补丁语义：未传的列保持原值）。
   * @param {Record<string, any>} call
   * @returns {{ok: true, gateway_call_id: string} | {ok: false, op: string, error: string}}
   */
  insertCall(call) {
    if (call === null || typeof call !== 'object') {
      throw new TypeError('insertCall(call) 需要一个对象');
    }
    const gatewayCallId = pick(call, 'gateway_call_id') ?? newGatewayCallId();
    if (typeof gatewayCallId !== 'string' || gatewayCallId === '') {
      throw new TypeError('insertCall: gateway_call_id 必须是非空字符串');
    }
    const now = nowUtcIso();
    const timestampUtc = pick(call, 'timestamp_utc');
    const startedAtUtc = pick(call, 'started_at_utc');
    const statusInput = pick(call, 'status');
    if (statusInput !== undefined && statusInput !== null) {
      // 未知 status 会归入 protocol_error 并告警（不静默）
      normalizeStatus(statusInput, {
        onUnknown: (value) =>
          this.logFailure(`op=insert_call status_unknown value=${JSON.stringify(value)}`, new TypeError('unknown status')),
      });
    }
    const values = {
      gateway_call_id: gatewayCallId,
      run_id: pick(call, 'run_id') ?? null,
      experiment_run_id: pick(call, 'experiment_run_id') ?? null,
      client_label: pick(call, 'client_label') ?? null,
      gateway_id: pick(call, 'gateway_id') ?? null,
      upstream_app: pick(call, 'upstream_app') ?? null,
      tool_name: pick(call, 'tool_name') ?? null,
      method: pick(call, 'method') ?? null,
      timestamp_utc: timestampUtc === undefined ? now : toUtcIso(timestampUtc),
      started_at_utc:
        startedAtUtc === undefined
          ? timestampUtc === undefined
            ? now
            : toUtcIso(timestampUtc)
          : toUtcIso(startedAtUtc),
      ended_at_utc: pick(call, 'ended_at_utc') === undefined ? null : toUtcIso(pick(call, 'ended_at_utc')),
      monotonic_duration_ms:
        pick(call, 'monotonic_duration_ms') === undefined ? null : Number(pick(call, 'monotonic_duration_ms')),
      status: statusInput === undefined ? null : normalizeStatus(statusInput),
      error_kind: pick(call, 'error_kind') ?? null,
      error_message: pick(call, 'error_message') ?? null,
      protocol_version: pick(call, 'protocol_version') ?? null,
      transport: pick(call, 'transport') ?? null,
      schema_version: pick(call, 'schema_version') ?? SCHEMA_VERSION,
      created_at_utc: now,
      updated_at_utc: now,
    };
    const params = buildUpsertParams('calls', 'gateway_call_id', CALL_FIELDS, values);
    return this._safeWrite('insert_call', () => {
      this.withTransaction(() => this.db.prepare(CALL_UPSERT_SQL).run(...params));
      return { ok: true, gateway_call_id: gatewayCallId };
    });
  }

  /**
   * 追加一条事件。载荷可以是原始字符串、任意 JSON 值，或 json.js 的归一化结果。
   * @param {Record<string, any>} event
   * @returns {{ok: true, event_id: string} | {ok: false, op: string, error: string}}
   */
  insertEvent(event) {
    if (event === null || typeof event !== 'object') {
      throw new TypeError('insertEvent(event) 需要一个对象');
    }
    const eventId = pick(event, 'event_id') ?? newEventId();
    if (typeof eventId !== 'string' || eventId === '') {
      throw new TypeError('insertEvent: event_id 必须是非空字符串');
    }
    const now = nowUtcIso();
    const timestampUtc = pick(event, 'timestamp_utc');
    const statusInput = pick(event, 'status');
    if (statusInput !== undefined && statusInput !== null) {
      normalizeStatus(statusInput, {
        onUnknown: (value) =>
          this.logFailure(`op=insert_event status_unknown value=${JSON.stringify(value)}`, new TypeError('unknown status')),
      });
    }

    const requestInput = pick(event, 'request_json') ?? pick(event, 'request');
    const responseInput = pick(event, 'response_json') ?? pick(event, 'response');
    const request = coercePayload(requestInput, this.maxPayloadBytes);
    const response = coercePayload(responseInput, this.maxPayloadBytes);

    const explicitSummary = pick(event, 'summary_json');
    /** @type {string | null} */
    let summaryJson;
    if (explicitSummary !== undefined && explicitSummary !== null) {
      summaryJson =
        typeof explicitSummary === 'string' ? explicitSummary : stableStringify({ user: explicitSummary });
    } else {
      /** @type {Record<string, unknown>} */
      const collected = {};
      if (request.summary && request.is_normalized) {
        Object.assign(collected, toolResultSummary(/** @type {any} */ (request.summary), this.maxPayloadBytes));
      } else if (request.summary) {
        collected.request_structure = request.summary;
      }
      if (response.summary && response.is_normalized) {
        collected.response = toolResultSummary(/** @type {any} */ (response.summary), this.maxPayloadBytes);
      } else if (response.summary) {
        collected.response_structure = response.summary;
      }
      if (request.truncated) collected.request_truncated = true;
      if (response.truncated) collected.response_truncated = true;
      summaryJson = Object.keys(collected).length > 0 ? stableStringify(collected) : null;
    }

    const values = {
      event_id: eventId,
      gateway_call_id: pick(event, 'gateway_call_id') ?? null,
      run_id: pick(event, 'run_id') ?? null,
      experiment_run_id: pick(event, 'experiment_run_id') ?? null,
      client_label: pick(event, 'client_label') ?? null,
      gateway_id: pick(event, 'gateway_id') ?? null,
      upstream_app: pick(event, 'upstream_app') ?? null,
      tool_name: pick(event, 'tool_name') ?? null,
      method: pick(event, 'method') ?? null,
      phase: normalizePhase(pick(event, 'phase')),
      timestamp_utc: timestampUtc === undefined ? now : toUtcIso(timestampUtc),
      monotonic_duration_ms:
        pick(event, 'monotonic_duration_ms') === undefined ? null : Number(pick(event, 'monotonic_duration_ms')),
      request_json: request.json,
      response_json: response.json,
      summary_json: summaryJson,
      truncated: this._truncatedFlag(event, request, response),
      byte_size: this._byteSize(event, request, response),
      status: statusInput === undefined ? null : normalizeStatus(statusInput),
      error_kind: pick(event, 'error_kind') ?? null,
      protocol_version: pick(event, 'protocol_version') ?? null,
      transport: pick(event, 'transport') ?? null,
      schema_version: pick(event, 'schema_version') ?? SCHEMA_VERSION,
      created_at_utc: now,
    };
    const params = buildUpsertParams('events', 'event_id', EVENT_FIELDS, values);
    return this._safeWrite('insert_event', () => {
      this.withTransaction(() => this.db.prepare(EVENT_UPSERT_SQL).run(...params));
      return { ok: true, event_id: eventId };
    });
  }

  /**
   * @param {Record<string, any>} event
   * @param {{truncated: boolean}} request
   * @param {{truncated: boolean}} response
   * @returns {number} 0/1
   */
  _truncatedFlag(event, request, response) {
    const explicit = pick(event, 'truncated');
    if (explicit !== undefined && explicit !== null) return explicit ? 1 : 0;
    return request.truncated || response.truncated ? 1 : 0;
  }

  /**
   * @param {Record<string, any>} event
   * @param {{byte_size: number}} request
   * @param {{byte_size: number}} response
   * @returns {number}
   */
  _byteSize(event, request, response) {
    const explicit = pick(event, 'byte_size');
    if (explicit !== undefined && explicit !== null) return Number(explicit);
    return (request.byte_size ?? 0) + (response.byte_size ?? 0);
  }

  /**
   * 写入/更新一次实验运行（补丁语义）。
   * @param {Record<string, any>} run
   * @returns {{ok: true, run_id: string} | {ok: false, op: string, error: string}}
   */
  upsertRun(run) {
    if (run === null || typeof run !== 'object') {
      throw new TypeError('upsertRun(run) 需要一个对象');
    }
    const experimentRunId = pick(run, 'experiment_run_id');
    if (typeof experimentRunId !== 'string' || experimentRunId === '') {
      throw new TypeError('upsertRun: experiment_run_id 必须是非空字符串');
    }
    // runs.experiment_run_id 是 UNIQUE：若该实验运行已存在（可能由另一个 Gateway 进程先建），
    // 复用其 run_id，避免 UNIQUE 冲突把 upsert 变成写入失败。
    const existing = this.db.prepare('SELECT run_id FROM runs WHERE experiment_run_id = ?').get(experimentRunId);
    const runId = pick(run, 'run_id') ?? existing?.run_id ?? experimentRunId;
    const now = nowUtcIso();
    const values = {
      run_id: runId,
      experiment_run_id: experimentRunId,
      client_label: pick(run, 'client_label') ?? null,
      started_at_utc:
        pick(run, 'started_at_utc') === undefined ? now : toUtcIso(pick(run, 'started_at_utc')),
      ended_at_utc: pick(run, 'ended_at_utc') === undefined ? null : toUtcIso(pick(run, 'ended_at_utc')),
      notes: pick(run, 'notes') ?? null,
      schema_version: pick(run, 'schema_version') ?? SCHEMA_VERSION,
      created_at_utc: now,
    };
    const params = buildUpsertParams('runs', 'run_id', RUN_FIELDS, values);
    return this._safeWrite('upsert_run', () => {
      this.withTransaction(() => this.db.prepare(RUN_UPSERT_SQL).run(...params));
      return { ok: true, run_id: runId };
    });
  }

  /**
   * @param {string} gatewayCallId
   * @returns {Record<string, any> | null}
   */
  getCall(gatewayCallId) {
    if (typeof gatewayCallId !== 'string' || gatewayCallId === '') {
      throw new TypeError('getCall(gateway_call_id) 需要非空字符串');
    }
    const row = this.db.prepare('SELECT * FROM calls WHERE gateway_call_id = ?').get(gatewayCallId);
    return row ?? null;
  }

  /**
   * 按 run_id 或 experiment_run_id 查询运行记录。
   * @param {string} runIdOrExperimentId
   * @returns {Record<string, any> | null}
   */
  getRun(runIdOrExperimentId) {
    if (typeof runIdOrExperimentId !== 'string' || runIdOrExperimentId === '') {
      throw new TypeError('getRun(run_id | experiment_run_id) 需要非空字符串');
    }
    const row =
      this.db.prepare('SELECT * FROM runs WHERE run_id = ?').get(runIdOrExperimentId) ??
      this.db.prepare('SELECT * FROM runs WHERE experiment_run_id = ?').get(runIdOrExperimentId);
    return row ?? null;
  }

  /**
   * 查询调用列表。
   * @param {{run_id?: string, runId?: string, experiment_run_id?: string, experimentRunId?: string,
   *   gateway_id?: string, gatewayId?: string, upstream_app?: string, upstreamApp?: string,
   *   tool_name?: string, toolName?: string, status?: string, gateway_call_id?: string,
   *   gatewayCallId?: string, since?: string | Date, until?: string | Date,
   *   limit?: number | null, offset?: number, order?: 'asc' | 'desc'}} [filter]
   * @returns {Array<Record<string, any>>}
   */
  listCalls(filter = {}) {
    const { where, params } = buildFilter('calls', filter);
    const limit = normalizeLimit(filter.limit);
    const offset = Number.isFinite(filter.offset) ? Number(filter.offset) : 0;
    const direction = filter.order === 'desc' ? 'DESC' : 'ASC';
    const sql =
      `SELECT * FROM calls${where} ORDER BY timestamp_utc ${direction}, gateway_call_id ${direction}` +
      `${limit === null ? '' : ` LIMIT ${limit}`}${offset > 0 ? ` OFFSET ${offset}` : ''}`;
    return this.db.prepare(sql).all(...params);
  }

  /**
   * 查询事件列表。
   * @param {{run_id?: string, runId?: string, experiment_run_id?: string, experimentRunId?: string,
   *   gateway_call_id?: string, gatewayCallId?: string, callId?: string, event_id?: string, eventId?: string,
   *   gateway_id?: string, gatewayId?: string, phase?: string, status?: string,
   *   since?: string | Date, until?: string | Date,
   *   limit?: number | null, offset?: number, order?: 'asc' | 'desc'}} [filter]
   * @returns {Array<Record<string, any>>}
   */
  listEvents(filter = {}) {
    const { where, params } = buildFilter('events', filter);
    const limit = normalizeLimit(filter.limit);
    const offset = Number.isFinite(filter.offset) ? Number(filter.offset) : 0;
    const direction = filter.order === 'desc' ? 'DESC' : 'ASC';
    const sql =
      `SELECT * FROM events${where} ORDER BY timestamp_utc ${direction}, event_id ${direction}` +
      `${limit === null ? '' : ` LIMIT ${limit}`}${offset > 0 ? ` OFFSET ${offset}` : ''}`;
    return this.db.prepare(sql).all(...params);
  }

  /**
   * 一次调用的完整证据（call 行 + 其全部事件，按时间升序）。
   * @param {string} gatewayCallId
   * @returns {{call: Record<string, any> | null, events: Array<Record<string, any>>}}
   */
  getCallDetail(gatewayCallId) {
    return {
      call: this.getCall(gatewayCallId),
      events: this.listEvents({ gateway_call_id: gatewayCallId, order: 'asc' }),
    };
  }

  /**
   * 查询运行列表（附带调用/事件计数与事件时间范围）。
   * @param {{run_id?: string, experiment_run_id?: string, client_label?: string, limit?: number | null,
   *   order?: 'asc' | 'desc'}} [filter]
   * @returns {Array<Record<string, any>>}
   */
  listRuns(filter = {}) {
    const { where, params } = buildFilter('runs', filter);
    const limit = normalizeLimit(filter.limit);
    const direction = filter.order === 'asc' ? 'ASC' : 'DESC';
    const sql =
      `SELECT r.*,
              (SELECT COUNT(*) FROM calls c WHERE c.run_id = r.run_id OR c.experiment_run_id = r.experiment_run_id) AS call_count,
              (SELECT COUNT(*) FROM events e WHERE e.run_id = r.run_id OR e.experiment_run_id = r.experiment_run_id) AS event_count,
              (SELECT MIN(timestamp_utc) FROM events e WHERE e.run_id = r.run_id OR e.experiment_run_id = r.experiment_run_id) AS first_event_utc,
              (SELECT MAX(timestamp_utc) FROM events e WHERE e.run_id = r.run_id OR e.experiment_run_id = r.experiment_run_id) AS last_event_utc
       FROM runs r${where} ORDER BY r.started_at_utc ${direction}, r.run_id ${direction}` +
      `${limit === null ? '' : ` LIMIT ${limit}`}`;
    return this.db.prepare(sql).all(...params);
  }

  /**
   * @param {object} [filter] 同 listEvents
   * @returns {number}
   */
  countEvents(filter = {}) {
    const { where, params } = buildFilter('events', filter);
    const row = this.db.prepare(`SELECT COUNT(*) AS count FROM events${where}`).get(...params);
    return Number(row?.count ?? 0);
  }

  /**
   * @param {object} [filter] 同 listCalls
   * @returns {number}
   */
  countCalls(filter = {}) {
    const { where, params } = buildFilter('calls', filter);
    const row = this.db.prepare(`SELECT COUNT(*) AS count FROM calls${where}`).get(...params);
    return Number(row?.count ?? 0);
  }

  /**
   * 按运行删除（calls + events + runs 一个事务内完成）。
   * @param {string} runIdOrExperimentId
   * @returns {{ok: true, run_id: string | null, deleted: {runs: number, calls: number, events: number}}
   *   | {ok: false, op: string, error: string}}
   */
  deleteRun(runIdOrExperimentId) {
    if (typeof runIdOrExperimentId !== 'string' || runIdOrExperimentId === '') {
      throw new TypeError('deleteRun(run_id | experiment_run_id) 需要非空字符串');
    }
    const run = this.getRun(runIdOrExperimentId);
    const runId = run?.run_id ?? null;
    const experimentRunId = run?.experiment_run_id ?? runIdOrExperimentId;
    return this._safeWrite('delete_run', () => {
      const deleted = this.withTransaction(() => {
        const events = this.db
          .prepare('DELETE FROM events WHERE run_id = ? OR experiment_run_id = ?')
          .run(runId, experimentRunId).changes;
        const calls = this.db
          .prepare('DELETE FROM calls WHERE run_id = ? OR experiment_run_id = ?')
          .run(runId, experimentRunId).changes;
        const runs = this.db
          .prepare('DELETE FROM runs WHERE run_id = ? OR experiment_run_id = ?')
          .run(runId ?? '', experimentRunId).changes;
        return {
          runs: Number(runs ?? 0),
          calls: Number(calls ?? 0),
          events: Number(events ?? 0),
        };
      });
      return { ok: true, run_id: runId, deleted };
    });
  }

  /**
   * VACUUM（不能在事务内执行）。
   * @returns {{ok: true, bytes_before: number, bytes_after: number} | {ok: false, op: string, error: string}}
   */
  vacuum() {
    return this._safeWrite('vacuum', () => {
      if (this._inTransaction > 0) throw new Error('vacuum 不能在事务内执行');
      const before = this.dbFileSize();
      this.db.exec('VACUUM');
      return { ok: true, bytes_before: before, bytes_after: this.dbFileSize() };
    });
  }

  /** @returns {number} 主库文件字节数（:memory: 为 0） */
  dbFileSize() {
    if (this.dbPath === ':memory:') return 0;
    try {
      return fs.statSync(this.dbPath).size;
    } catch {
      return 0;
    }
  }

  /**
   * @param {string} key
   * @returns {string | null}
   */
  getMeta(key) {
    const row = this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key);
    return row?.value ?? null;
  }

  /**
   * @param {string} key
   * @param {string} value
   * @returns {{ok: true} | {ok: false, op: string, error: string}}
   */
  setMeta(key, value) {
    if (typeof key !== 'string' || key === '') throw new TypeError('setMeta: key 必须是非空字符串');
    return this._safeWrite('set_meta', () => {
      this.db
        .prepare(
          `INSERT INTO meta (key, value, updated_at_utc) VALUES (?, ?, ?)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at_utc = excluded.updated_at_utc`,
        )
        .run(key, value === undefined || value === null ? null : String(value), nowUtcIso());
      return { ok: true };
    });
  }

  /** @returns {Array<{key: string, value: string | null, updated_at_utc: string}>} */
  listMeta() {
    return this.db.prepare('SELECT key, value, updated_at_utc FROM meta ORDER BY key').all();
  }

  /** 本进程内写入失败次数。 */
  getWriteFailures() {
    return this._writeFailures;
  }

  /** 持久化在 meta 表中的写入失败次数（跨进程累计，CLI 读出）。 */
  getPersistedWriteFailures() {
    const raw = this.getMeta(META_WRITE_FAILURES);
    const parsed = Number.parseInt(raw ?? '0', 10);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  /**
   * 汇总统计（CLI `trace stats` 的数据来源）。
   * write_failures.total = max(process, persisted)：
   * persisted（meta 表）已包含本进程的失败，因此不能相加；当持久化本身失败时取两者较大值。
   * @returns {Record<string, any>}
   */
  stats() {
    const persisted = this.getPersistedWriteFailures();
    return {
      db_path: this.dbPath,
      db_bytes: this.dbFileSize(),
      schema_version: this.getMeta(META_SCHEMA_VERSION) ?? SCHEMA_VERSION,
      ddl_version: Number(this.db.prepare('PRAGMA user_version').get()?.user_version ?? 0),
      runs: Number(this.db.prepare('SELECT COUNT(*) AS c FROM runs').get()?.c ?? 0),
      calls: Number(this.db.prepare('SELECT COUNT(*) AS c FROM calls').get()?.c ?? 0),
      events: Number(this.db.prepare('SELECT COUNT(*) AS c FROM events').get()?.c ?? 0),
      truncated_events: Number(this.db.prepare('SELECT COUNT(*) AS c FROM events WHERE truncated = 1').get()?.c ?? 0),
      calls_by_status: this.db
        .prepare('SELECT status, COUNT(*) AS count FROM calls GROUP BY status ORDER BY status')
        .all(),
      events_by_phase: this.db
        .prepare('SELECT phase, COUNT(*) AS count FROM events GROUP BY phase ORDER BY phase')
        .all(),
      write_failures: {
        process: this._writeFailures,
        persisted,
        total: Math.max(this._writeFailures, persisted),
      },
      meta: this.listMeta(),
    };
  }

  /** 关闭连接（幂等）。 */
  close() {
    if (this._closed) return;
    this._closed = true;
    this.db.close();
  }
}

/**
 * @param {unknown} limit
 * @returns {number | null}
 */
function normalizeLimit(limit) {
  if (limit === null) return null;
  if (limit === undefined) return null;
  const value = Number(limit);
  if (!Number.isFinite(value) || value < 0) throw new TypeError(`limit 非法: ${JSON.stringify(limit)}`);
  return Math.trunc(value);
}

/** 每张表允许过滤的列（防止把不存在的列塞进 WHERE）。 */
const FILTER_COLUMNS = Object.freeze({
  calls: new Set([
    'run_id',
    'experiment_run_id',
    'gateway_id',
    'upstream_app',
    'tool_name',
    'status',
    'gateway_call_id',
    'client_label',
  ]),
  events: new Set([
    'run_id',
    'experiment_run_id',
    'gateway_id',
    'upstream_app',
    'tool_name',
    'status',
    'gateway_call_id',
    'event_id',
    'phase',
    'client_label',
  ]),
  runs: new Set(['run_id', 'experiment_run_id', 'client_label']),
});

/**
 * @param {'calls'|'events'|'runs'} table
 * @param {Record<string, any>} filter
 * @returns {{where: string, params: Array<unknown>}}
 */
function buildFilter(table, filter = {}) {
  const allowed = FILTER_COLUMNS[table];
  const clauses = [];
  const params = [];
  const eq = (col, value) => {
    if (value === undefined || value === null || value === '') return;
    if (!allowed.has(col)) throw new TypeError(`${table} 不支持按 ${col} 过滤`);
    clauses.push(`${col} = ?`);
    params.push(toSqlValue(value));
  };
  // 「属于该运行」语义：run_id 与 experiment_run_id 两列任一命中即算同一运行
  // （Gateway 经 --experiment-run-id 采集时通常只知道自己那一列）。
  const runKey = filter.run_id ?? filter.runId ?? filter.experiment_run_id ?? filter.experimentRunId;
  if (runKey !== undefined && runKey !== null && runKey !== '') {
    clauses.push('(run_id = ? OR experiment_run_id = ?)');
    params.push(toSqlValue(runKey), toSqlValue(runKey));
  }
  eq('client_label', filter.client_label ?? filter.clientLabel);
  eq('gateway_id', filter.gateway_id ?? filter.gatewayId);
  eq('upstream_app', filter.upstream_app ?? filter.upstreamApp);
  eq('tool_name', filter.tool_name ?? filter.toolName);
  eq('status', filter.status);
  eq('gateway_call_id', filter.gateway_call_id ?? filter.gatewayCallId ?? filter.callId);
  eq('event_id', filter.event_id ?? filter.eventId);
  eq('phase', filter.phase);
  if (filter.since !== undefined && filter.since !== null) {
    clauses.push('timestamp_utc >= ?');
    params.push(toUtcIso(filter.since));
  }
  if (filter.until !== undefined && filter.until !== null) {
    clauses.push('timestamp_utc <= ?');
    params.push(toUtcIso(filter.until));
  }
  return { where: clauses.length > 0 ? ` WHERE ${clauses.join(' AND ')}` : '', params };
}

/**
 * 打开（必要时创建）事件库。
 * @param {string} dbPath 数据库文件路径，或 ':memory:'
 * @param {TraceStoreOptions & {createDir?: boolean}} [options]
 * @returns {TraceStore}
 */
export function openStore(dbPath, options = {}) {
  if (typeof dbPath !== 'string' || dbPath === '') {
    throw new TypeError('openStore(dbPath) 需要非空字符串（可用 ":memory:"）');
  }
  if (dbPath !== ':memory:' && options.createDir !== false) {
    fs.mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });
  }
  const busyTimeoutMs = Number.isFinite(options.busyTimeoutMs)
    ? Number(options.busyTimeoutMs)
    : DEFAULT_BUSY_TIMEOUT_MS;
  const db = new DatabaseSync(dbPath, { timeout: busyTimeoutMs });
  db.exec(`PRAGMA busy_timeout = ${Math.max(0, Math.trunc(busyTimeoutMs))}`);
  return new TraceStore(dbPath, db, { ...options, busyTimeoutMs });
}
