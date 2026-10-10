/**
 * src/cli/queries.js — CLI 的只读查询与导出构造（S2）
 *
 * 只读使用方：全部经 `TraceStore` 的查询方法（`listRuns` / `listCalls` / `listEvents` /
 * `getRun` / `getCall` / `stats`），**不直接改库**；唯一的写操作是 `deleteRun`/`vacuum`。
 *
 * 「运行」的两种来源：
 *   1. `runs` 表里显式登记的运行；
 *   2. 只在 calls/events 里出现 `experiment_run_id` 的运行（Gateway 采集时不会自动建 runs 行）。
 * 本模块把两者合并，并把「属于该运行」的语义固定为
 * `run_id / experiment_run_id 任一命中`（相关实现）。
 */
import { fail } from './args.js';
import { SCHEMA_VERSION } from '../shared/schemaversion.js';
// 脱敏只允许有一个实现：复用 P3 展示层的 mask.js（相关实现 的机器可读唯一真源）。
import { maskPayloadRow, newMaskStats } from '../web/mask.js';

/** 未归属任何运行的记录在表格里的显示值。 */
export const UNASSIGNED = '(unassigned)';

/**
 * @param {Record<string, any>} row
 * @returns {string}
 */
export function runKeyOf(row) {
  return row?.experiment_run_id ?? row?.run_id ?? UNASSIGNED;
}

/**
 * @param {any} store
 * @returns {Array<Record<string, any>>}
 */
function rowsOf(store) {
  return store.db.prepare('SELECT * FROM calls').all();
}

/**
 * 合并 runs 表与 calls/events 聚合出的运行列表（按开始时间倒序）。
 * @param {any} store
 * @returns {Array<{experiment_run_id: string, run_id: string|null, client_label: string|null,
 *   started_at_utc: string|null, ended_at_utc: string|null, call_count: number, event_count: number,
 *   first_event_utc: string|null, last_event_utc: string|null, registered: boolean, notes: string|null}>}
 */
export function collectRuns(store) {
  /** @type {Map<string, any>} */
  const runs = new Map();

  for (const row of store.listRuns({ order: 'asc' })) {
    const key = runKeyOf(row);
    runs.set(key, {
      experiment_run_id: row.experiment_run_id,
      run_id: row.run_id,
      client_label: row.client_label ?? null,
      started_at_utc: row.started_at_utc ?? null,
      ended_at_utc: row.ended_at_utc ?? null,
      call_count: 0,
      event_count: 0,
      first_event_utc: null,
      last_event_utc: null,
      registered: true,
      notes: row.notes ?? null,
    });
  }

  for (const call of rowsOf(store)) {
    const key = runKeyOf(call);
    const entry =
      runs.get(key) ??
      {
        experiment_run_id: call.experiment_run_id ?? null,
        run_id: call.run_id ?? null,
        client_label: call.client_label ?? null,
        started_at_utc: call.timestamp_utc ?? null,
        ended_at_utc: null,
        call_count: 0,
        event_count: 0,
        first_event_utc: null,
        last_event_utc: null,
        registered: false,
        notes: null,
      };
    entry.call_count += 1;
    if (!entry.client_label && call.client_label) entry.client_label = call.client_label;
    if (call.timestamp_utc) {
      if (!entry.started_at_utc || call.timestamp_utc < entry.started_at_utc) entry.started_at_utc = call.timestamp_utc;
      if (!entry.last_event_utc || call.timestamp_utc > entry.last_event_utc) entry.last_event_utc = call.timestamp_utc;
    }
    if (call.ended_at_utc && (!entry.ended_at_utc || call.ended_at_utc > entry.ended_at_utc)) entry.ended_at_utc = call.ended_at_utc;
    runs.set(key, entry);
  }

  for (const event of store.listEvents({ order: 'asc' })) {
    const key = runKeyOf(event);
    let entry = runs.get(key);
    if (!entry) {
      entry = {
        experiment_run_id: event.experiment_run_id ?? null,
        run_id: event.run_id ?? null,
        client_label: event.client_label ?? null,
        started_at_utc: event.timestamp_utc ?? null,
        ended_at_utc: null,
        call_count: 0,
        event_count: 0,
        first_event_utc: null,
        last_event_utc: null,
        registered: false,
        notes: null,
      };
      runs.set(key, entry);
    }
    entry.event_count += 1;
    if (!entry.client_label && event.client_label) entry.client_label = event.client_label;
    if (event.timestamp_utc) {
      if (!entry.started_at_utc || event.timestamp_utc < entry.started_at_utc) entry.started_at_utc = event.timestamp_utc;
      if (!entry.first_event_utc || event.timestamp_utc < entry.first_event_utc) entry.first_event_utc = event.timestamp_utc;
      if (!entry.last_event_utc || event.timestamp_utc > entry.last_event_utc) entry.last_event_utc = event.timestamp_utc;
    }
  }

  return [...runs.values()].sort((a, b) => String(b.started_at_utc ?? '').localeCompare(String(a.started_at_utc ?? '')));
}

/**
 * 按 run_id 或 experiment_run_id 精确查找某个运行（含未在 runs 表登记的情况）。
 * @param {any} store
 * @param {string} runKey
 * @returns {Record<string, any> | null}
 */
export function findRun(store, runKey) {
  return collectRuns(store).find((run) => run.experiment_run_id === runKey || run.run_id === runKey) ?? null;
}

/**
 * @param {any} store
 * @param {string} runKey
 * @returns {Record<string, any>}
 */
export function requireRun(store, runKey) {
  const run = findRun(store, runKey);
  if (!run) fail(`未找到运行：${runKey}（库里既没有 runs 行，也没有属于它的 calls/events）`, 3);
  return run;
}

/**
 * 查询某运行的调用列表。
 * @param {any} store
 * @param {string} runKey
 * @param {{limit?: number|null, order?: 'asc'|'desc', status?: string}} [options]
 * @returns {Array<Record<string, any>>}
 */
export function callsOfRun(store, runKey, options = {}) {
  const calls = store
    .listCalls({ experiment_run_id: runKey, run_id: runKey, order: options.order ?? 'asc' })
    .filter((call) => call.experiment_run_id === runKey || call.run_id === runKey);
  const filtered = options.status ? calls.filter((call) => call.status === options.status) : calls;
  return options.limit ? filtered.slice(0, options.limit) : filtered;
}

/**
 * 查询某运行的事件（时间升序）。
 * @param {any} store
 * @param {string} runKey
 * @param {{limit?: number|null, order?: 'asc'|'desc'}} [options]
 * @returns {Array<Record<string, any>>}
 */
export function eventsOfRun(store, runKey, options = {}) {
  const events = store
    .listEvents({ experiment_run_id: runKey, run_id: runKey, order: options.order ?? 'asc' })
    .filter((event) => event.experiment_run_id === runKey || event.run_id === runKey);
  return options.limit ? events.slice(0, options.limit) : events;
}

/**
 * 时间线：按时间排序的事件 + tools/call 的 request/response 成对检查。
 * @param {any} store
 * @param {string} runKey
 * @param {{limit?: number|null}} [options]
 * @returns {{run: Record<string, any>, calls: Array<Record<string, any>>, events: Array<Record<string, any>>,
 *   rows: Array<Record<string, any>>, pairing: {calls_checked: number, ok: number, incomplete: Array<Record<string, any>>,
 *   orphan_events: Array<Record<string, any>>, complete: boolean}}}
 */
export function buildTimeline(store, runKey, options = {}) {
  const run = requireRun(store, runKey);
  const calls = callsOfRun(store, runKey, { order: 'asc' });
  const events = eventsOfRun(store, runKey, { order: 'asc' });

  /** @type {Map<string, {request: any, terminal: any, terminalPhase: string|null}>} */
  const byCall = new Map();
  /** @type {Array<Record<string, any>>} */
  const orphanEvents = [];

  for (const event of events) {
    if (event.gateway_call_id === null || event.gateway_call_id === undefined) {
      continue; // 摘要/生命周期事件（initialize、tools_list、gateway_lifecycle …）不参与成对检查
    }
    const entry = byCall.get(event.gateway_call_id) ?? { request: null, terminal: null, terminalPhase: null };
    if (event.phase === 'request') entry.request = event;
    else if (event.phase === 'response' || event.phase === 'error') {
      if (!entry.terminal) {
        entry.terminal = event;
        entry.terminalPhase = event.phase;
      }
    } else orphanEvents.push({ ...event, reason: `非 request/response/error 的 phase=${event.phase}` });
    byCall.set(event.gateway_call_id, entry);
  }

  /** @type {Array<Record<string, any>>} */
  const incomplete = [];
  for (const call of calls) {
    const entry = byCall.get(call.gateway_call_id);
    /** @type {string[]} */
    const missing = [];
    if (!entry || !entry.request) missing.push('request');
    if (!entry || !entry.terminal) missing.push('response|error');
    if (missing.length > 0) {
      incomplete.push({
        gateway_call_id: call.gateway_call_id,
        tool_name: call.tool_name ?? null,
        status: call.status ?? null,
        missing,
      });
    }
  }

  const rows = events
    .filter((event) => event.gateway_call_id !== null && event.gateway_call_id !== undefined)
    .map((event) => {
      const call = calls.find((candidate) => candidate.gateway_call_id === event.gateway_call_id) ?? null;
      const entry = byCall.get(event.gateway_call_id);
      const isTerminal = event === entry?.terminal;
      const partner = event.phase === 'request' ? entry?.terminal ?? null : entry?.request ?? null;
      return {
        timestamp_utc: event.timestamp_utc,
        phase: event.phase,
        event_id: event.event_id,
        gateway_call_id: event.gateway_call_id,
        gateway_id: event.gateway_id,
        upstream_app: event.upstream_app,
        tool_name: event.tool_name,
        status: event.status,
        duration_ms: event.monotonic_duration_ms,
        byte_size: event.byte_size,
        truncated: event.truncated === 1,
        paired: partner !== null,
        pairing_note:
          event.phase === 'request'
            ? isTerminal || partner
              ? 'paired'
              : '!! 缺少 response/error'
            : event.phase === 'response' || event.phase === 'error'
              ? partner
                ? 'paired'
                : '!! 缺少 request'
              : 'n/a',
        call_status: call?.status ?? null,
      };
    });

  const checkedCalls = calls.length;
  return {
    run,
    calls,
    events,
    rows: options.limit ? rows.slice(0, options.limit) : rows,
    pairing: {
      calls_checked: checkedCalls,
      ok: checkedCalls - incomplete.length,
      incomplete,
      orphan_events: orphanEvents,
      complete: incomplete.length === 0 && orphanEvents.length === 0,
    },
  };
}

/**
 * 审计导出对象（JSON 形态）。JSONL 形态由调用方按行序列化。
 *
 * **脱敏语义（R-01 团队裁定，必须与 相关实现 一致）**：CLI 是**用户本机主动发起**的审计导出，
 * 因此**默认写未脱敏原文**（隐式脱敏会造成静默数据失真，比原文更危险）；只有显式传 `mask: true`
 * （`--mask`）才走脱敏投影。产物**必须**带 `masked` 字段，让读者一眼看到本文件的真实形态。
 * 掩码规则复用 P3 展示层的唯一实现 `src/web/mask.js`（`maskPayloadRow()`），不另写一套。
 *
 * @param {any} store
 * @param {string} runKey
 * @param {{includeEvents?: boolean, mask?: boolean}} [options]
 * @returns {{schema_version: string, export_kind: string, exported_at_utc: string, db_path: string,
 *   masked: boolean, mask_mode: string, mask_summary: Record<string, any> | null,
 *   run: Record<string, any>, calls: Array<Record<string, any>>, events: Array<Record<string, any>>}}
 */
export function buildExport(store, runKey, options = {}) {
  const run = requireRun(store, runKey);
  const mask = options.mask === true;
  const rawCalls = callsOfRun(store, runKey, { order: 'asc' });
  const rawEvents = options.includeEvents === false ? [] : eventsOfRun(store, runKey, { order: 'asc' });

  const stats = newMaskStats();
  // previewChars 用最大安全整数：审计导出**不得**因为展示层预览上限而截断内容（脱敏只做替换，不裁剪）。
  const maskOptions = { stats, previewChars: Number.MAX_SAFE_INTEGER };
  const calls = mask ? rawCalls.map((row) => maskPayloadRow(row, maskOptions).value) : rawCalls;
  const events = mask ? rawEvents.map((row) => maskPayloadRow(row, maskOptions).value) : rawEvents;

  return {
    schema_version: SCHEMA_VERSION,
    export_kind: 'mcp-cross-app-trace/audit-export',
    exported_at_utc: new Date().toISOString(),
    db_path: store.dbPath,
    masked: mask,
    mask_mode: mask ? 'category_and_masked_value' : 'raw',
    mask_summary: mask ? { fields_masked: stats.fields_masked, by_category: stats.by_category } : null,
    run,
    calls,
    events,
  };
}
