/**
 * src/demo/evidence.js — 演示证据的**唯一 schema 与校验算法**（G1）
 *
 * 两条运行路径（`inproc` / `subprocess`）都调用本模块的同一段代码生成证据，因此
 * **结构（键集合与嵌套形状）逐字相同**，只有「观测来源」类字段不同（`environment.*`、
 * `transport_frames.*.source`），便于 V1 逐字段对比。
 *
 * 证据的核心四块（计划书/任务契约要求）：
 *   1. `call_sequence` —— 调用序列（每个 tools/call 一行，含 gateway_call_id 与事件定位）；
 *   2. `pairing`       —— 按 gateway_call_id 的 request/response(或 error) 全配对校验；
 *   3. `calendar`      —— Calendar 写入内容（请求值、返回、磁盘内容、与 Mail 记录的一致性）；
 *   4. `db_query`      —— 数据库查询结果（calls/events/stats/integrity_check）。
 *
 * 不夸大：`pairing` 只对**经 Gateway 采集到库**的调用负责；未被 Gateway 覆盖的调用（例如
 * 直连 Mock Server 的协议回归）不在证据里冒充「已被追踪」。
 */
import fs from 'node:fs';
import path from 'node:path';

import { digestOf, parseJsonSafe, stableStringify } from '../shared/json.js';

/** 证据 schema 版本（与 相关实现 的事件 schema 版本相互独立）。 */
export const EVIDENCE_SCHEMA = 'mcp-cross-app-trace/demo-evidence/1';


/** 单条载荷在证据文件里的保留上限（字符）。 */
export const EVIDENCE_PAYLOAD_LIMIT = 4096;

/** 对比两份证据（两条路径）时**必须逐字段一致**的键。 */
export const COMPARABLE_KEYS = Object.freeze(['call_sequence', 'pairing', 'calendar', 'db_query']);

/**
 * @param {unknown} value
 * @param {number} [limit]
 * @returns {string|null}
 */
function boundedText(value, limit = EVIDENCE_PAYLOAD_LIMIT) {
  if (typeof value !== 'string') return null;
  if (value.length <= limit) return value;
  return `${value.slice(0, limit)}…[truncated:${value.length}]`;
}

/**
 * 单个 JSON-RPC 帧是否合法（"stdout 只有协议帧" 的可证伪判定）。
 * @param {string} text
 * @returns {{ok: boolean, reason?: string, message?: any}}
 */
export function parseProtocolFrame(text) {
  const parsed = parseJsonSafe(text);
  if (!parsed.ok) return { ok: false, reason: 'not_json', message: text.slice(0, 200) };
  const frame = /** @type {any} */ (parsed.value);
  if (frame === null || typeof frame !== 'object' || Array.isArray(frame)) {
    return { ok: false, reason: 'not_object', message: frame };
  }
  if (frame.jsonrpc !== '2.0') return { ok: false, reason: 'bad_jsonrpc_version', message: frame.jsonrpc ?? null };
  const hasMethod = typeof frame.method === 'string';
  const hasResult = Object.prototype.hasOwnProperty.call(frame, 'result');
  const hasError = Object.prototype.hasOwnProperty.call(frame, 'error');
  if (!hasMethod && !hasResult && !hasError) return { ok: false, reason: 'no_method_result_error', message: frame };
  return { ok: true, message: frame };
}

/**
 * 帧集合报告：总帧数、合法 JSON-RPC 帧数、非法帧样本、稳定摘要。
 * @param {readonly string[]} texts
 * @param {string} observer 观测来源说明
 * @returns {Record<string, any>}
 */
export function frameReport(texts, observer) {
  const frames = texts.filter((text) => String(text).trim() !== '');
  const bad = [];
  for (const text of frames) {
    const parsed = parseProtocolFrame(text);
    if (!parsed.ok) bad.push({ reason: parsed.reason, sample: String(text).slice(0, 200) });
  }
  return {
    observer,
    frames_total: frames.length,
    jsonrpc_frames: frames.length - bad.length,
    non_jsonrpc_frames: bad.length,
    all_jsonrpc: bad.length === 0 && frames.length > 0,
    sha256: frames.length > 0 ? digestOf(frames.join('\n')) : null,
    first_frame_preview: frames.length > 0 ? String(frames[0]).slice(0, 200) : null,
    non_jsonrpc_samples: bad.slice(0, 3),
  };
}

/**
 * 按 gateway_call_id 校验 request/response(或 error) 全配对。
 *
 * 判定（任一不满足即 `paired=false`，并给出稳定 problem 码）：
 *   - 恰好 1 条 phase=request；
 *   - 恰好 1 条 phase in {response, error}；
 *   - request.timestamp_utc <= terminal.timestamp_utc；
 *   - terminal.status 与 calls.status 一致；
 *   - 库中不存在带该 gateway_call_id 但 phase 不属于 {request,response,error} 的事件；
 *   - 不存在「有 gateway_call_id 但没有 calls 行」的孤儿事件。
 * @param {{calls: Array<Record<string, any>>, events: Array<Record<string, any>>}} input
 * @returns {Record<string, any>}
 */
export function verifyPairing(input) {
  const calls = input.calls ?? [];
  const events = input.events ?? [];
  const callIds = new Set(calls.map((call) => call.gateway_call_id));

  /** @type {Map<string, Array<Record<string, any>>>} */
  const byCall = new Map();
  /** @type {Array<Record<string, any>>} */
  const orphans = [];
  for (const event of events) {
    if (event.gateway_call_id === null || event.gateway_call_id === undefined) continue;
    if (!callIds.has(event.gateway_call_id)) {
      orphans.push({
        event_id: event.event_id,
        gateway_call_id: event.gateway_call_id,
        phase: event.phase,
        reason: 'orphan_event_without_call_row',
      });
      continue;
    }
    const list = byCall.get(event.gateway_call_id) ?? [];
    list.push(event);
    byCall.set(event.gateway_call_id, list);
  }

  /** @type {Array<Record<string, any>>} */
  const details = [];
  /** @type {Array<Record<string, any>>} */
  const failures = [];
  for (const call of calls) {
    const list = byCall.get(call.gateway_call_id) ?? [];
    const requests = list.filter((event) => event.phase === 'request');
    const terminals = list.filter((event) => event.phase === 'response' || event.phase === 'error');
    const unexpected = list.filter((event) => !['request', 'response', 'error'].includes(event.phase));
    /** @type {string[]} */
    const problems = [];
    if (requests.length === 0) problems.push('missing_request');
    if (requests.length > 1) problems.push('duplicate_request');
    if (terminals.length === 0) problems.push('missing_response_or_error');
    if (terminals.length > 1) problems.push('duplicate_response_or_error');
    if (unexpected.length > 0) problems.push('unexpected_phase_with_call_id');
    if (requests.length === 1 && terminals.length === 1) {
      if (String(requests[0].timestamp_utc) > String(terminals[0].timestamp_utc)) problems.push('phase_out_of_order');
      if ((terminals[0].status ?? null) !== (call.status ?? null)) problems.push('terminal_status_mismatch');
      if ((terminals[0].tool_name ?? null) !== (call.tool_name ?? null)) problems.push('terminal_tool_name_mismatch');
    }
    const paired = problems.length === 0;
    details.push({
      gateway_call_id: call.gateway_call_id,
      gateway_id: call.gateway_id ?? null,
      upstream_app: call.upstream_app ?? null,
      tool_name: call.tool_name ?? null,
      call_status: call.status ?? null,
      request_event_ids: requests.map((event) => event.event_id),
      terminal_event_ids: terminals.map((event) => event.event_id),
      terminal_phases: terminals.map((event) => event.phase),
      paired,
      problems,
    });
    if (!paired) failures.push({ gateway_call_id: call.gateway_call_id, tool_name: call.tool_name ?? null, problems });
  }

  for (const orphan of orphans) failures.push({ gateway_call_id: orphan.gateway_call_id, problems: [orphan.reason] });

  return {
    calls_total: calls.length,
    calls_paired: details.filter((detail) => detail.paired).length,
    all_paired: failures.length === 0 && calls.length > 0,
    orphan_events: orphans,
    details,
    failures,
  };
}

/**
 * 由 calls + events 生成调用序列（tools/call 视角）与时间线（全部事件视角）。
 * @param {{calls: Array<Record<string, any>>, events: Array<Record<string, any>>}} input
 * @returns {{call_sequence: Array<Record<string, any>>, timeline: Array<Record<string, any>>}}
 */
export function buildCallSequence(input) {
  const calls = [...(input.calls ?? [])].sort(
    (a, b) =>
      String(a.timestamp_utc).localeCompare(String(b.timestamp_utc)) ||
      String(a.gateway_call_id).localeCompare(String(b.gateway_call_id)),
  );
  const events = input.events ?? [];
  const call_sequence = calls.map((call, index) => {
    const own = events.filter((event) => event.gateway_call_id === call.gateway_call_id);
    const requests = own.filter((event) => event.phase === 'request');
    const terminals = own.filter((event) => event.phase === 'response' || event.phase === 'error');
    return {
      index: index + 1,
      gateway_call_id: call.gateway_call_id,
      gateway_id: call.gateway_id ?? null,
      upstream_app: call.upstream_app ?? null,
      client_label: call.client_label ?? null,
      tool_name: call.tool_name ?? null,
      method: call.method ?? null,
      phase_chain: `${requests[0]?.phase ?? '(missing)'}→${terminals[0]?.phase ?? '(missing)'}`,
      status: call.status ?? null,
      error_kind: call.error_kind ?? null,
      monotonic_duration_ms: call.monotonic_duration_ms ?? null,
      started_at_utc: call.started_at_utc ?? null,
      ended_at_utc: call.ended_at_utc ?? null,
      protocol_version: call.protocol_version ?? null,
      transport: call.transport ?? null,
      request_event_id: requests[0]?.event_id ?? null,
      terminal_event_id: terminals[0]?.event_id ?? null,
      terminal_phase: terminals[0]?.phase ?? null,
    };
  });

  const timeline = [...events]
    .sort(
      (a, b) =>
        String(a.timestamp_utc).localeCompare(String(b.timestamp_utc)) ||
        String(a.event_id).localeCompare(String(b.event_id)),
    )
    .map((event, index) => ({
      seq: index + 1,
      timestamp_utc: event.timestamp_utc,
      event_id: event.event_id,
      gateway_call_id: event.gateway_call_id ?? null,
      gateway_id: event.gateway_id ?? null,
      upstream_app: event.upstream_app ?? null,
      client_label: event.client_label ?? null,
      tool_name: event.tool_name ?? null,
      method: event.method ?? null,
      phase: event.phase,
      status: event.status,
      monotonic_duration_ms: event.monotonic_duration_ms ?? null,
      byte_size: event.byte_size ?? null,
      truncated: event.truncated === 1,
    }));

  return { call_sequence, timeline };
}

/**
 * 事件行 → 证据里的紧凑行（载荷做有界保留）。
 * @param {Array<Record<string, any>>} events
 * @returns {Array<Record<string, any>>}
 */
export function compactEventRows(events) {
  return events.map((event) => ({
    event_id: event.event_id,
    gateway_call_id: event.gateway_call_id ?? null,
    gateway_id: event.gateway_id ?? null,
    upstream_app: event.upstream_app ?? null,
    client_label: event.client_label ?? null,
    tool_name: event.tool_name ?? null,
    method: event.method ?? null,
    phase: event.phase,
    timestamp_utc: event.timestamp_utc,
    monotonic_duration_ms: event.monotonic_duration_ms ?? null,
    status: event.status,
    error_kind: event.error_kind ?? null,
    protocol_version: event.protocol_version ?? null,
    transport: event.transport ?? null,
    schema_version: event.schema_version,
    truncated: event.truncated === 1,
    byte_size: event.byte_size,
    request_json: boundedText(event.request_json),
    response_json: boundedText(event.response_json),
    summary_json: boundedText(event.summary_json),
  }));
}

/**
 * 生成完整证据对象。两条路径共用（结构因此必然相同）。
 *
 * @param {{
 *   mode: 'inproc'|'subprocess',
 *   producer: string,
 *   startedAtUtc: string,
 *   endedAtUtc: string,
 *   startMs: number,
 *   environment: Record<string, any>,
 *   run: Record<string, any>,
 *   task: Record<string, any>,
 *   calendar: Record<string, any>,
 *   consistency: {ok: boolean, checks: Array<Record<string, any>>, failures: Array<Record<string, any>>},
 *   dbQuery: Record<string, any>,
 *   transportFrames: Record<string, any>,
 *   extraFailures?: Array<Record<string, any>>,
 * }} input
 * @returns {Record<string, any>}
 */
export function buildEvidence(input) {
  const calls = input.dbQuery.calls ?? [];
  const events = input.dbQuery.events ?? [];
  const pairing = verifyPairing({ calls, events });
  const { call_sequence, timeline } = buildCallSequence({ calls, events });

  /** @type {Array<Record<string, any>>} */
  const failures = [];
  for (const failure of pairing.failures) failures.push({ kind: 'pairing', ...failure });
  for (const failure of input.consistency.failures) failures.push({ kind: 'consistency', ...failure });
  for (const failure of input.extraFailures ?? []) failures.push({ kind: 'run', ...failure });
  const framesOk = Object.values(input.transportFrames.gateways ?? {}).every(
    (entry) =>
      entry.to_client.all_jsonrpc === true &&
      entry.from_client.all_jsonrpc === true &&
      (entry.to_upstream === null || entry.to_upstream.all_jsonrpc === true) &&
      (entry.from_upstream === null || entry.from_upstream.all_jsonrpc === true),
  );
  if (!framesOk) failures.push({ kind: 'frames', problem: '存在非 JSON-RPC 帧（stdout 混入了非协议输出）' });

  const evidence = {
    evidence_schema: EVIDENCE_SCHEMA,
    producer: input.producer,
    mode: input.mode,
    generated_at_utc: input.endedAtUtc,
    status: 'ok',
    environment: input.environment,
    run: input.run,
    task: input.task,
    call_sequence,
    pairing,
    calendar: input.calendar,
    consistency: input.consistency,
    db_query: {
      ...input.dbQuery,
      events: compactEventRows(events),
      events_total_for_run: events.length,
      calls_total_for_run: calls.length,
    },
    timeline,
    transport_frames: input.transportFrames,
    comparable_keys: [...COMPARABLE_KEYS],
    verdict: { ok: false, failures: [] },
  };
  evidence.verdict = { ok: failures.length === 0, failures };
  evidence.status = evidence.verdict.ok ? 'ok' : 'failed';
  return evidence;
}

/**
 * 从事件库收集证据里的 `db_query` 块（calls / events / 统计 / integrity_check）。
 * 只读：调用方负责在写入端全部收尾之后再调用（读到的应是落盘后的最终状态）。
 * @param {{store: any, experimentRunId: string}} input
 * @returns {Record<string, any>}
 */
export function collectDbQuery(input) {
  const { store, experimentRunId } = input;
  const calls = store.listCalls({ experiment_run_id: experimentRunId, order: 'asc' });
  const events = store.listEvents({ experiment_run_id: experimentRunId, order: 'asc' });
  const stats = store.stats();
  let integrity = 'unavailable';
  try {
    const row = store.db.prepare('PRAGMA integrity_check').get();
    integrity = row?.integrity_check ?? 'unknown';
  } catch (error) {
    integrity = `error:${error instanceof Error ? error.message : String(error)}`;
  }
  /** 按本次运行聚合（不使用全库 stats，避免把全库计数误读成「本次运行的阶段分布」）。 */
  const eventsByPhase = new Map();
  for (const event of events) eventsByPhase.set(event.phase, (eventsByPhase.get(event.phase) ?? 0) + 1);
  const callsByStatus = new Map();
  for (const call of calls) callsByStatus.set(call.status, (callsByStatus.get(call.status) ?? 0) + 1);
  return {
    db_path: store.dbPath,
    experiment_run_id: experimentRunId,
    integrity_check: integrity,
    // 本次运行的计数（calls_total / events_total 是「本运行」的口径，历史运行不在其中）
    calls_total: calls.length,
    events_total: events.length,
    calls_by_status: [...callsByStatus.entries()]
      .map(([status, count]) => ({ status, count }))
      .sort((a, b) => a.status.localeCompare(b.status)),
    events_by_phase: [...eventsByPhase.entries()]
      .map(([phase, count]) => ({ phase, count }))
      .sort((a, b) => a.phase.localeCompare(b.phase)),
    // 全库口径（明确区分，便于判断「库里还有没有别的运行」）
    db_totals: {
      runs: stats.runs,
      calls: stats.calls,
      events: stats.events,
      truncated_events: stats.truncated_events,
      write_failures: stats.write_failures,
      schema_version: stats.schema_version,
      ddl_version: stats.ddl_version,
    },
    calls,
    events,
  };
}

/**
 * 人类可读报告（stdout）。**只输出报告**：不含协议帧、不含诊断日志。
 * @param {Record<string, any>} evidence
 * @returns {string}
 */
export function renderReport(evidence) {
  const lines = [];
  const run = evidence.run;
  lines.push(`[G1] 一键确定性演示（模式 ${evidence.mode}：${evidence.environment.process_boundary}）`);
  lines.push(
    `运行：experiment_run_id=${run.experiment_run_id} client_label=${run.client_label} db=${run.db_path} 耗时=${run.duration_ms}ms`,
  );
  for (const gateway of run.gateways) {
    const observed = gateway.client_observed_server_info;
    lines.push(
      `网关：${gateway.gateway_id} → ${gateway.upstream_app}（client 观测 server=${observed?.name ?? 'unknown'}@${
        observed?.version ?? 'unknown'
      } protocol=${gateway.protocol_version ?? 'unknown'} pid=${gateway.upstream_pid ?? 'n/a'}${
        gateway.gateway_pid ? ` gateway_pid=${gateway.gateway_pid}` : ''
      } 进程边界=${gateway.process_boundary}）`,
    );
  }
  lines.push(`任务：${evidence.task.name}`);
  for (const step of evidence.task.steps) {
    const structured = step.result?.structured_content ?? null;
    const marker = step.is_error === true ? '[isError]' : '[ok]';
    lines.push(
      `  步骤 ${step.step} ${marker} ${step.upstream_app}.${step.tool_name}(${stableStringify(step.arguments)}) ` +
        `耗时=${step.duration_ms}ms 结构化字段=${structured ? Object.keys(structured).join(',') : '(none)'}`,
    );
  }

  lines.push('');
  lines.push('调用时间线（SQLite events 表；request/response 按 gateway_call_id 配对）');
  lines.push(
    'seq   timestamp_utc             gateway_id  upstream_app   tool_name                    phase         status  ms      event_id        gateway_call_id',
  );
  for (const row of evidence.timeline) {
    lines.push(
      [
        String(row.seq).padEnd(5),
        String(row.timestamp_utc).padEnd(24),
        String(row.gateway_id ?? '-').padEnd(11),
        String(row.upstream_app ?? '-').padEnd(14),
        String(row.tool_name ?? '-').padEnd(28),
        String(row.phase).padEnd(13),
        String(row.status).padEnd(7),
        String(row.monotonic_duration_ms ?? '-').padEnd(7),
        String(row.event_id ?? '-').padEnd(15),
        String(row.gateway_call_id ?? '-'),
      ].join(' '),
    );
  }

  lines.push('');
  lines.push('调用序列（calls 表：tools/call 原始证据定位）');
  lines.push('#   gateway_call_id     gateway_id   upstream_app    tool_name                    status  ms     request_event   response_event');
  for (const call of evidence.call_sequence) {
    lines.push(
      [
        String(call.index).padEnd(3),
        String(call.gateway_call_id).padEnd(19),
        String(call.gateway_id ?? '-').padEnd(12),
        String(call.upstream_app ?? '-').padEnd(15),
        String(call.tool_name ?? '-').padEnd(28),
        String(call.status).padEnd(7),
        String(call.monotonic_duration_ms ?? '-').padEnd(6),
        String(call.request_event_id ?? '-').padEnd(15),
        String(call.terminal_event_id ?? '-'),
      ].join(' '),
    );
  }

  lines.push('');
  lines.push(
    `配对校验：calls=${evidence.pairing.calls_total} paired=${evidence.pairing.calls_paired} all_paired=${evidence.pairing.all_paired} orphan_events=${evidence.pairing.orphan_events.length}`,
  );
  for (const failure of evidence.pairing.failures) {
    lines.push(`  !! ${failure.gateway_call_id}: ${failure.problems.join(', ')}`);
  }

  lines.push('');
  const calendar = evidence.calendar;
  lines.push(`Calendar 写入：store=${calendar.store_file} 事件数=${calendar.stored_events.length}（重置前有 ${calendar.cleared_before} 条）`);
  for (const event of calendar.stored_events) {
    lines.push(`  ${event.event_id}  ${event.date} ${event.time}  《${event.title}》`);
  }
  lines.push(
    `  与 Mail 记录一致：${calendar.stored_matches_mail}（Mail：${calendar.mail_record?.title} ${calendar.mail_record?.date} ${calendar.mail_record?.time}）`,
  );

  lines.push('');
  lines.push('一致性检查：');
  for (const check of evidence.consistency.checks) {
    lines.push(`  [${check.ok ? 'ok' : 'FAIL'}] ${check.name}${check.detail ? ` — ${check.detail}` : ''}`);
  }

  lines.push('');
  const db = evidence.db_query;
  lines.push(
    `数据库查询（本次运行口径）：integrity_check=${db.integrity_check} calls=${db.calls_total} events=${db.events_total} ` +
      `阶段分布=${db.events_by_phase.map((row) => `${row.phase}=${row.count}`).join(' ')}`,
  );
  lines.push(
    `数据库全库口径：runs=${db.db_totals.runs} calls=${db.db_totals.calls} events=${db.db_totals.events} ` +
      `write_failures=${db.db_totals.write_failures.total} schema_version=${db.db_totals.schema_version}`,
  );
  const frameEntry = Object.values(evidence.transport_frames.gateways)[0];
  if (frameEntry) {
    lines.push(
      `协议帧纪律：to_client(${frameEntry.to_client.observer})=${frameEntry.to_client.frames_total} 帧/非法 ${frameEntry.to_client.non_jsonrpc_frames}；` +
        `from_client=${frameEntry.from_client.frames_total} 帧/非法 ${frameEntry.from_client.non_jsonrpc_frames}`,
    );
  }

  lines.push('');
  if (evidence.verdict.ok) {
    lines.push(`结论：OK（${evidence.status}）；证据文件已写出，供 V1 与另一条路径逐字段比对（keys=${evidence.comparable_keys.join(',')}）`);
  } else {
    lines.push(`结论：FAILED；失败项 ${evidence.verdict.failures.length} 条`);
    for (const failure of evidence.verdict.failures) lines.push(`  !! ${stableStringify(failure)}`);
  }
  return lines.join('\n');
}

/**
 * @param {string} filePath
 * @param {Record<string, any>} evidence
 * @returns {string} 写入的绝对路径
 */
export function writeEvidenceFile(filePath, evidence) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
  return filePath;
}
