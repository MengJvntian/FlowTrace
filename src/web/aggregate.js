/**
 * src/web/aggregate.js — P3 只读页面的运行/时间线聚合（W1）
 *
 * **运行计数语义与 `bin/trace.js runs --json` 完全一致**（团队硬约束 1）：
 *   - `registered`：`runs` 表里登记的行（CLI 显示 `REGISTERED=yes`）；
 *   - `implicit`：只出现在 `calls` / `events` 的 `experiment_run_id`
 *     （Gateway 采集默认不建 runs 行；CLI 显示 `REGISTERED=implicit`）。
 * 两者**分别计数、分别命名**，任何位置都不得合并成一个数字。
 *
 * **配对完整性用数据判定**（团队硬约束 2）：字段与 CLI `timeline --json` 一致——
 * `pairing.calls_checked` / `pairing.ok` / `pairing.incomplete[]` / `pairing.orphan_events[]`
 * / `pairing.complete`；缺 response/error 的调用用 `!!` 文案显著标出，页面不报错。
 *
 * **时间**（团队硬约束 3）：库内一律 UTC 毫秒；本模块为每个时间点同时给出
 * `*_utc`（原始值）与 `*_local`（本机时区 + 显式 UTC 偏移），本地化绝不覆盖 UTC 原值。
 */
import { performance } from 'node:perf_hooks';
import { annotateCalls } from './call_insights.js';

/** 未归属任何运行的记录在页面里的显示值（与 CLI 的 UNASSIGNED 一致）。 */
export const UNASSIGNED = '(unassigned)';

/** 采集状态枚举（要求 8：页面上必须可见「开启/关闭/已删除」）。 */
export const COLLECTION_STATES = Object.freeze([
  { state: 'enabled', label: '原始数据采集：开启', detail: '至少一个 tools/call 事件保留了原始 request/response 载荷。' },
  { state: 'disabled', label: '原始数据采集：关闭', detail: '工具调用事件只有摘要/字节数/摘要散列，没有原始载荷（Gateway 以 --trace-enabled 关闭采集）。' },
  { state: 'partial', label: '原始数据采集：部分事件无载荷', detail: '同一库里既有保留载荷的事件，也有只留摘要的事件（可能来自不同的 Gateway 启动参数或截断）。' },
  { state: 'empty', label: '原始数据采集：无数据', detail: '事件库可读但没有 calls/events 记录（尚未采集，或已按运行全部删除）。' },
  { state: 'deleted', label: '原始数据采集：已删除', detail: '事件库文件不存在（被 reset --delete-db-file 删除，或路径错误）。' },
  { state: 'unreadable', label: '原始数据采集：库不可读', detail: '文件存在但不是本平台的事件库，或无法以只读方式打开。' },
]);

/** 数据流相关的 phase（与 相关实现 一致）。 */
const DATAFLOW_PHASES = Object.freeze(['request', 'response', 'error']);

/**
 * @param {Record<string, any>} row
 * @returns {string}
 */
export function runKeyOf(row) {
  return row?.experiment_run_id ?? row?.run_id ?? UNASSIGNED;
}

/** 本机时区信息（进程所在机器；页面与库里数据同机）。 */
export function timezoneInfo() {
  const name = Intl.DateTimeFormat().resolvedOptions().timeZone || 'unknown';
  const offsetMinutes = -new Date().getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? '+' : '-';
  const abs = Math.abs(offsetMinutes);
  const label = `UTC${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`;
  return { name, offset_minutes: offsetMinutes, offset_label: label };
}

/**
 * UTC ISO 字符串 → 本机墙上时间（保留毫秒）+ 显式偏移。
 * @param {string | null | undefined} iso
 * @returns {{utc: string | null, local: string | null, local_label: string | null, epoch_ms: number | null}}
 */
export function formatUtcLocal(iso) {
  if (typeof iso !== 'string' || iso === '') return { utc: null, local: null, local_label: null, epoch_ms: null };
  const date = new Date(iso);
  const epochMs = date.getTime();
  if (!Number.isFinite(epochMs)) {
    return { utc: iso, local: null, local_label: '（时间戳不可解析）', epoch_ms: null };
  }
  const tz = timezoneInfo();
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz.name,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    fractionalSecondDigits: 3,
    hourCycle: 'h23',
  }).formatToParts(date);
  /** @type {Record<string, string>} */
  const map = {};
  for (const part of parts) map[part.type] = part.value;
  const local = `${map.year}-${map.month}-${map.day} ${map.hour}:${map.minute}:${map.second}.${map.fractionalSecondDigits ?? '000'}`;
  return { utc: iso, local, local_label: `${local} ${tz.offset_label}`, epoch_ms: epochMs };
}

/**
 * 给行对象补上 `utc` / `local` / `local_label`（字段名可配置）。
 * @param {Record<string, any>} target
 * @param {Record<string, any>} source
 * @param {Array<[string, string]>} pairs [源字段, 目标前缀]
 */
export function attachTimes(target, source, pairs) {
  for (const [field, prefix] of pairs) {
    const formatted = formatUtcLocal(source?.[field] ?? null);
    target[`${prefix}_utc`] = formatted.utc;
    target[`${prefix}_local`] = formatted.local;
    target[`${prefix}_local_label`] = formatted.local_label;
  }
  return target;
}

/**
 * 判断一个事件是否保留原始载荷。
 * @param {Record<string, any>} event
 * @returns {{has_payload: boolean, payload_omitted: boolean}}
 */
export function payloadPresence(event) {
  const hasPayload = event?.request_json !== null && event?.request_json !== undefined
    ? true
    : event?.response_json !== null && event?.response_json !== undefined;
  let omitted = false;
  if (typeof event?.summary_json === 'string' && event.summary_json.includes('"omitted":true')) omitted = true;
  return { has_payload: hasPayload, payload_omitted: omitted || !hasPayload };
}

/**
 * 按运行聚合所有 calls / events（一次装载，避免 N+1 查询）。
 * @param {Record<string, any>} store 只读 store 门面
 * @returns {{
 *   runs: Array<Record<string, any>>,
 *   totals: {registered: number, implicit: number, total: number, calls: number, events: number},
 *   calls: Array<Record<string, any>>,
 *   events: Array<Record<string, any>>,
 *   load_ms: number,
 * }}
 */
export function collectRunAggregates(store) {
  const started = performance.now();
  const registeredRows = store.listRuns({ order: 'asc' });
  const calls = store.listCalls({ order: 'asc', limit: null });
  const events = store.listEvents({ order: 'asc', limit: null });

  /** @type {Map<string, Record<string, any>>} */
  const runs = new Map();

  for (const row of registeredRows) {
    const key = runKeyOf(row);
    runs.set(key, {
      experiment_run_id: row.experiment_run_id ?? null,
      run_id: row.run_id ?? null,
      client_label: row.client_label ?? null,
      registered: true,
      registered_label: 'yes',
      notes: row.notes ?? null,
      started_at_utc: row.started_at_utc ?? null,
      ended_at_utc: row.ended_at_utc ?? null,
      first_event_utc: null,
      last_event_utc: null,
      call_count: 0,
      event_count: 0,
      calls: [],
      events: [],
      status_summary: {},
      error_kinds: {},
      apps: [],
      gateway_ids: [],
      pairing: null,
      collection: null,
    });
  }

  for (const call of calls) {
    const key = runKeyOf(call);
    let entry = runs.get(key);
    if (!entry) {
      entry = {
        experiment_run_id: call.experiment_run_id ?? null,
        run_id: call.run_id ?? null,
        client_label: call.client_label ?? null,
        registered: false,
        registered_label: 'implicit',
        notes: null,
        started_at_utc: call.timestamp_utc ?? null,
        ended_at_utc: call.ended_at_utc ?? null,
        first_event_utc: null,
        last_event_utc: null,
        call_count: 0,
        event_count: 0,
        calls: [],
        events: [],
        status_summary: {},
        error_kinds: {},
        apps: [],
        gateway_ids: [],
        pairing: null,
        collection: null,
      };
      runs.set(key, entry);
    }
    entry.call_count += 1;
    entry.calls.push(call);
    if (!entry.client_label && call.client_label) entry.client_label = call.client_label;
    if (!entry.run_id && call.run_id) entry.run_id = call.run_id;
    if (call.timestamp_utc) {
      if (!entry.started_at_utc || call.timestamp_utc < entry.started_at_utc) entry.started_at_utc = call.timestamp_utc;
      if (!entry.last_event_utc || call.timestamp_utc > entry.last_event_utc) entry.last_event_utc = call.timestamp_utc;
    }
    if (call.ended_at_utc && (!entry.ended_at_utc || call.ended_at_utc > entry.ended_at_utc)) entry.ended_at_utc = call.ended_at_utc;
    const status = call.status ?? 'unknown';
    entry.status_summary[status] = (entry.status_summary[status] ?? 0) + 1;
    if (call.error_kind) entry.error_kinds[call.error_kind] = (entry.error_kinds[call.error_kind] ?? 0) + 1;
    if (call.upstream_app && !entry.apps.includes(call.upstream_app)) entry.apps.push(call.upstream_app);
    if (call.gateway_id && !entry.gateway_ids.includes(call.gateway_id)) entry.gateway_ids.push(call.gateway_id);
  }

  for (const event of events) {
    const key = runKeyOf(event);
    let entry = runs.get(key);
    if (!entry) {
      entry = {
        experiment_run_id: event.experiment_run_id ?? null,
        run_id: event.run_id ?? null,
        client_label: event.client_label ?? null,
        registered: false,
        registered_label: 'implicit',
        notes: null,
        started_at_utc: event.timestamp_utc ?? null,
        ended_at_utc: null,
        first_event_utc: null,
        last_event_utc: null,
        call_count: 0,
        event_count: 0,
        calls: [],
        events: [],
        status_summary: {},
        error_kinds: {},
        apps: [],
        gateway_ids: [],
        pairing: null,
        collection: null,
      };
      runs.set(key, entry);
    }
    entry.event_count += 1;
    entry.events.push(event);
    if (!entry.client_label && event.client_label) entry.client_label = event.client_label;
    if (!entry.run_id && event.run_id) entry.run_id = event.run_id;
    if (event.timestamp_utc) {
      if (!entry.started_at_utc || event.timestamp_utc < entry.started_at_utc) entry.started_at_utc = event.timestamp_utc;
      if (!entry.first_event_utc || event.timestamp_utc < entry.first_event_utc) entry.first_event_utc = event.timestamp_utc;
      if (!entry.last_event_utc || event.timestamp_utc > entry.last_event_utc) entry.last_event_utc = event.timestamp_utc;
    }
    if (event.upstream_app && !entry.apps.includes(event.upstream_app)) entry.apps.push(event.upstream_app);
    if (event.gateway_id && !entry.gateway_ids.includes(event.gateway_id)) entry.gateway_ids.push(event.gateway_id);
  }

  const list = [...runs.values()];
  for (const entry of list) {
    entry.pairing = pairingOfCalls(entry.calls, entry.events);
    entry.collection = collectionStateOf(entry.events, entry.calls);
    entry.apps.sort();
    entry.gateway_ids.sort();
    delete entry.calls;
    delete entry.events;
  }
  list.sort((a, b) => String(b.started_at_utc ?? '').localeCompare(String(a.started_at_utc ?? '')));

  const registered = list.filter((entry) => entry.registered).length;
  const implicit = list.length - registered;

  return {
    runs: list,
    totals: {
      registered,
      implicit,
      total: list.length,
      calls: calls.length,
      events: events.length,
    },
    calls,
    events,
    load_ms: Math.round((performance.now() - started) * 1000) / 1000,
  };
}

/**
 * request/response 成对检查。字段与 CLI `timeline --json` 的 `pairing` 一致。
 * @param {Array<Record<string, any>>} calls
 * @param {Array<Record<string, any>>} events
 * @returns {{calls_checked: number, ok: number, incomplete: Array<Record<string, any>>, orphan_events: Array<Record<string, any>>, complete: boolean}}
 */
export function pairingOfCalls(calls, events) {
  /** @type {Map<string, {request: any, terminal: any}>} */
  const byCall = new Map();
  /** @type {Array<Record<string, any>>} */
  const orphanEvents = [];

  for (const event of events) {
    if (event.gateway_call_id === null || event.gateway_call_id === undefined) continue;
    const entry = byCall.get(event.gateway_call_id) ?? { request: null, terminal: null };
    if (event.phase === 'request') entry.request = event;
    else if (event.phase === 'response' || event.phase === 'error') {
      if (!entry.terminal) entry.terminal = event;
    } else orphanEvents.push({ event_id: event.event_id, phase: event.phase, reason: `非 request/response/error 的 phase=${event.phase}` });
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
        upstream_app: call.upstream_app ?? null,
        status: call.status ?? null,
        missing,
        marker: '!!',
      });
    }
  }

  return {
    calls_checked: calls.length,
    ok: calls.length - incomplete.length,
    incomplete,
    orphan_events: orphanEvents,
    complete: incomplete.length === 0 && orphanEvents.length === 0,
  };
}

/**
 * 单个运行的采集状态（只看属于 tools/call 的事件，生命周期/握手事件天然只留摘要）。
 * @param {Array<Record<string, any>>} events
 * @param {Array<Record<string, any>>} calls
 * @returns {Record<string, any>}
 */
export function collectionStateOf(events, calls) {
  const callEvents = events.filter(
    (event) => event.gateway_call_id !== null && event.gateway_call_id !== undefined && DATAFLOW_PHASES.includes(event.phase),
  );
  let withPayload = 0;
  let withoutPayload = 0;
  for (const event of callEvents) {
    if (payloadPresence(event).has_payload) withPayload += 1;
    else withoutPayload += 1;
  }
  let state;
  if (callEvents.length === 0) state = 'empty';
  else if (withPayload > 0 && withoutPayload > 0) state = 'partial';
  else if (withPayload > 0) state = 'enabled';
  else state = 'disabled';
  const meta = COLLECTION_STATES.find((entry) => entry.state === state) ?? COLLECTION_STATES[3];
  return {
    state,
    label: meta.label,
    detail: meta.detail,
    evidence: {
      tools_call_events: callEvents.length,
      events_with_payload: withPayload,
      events_without_payload: withoutPayload,
    },
  };
}

/**
 * 事件库全局采集状态（要求 8：开启 / 关闭 / 已删除 必须在页面上可见）。
 * @param {{store: Record<string, any> | null, db_exists: boolean, db_bytes: number, open_error: string | null, mode: string}} opened
 * @param {string} dbPath
 * @returns {Record<string, any>}
 */
export function collectionStatus(opened, dbPath) {
  /** @type {Record<string, any>} */
  const base = {
    db_path: dbPath,
    db_exists: opened.db_exists,
    db_bytes: opened.db_bytes,
    open_mode: opened.mode,
    open_error: opened.open_error,
    legend: COLLECTION_STATES.map((entry) => ({ ...entry })),
  };

  if (!opened.db_exists) {
    return {
      ...base,
      state: 'deleted',
      label: '原始数据采集：已删除',
      detail: '事件库文件不存在。若刚刚执行过 `node bin/reset.js --delete-db-file --yes`，这就是预期状态。',
      evidence: { calls: 0, events: 0, events_with_payload: 0, events_without_payload: 0, last_event_utc: null },
    };
  }
  if (opened.store === null) {
    return {
      ...base,
      state: 'unreadable',
      label: '原始数据采集：库不可读',
      detail: `文件存在但打不开或不是本平台事件库：${opened.open_error ?? '未知原因'}`,
      evidence: { calls: 0, events: 0, events_with_payload: 0, events_without_payload: 0, last_event_utc: null },
    };
  }

  let calls;
  let events;
  try {
    calls = opened.store.listCalls({ limit: null });
    events = opened.store.listEvents({ limit: null });
  } catch (error) {
    // 文件存在但不是本平台事件库（或不可读）：如实报「库不可读」，不抛异常、不猜数据。
    return {
      ...base,
      state: 'unreadable',
      label: '原始数据采集：库不可读',
      detail: `只读查询失败：${error instanceof Error ? error.message : String(error)}`,
      evidence: { calls: 0, events: 0, events_with_payload: 0, events_without_payload: 0, last_event_utc: null },
    };
  }
  const callEvents = events.filter(
    (event) => event.gateway_call_id !== null && event.gateway_call_id !== undefined && DATAFLOW_PHASES.includes(event.phase),
  );
  let withPayload = 0;
  let withoutPayload = 0;
  for (const event of callEvents) {
    if (payloadPresence(event).has_payload) withPayload += 1;
    else withoutPayload += 1;
  }
  let state;
  if (calls.length === 0 && events.length === 0) state = 'empty';
  else if (withPayload > 0 && withoutPayload > 0) state = 'partial';
  else if (withPayload > 0) state = 'enabled';
  else if (withoutPayload > 0) state = 'disabled';
  else state = 'empty';
  const meta = COLLECTION_STATES.find((entry) => entry.state === state) ?? COLLECTION_STATES[3];
  const lastEvent = events.length > 0 ? events[events.length - 1].timestamp_utc : null;
  return {
    ...base,
    state,
    label: meta.label,
    detail: meta.detail,
    evidence: {
      calls: calls.length,
      events: events.length,
      events_with_payload: withPayload,
      events_without_payload: withoutPayload,
      last_event_utc: lastEvent,
    },
  };
}

/**
 * 运行 key 的匹配器。
 *
 * 为什么需要它（2026-10-05 用户报「自动刷新失败」的根因）：
 *   `run_key` 的取值规则是 `experiment_run_id ?? run_id ?? UNASSIGNED`（见 src/web/api.js:174），
 *   所以列表里会出现 `run_key === '(unassigned)'` 的条目（来自「calls/events 存在但没带运行 id」的数据）。
 *   旧实现直接拿 key 去比对 `call.experiment_run_id === runKey || call.run_id === runKey`，
 *   而 `(unassigned)` 从来不是任何一行的真实字段值 → 查不到 → **404** →
 *   页面自动刷新每轮重选运行时会撞上它并报「自动刷新失败」。
 *   现在按语义匹配：UNASSIGNED 匹配「两个字段都为空」的那些行。
 *
 * @param {string} runKey
 * @returns {(row: Record<string, any>) => boolean}
 */
export function runKeyMatcher(runKey) {
  if (runKey === UNASSIGNED) {
    return (row) => (row?.experiment_run_id ?? null) === null && (row?.run_id ?? null) === null;
  }
  return (row) => row?.experiment_run_id === runKey || row?.run_id === runKey;
}

/**
 * 单个运行的时间线（字段与 CLI `timeline --json` 对齐；不做任何内容推断/补全）。
 * @param {Record<string, any>} store 只读 store 门面
 * @param {string} runKey
 * @param {{previewChars?: number, mask?: Function, maskStats?: Record<string, any>}} [options]
 * @returns {Record<string, any> | null}
 */
export function buildRunTimeline(store, runKey, options = {}) {
  const match = runKeyMatcher(runKey);
  // ⚠️ 未归属运行（runKey === UNASSIGNED）**不能**把 '(unassigned)' 交给 store 当过滤条件：
  // store 的 listCalls/listEvents 是按 SQL 精确匹配 experiment_run_id 的，传一个字符串进去
  // 只会得到 0 行（实测：库里明明有 2 条两个字段都为空的记录）。
  // 因此这种情况取全量再在内存里按语义过滤；代价是读全表，但只发生在查看「未归属」这一个视图时。
  const query = runKey === UNASSIGNED ? { order: 'asc' } : { experiment_run_id: runKey, order: 'asc' };
  const calls = store.listCalls(query).filter(match);
  const events = store.listEvents(query).filter(match);
  if (calls.length === 0 && events.length === 0) return null;

  const pairing = pairingOfCalls(calls, events);
  /** @type {Set<string>} */
  const incompleteIds = new Set(pairing.incomplete.map((entry) => entry.gateway_call_id));
  const callById = new Map(calls.map((call) => [call.gateway_call_id, call]));
  const eventCounts = new Map();
  const missingByCall = new Map(pairing.incomplete.map(item => [item.gateway_call_id, item.missing]));
  /** @type {Map<string, {request: any, terminal: any}>} */
  const byCall = new Map();
  for (const event of events) {
    eventCounts.set(event.gateway_call_id, (eventCounts.get(event.gateway_call_id) ?? 0) + 1);
    if (event.gateway_call_id === null || event.gateway_call_id === undefined) continue;
    const entry = byCall.get(event.gateway_call_id) ?? { request: null, terminal: null };
    if (event.phase === 'request') entry.request = event;
    else if ((event.phase === 'response' || event.phase === 'error') && !entry.terminal) entry.terminal = event;
    byCall.set(event.gateway_call_id, entry);
  }

  const previewChars = options.previewChars ?? 4000;
  const maskFn = typeof options.mask === 'function' ? options.mask : null;

  const rows = events.map((event) => {
    const entry = event.gateway_call_id === null ? null : byCall.get(event.gateway_call_id);
    const isRequest = event.phase === 'request';
    const isTerminal = entry !== null && entry !== undefined && event === entry.terminal;
    const partner = entry ? (isRequest ? entry.terminal : entry.request) : null;
    /** @type {Record<string, any>} */
    const row = {
      event_id: event.event_id,
      gateway_call_id: event.gateway_call_id,
      client_label: event.client_label,
      gateway_id: event.gateway_id,
      upstream_app: event.upstream_app,
      tool_name: event.tool_name,
      method: event.method,
      phase: event.phase,
      status: event.status,
      error_kind: event.error_kind,
      duration_ms: event.monotonic_duration_ms,
      byte_size: event.byte_size,
      truncated: event.truncated === 1,
      protocol_version: event.protocol_version,
      transport: event.transport,
      call_status: callById.get(event.gateway_call_id)?.status ?? null,
      paired: Boolean(partner),
      has_request_json: event.request_json !== null && event.request_json !== undefined,
      has_response_json: event.response_json !== null && event.response_json !== undefined,
      summary_json: null,
      pairing_note: 'n/a',
      pairing_marker: '',
    };
    attachTimes(row, event, [['timestamp_utc', 'timestamp']]);
    if (event.gateway_call_id === null) row.pairing_note = 'n/a（非 tools/call 事件，只留摘要）';
    else if (isRequest) row.pairing_note = partner ? 'paired' : '!! 缺少 response/error';
    else if (isTerminal || event.phase === 'response' || event.phase === 'error') row.pairing_note = partner ? 'paired' : '!! 缺少 request';
    if (row.pairing_note.startsWith('!!')) row.pairing_marker = '!!';
    if (incompleteIds.has(event.gateway_call_id)) row.call_pairing_incomplete = true;

    if (maskFn) {
      const summary = maskFn(event.summary_json === null || event.summary_json === undefined ? null : safeParse(event.summary_json), `summary_json`);
      row.summary_json = summary.value;
      row.payload = {
        request_preview: maskFn(safeParse(event.request_json), 'request_json').value,
        response_preview: maskFn(safeParse(event.response_json), 'response_json').value,
        request_present: row.has_request_json,
        response_present: row.has_response_json,
        payload_omitted: !row.has_request_json && !row.has_response_json,
        preview_chars: previewChars,
      };
    }
    return row;
  });

  const callRows = calls.map((call) => {
    const entry = byCall.get(call.gateway_call_id);
    const row = {
      gateway_call_id: call.gateway_call_id,
      run_id: call.run_id ?? null,
      experiment_run_id: call.experiment_run_id ?? null,
      task_id: /__(?:codex|dsh)__(.+)$/u.exec(call.experiment_run_id ?? '')?.[1] ?? null,
      client_label: call.client_label,
      gateway_id: call.gateway_id,
      upstream_app: call.upstream_app,
      tool_name: call.tool_name,
      method: call.method,
      status: call.status,
      error_category: call.error_kind ?? (call.status === 'ok' ? null : call.status),
      error_message: call.error_message ?? null,
      duration_ms: call.monotonic_duration_ms,
      event_count: eventCounts.get(call.gateway_call_id) ?? 0,
      paired: Boolean(entry?.request) && Boolean(entry?.terminal),
      pairing_incomplete: incompleteIds.has(call.gateway_call_id),
      pairing_marker: incompleteIds.has(call.gateway_call_id) ? '!!' : '',
      missing: missingByCall.get(call.gateway_call_id) ?? [],
    };
    attachTimes(row, call, [
      ['started_at_utc', 'started_at'],
      ['ended_at_utc', 'ended_at'],
    ]);
    return row;
  });

  return {
    calls: annotateCalls(callRows, events),
    events: rows,
    pairing,
    collection: collectionStateOf(events, calls),
    counts: { calls: calls.length, events: events.length },
  };
}

/**
 * @param {unknown} text
 * @returns {*}
 */
export function safeParse(text) {
  if (text === null || text === undefined) return null;
  if (typeof text !== 'string') return text;
  const trimmed = text.trim();
  if (trimmed === '') return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return text;
  }
}
