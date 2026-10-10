/**
 * src/web/api.js — P3 只读 JSON API（W1）
 *
 * 路由（全部 **GET/HEAD**，没有任何写端点）：
 *   GET /api/meta                              服务/库/采集状态/隐私策略/运行计数语义
 *   GET /api/ops                               受控运维入口（删除、保留期、审计导出的 CLI 命令原文）
 *   GET /api/runs[?retention=active|all|expired]  任务列表（登记 vs 隐式分开计数）
 *   GET /api/runs/:id                          单个运行的概要
 *   GET /api/runs/:id/timeline                 调用时间线（成对判定、状态、错误分类、耗时）
 *   GET /api/runs/:id/flows                    流向图数据（四种边界分开返回）
 *   GET /api/runs/:id/edges/:edgeId            单条边证据详情（可回溯到具体请求/响应）
 *   GET /api/runs/:id/export[?format=json|jsonl] 审计导出（默认脱敏）
 *   GET /api/raw?event_id&path&payload&ack&reason  受控查看原文（**审计**）
 *   GET /api/audit                             受控访问的审计记录（内存，只读）
 *
 * 错误语义：`{ok:false, error:{code, message}}`；HTTP 状态码表达请求结果，
 * **绝不**用状态码表达被观测数据的质量（缺配对仍是 200，由 `pairing` 字段表达）。
 */
import { SCHEMA_VERSION } from '../shared/schemaversion.js';
import { createHash } from 'node:crypto';
import { cachedView, compactFlows } from './view_cache.js';
import { parsePath } from '../lineage/index.js';
// 别名：本文件多处把 `path` 当参数名用（如 resolvePath(payload, path)），直接导入会被遮蔽。
import nodePathBasenameModule from 'node:path';
import { listCandidateDatabases } from './databases.js';

/** 事件库的纯文件名（首页文案用；首页不得出现系统字段名，故不直接暴露 db_path）。 */
function nodePathBasename(filePath) {
  try {
    return nodePathBasenameModule.basename(String(filePath));
  } catch {
    return '（未知文件）';
  }
}
import {
  buildRunTimeline,
  collectionStatus,
  collectRunAggregates,
  formatUtcLocal,
  timezoneInfo,
  UNASSIGNED,
} from './aggregate.js';
import { AUDIT_ACTIONS } from './audit.js';
import { buildRunFlows, METRIC_DISCLAIMER } from './edges.js';
import { labelOf, maskPayloadRow, maskPolicy, maskValue, newMaskStats, scanSensitive } from './mask.js';

export const API_PREFIX = '/api/';

/** API 错误（带 HTTP 状态码）。 */
export class ApiError extends Error {
  /**
   * @param {number} status
   * @param {string} code
   * @param {string} message
   */
  constructor(status, code, message) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

/**
 * @param {string} message
 * @returns {never}
 */
export function badRequest(message) {
  throw new ApiError(400, 'bad_request', message);
}

/**
 * @param {string} message
 * @returns {never}
 */
export function notFound(message) {
  throw new ApiError(404, 'not_found', message);
}

/**
 * @param {string} message
 * @returns {never}
 */
export function forbidden(message) {
  throw new ApiError(403, 'forbidden', message);
}

/**
 * @typedef {object} ApiContext
 * @property {{store: Record<string, any> | null, db_exists: boolean, db_bytes: number, open_error: string | null, mode: string}} opened
 * @property {Record<string, any>} config
 * @property {import('./audit.js').AuditLog} audit
 * @property {() => string} now
 * @property {{host: string, port: () => number, url: () => string}} server
 * @property {Record<string, any>} store Readonly store 门面或 null
 */

/**
 * @param {ApiContext} ctx
 * @returns {Record<string, any>} 脱敏策略与审计开关（每个响应都带）
 */
function privacyOf(ctx) {
  return {
    mask_policy: viewPolicy(ctx.config),
    raw_access_enabled: ctx.config.allowRaw === true,
  };
}

function viewPolicy(config) {
  return maskPolicy({ ...config, maskData: config.maskData === true });
}

/**
 * 每个响应都会带上的运行计数语义说明（团队硬约束 1）。
 * @param {number} registered
 * @param {number} implicit
 * @returns {Record<string, any>}
 */
export function runRootCounts(registered, implicit) {
  return {
    registered: {
      count: registered,
      key: 'registered',
      label: '已登记运行',
      cli_semantics: 'bin/trace.js runs 的 REGISTERED=yes（runs 表里显式登记的行）',
    },
    implicit: {
      count: implicit,
      key: 'implicit',
      label: '隐式运行',
      cli_semantics: 'bin/trace.js runs 的 REGISTERED=implicit（只出现在 calls/events 里的 experiment_run_id）',
    },
    total: registered + implicit,
    note:
      '两者是不同来源，必须分开计数：Gateway 采集默认**不建** runs 行，因此仅出现在 calls/events 的运行是正常现象，' +
      '不是「缺登记」缺陷；页面同时显示两个数，不合并。',
  };
}

/**
 * 脱敏函数工厂（值 + 键名提示 → {value, stats}）。
 * @param {Record<string, any>} stats
 * @param {Record<string, any>} config
 * @returns {(value: *, key: string) => {value: *, stats: Record<string, any>}}
 */
function makeMaskFn(stats, config) {
  return (value, key) => ({
    value: config.maskData === true ? maskValue(value, { key, stats, previewChars: config.previewChars }) : value,
    stats,
  });
}

/**
 * 保留期判定：`last_activity_utc` 早于 cutoff 视为过期。
 * @param {Record<string, any>} run
 * @param {number} retentionDays
 * @param {string} nowIso
 * @returns {{expired: boolean, unknown: boolean, last_activity_utc: string | null, cutoff_utc: string | null}}
 */
export function retentionOf(run, retentionDays, nowIso) {
  if (!Number.isFinite(retentionDays) || retentionDays <= 0) {
    return { expired: false, unknown: false, last_activity_utc: run.last_event_utc ?? run.started_at_utc ?? null, cutoff_utc: null };
  }
  const nowMs = new Date(nowIso).getTime();
  const cutoffMs = nowMs - retentionDays * 86400000;
  const cutoffUtc = new Date(cutoffMs).toISOString();
  const lastActivity = run.last_event_utc ?? run.ended_at_utc ?? run.started_at_utc ?? null;
  if (lastActivity === null) return { expired: false, unknown: true, last_activity_utc: null, cutoff_utc: cutoffUtc };
  const lastMs = new Date(lastActivity).getTime();
  if (!Number.isFinite(lastMs)) return { expired: false, unknown: true, last_activity_utc: lastActivity, cutoff_utc: cutoffUtc };
  return { expired: lastMs < cutoffMs, unknown: false, last_activity_utc: lastActivity, cutoff_utc: cutoffUtc };
}

/**
 * 运行列表（含登记/隐式计数、配对、采集状态、保留期过滤明细）。
 * @param {ApiContext} ctx
 * @param {URLSearchParams} query
 * @returns {Record<string, any>}
 */
export function apiRuns(ctx, query) {
  const nowIso = ctx.now();
  const mode = String(query.get('retention') ?? ctx.config.retentionMode ?? 'active').toLowerCase();
  if (!['active', 'all', 'expired'].includes(mode)) {
    badRequest(`retention 只接受 active|all|expired，实际为 ${JSON.stringify(mode)}`);
  }
  const { aggregate, degraded_reason: degradedRuns } = safeAggregate(ctx);
  const withRetention = aggregate.runs.map((run) => {
    const retention = retentionOf(run, ctx.config.retentionDays, nowIso);
    const summary = {
      experiment_run_id: run.experiment_run_id,
      run_id: run.run_id,
      run_key: run.experiment_run_id ?? run.run_id ?? UNASSIGNED,
      client_label: run.client_label,
      registered: run.registered,
      registered_label: run.registered_label,
      notes: run.notes,
      call_count: run.call_count,
      event_count: run.event_count,
      status_summary: run.status_summary,
      error_kinds: run.error_kinds,
      apps: run.apps,
      gateway_ids: run.gateway_ids,
      pairing: run.pairing,
      collection: run.collection,
      retention: { ...retention, days: ctx.config.retentionDays },
    };
    const times = {};
    for (const [field, prefix] of [
      ['started_at_utc', 'started_at'],
      ['ended_at_utc', 'ended_at'],
      ['first_event_utc', 'first_event'],
      ['last_event_utc', 'last_event'],
    ]) {
      const formatted = formatUtcLocal(run[field]);
      times[`${prefix}_utc`] = formatted.utc;
      times[`${prefix}_local`] = formatted.local;
      times[`${prefix}_local_label`] = formatted.local_label;
    }
    return { ...summary, ...times };
  });

  const filteredOut = withRetention.filter((run) => run.retention.expired);
  const selected =
    mode === 'all' ? withRetention : mode === 'expired' ? filteredOut : withRetention.filter((run) => !run.retention.expired);

  return {
    ok: true,
    generated_at_utc: nowIso,
    retention: {
      days: ctx.config.retentionDays,
      enabled: ctx.config.retentionDays > 0,
      mode,
      available_modes: ['active', 'all', 'expired'],
      cutoff_utc: filteredOut.length > 0 ? filteredOut[0].retention.cutoff_utc : retentionOf({ last_event_utc: nowIso }, ctx.config.retentionDays, nowIso).cutoff_utc,
      cutoff_local: formatUtcLocal(retentionOf({ last_event_utc: nowIso }, ctx.config.retentionDays, nowIso).cutoff_utc).local_label,
      filtered_out: {
        count: mode === 'active' ? filteredOut.length : 0,
        run_ids: mode === 'active' ? filteredOut.map((run) => run.run_key) : [],
        reason:
          ctx.config.retentionDays > 0
            ? `最后活动时间早于保留期截止时间（保留期 ${ctx.config.retentionDays} 天）；页面顶部会显示被过滤的运行数，可用 ?retention=all 查看。`
            : '保留期已关闭（--retention-days 0），不过滤任何运行。',
      },
    },
    run_root: runRootCounts(aggregate.totals.registered, aggregate.totals.implicit),
    counts: {
      calls: aggregate.totals.calls,
      events: aggregate.totals.events,
      returned: selected.length,
    },
    load_ms: aggregate.load_ms,
    runs: selected,
    degraded: degradedRuns === null ? null : { reason: degradedRuns, runs_returned: 0 },
    privacy: privacyOf(ctx),
    time: {
      utc_policy: '库内时间一律 UTC ISO-8601 毫秒精度（…Z）；页面同时给出本机时区墙上时间（local_label 显式带 UTC 偏移）。',
      local_timezone: timezoneInfo(),
    },
  };
}

/** 空聚合（库不存在/不可读时的结构一致的响应）。 */
function emptyAggregate() {
  return { runs: [], totals: { registered: 0, implicit: 0, total: 0, calls: 0, events: 0 }, calls: [], events: [], load_ms: 0 };
}

/**
 * 读取聚合结果：库缺失/不可读时降级为空集 + 明确原因，**不抛 500**（页面必须能显示状态）。
 * @param {ApiContext} ctx
 * @returns {{aggregate: Record<string, any>, degraded_reason: string | null}}
 */
function safeAggregate(ctx) {
  if (ctx.store === null) return { aggregate: emptyAggregate(), degraded_reason: storeMissingMessage(ctx) };
  try {
    return { aggregate: collectRunAggregates(ctx.store), degraded_reason: null };
  } catch (error) {
    return {
      aggregate: emptyAggregate(),
      degraded_reason: `只读查询失败：${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/**
 * 单个运行的概要。
 * @param {ApiContext} ctx
 * @param {string} runKey
 * @returns {Record<string, any>}
 */
export function apiRun(ctx, runKey) {
  const { aggregate, degraded_reason: degraded } = safeAggregate(ctx);
  const run = aggregate.runs.find((entry) => entry.experiment_run_id === runKey || entry.run_id === runKey);
  if (!run) {
    notFound(
      degraded === null
        ? `未找到运行：${runKey}（库里既没有 runs 行，也没有属于它的 calls/events）`
        : `未找到运行：${runKey}（${degraded}）`,
    );
  }
  const retention = retentionOf(run, ctx.config.retentionDays, ctx.now());
  const times = {};
  for (const [field, prefix] of [
    ['started_at_utc', 'started_at'],
    ['ended_at_utc', 'ended_at'],
    ['first_event_utc', 'first_event'],
    ['last_event_utc', 'last_event'],
  ]) {
    const formatted = formatUtcLocal(run[field]);
    times[`${prefix}_utc`] = formatted.utc;
    times[`${prefix}_local`] = formatted.local;
    times[`${prefix}_local_label`] = formatted.local_label;
  }
  return {
    ok: true,
    generated_at_utc: ctx.now(),
    run: {
      experiment_run_id: run.experiment_run_id,
      run_id: run.run_id,
      client_label: run.client_label,
      registered: run.registered,
      registered_label: run.registered_label,
      run_root: run.registered ? 'registered' : 'implicit',
      notes: run.notes,
      call_count: run.call_count,
      event_count: run.event_count,
      status_summary: run.status_summary,
      error_kinds: run.error_kinds,
      apps: run.apps,
      gateway_ids: run.gateway_ids,
      pairing: run.pairing,
      collection: run.collection,
      retention: { ...retention, days: ctx.config.retentionDays },
      ...times,
    },
    privacy: privacyOf(ctx),
  };
}

/**
 * 时间线（配对判定 + 脱敏载荷预览）。
 * @param {ApiContext} ctx
 * @param {string} runKey
 * @param {URLSearchParams} query
 * @returns {Record<string, any>}
 */
export function apiTimeline(ctx, runKey, query) {
  if (ctx.store === null) notFound(storeMissingMessage(ctx));
  const limit = query.get('limit');
  const stats = newMaskStats();
  const maskFn = makeMaskFn(stats, ctx.config);
  const timeline = cachedView(ctx, 'timeline:' + runKey + ':' + Boolean(ctx.config.maskData), () => buildRunTimeline(ctx.store, runKey, { previewChars: ctx.config.previewChars, mask: maskFn }));
  if (timeline === null) notFound(`未找到运行：${runKey}（该运行没有任何 calls/events）`);
  let events = Number.isFinite(Number(limit)) && limit !== null ? timeline.events.slice(0, Number(limit)) : timeline.events;
  if (query.get('compact') === '1') events = events.map(event => ({ ...event, summary_json: null, payload: event.payload ? { request_present: event.payload.request_present, response_present: event.payload.response_present, payload_omitted: event.payload.payload_omitted } : null }));
  return {
    ok: true,
    generated_at_utc: ctx.now(),
    experiment_run_id: runKey,
    counts: timeline.counts,
    pairing: timeline.pairing,
    pairing_legend: {
      complete: 'pairing.complete=true 表示每个 tools/call 都有 request 与 response|error。',
      incomplete: 'pairing.incomplete[] 列出缺对调用；页面用 !! 标出，**不用 HTTP 状态码表达数据缺口**。',
      calls_checked: 'pairing.calls_checked = 该运行的 calls 行数；pairing.ok = 其中成对的条数。',
    },
    collection: timeline.collection,
    calls: timeline.calls,
    events,
    events_returned: events.length,
    limit_applied: events.length !== timeline.events.length,
    mask: { ...stats, policy: viewPolicy(ctx.config) },
    privacy: privacyOf(ctx),
    time: { local_timezone: timezoneInfo(), utc_policy: '每个时间点同时给出 *_utc（原始）与 *_local_label（本机时区 + UTC 偏移）。' },
  };
}

/**
 * 流向图数据。
 * @param {ApiContext} ctx
 * @param {string} runKey
 * @returns {Record<string, any>}
 */
export function apiFlows(ctx, runKey, query = new URLSearchParams()) {
  if (ctx.store === null) notFound(storeMissingMessage(ctx));
  const stats = newMaskStats();
  const maskFn = makeMaskFn(stats, ctx.config);
  const fullFlows = cachedView(ctx, 'flows:' + runKey + ':' + Boolean(ctx.config.maskData), () => buildRunFlows(ctx.store, runKey, { maskFn }));
  const flows = query.get('compact') === '1' ? cachedView(ctx, 'compact-flows:' + runKey + ':' + Boolean(ctx.config.maskData), () => compactFlows(fullFlows)) : fullFlows;
  if ((flows.counts?.source_fields ?? 0) === 0 && (flows.counts?.sink_fields ?? 0) === 0) {
    const timeline = buildRunTimeline(ctx.store, runKey);
    if (timeline === null) notFound(`未找到运行：${runKey}（该运行没有任何 calls/events）`);
  }
  return {
    ok: true,
    generated_at_utc: ctx.now(),
    ...flows,
    mask: { ...stats, policy: viewPolicy(ctx.config) },
    privacy: privacyOf(ctx),
  };
}

/**
 * 单条边证据详情：可回溯到具体 MCP 请求与响应（event_id / gateway_call_id / JSON 路径 / 规则 / 置信级别）。
 * @param {ApiContext} ctx
 * @param {string} runKey
 * @param {string} edgeId
 * @returns {Record<string, any>}
 */
export function apiEdgeDetail(ctx, runKey, edgeId) {
  if (ctx.store === null) notFound(storeMissingMessage(ctx));
  const stats = newMaskStats();
  const maskFn = makeMaskFn(stats, ctx.config);
  const flows = buildRunFlows(ctx.store, runKey, { maskFn });
  const all = [...flows.edges.observed, ...flows.edges.inferred];
  const edge = all.find((candidate) => candidate.edge_id === edgeId);
  if (!edge) notFound(`未找到边：${edgeId}（运行 ${runKey} 内没有这个 edge_id；edge_id 由 representation|rule|事件|路径 派生，删除或重采后可能变化）`);

  const events = ctx.store.listEvents({ experiment_run_id: runKey });
  const sourceEvent = events.find((event) => event.event_id === edge.source_event_id) ?? null;
  const sinkEvent = events.find((event) => event.event_id === edge.sink_event_id) ?? null;

  /**
   * @param {Record<string, any> | null} event
   * @param {string} purpose
   * @returns {Record<string, any> | null}
   */
  function endpoint(event, purpose) {
    if (event === null) return null;
    // 载荷方向的**提示**（写侧路径以 params 开头 → request；读侧以 result 开头 → response）；
    // 受控查看接口实际按 auto 两payload 依次尝试，不依赖该提示。
    const payloadHint = String(edge[`${purpose}_json_path`] ?? '').startsWith('result') ? 'response' : 'request';
    return {
      event_id: event.event_id,
      gateway_call_id: event.gateway_call_id,
      gateway_id: event.gateway_id,
      upstream_app: event.upstream_app,
      tool_name: event.tool_name,
      method: event.method,
      phase: event.phase,
      status: event.status,
      error_kind: event.error_kind,
      transport: event.transport,
      protocol_version: event.protocol_version,
      timestamp_utc: event.timestamp_utc,
      timestamp_local_label: formatUtcLocal(event.timestamp_utc).local_label,
      byte_size: event.byte_size,
      truncated: event.truncated === 1,
      json_path: edge[`${purpose}_json_path`],
      json_paths: edge[`${purpose}_json_paths`] ?? [],
      payload_hint: payloadHint,
      payload_preview: maskFn(
        payloadHint === 'response' ? safeJson(event.response_json) : safeJson(event.request_json),
        `${purpose}_json`,
      ).value,
      raw_access: {
        url_without_gate: `/api/raw?payload=auto&event_id=${encodeURIComponent(event.event_id)}&path=${encodeURIComponent(edge[`${purpose}_json_path`] ?? '')}`,
        requires: ctx.config.maskData === true ? ['ack=1', `reason（≥${ctx.config.revealReasonMinLength} 字符）`] : [],
        audited: true,
      },
    };
  }

  return {
    ok: true,
    generated_at_utc: ctx.now(),
    experiment_run_id: runKey,
    edge,
    traceability: {
      summary:
        `${edge.source_upstream_app ?? '?'}（${edge.source_tool_name ?? '?'}，${edge.source_phase}）` +
        `${edge.source_json_path} → ${edge.sink_upstream_app ?? '?'}（${edge.sink_tool_name ?? '?'}，${edge.sink_phase}）${edge.sink_json_path}`,
      rule: edge.rule,
      representation: edge.representation,
      confidence: edge.confidence,
      confidence_reasons: edge.confidence_reasons,
      boundary: edge.boundary,
      boundary_label: edge.boundary_label,
      source: endpoint(sourceEvent, 'source'),
      sink: endpoint(sinkEvent, 'sink'),
      evidence: edge.evidence,
      hash_usage: flows.hash_policy,
      cross_run_check: flows.cross_run_check,
    },
    mask: { ...stats, policy: viewPolicy(ctx.config) },
    privacy: privacyOf(ctx),
  };
}

/**
 * @param {unknown} text
 * @returns {*}
 */
function safeJson(text) {
  if (typeof text !== 'string' || text.trim() === '') return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/**
 * 审计导出（默认脱敏；`reveal=1` 时为受控原文导出，需 ack+reason 并写审计）。
 * @param {ApiContext} ctx
 * @param {string} runKey
 * @param {URLSearchParams} query
 * @param {Record<string, any>} client
 * @returns {{status: number, contentType: string, body: string, audit?: Record<string, any>}}
 */
export function apiExport(ctx, runKey, query, client = {}) {
  if (ctx.store === null) notFound(storeMissingMessage(ctx));
  const includeEvents = query.get('include_events') !== '0' && query.get('include_events') !== 'false';
  const ownerView = ctx.config.maskData !== true;
  const reveal = ownerView || ['1', 'true', 'yes'].includes(String(query.get('reveal') ?? '').toLowerCase());
  const reason = String(query.get('reason') ?? '').trim();
  const format = String(query.get('format') ?? 'json').toLowerCase();
  if (!['json', 'jsonl'].includes(format)) badRequest(`format 只接受 json|jsonl，实际为 ${JSON.stringify(format)}`);

  let auditEntry = null;
  let exportCalls;
  let exportEvents;
  let maskStats = newMaskStats();
  if (reveal) {
    if (!ownerView) requireReveal(ctx, query, reason);
    if (!ownerView && !includeEvents) badRequest('原文导出必须包含事件（不要传 include_events=0）');
    auditEntry = ctx.audit.record({
      action: AUDIT_ACTIONS.EXPORT_RAW,
      target_kind: 'audit_export',
      reason,
      client,
      detail: { experiment_run_id: runKey, format, include_events: true },
    });
    exportCalls = ctx.store.listCalls({ experiment_run_id: runKey, order: 'asc' });
    exportEvents = includeEvents ? ctx.store.listEvents({ experiment_run_id: runKey, order: 'asc' }) : [];
  } else {
    exportCalls = ctx.store
      .listCalls({ experiment_run_id: runKey, order: 'asc' })
      .map((call) => maskPayloadRow(call, { stats: maskStats, previewChars: ctx.config.previewChars }).value);
    exportEvents = includeEvents
      ? ctx.store
          .listEvents({ experiment_run_id: runKey, order: 'asc' })
          .map((event) => maskPayloadRow(event, { stats: maskStats, previewChars: ctx.config.previewChars }).value)
      : [];
  }
  if (exportCalls.length === 0 && exportEvents.length === 0) {
    notFound(`未找到运行：${runKey}（该运行没有任何 calls/events 可导出）`);
  }

  const header = {
    export_kind: 'mcp-cross-app-trace/p3-audit-export',
    schema_version: SCHEMA_VERSION,
    exported_at_utc: ctx.now(),
    db_path: ctx.config.dbPath,
    experiment_run_id: runKey,
    masked: reveal !== true,
    mask_mode: ownerView ? 'original_values' : reveal ? 'controlled_raw' : 'category_and_masked_value',
    raw_export_audit_id: auditEntry?.audit_id ?? null,
    reason: reveal ? reason : null,
    note: ownerView ? '个人工作台导出原始数据，不在服务端落盘。' : reveal
      ? '这是受控原文导出：已写入审计记录，原文值不进入页面缓存。'
      : '默认导出为脱敏投影（类别 + 脱敏值）；需要原文请用 reveal=1&ack=1&reason=… 并会被审计。',
  };

  if (format === 'jsonl') {
    const lines = [JSON.stringify(header)];
    for (const call of exportCalls) lines.push(JSON.stringify({ kind: 'call', ...call }));
    for (const event of exportEvents) lines.push(JSON.stringify({ kind: 'event', ...event }));
    return { status: 200, contentType: 'application/x-ndjson; charset=utf-8', body: `${lines.join('\n')}\n`, audit: auditEntry ?? undefined };
  }

  const document = { ...header, calls: exportCalls, events: exportEvents, counts: { calls: exportCalls.length, events: exportEvents.length } };
  return { status: 200, contentType: 'application/json; charset=utf-8', body: JSON.stringify(document, null, 2), audit: auditEntry ?? undefined };
}

/**
 * 受控查看原文（要求 6）：必须显式确认 + 给出理由，且每次都写审计记录。
 * @param {ApiContext} ctx
 * @param {URLSearchParams} query
 * @param {Record<string, any>} client
 * @returns {Record<string, any>}
 */
export function apiRaw(ctx, query, client = {}) {
  const reason = String(query.get('reason') ?? '').trim();
  requireReveal(ctx, query, reason);
  if (ctx.store === null) notFound(storeMissingMessage(ctx));

  const eventId = String(query.get('event_id') ?? '').trim();
  if (eventId === '') badRequest('缺少 event_id：受控查看原文必须指定具体事件，不支持整库导出');
  const requestedPath = String(query.get('path') ?? '').trim();
  const payloadMode = String(query.get('payload') ?? 'auto').toLowerCase();
  if (!['auto', 'request', 'response'].includes(payloadMode)) badRequest('payload 只接受 auto|request|response');

  const event = ctx.store.listEvents({ event_id: eventId })[0] ?? null;
  if (event === null) notFound(`未找到事件：${eventId}`);

  /** @type {Array<{name: string, text: string | null}>} */
  const candidates =
    payloadMode === 'auto'
      ? [
          { name: 'request', text: event.request_json ?? null },
          { name: 'response', text: event.response_json ?? null },
        ]
      : [{ name: payloadMode, text: payloadMode === 'request' ? event.request_json ?? null : event.response_json ?? null }];

  const available = candidates.filter((candidate) => candidate.text !== null && candidate.text !== undefined);
  if (available.length === 0) {
    notFound(
      `事件 ${eventId} 没有保留原始载荷（原始数据采集可能已关闭，或 payload 被截断/排除）：` +
        '页面不推断、不补全；请核对采集设置，确认是否保存了原始请求和响应。',
    );
  }

  let chosen = available[0];
  let value = safeJson(chosen.text);
  let resolvedPath = '';
  if (requestedPath !== '') {
    /** @type {{name: string, value: *} | null} */
    let hit = null;
    for (const candidate of available) {
      const parsed = safeJson(candidate.text);
      const located = resolvePath(parsed, requestedPath);
      if (located.found) {
        hit = { name: candidate.name, value: located.value };
        break;
      }
    }
    if (hit === null) {
      notFound(`在事件 ${eventId} 的原始载荷里找不到路径 ${requestedPath}（不推断、不补全，故直接 404）`);
    }
    chosen = { name: hit.name, text: chosen.text };
    value = hit.value;
    resolvedPath = requestedPath;
  }

  const entry = ctx.audit.record({
    action: AUDIT_ACTIONS.REVEAL_RAW,
    target_kind: resolvedPath === '' ? 'payload' : 'field',
    event_id: eventId,
    gateway_call_id: event.gateway_call_id ?? null,
    payload: chosen.name,
    json_path: resolvedPath,
    reason,
    client,
    detail: { experiment_run_id: event.experiment_run_id ?? null, upstream_app: event.upstream_app ?? null, tool_name: event.tool_name ?? null },
  });

  const scan = scanSensitive(value, {});
  return {
    ok: true,
    generated_at_utc: ctx.now(),
    reveal: {
      event_id: eventId,
      gateway_call_id: event.gateway_call_id ?? null,
      experiment_run_id: event.experiment_run_id ?? null,
      payload: chosen.name,
      json_path: resolvedPath === '' ? '(整个载荷)' : resolvedPath,
      value,
      value_type: Array.isArray(value) ? 'array' : typeof value,
      sensitive_fields_in_value: scan,
    },
    audit: { audit_id: entry.audit_id, at_utc: entry.at_utc, reason: entry.reason, persisted: false },
    warnings: [
      '本次访问已写入内存审计记录（页面「审计记录」区可见，进程重启即清空）。',
      ctx.config.maskData === true ? '原文仅供本机查看，请妥善保管，避免通过截图或导出泄露。' : '个人工作台直接显示操作数据。',
      ctx.config.maskData === true ? '当前展示脱敏。' : '当前为个人工作台，数据直接显示。',
    ],
  };
}

/**
 * 受控查看原文的准入检查（缺一即拒）。
 * @param {ApiContext} ctx
 * @param {URLSearchParams} query
 * @param {string} reason
 */
export function requireReveal(ctx, query, reason) {
  if (ctx.config.allowRaw !== true) {
    forbidden('本服务以 --no-raw-access 启动：禁止查看原文。重启时不加该参数即可临时开启（每次访问都会被审计）。');
  }
  if (ctx.config.maskData !== true) return;
  const ack = String(query.get('ack') ?? '').toLowerCase();
  if (!['1', 'true', 'yes'].includes(ack)) {
    badRequest('受控查看原文需要显式确认：请带 ack=1（页面上的「我确认本次查看会被审计」勾选后再提交）。');
  }
  const min = ctx.config.revealReasonMinLength ?? 3;
  if (reason.length < min) {
    badRequest(`受控查看原文需要填写理由（至少 ${min} 个字符，写在页面理由框里，会进入审计记录）`);
  }
}

/**
 * JSON 路径取值（不推断、不补全：不存在就是不存在）。
 * 路径记法与 L1 一致（`src/lineage/paths.js`）；文本锚点路径（`…#phone[0]`）不是 JSON 路径，
 * 一律返回 not_found（页面对文本锚点走「整个载荷」的受控查看）。
 * @param {*} payload
 * @param {string} path
 * @returns {{found: boolean, value: *, reason?: string}}
 */
export function resolvePath(payload, path) {
  if (path === '') return { found: true, value: payload };
  if (path.includes('#')) {
    return { found: false, value: null, reason: 'text_anchor_path_is_not_json_path' };
  }
  /** @type {Array<string | number>} */
  let segments;
  try {
    segments = parsePath(path);
  } catch {
    return { found: false, value: null, reason: 'path_syntax_error' };
  }
  let current = payload;
  for (const segment of segments) {
    if (current === null || current === undefined) return { found: false, value: null, reason: 'path_not_present' };
    if (typeof segment === 'number') {
      if (!Array.isArray(current) || segment >= current.length) return { found: false, value: null, reason: 'path_not_present' };
      current = current[segment];
      continue;
    }
    if (typeof current !== 'object' || !Object.prototype.hasOwnProperty.call(current, segment)) {
      return { found: false, value: null, reason: 'path_not_present' };
    }
    current = current[segment];
  }
  return { found: true, value: current === undefined ? null : current };
}

/**
 * 服务与库的状态（要求 8：原始数据采集开启/关闭/已删除必须可见）。
 * @param {ApiContext} ctx
 * @returns {Record<string, any>}
 */
export function apiMeta(ctx) {
  const nowIso = ctx.now();
  const collection = collectionStatus(ctx.opened, ctx.config.dbPath);
  let stats = null;
  let runCounts = { registered: 0, implicit: 0 };
  let secretScan = { fields: 0, by_category: {}, secret_paths: [] };
  if (ctx.store !== null) {
    try {
      const aggregate = collectRunAggregates(ctx.store);
      runCounts = { registered: aggregate.totals.registered, implicit: aggregate.totals.implicit };
      stats = ctx.store.stats();
    } catch (error) {
      collection.state = 'unreadable';
      collection.label = '原始数据采集：库不可读';
      collection.detail = `只读查询失败：${error instanceof Error ? error.message : String(error)}`;
    }
  }
  if (ctx.store !== null && collection.state !== 'unreadable') {
    try {
      for (const event of ctx.store.listEvents({ limit: 500 })) {
        const found = scanSensitive({ request: safeJson(event.request_json), response: safeJson(event.response_json), summary: safeJson(event.summary_json) });
        secretScan.fields += found.fields;
        for (const [key, value] of Object.entries(found.by_category)) {
          secretScan.by_category[key] = (secretScan.by_category[key] ?? 0) + Number(value);
        }
        for (const path of found.secret_paths) if (secretScan.secret_paths.length < 50) secretScan.secret_paths.push(path);
      }
    } catch {
      // 扫描失败不影响主状态（已在上面记录 unreadable）
    }
  }

  // 库发现：**只在当前库没有任何调用时**才扫描候选库。
  // 理由：自动刷新每轮都会拉 /api/meta，扫描文件系统不能变成常态化开销；
  // 而「当前库为空」正是用户会问「我的数据呢」的那一刻 —— 那时给出候选库才最有价值。
  //
  // 同时给一份**给首页用的安全文案** `store.file_label`：首页有一条硬约束 ——
  // 不得出现系统字段名（`db_path`/`db_bytes`/`journal_mode`… 由 tests/web_api.test.js 的
  // 禁止词表逐词断言）。所以首页不直接读 `store.db_path`，而是用这里给出的纯文件名标签。
  // （2026-10-05：我第一版在 app.js 里直接写了 `store.db_path`，当场把那条契约弄红。）
  let availableDatabases = [];
  const currentCalls = Number(stats?.calls ?? 0);
  if (currentCalls === 0) {
    try {
      availableDatabases = listCandidateDatabases(ctx.config.dbPath, {
        // 用配置里的 cwd 作仓库根 —— 不要从 dbPath 反推（`../..` 在 db 位于更深目录时是错的）。
        repoRoot: ctx.config.cwd,
      });
    } catch {
      availableDatabases = [];
    }
  }

  return {
    ok: true,
    generated_at_utc: nowIso,
    available_databases: availableDatabases,
    view_key: createHash('sha256').update(ctx.config.dbPath).digest('hex').slice(0, 20),
    service: {
      name: 'mcp-cross-app-trace-web',
      version: '0.1.0',
      url: ctx.server.url(),
      host: ctx.server.host,
      port: ctx.server.port(),
      read_only: true,
      write_endpoints: [],
      configuration_endpoints: ['/api/settings/monitoring'],
      allowed_methods: ['GET', 'HEAD'],
      write_guard: [
        'SQLite 连接以 readOnly:true 打开（写操作报 attempt to write a readonly database）。',
        'store 门面只暴露查询方法白名单，任何写方法调用直接抛错。',
        'HTTP 层只接受 GET/HEAD，其余方法返回 405 并给出 CLI 受控入口。',
      ],
      note: '删除/重置/压缩等改库动作一律走 CLI 受控入口（页面只显示命令原文，不代执行）。',
    },
    store: {
      db_path: ctx.config.dbPath,
      db_exists: ctx.opened.db_exists,
      db_bytes: ctx.opened.db_bytes,
      open_mode: ctx.opened.mode,
      open_error: ctx.opened.open_error,
      schema_version: stats?.schema_version ?? null,
      ddl_version: stats?.ddl_version ?? null,
      journal_mode: null,
      // 首页可安全展示的标签（纯文件名）：首页禁止出现系统字段名，故不让它读 db_path。
      file_label: nodePathBasename(ctx.config.dbPath),
    },
    collection,
    run_root: runRootCounts(runCounts.registered, runCounts.implicit),
    counts: {
      calls: stats?.calls ?? collection.evidence.calls ?? 0,
      events: stats?.events ?? collection.evidence.events ?? 0,
      truncated_events: stats?.truncated_events ?? null,
      calls_by_status: stats?.calls_by_status ?? [],
      events_by_phase: stats?.events_by_phase ?? [],
      write_failures: stats?.write_failures ?? null,
    },
    secrets: {
      scan_scope: '最多扫描最近 500 条事件；统计的是「疑似」敏感/密钥字段个数。',
      fields_detected: secretScan.fields,
      by_category: secretScan.by_category,
      path_samples: secretScan.secret_paths.slice(0, 20),
      policy: ctx.config.maskData === true
        ? '当前已启用脱敏，疑似令牌/密钥显示 <redacted:secret>；事件库原始数据不变。'
        : '个人工作台直接显示操作载荷中的原始数据；此处只统计已有字段，不读取额外凭证文件。',
    },
    retention: {
      days: ctx.config.retentionDays,
      enabled: ctx.config.retentionDays > 0,
      default_mode: ctx.config.retentionMode,
      cutoff_utc: retentionOf({ last_event_utc: nowIso }, ctx.config.retentionDays, nowIso).cutoff_utc,
      cutoff_local_label: formatUtcLocal(retentionOf({ last_event_utc: nowIso }, ctx.config.retentionDays, nowIso).cutoff_utc).local_label,
      delete_boundary: '保留期只影响列表过滤与提示；真正删除必须由运维执行 CLI（页面没有改库端点）。',
    },
    time: {
      utc_policy: '库内时间一律 UTC ISO-8601 毫秒精度（…Z）；展示为「本机时区墙上时间 + UTC 偏移」并始终保留 *_utc 原值。',
      local_timezone: timezoneInfo(),
      now_utc: nowIso,
      now_local_label: formatUtcLocal(nowIso).local_label,
    },
    mask: viewPolicy(ctx.config),
    secrets_placeholder_examples: [labelOf('phone'), labelOf('email'), labelOf('secret')],
    audit: ctx.audit.summary(),
    metrics: { disclaimer: METRIC_DISCLAIMER },
  };
}

/**
 * 受控运维入口（页面「隐私与运维」区显示命令原文）。
 * @param {ApiContext} ctx
 * @returns {Record<string, any>}
 */
export function apiOps(ctx) {
  const db = ctx.config.dbPath;
  return {
    ok: true,
    generated_at_utc: ctx.now(),
    read_only_boundary: {
      statement: '页面服务是只读的：没有任何改库端点；HTTP 写方法一律 405。',
      enforced_by: ['SQLite readOnly 连接', 'store 查询方法白名单门面', 'HTTP 仅 GET/HEAD'],
    },
    commands: [
      {
        key: 'delete_run',
        label: '按运行删除',
        purpose: '删除某个实验运行的 calls + events + runs（一个事务内完成）。',
        command: `node bin/trace.js delete --run <experiment_run_id> --db "${db}"`,
        dry_run_command: `node bin/trace.js delete --run <experiment_run_id> --db "${db}" --dry-run`,
        cli_doc: 'bin/trace.js delete（S2 交付的受控运维入口）',
      },
      {
        key: 'retention_list',
        label: '保留期查看（不改库）',
        purpose: `页面服务按 --retention-days=${ctx.config.retentionDays} 过滤列表并显示过期运行；查看全部用 ?retention=all。`,
        command: `node bin/web.js --db "${db}" --retention-days ${ctx.config.retentionDays} --retention-mode active`,
        cli_doc: '保留期设置只影响展示过滤；删除仍需逐运行执行 delete_run。',
      },
      {
        key: 'audit_export',
        label: 'CLI 审计导出（**默认未脱敏原文**）',
        purpose:
          '把该运行的 calls/events 快照写成文件。CLI 是用户本机主动发起的导出，因此**默认写未脱敏原文**' +
          '（产物 masked=false，请自行保管并限期删除）；需要脱敏投影请加 --mask（产物 masked=true）。',
        command: `node bin/trace.js export --run <experiment_run_id> --out demo-data/tmp/audit-export.json --db "${db}"`,
        dry_run_command: `node bin/trace.js export --run <experiment_run_id> --out demo-data/tmp/audit-export.json --mask --db "${db}"`,
        cli_doc:
          ctx.config.maskData === true ? '当前页面启用脱敏导出（masked=true）；CLI 默认原文（masked=false）。' : '当前页面和 CLI 默认均导出原始数据（masked=false）。',
      },
      {
        key: 'page_export',
        label: ctx.config.maskData === true ? '页面审计导出（脱敏，不落盘）' : '页面操作数据导出（原始数据，不落盘）',
        purpose: ctx.config.maskData === true ? '页面导出为脱敏投影（masked=true），不在服务端落盘。' : '页面导出原始数据（masked=false），不在服务端落盘。',
        page_api: '/api/runs/<experiment_run_id>/export?format=json（只读 JSON 文档，不落盘）',
        cli_doc: '页面导出的 JSONL 首行是导出头对象（export_kind=mcp-cross-app-trace/p3-audit-export，带 masked）；与 CLI 导出首行形状不同。',
      },
      {
        key: 'audit_export_raw',
        label: '审计导出（受控原文）',
        purpose: ctx.config.maskData === true ? '需要原文时必须带 ack=1 与理由，且会写入审计记录。' : '个人工作台直接导出原始数据，无需填写理由。',
        command: `GET /api/runs/<experiment_run_id>/export?reveal=1&ack=1&reason=<纯文字理由>&format=json`,
        cli_doc: '原文导出包含业务数据，请妥善保管。',
      },
      {
        key: 'reset_events',
        label: '清空事件库内容',
        purpose: '清空 calls/events/runs（保留库文件）。',
        command: 'node bin/reset.js --events --yes',
        cli_doc: 'node bin/reset.js 默认只清 Mock Calendar 数据。',
      },
      {
        key: 'delete_db_file',
        label: '删除事件库文件',
        purpose: '删除库文件本身（页面会显示「原始数据采集：已删除」）。',
        command: 'node bin/reset.js --delete-db-file --yes',
        cli_doc: '执行后必须重启页面服务（只读连接在文件被删后不再有效）。',
      },
    ],
    audit_export_endpoint: {
      read_only: true,
      writes_files: false,
      formats: ['json', 'jsonl'],
      default_masked: ctx.config.maskData === true,
    },
  };
}

/**
 * @param {ApiContext} ctx
 * @returns {Record<string, any>}
 */
export function apiAudit(ctx, query) {
  const limit = query?.get?.('limit');
  return {
    ok: true,
    generated_at_utc: ctx.now(),
    summary: ctx.audit.summary(),
    entries: ctx.audit.list({ limit: Number.isFinite(Number(limit)) && limit !== null ? Number(limit) : undefined }),
    note:
      '审计记录只针对「受控查看原文 / 原文导出」两类操作；记录内不保存被查看的原文值，' +
      '只保存目标（event_id、payload、JSON 路径）、理由、访问来源与时间。',
  };
}

/**
 * @param {ApiContext} ctx
 * @returns {string}
 */
function storeMissingMessage(ctx) {
  return ctx.opened.db_exists
    ? `事件库不可读：${ctx.opened.open_error ?? '未知原因'}`
    : `事件库不存在：${ctx.config.dbPath}（没有可查询的数据；原始数据采集状态显示为「已删除」）`;
}

export { METRIC_DISCLAIMER };
