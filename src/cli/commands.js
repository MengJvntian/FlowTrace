/**
 * src/cli/commands.js — bin/trace.js 与 bin/reset.js 的命令实现（S2）
 *
 * 命令一览（`node bin/trace.js --help`）：
 *   init                 建库/迁移（幂等）
 *   runs                 列出 experiment_run_id / client_label / 起止时间 / 调用数
 *   calls    --run <id>  表格：gateway_id / upstream_app / tool_name / status / 耗时
 *   timeline --run <id>  按时间排序的 request/response 成对视图（缺对显著标出）
 *   show     --call <id> 原始 request/response JSON（原始留存）
 *   export   --run <id> --out <file>   JSON/JSONL 审计导出（含 schema_version；**默认未脱敏原文**，--mask 才脱敏）
 *   delete   --run <id>  按运行删除（calls + events + runs）
 *   vacuum               压缩数据库文件
 *   stats                统计（含采集失败计数 trace_write_failures）
 *
 * `node bin/reset.js` 一键清空 Mock Calendar 测试数据；`--events`/`--all` 追加清空事件库内容；
 * `--delete-db-file` 删除数据库文件本身（需 --yes）。
 */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { openStore } from '../collector/store.js';
import { CalendarStore, StorePathError, repoRelative, resolveStorePath } from '../mock_servers/calendar_store.js';
import { SCHEMA_VERSION } from '../shared/schemaversion.js';
import { fail, normalizeOrder, parseBoolean, parseOptions, requireString, usageError } from './args.js';
import { formatBytes, formatDuration, oneLine, out, renderTable, toJson } from './format.js';
import { buildExport, buildTimeline, callsOfRun, collectRuns, requireRun, UNASSIGNED } from './queries.js';

export const DEFAULT_DB_RELATIVE = 'demo-data/events.db';
/** 仓库根（`src/cli/commands.js` → `<repo>`）。 */
export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * @param {string | undefined} explicit
 * @returns {string}
 */
export function resolveDbPath(explicit) {
  const raw = typeof explicit === 'string' && explicit.trim() !== '' ? explicit.trim() : DEFAULT_DB_RELATIVE;
  if (raw === ':memory:') return raw;
  return path.isAbsolute(raw) ? raw : path.resolve(process.cwd(), raw);
}

/**
 * 只读命令：库文件不存在时直接报「不存在」（避免误建空库）。
 * @param {string} dbPath
 */
function openForRead(dbPath) {
  if (dbPath !== ':memory:' && !fs.existsSync(dbPath)) {
    fail(`事件库不存在：${dbPath}\n提示：先用 \`trace init --db ${dbPath}\` 建库，或 --db 指向已有库`, 3);
  }
  try {
    return openStore(dbPath);
  } catch (error) {
    fail(`打不开事件库 ${dbPath}：${error instanceof Error ? error.message : String(error)}`, 1);
  }
}

export const TRACE_USAGE = `用法: node bin/trace.js <命令> [选项]

命令：
  init                          建库/迁移（幂等），打印库路径、schema_version 与表清单
  runs                          列出运行：experiment_run_id / client_label / 起止时间 / 调用数
  calls    --run <id>           调用表格：gateway_id / upstream_app / tool_name / status / 耗时
  timeline --run <id>           时间线：按时间排序的 request/response 成对视图（缺对用 !! 标出）
  show     --call <id>          原始证据：该调用的 request/response JSON
  export   --run <id> --out <f> 审计导出（JSON 或 JSONL，含 schema_version；**默认未脱敏原文**，见下）
  delete   --run <id>           按运行删除（calls + events + runs）
  vacuum                        压缩数据库文件
  stats                         统计（含采集失败计数 trace_write_failures）
  help                          输出本说明

公共选项：
  --db <path>       事件库路径（缺省 ${DEFAULT_DB_RELATIVE}）
  --json            以 JSON 输出（stdout）
  --quiet           精简输出
  --limit <n>       限制条数
  --order asc|desc  排序方向（缺省 asc）
  --client-label <label>  runs 过滤
  --status <status>  calls 过滤（ok|tool_iserror|protocol_error|transport_error|timeout|validation_error）
  --format json|jsonl     export 输出格式（缺省按 --out 扩展名推断）
  --mask                  export：导出**脱敏投影**（手机号/邮箱/令牌·密钥 → 占位符），产物 masked=true
  --reveal                export：显式声明导出**未脱敏原文**（等于缺省行为，供脚本自证）；与 --mask 互斥
  --dry-run          delete 只预览不删除

关于 export 的脱敏（与页面导出**不是**同一套保证，务必看清）：
  1) 默认（不加开关）：写**未脱敏原文**（与库内一致），产物 masked=false —— CLI 是你本机主动发起的
     审计导出，隐式脱敏会造成**静默数据失真**，因此本命令不替你脱敏。请自行保管并限期删除。
  2) --mask：写脱敏投影，产物 masked=true；三处虚构样例（令牌/手机号/邮箱）在产物里均不可见。
  3) --reveal：显式声明要原文（等价缺省）；与 --mask 同时给出是**用法错误**（退出码 2）。
  4) 页面导出一律**默认脱敏**：GET /api/runs/<run>/export?format=json（masked=true）；
     要页面侧原文必须 reveal=1&ack=1&reason=… 并写审计记录（相关实现/§8）。
  5) JSON 与 JSONL 两种形态都在元数据里带 masked / mask_mode，读者可直接核对。

退出码（表达的是「命令执行结果」，**不表达数据质量**）：
  0  成功（即使数据有缺口，例如某次调用缺 response 事件）
  1  运行错误（库打不开、文件损坏、写文件失败）
  2  用法/参数错误（未知命令、缺必填参数、非法取值）
  3  查询对象不存在（--run/--call 查不到，或库文件不存在）

关于 timeline 的「缺对」：
  「request 没有配对的 response/error」是被观测数据的属性，不是命令失败，因此 timeline 缺对时
  **退出码仍为 0**，并用两种方式表达：人读输出里的『!! 缺少 response/error』标记 + 『pairing: …』摘要行；
  脚本判定必须解析 --json 的 pairing.complete / pairing.calls_checked / pairing.ok /
  pairing.incomplete[] / pairing.orphan_events[]。禁止用退出码判断事件是否成对。`;

export const RESET_USAGE = `用法: node bin/reset.js [选项]

默认行为：清空 Mock Calendar 测试数据（demo-data/calendar-events.json 的 events 数组）。

选项：
  --calendar=true|false  是否清空 Mock Calendar 测试数据（缺省 true）
  --calendar-store <path> 日历存储路径（缺省 demo-data/calendar-events.json，只允许仓库内路径）
  --events               追加清空事件库内容（逐运行 deleteRun，保留库文件与 schema）
  --all                  等价于 --events
  --delete-db-file       删除事件库文件本身（含 -wal/-shm，需同时给 --yes）
  --db <path>            事件库路径（缺省 ${DEFAULT_DB_RELATIVE}）
  --dry-run              只报告将清理什么，不改动任何文件
  --yes                  确认不可逆操作（--delete-db-file 必需）
  --json                 以 JSON 输出
  --help                 输出本说明

退出码：0 成功 / 1 运行错误 / 2 用法错误。
目标不存在（日历存储文件或事件库文件缺失）不算失败：按 0 返回，并在输出里标注 existed=no（未做任何修改）。`;

/**
 * 分发 trace 子命令。
 * @param {string[]} argv
 * @returns {number}
 */
export function runTraceCli(argv) {
  const command = argv[0];
  const rest = argv.slice(1);
  if (!command || command === 'help' || command === '--help' || command === '-h') {
    out(TRACE_USAGE);
    return 0;
  }

  switch (command) {
    case 'init':
      return cmdInit(rest);
    case 'runs':
      return cmdRuns(rest);
    case 'calls':
      return cmdCalls(rest);
    case 'timeline':
      return cmdTimeline(rest);
    case 'show':
      return cmdShow(rest);
    case 'export':
      return cmdExport(rest);
    case 'delete':
      return cmdDelete(rest);
    case 'vacuum':
      return cmdVacuum(rest);
    case 'stats':
      return cmdStats(rest);
    default:
      usageError(`未知命令：${command}\n\n${TRACE_USAGE}`);
  }
}

/**
 * @param {string[]} argv
 * @param {Record<string, {type: 'string'|'number'|'boolean', key: string}>} [extra]
 * @returns {{values: Record<string, any>, positionals: string[]}}
 */
function parseOptionsSync(argv, extra = {}) {
  const spec = {
    '--db': { type: 'string', key: 'db' },
    '--json': { type: 'boolean', key: 'json' },
    '--quiet': { type: 'boolean', key: 'quiet' },
    '--limit': { type: 'number', key: 'limit' },
    '--order': { type: 'string', key: 'order' },
    '--help': { type: 'boolean', key: 'help' },
    '-h': { type: 'boolean', key: 'help' },
    ...extra,
  };
  const { values, positionals, help } = parseOptions(argv, spec);
  if (help) {
    out(TRACE_USAGE);
    process.exit(0);
  }
  return { values, positionals };
}

/** @param {string[]} argv */
function cmdInit(argv) {
  const { values } = parseOptionsSync(argv, {});
  const dbPath = resolveDbPath(values.db);
  let store;
  try {
    store = openStore(dbPath, { maxPayloadBytes: 262144 });
  } catch (error) {
    fail(`建库失败 ${dbPath}：${error instanceof Error ? error.message : String(error)}`, 1);
  }
  try {
    const tables = store.db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all()
      .map((row) => row.name);
    const info = {
      schema_version: SCHEMA_VERSION,
      db_path: store.dbPath,
      ddl_version: Number(store.db.prepare('PRAGMA user_version').get()?.user_version ?? 0),
      journal_mode: store.db.prepare('PRAGMA journal_mode').get()?.journal_mode ?? null,
      tables,
      counts: {
        runs: Number(store.db.prepare('SELECT COUNT(*) AS c FROM runs').get()?.c ?? 0),
        calls: Number(store.db.prepare('SELECT COUNT(*) AS c FROM calls').get()?.c ?? 0),
        events: Number(store.db.prepare('SELECT COUNT(*) AS c FROM events').get()?.c ?? 0),
      },
      note: '幂等操作：重复执行不会丢数据',
    };
    if (values.json) out(toJson(info));
    else {
      out(`initialized db=${info.db_path}`);
      out(`schema_version=${info.schema_version} ddl_version=${info.ddl_version} journal_mode=${info.journal_mode}`);
      out(`tables=${info.tables.join(',')}`);
      out(`counts runs=${info.counts.runs} calls=${info.counts.calls} events=${info.counts.events}`);
      out('note=幂等操作：重复执行不会丢数据');
    }
    return 0;
  } finally {
    store.close();
  }
}

/** @param {string[]} argv */
function cmdRuns(argv) {
  const { values } = parseOptionsSync(argv, {
    '--client-label': { type: 'string', key: 'clientLabel' },
  });
  const dbPath = resolveDbPath(values.db);
  const store = openForRead(dbPath);
  try {
    const order = normalizeOrder(values.order);
    let runs = collectRuns(store);
    if (values.clientLabel) runs = runs.filter((run) => run.client_label === values.clientLabel);
    if (order === 'asc') runs = [...runs].reverse();
    if (values.limit) runs = runs.slice(0, values.limit);

    if (values.json) {
      out(toJson({ schema_version: SCHEMA_VERSION, db_path: store.dbPath, run_count: runs.length, runs }));
      return 0;
    }
    if (runs.length === 0) {
      out(`runs=0 db=${store.dbPath}`);
      out('(无运行：库里既没有 runs 行，也没有 calls/events 记录)');
      return 0;
    }
    out(
      renderTable(
        [
          { title: 'EXPERIMENT_RUN_ID', key: 'experiment_run_id', width: 34 },
          { title: 'CLIENT_LABEL', key: 'client_label', width: 16 },
          { title: 'STARTED_AT_UTC', key: 'started_at_utc', width: 24 },
          { title: 'LAST_EVENT_UTC', key: 'last_event_utc', width: 24 },
          { title: 'CALLS', key: 'call_count', width: 5, align: 'right' },
          { title: 'EVENTS', key: 'event_count', width: 6, align: 'right' },
          { title: 'REGISTERED', key: 'registered', width: 10 },
        ],
        runs.map((run) => ({ ...run, registered: run.registered ? 'yes' : 'implicit' })),
      ),
    );
    out(`runs=${runs.length} db=${store.dbPath}`);
    return 0;
  } finally {
    store.close();
  }
}

/** @param {string[]} argv */
function cmdCalls(argv) {
  const { values } = parseOptionsSync(argv, {
    '--run': { type: 'string', key: 'run' },
    '--status': { type: 'string', key: 'status' },
  });
  const runKey = requireString(values.run, '--run');
  const dbPath = resolveDbPath(values.db);
  const store = openForRead(dbPath);
  try {
    const run = requireRun(store, runKey);
    const calls = callsOfRun(store, runKey, {
      order: normalizeOrder(values.order),
      limit: values.limit,
      status: values.status,
    });
    if (values.json) {
      out(toJson({ schema_version: SCHEMA_VERSION, run, call_count: calls.length, calls }));
      return 0;
    }
    if (calls.length === 0) {
      out(`run=${runKey} calls=0（该运行下没有调用记录）`);
      return 0;
    }
    out(
      renderTable(
        [
          { title: 'GATEWAY_CALL_ID', key: 'gateway_call_id', width: 34 },
          { title: 'GATEWAY_ID', key: 'gateway_id', width: 18 },
          { title: 'UPSTREAM_APP', key: 'upstream_app', width: 14 },
          { title: 'TOOL_NAME', key: 'tool_name', width: 26 },
          { title: 'STATUS', key: 'status', width: 16 },
          { title: 'DURATION_MS', key: 'duration', width: 12, align: 'right' },
          { title: 'STARTED_AT_UTC', key: 'timestamp_utc', width: 24 },
        ],
        calls.map((call) => ({ ...call, duration: formatDuration(call.monotonic_duration_ms) })),
      ),
    );
    out(`run=${runKey} calls=${calls.length} db=${store.dbPath}`);
    return 0;
  } finally {
    store.close();
  }
}

/** @param {string[]} argv */
function cmdTimeline(argv) {
  const { values } = parseOptionsSync(argv, { '--run': { type: 'string', key: 'run' } });
  const runKey = requireString(values.run, '--run');
  const dbPath = resolveDbPath(values.db);
  const store = openForRead(dbPath);
  try {
    const timeline = buildTimeline(store, runKey, { limit: values.limit });
    if (values.json) {
      out(
        toJson({
          schema_version: SCHEMA_VERSION,
          run: timeline.run,
          pairing: timeline.pairing,
          rows: timeline.rows,
          summary_event_count: timeline.events.length - timeline.rows.length,
        }),
      );
      return 0;
    }

    out(`run=${runKey} calls=${timeline.calls.length} events=${timeline.events.length} db=${store.dbPath}`);
    if (timeline.rows.length === 0) {
      out('(该运行没有 tools/call 的 request/response/error 事件)');
    } else {
      const baseTime = Date.parse(timeline.rows[0].timestamp_utc);
      out(
        renderTable(
          [
            { title: 'TIMESTAMP_UTC', key: 'timestamp_utc', width: 24 },
            { title: 'DELTA', key: 'delta', width: 10, align: 'right' },
            { title: 'PHASE', key: 'phase', width: 8 },
            { title: 'GATEWAY_CALL_ID', key: 'gateway_call_id', width: 34 },
            { title: 'UPSTREAM_APP', key: 'upstream_app', width: 14 },
            { title: 'TOOL_NAME', key: 'tool_name', width: 26 },
            { title: 'STATUS', key: 'status', width: 16 },
            { title: 'DURATION', key: 'duration', width: 11, align: 'right' },
            { title: 'PAIRING', key: 'pairing_note', width: 20 },
          ],
          timeline.rows.map((row) => ({
            ...row,
            delta: `+${Math.max(0, Date.parse(row.timestamp_utc) - baseTime)}ms`,
            duration: formatDuration(row.duration_ms),
          })),
        ),
      );
    }

    const summaryCount = timeline.events.length - timeline.rows.length;
    out(
      `pairing: calls_checked=${timeline.pairing.calls_checked} ok=${timeline.pairing.ok} ` +
        `incomplete=${timeline.pairing.incomplete.length} orphan_events=${timeline.pairing.orphan_events.length}`,
    );
    if (timeline.pairing.incomplete.length > 0) {
      out('!! 以下调用缺少成对事件（request 与 response/error 必须成对）：');
      for (const item of timeline.pairing.incomplete) {
        out(`!!   gateway_call_id=${item.gateway_call_id} tool=${item.tool_name ?? '-'} status=${item.status ?? '-'} 缺少=${item.missing.join('+')}`);
      }
    }
    if (timeline.pairing.orphan_events.length > 0) {
      out('!! 以下事件带有 gateway_call_id 但 phase 既不是 request 也不是 response/error：');
      for (const item of timeline.pairing.orphan_events) {
        out(`!!   event_id=${item.event_id} phase=${item.phase} gateway_call_id=${item.gateway_call_id}`);
      }
    }
    if (timeline.pairing.complete) out('pairing=ok 所有 tools/call 的 request 与终态事件均成对');
    out(`summary_events=${summaryCount}（initialize/tools_list/notification/gateway_lifecycle 等，不参与成对检查）`);
    return 0;
  } finally {
    store.close();
  }
}

/** @param {string[]} argv */
function cmdShow(argv) {
  const { values } = parseOptionsSync(argv, { '--call': { type: 'string', key: 'call' } });
  const callId = requireString(values.call, '--call');
  const dbPath = resolveDbPath(values.db);
  const store = openForRead(dbPath);
  try {
    const call = store.getCall(callId);
    if (!call) fail(`未找到调用：${callId}`, 3);
    const events = store.listEvents({ gateway_call_id: callId, order: 'asc' });

    if (values.json) {
      out(toJson({ schema_version: SCHEMA_VERSION, call, events }));
      return 0;
    }

    out(`call=${call.gateway_call_id} tool=${call.tool_name ?? '-'} status=${call.status} duration=${formatDuration(call.monotonic_duration_ms)}`);
    out(`gateway_id=${call.gateway_id ?? '-'} upstream_app=${call.upstream_app ?? '-'} transport=${call.transport ?? '-'} protocol_version=${call.protocol_version ?? '-'} schema_version=${call.schema_version}`);
    out(`run=${call.experiment_run_id ?? call.run_id ?? '-'} client_label=${call.client_label ?? '-'} started=${call.timestamp_utc} ended=${call.ended_at_utc ?? '-'}`);
    if (call.error_message) out(`error_kind=${call.error_kind ?? '-'} error_message=${oneLine(call.error_message, 200)}`);
    if (events.length === 0) {
      out('events=0（该调用没有事件记录）');
      return 0;
    }
    for (const event of events) {
      out('');
      out(
        `--- event ${event.event_id} phase=${event.phase} status=${event.status} ` +
          `duration=${formatDuration(event.monotonic_duration_ms)} byte_size=${event.byte_size} truncated=${event.truncated === 1 ? 'yes' : 'no'}`,
      );
      if (event.request_json !== null && event.request_json !== undefined) {
        out('request_json:');
        out(event.request_json);
      }
      if (event.response_json !== null && event.response_json !== undefined) {
        out('response_json:');
        out(event.response_json);
      }
      if (event.summary_json !== null && event.summary_json !== undefined) {
        out('summary_json:');
        out(event.summary_json);
      }
      if (event.truncated === 1) {
        out(`!! 该事件载荷超过 max_payload_bytes 已截断（原始 ${event.byte_size} 字节），上面存的是截断信封`);
      }
    }
    return 0;
  } finally {
    store.close();
  }
}

/** @param {string[]} argv */
function cmdExport(argv) {
  const { values } = parseOptionsSync(argv, {
    '--run': { type: 'string', key: 'run' },
    '--out': { type: 'string', key: 'out' },
    '--format': { type: 'string', key: 'format' },
    '--mask': { type: 'boolean', key: 'mask' },
    '--reveal': { type: 'boolean', key: 'reveal' },
  });
  const runKey = requireString(values.run, '--run');
  const outPath = requireString(values.out, '--out');
  const format = resolveFormat(values.format, outPath);
  const dbPath = resolveDbPath(values.db);

  // R-01（团队裁定）：CLI 导出**默认原文**，脱敏必须显式请求；两个开关互斥。
  if (values.mask === true && values.reveal === true) {
    usageError(
      '--mask 与 --reveal 互斥：请二选一。\n' +
        '  --mask   导出脱敏投影（手机号/邮箱/令牌替换为占位符；产物 masked=true）\n' +
        '  --reveal 显式导出未脱敏原文（等于缺省行为；产物 masked=false）',
    );
  }
  const masked = values.mask === true;

  const store = openForRead(dbPath);
  try {
    const payload = buildExport(store, runKey, { mask: masked });
    const absolute = path.isAbsolute(outPath) ? outPath : path.resolve(process.cwd(), outPath);
    assertWritableTarget(absolute);
    fs.mkdirSync(path.dirname(absolute), { recursive: true });

    let text;
    if (format === 'jsonl') {
      const lines = [
        {
          type: 'export_header',
          schema_version: payload.schema_version,
          export_kind: payload.export_kind,
          exported_at_utc: payload.exported_at_utc,
          db_path: payload.db_path,
          masked: payload.masked,
          mask_mode: payload.mask_mode,
          mask_summary: payload.mask_summary,
          run: payload.run,
          counts: { calls: payload.calls.length, events: payload.events.length },
          note: payload.masked
            ? '本文件为脱敏投影（masked=true）：手机号/邮箱/令牌·密钥已替换为占位符。'
            : '本文件为**未脱敏原文**（masked=false）：与事件库内容一致，请自行保管并限期删除；需要脱敏投影请改用 --mask。',
        },
        ...payload.calls.map((call) => ({ type: 'call', schema_version: payload.schema_version, ...call })),
        ...payload.events.map((event) => ({ type: 'event', schema_version: payload.schema_version, ...event })),
      ];
      text = `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`;
    } else {
      text = `${JSON.stringify(payload, null, 2)}\n`;
    }
    fs.writeFileSync(absolute, text, 'utf8');
    const bytes = Buffer.byteLength(text, 'utf8');

    if (values.json) {
      out(
        toJson({
          ok: true,
          schema_version: payload.schema_version,
          format,
          masked: payload.masked,
          mask_mode: payload.mask_mode,
          mask_summary: payload.mask_summary,
          raw_notice: payload.masked
            ? null
            : '未脱敏原文：请自行保管并限期删除；脱敏投影请用 --mask',
          out: absolute,
          bytes,
          calls: payload.calls.length,
          events: payload.events.length,
          run: payload.run.experiment_run_id,
        }),
      );
      return 0;
    }
    out(`exported run=${payload.run.experiment_run_id} calls=${payload.calls.length} events=${payload.events.length}`);
    out(
      `format=${format} schema_version=${payload.schema_version} masked=${payload.masked} mask_mode=${payload.mask_mode} ` +
        `out=${absolute} bytes=${bytes}`,
    );
    if (payload.masked) {
      out('脱敏投影已写出（masked=true）：手机号/邮箱/令牌·密钥已替换为占位符。');
    } else {
      out('!! 本文件为未脱敏原文（masked=false）：请自行保管并限期删除；需要脱敏投影请加 --mask。');
    }
    return 0;
  } finally {
    store.close();
  }
}

/**
 * 拒绝把导出写到用户配置目录（CONVENTIONS §6.1：不得写 `~/.codex` 与 `~/.dsh`）。
 * @param {string} absolute
 */
function assertWritableTarget(absolute) {
  const home = process.env.USERPROFILE ?? process.env.HOME ?? '';
  if (!home) return;
  for (const dir of ['.codex', '.dsh']) {
    const forbidden = path.resolve(home, dir);
    const relative = path.relative(forbidden, absolute);
    if (relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))) {
      usageError(`拒绝写入用户配置目录 ${forbidden}（CONVENTIONS §6.1）：请改用仓库内的路径，例如 demo-data/exports/x.json`);
    }
  }
}

/**
 * @param {string | undefined} explicit
 * @param {string} outPath
 * @returns {'json' | 'jsonl'}
 */
function resolveFormat(explicit, outPath) {
  if (explicit !== undefined) {
    const lowered = String(explicit).toLowerCase();
    if (lowered === 'json' || lowered === 'jsonl') return lowered;
    usageError(`--format 只接受 json|jsonl，实际为 ${JSON.stringify(explicit)}`);
  }
  return path.extname(outPath).toLowerCase() === '.jsonl' ? 'jsonl' : 'json';
}

/** @param {string[]} argv */
function cmdDelete(argv) {
  const { values } = parseOptionsSync(argv, {
    '--run': { type: 'string', key: 'run' },
    '--dry-run': { type: 'boolean', key: 'dryRun' },
  });
  const runKey = requireString(values.run, '--run');
  const dbPath = resolveDbPath(values.db);
  const store = openForRead(dbPath);
  try {
    const run = requireRun(store, runKey);
    const calls = callsOfRun(store, runKey, {});
    const events = store.countEvents({ experiment_run_id: runKey, run_id: runKey });

    if (values.dryRun) {
      const preview = { dry_run: true, run: run.experiment_run_id, would_delete: { runs: run.registered ? 1 : 0, calls: calls.length, events } };
      if (values.json) out(toJson(preview));
      else {
        out(`dry-run run=${run.experiment_run_id}`);
        out(`would_delete runs=${preview.would_delete.runs} calls=${preview.would_delete.calls} events=${preview.would_delete.events}`);
        out('未做任何修改（去掉 --dry-run 才会真正删除）');
      }
      return 0;
    }

    const result = store.deleteRun(runKey);
    if (!result.ok) fail(`删除失败：${result.error}`, 1);
    const info = {
      ok: true,
      run: run.experiment_run_id,
      deleted: result.deleted,
      schema_version: SCHEMA_VERSION,
    };
    if (values.json) out(toJson(info));
    else {
      out(`deleted run=${run.experiment_run_id}`);
      out(`deleted runs=${result.deleted.runs} calls=${result.deleted.calls} events=${result.deleted.events}`);
      out(`提示：空间未回收，可用 \`trace vacuum --db ${dbPath}\` 压缩`);
    }
    return 0;
  } finally {
    store.close();
  }
}

/** @param {string[]} argv */
function cmdVacuum(argv) {
  const { values } = parseOptionsSync(argv, {});
  const dbPath = resolveDbPath(values.db);
  const store = openForRead(dbPath);
  try {
    const result = store.vacuum();
    if (result.ok !== true) fail(`vacuum 失败：${result.error}`, 1);
    const info = {
      ok: true,
      db_path: store.dbPath,
      bytes_before: result.bytes_before,
      bytes_after: result.bytes_after,
      reclaimed_bytes: Math.max(0, result.bytes_before - result.bytes_after),
    };
    if (values.json) out(toJson(info));
    else {
      out(`vacuum db=${info.db_path}`);
      out(`bytes_before=${info.bytes_before} (${formatBytes(info.bytes_before)}) bytes_after=${info.bytes_after} (${formatBytes(info.bytes_after)}) reclaimed=${info.reclaimed_bytes}`);
    }
    return 0;
  } finally {
    store.close();
  }
}

/** @param {string[]} argv */
function cmdStats(argv) {
  const { values } = parseOptionsSync(argv, {});
  const dbPath = resolveDbPath(values.db);
  const store = openForRead(dbPath);
  try {
    const stats = store.stats();
    if (values.json) {
      out(toJson({ ...stats, schema_version: SCHEMA_VERSION }));
      return 0;
    }
    out(`db=${stats.db_path} bytes=${stats.db_bytes} (${formatBytes(stats.db_bytes)})`);
    out(`schema_version=${stats.schema_version} ddl_version=${stats.ddl_version}`);
    out(`runs=${stats.runs} calls=${stats.calls} events=${stats.events} truncated_events=${stats.truncated_events}`);
    out(
      `采集失败计数 write_failures: process=${stats.write_failures.process} ` +
        `persisted=${stats.write_failures.persisted} total=${stats.write_failures.total}` +
        (stats.write_failures.total > 0 ? '  ← 采集写入失败（详见 stderr 中的 [trace-write-failure]）' : ''),
    );
    if (stats.calls_by_status.length > 0) {
      out(`calls_by_status=${stats.calls_by_status.map((row) => `${row.status}:${row.count}`).join(' ')}`);
    }
    if (stats.events_by_phase.length > 0) {
      out(`events_by_phase=${stats.events_by_phase.map((row) => `${row.phase}:${row.count}`).join(' ')}`);
    }
    out('runs（最多 10 条）:');
    const runs = collectRuns(store).slice(0, 10);
    if (runs.length === 0) out('  (无)');
    for (const run of runs) {
      out(`  run=${run.experiment_run_id} client_label=${run.client_label ?? '-'} calls=${run.call_count} events=${run.event_count} started=${run.started_at_utc ?? '-'}`);
    }
    return 0;
  } finally {
    store.close();
  }
}

// ── reset ────────────────────────────────────────────────────────────────────

/**
 * 一键重置：清空 Mock Calendar 测试数据（默认）与（可选）事件库。
 * @param {string[]} argv
 * @returns {number}
 */
export function runResetCli(argv) {
  const { values, help } = parseOptions(argv, {
    '--calendar': { type: 'string', key: 'calendar' },
    '--calendar-store': { type: 'string', key: 'calendarStore' },
    '--events': { type: 'boolean', key: 'events' },
    '--all': { type: 'boolean', key: 'all' },
    '--delete-db-file': { type: 'boolean', key: 'deleteDbFile' },
    '--db': { type: 'string', key: 'db' },
    '--dry-run': { type: 'boolean', key: 'dryRun' },
    '--yes': { type: 'boolean', key: 'yes' },
    '-y': { type: 'boolean', key: 'yes' },
    '--json': { type: 'boolean', key: 'json' },
    '--help': { type: 'boolean', key: 'help' },
    '-h': { type: 'boolean', key: 'help' },
  });
  if (help) {
    out(RESET_USAGE);
    return 0;
  }

  const dryRun = values.dryRun === true;
  const clearEvents = values.events === true || values.all === true;
  const deleteDbFile = values.deleteDbFile === true;
  let clearCalendar = true;
  if (values.calendar !== undefined) {
    const parsed = parseBoolean(values.calendar);
    if (parsed === null) usageError(`--calendar 的布尔值无法解析：${values.calendar}`);
    clearCalendar = parsed;
  }
  if (!clearCalendar && !clearEvents && !deleteDbFile) {
    usageError('没有要清理的目标：--calendar=false 时必须给 --events / --all / --delete-db-file');
  }
  if (deleteDbFile && !values.yes && !dryRun) {
    usageError('--delete-db-file 会物理删除事件库文件，必须显式加 --yes 确认（或用 --dry-run 预览）');
  }

  const report = {
    dry_run: dryRun,
    calendar_store: null,
    calendar: { path: null, existed: false, cleared: 0, note: null },
    events: { path: null, existed: false, deleted: null, cleared: false },
    db_file: { path: null, existed: false, deleted: false },
  };

  // 1) Mock Calendar 测试数据
  if (clearCalendar) {
    let absolute;
    try {
      absolute = resolveStorePath(values.calendarStore);
    } catch (error) {
      if (error instanceof StorePathError) fail(`日历存储路径非法：${error.message}`, 2);
      throw error;
    }
    const relative = repoRelative(absolute);
    report.calendar_store = relative;
    report.calendar.path = relative;
    report.calendar.existed = fs.existsSync(absolute);
    if (!report.calendar.existed) {
      report.calendar.note = '存储文件不存在（无需清理）';
    } else {
      try {
        const store = new CalendarStore(absolute);
        if (dryRun) {
          report.calendar.cleared = store.load().events.length;
          report.calendar.note = 'dry-run：未修改';
        } else {
          report.calendar.cleared = store.clear();
          report.calendar.note = '已清空 events 数组（文件保留）';
        }
      } catch (error) {
        fail(
          `清空 Mock Calendar 测试数据失败（${relative}）：${error instanceof Error ? error.message : String(error)}`,
          1,
        );
      }
    }
  }

  // 2) 事件库内容
  const dbPath = resolveDbPath(values.db);
  report.events.path = dbPath;
  report.events.existed = dbPath === ':memory:' ? false : fs.existsSync(dbPath);
  if (clearEvents) {
    if (!report.events.existed) {
      report.events.deleted = { runs: 0, calls: 0, events: 0 };
      report.events.cleared = false;
    } else {
      let store;
      try {
        store = openStore(dbPath);
      } catch (error) {
        fail(`打不开事件库 ${dbPath}：${error instanceof Error ? error.message : String(error)}`, 1);
      }
      try {
        const totals = { runs: 0, calls: 0, events: 0 };
        const runKeys = collectRuns(store).map((run) => run.experiment_run_id ?? UNASSIGNED);
        for (const key of runKeys) {
          if (key === UNASSIGNED) continue;
          if (dryRun) {
            totals.runs += store.getRun(key) ? 1 : 0;
            totals.calls += store.countCalls({ experiment_run_id: key, run_id: key });
            totals.events += store.countEvents({ experiment_run_id: key, run_id: key });
            continue;
          }
          const result = store.deleteRun(key);
          if (result.ok) {
            totals.runs += result.deleted.runs;
            totals.calls += result.deleted.calls;
            totals.events += result.deleted.events;
          } else {
            fail(`清空运行 ${key} 失败：${result.error}`, 1);
          }
        }
        report.events.deleted = totals;
        report.events.cleared = !dryRun;
      } finally {
        store.close();
      }
    }
  }

  // 3) 事件库文件本身
  if (dbPath !== ':memory:') {
    report.db_file.path = dbPath;
    report.db_file.existed = fs.existsSync(dbPath);
    if (deleteDbFile && report.db_file.existed) {
      if (dryRun) {
        report.db_file.note = 'dry-run：未删除';
      } else {
        const sidecars = [`${dbPath}-wal`, `${dbPath}-shm`];
        try {
          fs.rmSync(dbPath, { force: true });
          for (const sidecar of sidecars) fs.rmSync(sidecar, { force: true });
          report.db_file.deleted = true;
        } catch (error) {
          fail(
            `删除数据库文件失败：${error instanceof Error ? error.message : String(error)}\n` +
              '提示：可能有其它进程（Gateway / 页面）正打开该库，先停止它们再重试',
            1,
          );
        }
      }
    }
  }

  if (values.json) {
    out(toJson({ ok: true, schema_version: SCHEMA_VERSION, ...report }));
    return 0;
  }
  out(`reset${dryRun ? '（dry-run，未修改任何文件）' : ''}`);
  if (clearCalendar) {
    out(
      `calendar: path=${report.calendar.path} existed=${report.calendar.existed ? 'yes' : 'no'} ` +
        `cleared=${report.calendar.cleared} ${report.calendar.note ?? ''}`.trim(),
    );
  } else {
    out('calendar: 已跳过（--calendar=false）');
  }
  if (clearEvents) {
    const deleted = report.events.deleted ?? { runs: 0, calls: 0, events: 0 };
    out(
      `events: path=${report.events.path} existed=${report.events.existed ? 'yes' : 'no'} ` +
        `cleared=${report.events.cleared ? 'yes' : 'no'} deleted_runs=${deleted.runs} deleted_calls=${deleted.calls} deleted_events=${deleted.events}`,
    );
  } else {
    out(`events: 已跳过（未给 --events/--all）；库路径=${report.events.path}`);
  }
  if (deleteDbFile) {
    out(`db_file: path=${report.db_file.path} deleted=${report.db_file.deleted ? 'yes' : 'no'} ${report.db_file.note ?? ''}`.trim());
  }
  return 0;
}
