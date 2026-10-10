/**
 * src/demo/task.js — 「同题任务」：读 Mock Mail 最新会议通知 → 写入 Mock Calendar（G1）
 *
 * 关键纪律：
 *   1. **数据来自 Mail 的真实响应**（`structuredContent` 的 title/date/time），不是脚本里写死的常量；
 *      常量只用于**校验**（frozen record 逐字比对），不得当成数据源；
 *   2. 每一步都记录「请求参数 + 返回内容 + 耗时 + 是否 isError」，供证据文件与回归比对；
 *   3. 校验函数 `evaluateConsistency()` 是纯函数：把任意（含被破坏的）输入喂进去都会如实报失败，
 *      因此测试可以用「故意篡改的输入」证明校验真的可失败（而不是永远返回 ok）。
 */
import fs from 'node:fs';
import { performance } from 'node:perf_hooks';

import { CalendarStore } from '../mock_servers/calendar_store.js';
import { MEETING_NOTICE } from '../mock_servers/notices.js';
import { CALENDAR_TOOL_NAMES, buildMockCalendarServer } from '../mock_servers/mock_calendar.js';
import { MAIL_TOOL_NAMES, buildMockMailServer } from '../mock_servers/mock_mail.js';

export { CALENDAR_TOOL_NAMES, MAIL_TOOL_NAMES, buildMockCalendarServer, buildMockMailServer };

/** 任务名（写进证据，两条路径同一字符串）。 */
export const TASK_NAME = 'mock-mail.read_latest_meeting_notice → mock-calendar.create_event（同一份取回的字段）';

/**
 * 工具结果里的文本内容（text 块拼接）。
 * @param {{content?: Array<{type?: string, text?: string}>}} result
 * @returns {string}
 */
export function textOf(result) {
  return (result?.content ?? [])
    .filter((block) => block?.type === 'text')
    .map((block) => block.text ?? '')
    .join('\n');
}

/**
 * 从 Mail 的工具结果里取出「同题任务」真正使用的字段。
 * @param {any} result `read_latest_meeting_notice` 的返回
 * @returns {{title: string, date: string, time: string, phone: string, notice_id: string|null, text: string,
 *   structured: Record<string, any>}}
 */
export function extractMailRecord(result) {
  const structured = result?.structuredContent;
  if (!structured || typeof structured !== 'object') {
    throw new Error('Mail 响应缺少 structuredContent：无法从真实响应取字段（不允许脚本内写死）');
  }
  for (const field of ['title', 'date', 'time']) {
    if (typeof structured[field] !== 'string' || structured[field] === '') {
      throw new Error(`Mail 响应的 structuredContent.${field} 缺失/非字符串：${JSON.stringify(structured[field])}`);
    }
  }
  return {
    title: structured.title,
    date: structured.date,
    time: structured.time,
    phone: typeof structured.phone === 'string' ? structured.phone : null,
    notice_id: typeof structured.notice_id === 'string' ? structured.notice_id : null,
    text: textOf(result),
    structured,
  };
}

/**
 * 读取 Calendar 存储文件（磁盘真值；不存在时视为空）。
 * @param {string} storeFileAbsolute
 * @returns {{schema: string|null, events: Array<Record<string, any>>, exists: boolean}}
 */
export function readCalendarFile(storeFileAbsolute) {
  if (!fs.existsSync(storeFileAbsolute)) return { schema: null, events: [], exists: false };
  const parsed = JSON.parse(fs.readFileSync(storeFileAbsolute, 'utf8'));
  return {
    schema: typeof parsed?.schema === 'string' ? parsed.schema : null,
    events: Array.isArray(parsed?.events) ? parsed.events : [],
    exists: true,
  };
}

/**
 * 一键重置：清空 Calendar 测试存储（文件保留、events 置空），保证演示可重复。
 * @param {string} storeFile 仓库内路径（相对或绝对）
 * @returns {{cleared: number, store_file: string, events_after: number}}
 */
export function resetCalendarStore(storeFile) {
  const store = new CalendarStore(storeFile);
  const cleared = store.clear();
  const events = store.list();
  return { cleared, store_file: store.relativePath, events_after: events.length };
}

/**
 * @param {string} name
 * @param {boolean} ok
 * @param {unknown} expected
 * @param {unknown} actual
 * @param {string} [detail]
 */
function check(name, ok, expected, actual, detail) {
  return { name, ok, expected, actual, detail: detail ?? null };
}

/**
 * 一致性校验（纯函数；被篡改的输入必须报 FAIL）。
 * @param {{
 *   mailRecord: Record<string, any>,
 *   requested: {title: string, date: string, time: string},
 *   createResult: any,
 *   listResult: any,
 *   storedEvents: Array<Record<string, any>>,
 *   storeFile: string,
 *   frozenRecord?: {title: string, date: string, time: string, phone: string},
 * }} input
 * @returns {{ok: boolean, checks: Array<Record<string, any>>, failures: Array<Record<string, any>>}}
 */
export function evaluateConsistency(input) {
  const frozen = input.frozenRecord ?? MEETING_NOTICE;
  const mail = input.mailRecord ?? {};
  const requested = input.requested ?? {};
  const created = input.createResult?.structuredContent ?? {};
  const listed = input.listResult?.structuredContent ?? {};
  const stored = input.storedEvents ?? [];
  /** @type {Array<Record<string, any>>} */
  const checks = [];

  checks.push(
    check(
      'mail_record_matches_frozen_truth',
      mail.title === frozen.title && mail.date === frozen.date && mail.time === frozen.time && mail.phone === frozen.phone,
      { title: frozen.title, date: frozen.date, time: frozen.time, phone: frozen.phone },
      { title: mail.title, date: mail.date, time: mail.time, phone: mail.phone },
      'Mock Mail 固定记录逐字一致（title/date/time/phone）',
    ),
  );
  checks.push(
    check(
      'mail_text_contains_structured_values',
      ['title', 'date', 'time'].every((field) => String(mail.text ?? '').includes(String(mail[field]))) &&
        (mail.phone === null || String(mail.text ?? '').includes(mail.phone)),
      '文本包含 structuredContent 的 title/date/time/phone',
      String(mail.text ?? '').slice(0, 200),
      '文本表示与结构化表示同源',
    ),
  );
  checks.push(
    check(
      'calendar_request_uses_mail_response_fields',
      mail.title === requested.title && mail.date === requested.date && mail.time === requested.time,
      { title: mail.title, date: mail.date, time: mail.time },
      requested,
      'create_event 的参数直接取自 Mail 响应（不是脚本常量）',
    ),
  );
  checks.push(
    check(
      'calendar_create_echo_matches_request',
      created.title === requested.title && created.date === requested.date && created.time === requested.time,
      requested,
      { title: created.title, date: created.date, time: created.time },
    ),
  );
  checks.push(
    check(
      'calendar_create_not_error',
      input.createResult?.isError !== true,
      'isError !== true',
      input.createResult?.isError ?? null,
    ),
  );
  checks.push(
    check(
      'calendar_event_id_shape',
      typeof created.event_id === 'string' && /^cevt_[0-9A-HJKMNP-TV-Z]{26}$/.test(created.event_id),
      'cevt_<ULID>',
      created.event_id ?? null,
    ),
  );
  checks.push(
    check('calendar_store_file_reported', created.store_file === input.storeFile, input.storeFile, created.store_file ?? null),
  );
  checks.push(check('calendar_stored_event_count', stored.length === 1, 1, stored.length));
  checks.push(
    check(
      'calendar_stored_matches_mail_record',
      stored.length === 1 && stored[0]?.title === mail.title && stored[0]?.date === mail.date && stored[0]?.time === mail.time,
      { title: mail.title, date: mail.date, time: mail.time },
      stored[0] ? { title: stored[0].title, date: stored[0].date, time: stored[0].time } : null,
      '磁盘上的 Calendar 内容与 Mail 记录一致',
    ),
  );
  checks.push(
    check(
      'calendar_stored_event_id_matches_create_result',
      stored.length === 1 && stored[0]?.event_id === created.event_id,
      created.event_id ?? null,
      stored[0]?.event_id ?? null,
    ),
  );
  checks.push(
    check(
      'calendar_list_matches_disk',
      listed.count === stored.length &&
        Array.isArray(listed.events) &&
        listed.events.length === stored.length &&
        listed.events.every((event, index) => event?.event_id === stored[index]?.event_id),
      { count: stored.length, event_ids: stored.map((event) => event.event_id) },
      { count: listed.count ?? null, event_ids: (listed.events ?? []).map((event) => event?.event_id ?? null) },
      'list_events 的返回与磁盘内容一致',
    ),
  );

  const failures = checks
    .filter((item) => !item.ok)
    .map((item) => ({ name: item.name, expected: item.expected, actual: item.actual }));
  return { ok: failures.length === 0, checks, failures };
}

/**
 * 库侧一致性校验：确认「经 Gateway 采集的调用」真的属于本次运行、client_label 正确、且
 * 与客户端侧观测到的 tools/call 步骤一一对应（不允许只报乐观结论）。
 * @param {{
 *   calls: Array<Record<string, any>>,
 *   events: Array<Record<string, any>>,
 *   experimentRunId: string,
 *   clientLabel: string,
 *   expectedCalls: Array<{upstream_app: string, tool_name: string}>,
 * }} input
 * @returns {{ok: boolean, checks: Array<Record<string, any>>, failures: Array<Record<string, any>>}}
 */
export function evaluateRunConsistency(input) {
  const { calls, events } = input;
  /** @type {Array<Record<string, any>>} */
  const checks = [];

  checks.push(
    check(
      'all_calls_share_experiment_run_id',
      calls.length > 0 && calls.every((call) => call.experiment_run_id === input.experimentRunId),
      input.experimentRunId,
      [...new Set(calls.map((call) => call.experiment_run_id))],
    ),
  );
  checks.push(
    check(
      'all_calls_client_label_matches',
      calls.length > 0 && calls.every((call) => call.client_label === input.clientLabel),
      input.clientLabel,
      [...new Set(calls.map((call) => call.client_label))],
      'client_label 用于标注调用来源（deterministic / codex / deepseek_harness）',
    ),
  );
  checks.push(
    check(
      'all_events_share_experiment_run_id',
      events.length > 0 && events.every((event) => event.experiment_run_id === input.experimentRunId),
      input.experimentRunId,
      [...new Set(events.map((event) => event.experiment_run_id))],
    ),
  );
  const expectedPairs = input.expectedCalls
    .map((item) => `${item.upstream_app}::${item.tool_name}`)
    .sort();
  const actualPairs = calls.map((call) => `${call.upstream_app}::${call.tool_name}`).sort();
  checks.push(
    check(
      'db_calls_cover_all_client_side_tool_calls',
      expectedPairs.length === actualPairs.length && expectedPairs.every((pair, index) => pair === actualPairs[index]),
      expectedPairs,
      actualPairs,
      '客户端发出的每个 tools/call 都在库里有一条 calls 记录（不多不少）',
    ),
  );
  checks.push(
    check(
      'all_calls_status_ok',
      calls.length > 0 && calls.every((call) => call.status === 'ok'),
      'ok',
      calls.map((call) => call.status),
    ),
  );
  checks.push(
    check(
      'all_calls_have_protocol_version',
      calls.length > 0 && calls.every((call) => typeof call.protocol_version === 'string' && call.protocol_version !== ''),
      '非空 protocol_version',
      calls.map((call) => call.protocol_version ?? null),
      '记录实测协商版本，不把默认值当上限',
    ),
  );
  checks.push(
    check(
      'all_calls_have_gateway_and_upstream_app',
      calls.length > 0 &&
        calls.every(
          (call) =>
            typeof call.gateway_id === 'string' &&
            call.gateway_id !== '' &&
            typeof call.upstream_app === 'string' &&
            call.upstream_app !== '',
        ),
      'gateway_id/upstream_app 非空',
      calls.map((call) => `${call.gateway_id ?? '(null)'}→${call.upstream_app ?? '(null)'}`),
    ),
  );

  const failures = checks
    .filter((item) => !item.ok)
    .map((item) => ({ name: item.name, expected: item.expected, actual: item.actual }));
  return { ok: failures.length === 0, checks, failures };
}

/**
 * 跑完整同题任务。返回结构化结果（证据生成器直接消费）。
 *
 * @param {{mail: any, calendar: any, calendarStoreFile: string, calendarStoreRelative: string,
 *   logger?: (message: string) => void}} options
 * @returns {Promise<Record<string, any>>}
 */
export async function runMailToCalendarTask(options) {
  const { mail, calendar } = options;
  if (typeof options.calendarStoreRelative !== 'string' || options.calendarStoreRelative === '') {
    throw new TypeError('runMailToCalendarTask 需要 calendarStoreRelative（仓库相对 POSIX 路径，用于与 Mock Calendar 返回的 store_file 比对）');
  }
  const logger = typeof options.logger === 'function' ? options.logger : () => {};
  /** @type {Array<Record<string, any>>} */
  const steps = [];
  let stepSeq = 0;

  /**
   * @param {{upstream_app: string, method: string, tool_name: string|null, arguments: any, run: () => Promise<any>}} spec
   */
  async function step(spec) {
    stepSeq += 1;
    const started = performance.now();
    const result = await spec.run();
    const durationMs = Number((performance.now() - started).toFixed(3));
    const record = {
      step: stepSeq,
      upstream_app: spec.upstream_app,
      method: spec.method,
      tool_name: spec.tool_name,
      arguments: spec.arguments ?? null,
      status: result?.isError === true ? 'tool_iserror' : 'ok',
      is_error: result?.isError === true,
      duration_ms: durationMs,
      result: {
        text: textOf(result),
        structured_content: result?.structuredContent ?? null,
      },
    };
    steps.push(record);
    logger(
      `[demo] 步骤 ${record.step} ${record.status} ${spec.upstream_app}.${spec.tool_name ?? spec.method} 耗时=${durationMs}ms`,
    );
    return result;
  }

  const mailTools = await step({
    upstream_app: 'mock-mail',
    method: 'tools/list',
    tool_name: null,
    arguments: null,
    run: async () => {
      const { tools } = await mail.listTools();
      return { content: [{ type: 'text', text: tools.map((tool) => tool.name).join(', ') }], structuredContent: { tool_names: tools.map((tool) => tool.name) } };
    },
  });
  const mailToolNames = mailTools.structuredContent.tool_names;
  if (mailToolNames.join(',') !== MAIL_TOOL_NAMES.join(',')) {
    throw new Error(`Mock Mail 工具清单与冻结常量不一致：${mailToolNames.join(',')} ≠ ${MAIL_TOOL_NAMES.join(',')}`);
  }

  const notice = await step({
    upstream_app: 'mock-mail',
    method: 'tools/call',
    tool_name: 'read_latest_meeting_notice',
    arguments: {},
    run: () => mail.callTool({ name: 'read_latest_meeting_notice', arguments: {} }),
  });
  const mailRecord = extractMailRecord(notice);

  const calendarTools = await step({
    upstream_app: 'mock-calendar',
    method: 'tools/list',
    tool_name: null,
    arguments: null,
    run: async () => {
      const { tools } = await calendar.listTools();
      return { content: [{ type: 'text', text: tools.map((tool) => tool.name).join(', ') }], structuredContent: { tool_names: tools.map((tool) => tool.name) } };
    },
  });
  const calendarToolNames = calendarTools.structuredContent.tool_names;
  if (calendarToolNames.join(',') !== CALENDAR_TOOL_NAMES.join(',')) {
    throw new Error(`Mock Calendar 工具清单与冻结常量不一致：${calendarToolNames.join(',')} ≠ ${CALENDAR_TOOL_NAMES.join(',')}`);
  }

  const requested = { title: mailRecord.title, date: mailRecord.date, time: mailRecord.time };
  const createResult = await step({
    upstream_app: 'mock-calendar',
    method: 'tools/call',
    tool_name: 'create_event',
    arguments: requested,
    run: () => calendar.callTool({ name: 'create_event', arguments: requested }),
  });

  const listResult = await step({
    upstream_app: 'mock-calendar',
    method: 'tools/call',
    tool_name: 'list_events',
    arguments: {},
    run: () => calendar.callTool({ name: 'list_events', arguments: {} }),
  });

  const disk = readCalendarFile(options.calendarStoreFile);
  const consistency = evaluateConsistency({
    mailRecord,
    requested,
    createResult,
    listResult,
    storedEvents: disk.events,
    storeFile: options.calendarStoreRelative,
  });

  return {
    steps,
    mail_record: mailRecord,
    requested_event: requested,
    create_result: createResult,
    list_result: listResult,
    stored_events: disk.events,
    consistency,
  };
}
