#!/usr/bin/env node
/**
 * bin/demo.js — 一键确定性演示：Mock Mail 最新会议通知 → Mock Calendar（G1）
 *
 * 两条**显式**运行路径（不允许静默替换，见 CONVENTIONS §1.1.2）：
 *
 *   路径 A `--mode=inproc`（缺省；沙箱内 `npm test` 必须绿）
 *     进程内同构拓扑：真实 `src/gateway/gateway.js` + 真实 `src/mock_servers/*`，
 *     两段都用真实 SDK stdio 传输（内存流取代 OS 进程边界）；两个 Gateway 实例
 *     各自打开同一个 SQLite 文件；跑完整同题任务并落库。
 *
 *   路径 B `--mode=subprocess`（真实跨进程 stdio；沙箱内必然失败，供沙箱外执行）
 *     真实 spawn 两个 `bin/gateway.js`（各自再 spawn 上游 Mock Server），用
 *     `@modelcontextprotocol/client/stdio` 的 `StdioClientTransport` 连接。
 *     本沙箱禁止带管道的子进程 stdio → 在 spawn 阶段即失败：**快速失败、写可辨识诊断、
 *     打印沙箱外复现命令、退出码 3**，绝不挂死、绝不伪装成功、绝不降级为路径 A。
 *
 * 两条路径写出**同一 schema** 的证据文件（`src/demo/evidence.js`，键：call_sequence /
 * pairing / calendar / db_query），供 V1 逐字段对比。
 *
 * 退出码：0 成功 / 1 运行失败或一致性校验失败 / 2 用法错误 / 3 沙箱管道限制（路径 B 专用）。
 *
 * 纪律：stdout **只输出报告或 `--json` 证据**；所有诊断一律 stderr。
 */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { openStore } from '../src/collector/store.js';
import { CliError, parseOptions, writeErr, writeOut } from '../src/cli/args.js';
import {
  EVIDENCE_SCHEMA,
  buildEvidence,
  collectDbQuery,
  frameReport,
  renderReport,
  writeEvidenceFile,
} from '../src/demo/evidence.js';
import {
  BUNDLED_NODE,
  REPO_ROOT,
  classifySpawnFailure,
  ensureDir,
  probePipeSupport,
  repoRelative,
  resolveInRepo,
  resolveNodeBin,
  sandboxLimitationMessage,
} from '../src/demo/runtime.js';
import { createInProcessGatewayStack, createSubprocessGatewayStack } from '../src/demo/stack.js';
import {
  TASK_NAME,
  buildMockCalendarServer,
  buildMockMailServer,
  evaluateRunConsistency,
  resetCalendarStore,
  runMailToCalendarTask,
} from '../src/demo/task.js';
import { CalendarStore } from '../src/mock_servers/calendar_store.js';
import { MOCK_SERVER_VERSION } from '../src/mock_servers/common.js';
import { CALENDAR_SERVER_NAME } from '../src/mock_servers/mock_calendar.js';
import { MAIL_SERVER_NAME } from '../src/mock_servers/mock_mail.js';
import { newExperimentRunId } from '../src/shared/ids.js';
import { nowUtcIso } from '../src/shared/time.js';

export const DEMO_USAGE = `用法: node bin/demo.js [--mode=inproc|subprocess] [选项]

模式（必须显式选择，二者不可互相替代）：
  --mode=inproc       缺省。进程内同构拓扑（真实 Gateway + 真实 Mock Server + 内存流），沙箱内可自动化
  --mode=subprocess   真实 spawn 两个 bin/gateway.js 并用 StdioClientTransport 连接（沙箱内提示限制并退出码 3）

选项：
  --db <path>                 事件库路径（缺省 demo-data/demo/events.db）
  --experiment-run-id <id>    实验运行 ID（缺省自动生成 exp_<ULID>；一键演示要求每次运行唯一）
  --client-label <label>      触发方标签：deterministic | codex | deepseek_harness（缺省 deterministic）
  --gateway-id-mail <id>      Mail Gateway 实例 ID（缺省 gw-mail）
  --gateway-id-calendar <id>  Calendar Gateway 实例 ID（缺省 gw-calendar）
  --calendar-store <path>     Mock Calendar 存储文件（缺省 demo-data/demo/calendar-events.json，只允许仓库内）
  --evidence-out <path>       证据文件路径（缺省 demo-data/demo/evidence-<mode>.json）
  --no-evidence-file          不写证据文件（stdout 报告仍输出）
  --no-reset                  跳过 Calendar 一键重置（仅诊断用；会让「恰好 1 条」的一致性校验失败）
  --json                      把证据 JSON 打印到 stdout（替代人类可读报告）
  --help                      输出本说明

退出码：0 成功 / 1 运行失败 / 2 用法错误 / 3 沙箱管道限制（路径 B 专用）`;

export const DEFAULT_DB_RELATIVE = 'demo-data/demo/events.db';
export const DEFAULT_CALENDAR_STORE_RELATIVE = 'demo-data/demo/calendar-events.json';
export const DEFAULT_EVIDENCE_DIR_RELATIVE = 'demo-data/demo';

const OPTION_SPEC = Object.freeze({
  '--mode': { type: 'string', key: 'mode' },
  '--db': { type: 'string', key: 'db' },
  '--experiment-run-id': { type: 'string', key: 'experimentRunId' },
  '--client-label': { type: 'string', key: 'clientLabel' },
  '--gateway-id-mail': { type: 'string', key: 'gatewayIdMail' },
  '--gateway-id-calendar': { type: 'string', key: 'gatewayIdCalendar' },
  '--calendar-store': { type: 'string', key: 'calendarStore' },
  '--evidence-out': { type: 'string', key: 'evidenceOut' },
  '--no-evidence-file': { type: 'boolean', key: 'noEvidenceFile' },
  '--no-reset': { type: 'boolean', key: 'noReset' },
  '--json': { type: 'boolean', key: 'json' },
  '--help': { type: 'boolean', key: 'help' },
  '-h': { type: 'boolean', key: 'help' },
});

/**
 * @param {string[]} argv
 * @returns {Record<string, any>}
 */
export function parseDemoArgs(argv) {
  const { values, positionals, help } = parseOptions(argv, OPTION_SPEC, { allowPositionals: false });
  if (positionals.length > 0) throw new CliError(`未知位置参数：${positionals.join(' ')}`, 2, { showUsage: true });
  if (help) return { help: true };
  const mode = values.mode ?? 'inproc';
  if (mode !== 'inproc' && mode !== 'subprocess') {
    throw new CliError(`--mode 只接受 inproc|subprocess，实际为 ${JSON.stringify(mode)}`, 2, { showUsage: true });
  }
  const clientLabel = values.clientLabel ?? 'deterministic';
  if (!/^[A-Za-z0-9_.:-]+$/.test(clientLabel)) {
    throw new CliError(`--client-label 只接受 [A-Za-z0-9_.:-]，实际为 ${JSON.stringify(clientLabel)}`, 2);
  }
  const experimentRunId = values.experimentRunId ?? newExperimentRunId();
  const gatewayIdMail = values.gatewayIdMail ?? 'gw-mail';
  const gatewayIdCalendar = values.gatewayIdCalendar ?? 'gw-calendar';
  const db = resolveInRepo(values.db ?? DEFAULT_DB_RELATIVE, '--db');
  const calendarStore = resolveInRepo(values.calendarStore ?? DEFAULT_CALENDAR_STORE_RELATIVE, '--calendar-store');
  const evidenceOut = resolveInRepo(
    values.evidenceOut ?? path.join(DEFAULT_EVIDENCE_DIR_RELATIVE, `evidence-${mode}.json`),
    '--evidence-out',
  );
  return {
    help: false,
    mode,
    clientLabel,
    experimentRunId,
    gatewayIdMail,
    gatewayIdCalendar,
    dbPath: db,
    dbRelative: repoRelative(db),
    calendarStoreFile: calendarStore,
    calendarStoreRelative: repoRelative(calendarStore),
    evidenceOut,
    writeEvidence: values.noEvidenceFile !== true,
    resetCalendar: values.noReset !== true,
    json: values.json === true,
  };
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
 * 执行一次演示（可被测试直接调用；writeEvidence 等副作用由参数控制）。
 * @param {Record<string, any>} options 见 parseDemoArgs 的返回
 * @param {{out?: (line: string) => void, err?: (line: string) => void,
 *   pipeProbe?: Record<string, any>}} [io]
 * @returns {Promise<{evidence: Record<string, any>, exitCode: number, evidencePath: string|null}>}
 */
export async function runDemo(options, io = {}) {
  const out = typeof io.out === 'function' ? io.out : (line) => writeOut(line);
  const err = typeof io.err === 'function' ? io.err : (line) => writeErr(line);
  const mode = options.mode ?? 'inproc';
  const startedAtUtc = nowUtcIso();
  const startMs = Date.now();
  const nodeBin = resolveNodeBin();
  const probe = io.pipeProbe ?? (await probePipeSupport());

  err(
    `[demo] 模式=${mode} 运行=${options.experimentRunId} client_label=${options.clientLabel} db=${options.dbRelative} ` +
      `node=${nodeBin.bin}（source=${nodeBin.source}） 管道 stdio 可用=${probe.ok}`,
  );
  if (nodeBin.source === 'fallback') {
    err(`[demo] 警告：未找到捆绑 Node 24（${BUNDLED_NODE}），回退到 ${nodeBin.bin}；可用 TRACE_NODE_BIN 指定。`);
  }

  ensureDir(path.dirname(options.dbPath));
  ensureDir(path.dirname(options.calendarStoreFile));
  ensureDir(path.dirname(options.evidenceOut));

  /** 一键重置的结果（延后到 Gateway 就绪之后才真正执行，见下）。 */
  /** @type {{cleared: number|null, store_file: string, events_after: number|null}} */
  let reset = { cleared: null, store_file: options.calendarStoreRelative, events_after: null };

  const baseConfig = {
    clientLabel: options.clientLabel,
    experimentRunId: options.experimentRunId,
    // 传给 Gateway 的一律是绝对路径：路径 A 在本进程开库，路径 B 的子进程 cwd 虽为仓库根，
    // 但绝对路径可以避免「换 cwd 就落错库」这类不可复现问题（证据里仍记仓库相对路径）。
    dbPath: options.dbPath,
    timeoutMs: 60000,
    transport: 'stdio',
    maxPayloadBytes: 262144,
  };
  const gatewaySpecs = [
    {
      gatewayId: options.gatewayIdMail,
      upstreamApp: MAIL_SERVER_NAME,
      upstreamEntry: 'src/mock_servers/mock_mail.js',
      upstreamArgs: [],
      expectedServerName: MAIL_SERVER_NAME,
    },
    {
      gatewayId: options.gatewayIdCalendar,
      upstreamApp: CALENDAR_SERVER_NAME,
      upstreamEntry: 'src/mock_servers/mock_calendar.js',
      upstreamArgs: ['--store', options.calendarStoreRelative],
      expectedServerName: CALENDAR_SERVER_NAME,
    },
  ];

  // ── 唯一运行 ID 守卫 ───────────────────────────────────────────────────────
  // 一键演示的「恰好 3 次调用 / 恰好 1 条日历」断言要求每次运行一个唯一 ID。
  // 必须放在**创建任何 Gateway 之前**：Gateway 一连上就会写 upstream_started 生命周期事件，
  // 那时再检查就会把自己的事件误判成「重跑」。
  // 注意（R-02/V1-F5 措辞更正）：这段守卫会 `openStore()`，因此路径 B 失败时**会创建/初始化空的事件库文件**；
  // 失败路径的准确说法是「不写 runs/证据/日历/子进程日志，但会创建空库文件」，**不是**「零副作用」。
  {
    const store = openStore(options.dbPath);
    try {
      const existingCalls = store.countCalls({ experiment_run_id: options.experimentRunId });
      const existingEvents = store.countEvents({ experiment_run_id: options.experimentRunId });
      if (existingCalls > 0 || existingEvents > 0) {
        throw new CliError(
          `experiment_run_id=${options.experimentRunId} 在 ${options.dbRelative} 里已有 ${existingCalls} 条 calls / ` +
            `${existingEvents} 条 events。一键演示要求每次运行使用唯一 ID（不给 --experiment-run-id 时会自动生成 ` +
            `exp_<ULID>）；请改用新的 --experiment-run-id，或先执行 \`npm run trace -- delete --run ` +
            `${options.experimentRunId} --db ${options.dbRelative}\`。`,
          1,
        );
      }
    } finally {
      store.close();
    }
  }

  /** @type {Array<any>} */
  const stacks = [];
  /** @type {Array<{path: string, fd: number}>} */
  const stderrFiles = [];

  /** 关闭已创建的一切（幂等；失败只记 stderr）。 */
  async function cleanup() {
    for (const stack of stacks.reverse()) {
      try {
        await stack.close();
      } catch (error) {
        err(`[demo] 收尾失败：${error instanceof Error ? error.message : String(error)}`);
      }
    }
    stacks.length = 0;
    for (const file of stderrFiles) {
      try {
        fs.closeSync(file.fd);
      } catch {
        /* 忽略 */
      }
    }
    stderrFiles.length = 0;
  }

  try {
    // ── 1. 装配两条路径各自的 Gateway（都指向同一个 SQLite 库） ──────────────
    for (const spec of gatewaySpecs) {
      const config = {
        ...baseConfig,
        gatewayId: spec.gatewayId,
        upstreamApp: spec.upstreamApp,
        upstreamEntry: spec.upstreamEntry,
        upstreamArgs: spec.upstreamArgs,
        upstreamCommand: `${nodeBin.bin} ${spec.upstreamEntry}`,
      };
      if (mode === 'inproc') {
        const stack = await createInProcessGatewayStack({
          config,
          buildUpstreamServer:
            spec.upstreamApp === MAIL_SERVER_NAME
              ? buildMockMailServer
              : () => buildMockCalendarServer({ store: new CalendarStore(options.calendarStoreRelative) }),
          clientName: 'g1-demo-inproc-client',
          logger: (message) => err(message),
        });
        stack.spec = spec;
        stacks.push(stack);
        err(
          `[demo] 路径 A 就绪 ${spec.gatewayId} → ${spec.upstreamApp} ` +
            `upstream_server=${stack.gateway.upstreamClient.getServerVersion()?.name ?? 'unknown'} protocol=${
              stack.gateway.upstreamClient.getNegotiatedProtocolVersion() ?? 'unknown'
            }`,
        );
      } else {
        // stderr 落盘只在「本环境确实允许管道 stdio」时才用文件：沙箱内路径 B 注定在 spawn
        // 阶段失败，此时用 'inherit'，连日志文件都不创建（**只保证不建子进程日志文件**；
        // 事件库文件仍会由上面的 openStore() 创建 —— 见该处的 R-02 说明，勿写成「零副作用」）。
        let stderrTarget = 'inherit';
        let stderrPath = null;
        if (probe.ok === true) {
          stderrPath = path.join(path.dirname(options.evidenceOut), `gateway-${spec.gatewayId}.stderr.log`);
          const fd = fs.openSync(stderrPath, 'w');
          stderrFiles.push({ path: stderrPath, fd });
          stderrTarget = fd;
        }
        const stack = await createSubprocessGatewayStack({
          config,
          nodeBin: nodeBin.bin,
          repoRoot: REPO_ROOT,
          clientName: 'g1-demo-subprocess-client',
          stderr: stderrTarget,
          logger: (message) => err(message),
        });
        stack.spec = spec;
        stack.stderr_path = stderrPath ? repoRelative(stderrPath) : null;
        stacks.push(stack);
      }
    }

    // ── 2. 一键重置（Gateway 都已就绪，此时才动数据；失败路径不留副作用） ────
    if (options.resetCalendar) {
      reset = resetCalendarStore(options.calendarStoreFile);
      err(`[demo] 已重置 Calendar 测试存储 ${reset.store_file}（清除 ${reset.cleared} 条，当前 ${reset.events_after} 条）`);
      if (reset.events_after !== 0) throw new CliError('重置后 Calendar 存储仍非空，拒绝继续（证据会不可信）', 1);
    } else {
      err('[demo] --no-reset：跳过 Calendar 重置（一致性校验可能失败，属预期）');
    }

    // ── 3. 运行行（runs 表）：让 P1 CLI / P3 页面能按运行聚合 ────────────────
    {
      const store = openStore(options.dbPath);
      try {
        const result = store.upsertRun({
          experiment_run_id: options.experimentRunId,
          client_label: options.clientLabel,
          started_at_utc: startedAtUtc,
          notes: `G1 demo mode=${mode}; task=${TASK_NAME}`,
        });
        if (result.ok === false) throw new CliError(`写入 runs 失败：${result.error}`, 1);
      } finally {
        store.close();
      }
    }

    // ── 4. 跑同题任务：读 Mail → 写 Calendar → 读回 ─────────────────────────
    const [mailStack, calendarStack] = stacks;
    const task = await runMailToCalendarTask({
      mail: mailStack.client,
      calendar: calendarStack.client,
      calendarStoreFile: options.calendarStoreFile,
      calendarStoreRelative: options.calendarStoreRelative,
      logger: (message) => err(message),
    });

    // ── 5. 证据骨架（在关闭前先取帧，避免流关闭后观测不到） ──────────────────
    /** @type {Record<string, any>} */
    const transportFrames = { gateways: {} };
    /** @type {Array<Record<string, any>>} */
    const gatewayEvidence = [];
    /** @type {Array<Record<string, any>>} */
    const extraFailures = [];
    for (const stack of stacks) {
      const spec = stack.spec;
      const inproc = stack.kind === 'inproc';
      const toClientObserver = inproc
        ? 'Gateway stdout 字节 tap（真实 stdio 分帧）'
        : 'client 侧 RecordingTransport（Gateway stdout 经 SDK 解析）';
      transportFrames.gateways[spec.gatewayId] = {
        source: inproc ? 'in-process taps' : 'client-side RecordingTransport',
        to_client: frameReport(stack.frames.toClient(), toClientObserver),
        from_client: frameReport(stack.frames.fromClient(), 'client → Gateway 帧（真实 stdio 分帧）'),
        to_upstream: inproc ? frameReport(stack.frames.toUpstream(), 'Gateway → 上游 stdin tap') : null,
        from_upstream: inproc ? frameReport(stack.frames.fromUpstream(), '上游 stdout tap（Mock Server 协议帧）') : null,
      };

      const clientObserved = stack.client.getServerVersion() ?? null;
      const upstreamInfo = inproc ? stack.gateway.upstreamClient.getServerVersion() ?? null : null;
      const clientProtocol = stack.client.getNegotiatedProtocolVersion() ?? null;
      const upstreamProtocol = inproc
        ? stack.gateway.upstreamClient.getNegotiatedProtocolVersion() ?? null
        : null;
      const identityAgreement = inproc
        ? {
            checked: true,
            ok:
              clientObserved?.name === upstreamInfo?.name &&
              clientObserved?.version === upstreamInfo?.version,
            detail: `client 观测 ${clientObserved?.name}@${clientObserved?.version} vs 上游 ${upstreamInfo?.name}@${upstreamInfo?.version}`,
          }
        : {
            checked: false,
            ok: null,
            detail:
              '路径 B 无法直接读取上游 serverInfo（在被 spawn 的 Gateway 进程内部）；以 client 观测值与 Mock Server 冻结身份常量比对',
          };
      if (identityAgreement.checked && identityAgreement.ok !== true) {
        extraFailures.push({ name: 'gateway_mirrors_upstream_identity', problem: identityAgreement.detail });
      }
      if (clientObserved?.name !== spec.expectedServerName) {
        extraFailures.push({
          name: 'client_observed_server_name',
          problem: `${spec.gatewayId}: client 看到的 server 名 ${JSON.stringify(clientObserved?.name)} ≠ ${JSON.stringify(spec.expectedServerName)}`,
        });
      }
      if (clientObserved?.version !== MOCK_SERVER_VERSION) {
        extraFailures.push({
          name: 'client_observed_server_version',
          problem: `${spec.gatewayId}: client 看到的 server 版本 ${JSON.stringify(clientObserved?.version)} ≠ ${JSON.stringify(MOCK_SERVER_VERSION)}`,
        });
      }
      gatewayEvidence.push({
        gateway_id: spec.gatewayId,
        upstream_app: spec.upstreamApp,
        upstream_entry: spec.upstreamEntry,
        upstream_args: spec.upstreamArgs,
        upstream_command_line:
          `${nodeBin.bin} bin/gateway.js --upstream-command ${nodeBin.bin} --upstream-arg ${spec.upstreamEntry} ` +
          `--upstream-app ${spec.upstreamApp} --gateway-id ${spec.gatewayId} --client-label ${options.clientLabel} ` +
          `--experiment-run-id ${options.experimentRunId} --db ${options.dbRelative}`,
        client_observed_server_info: clientObserved,
        upstream_server_info: upstreamInfo,
        upstream_server_info_source: inproc
          ? 'gateway 的上游 Client（进程内真实上游 Server 句柄）'
          : 'null：上游 Server 在子进程内部，不可直接观测',
        protocol_version: clientProtocol,
        upstream_protocol_version: upstreamProtocol,
        upstream_protocol_version_source: inproc ? 'gateway 的上游 Client（实测协商结果）' : 'null：同上',
        identity_agreement: identityAgreement,
        process_boundary: stack.process_boundary,
        gateway_pid: stack.gateway_pid ?? null,
        upstream_pid: stack.upstream_pid ?? null,
        stderr_log: stack.stderr_path ?? null,
      });
    }

    await cleanup();

    // ── 6. 只读回读（写入端已全部收尾）：calls / events / stats / integrity ──
    const readStore = openStore(options.dbPath);
    /** @type {Record<string, any>} */
    let dbQuery;
    try {
      dbQuery = collectDbQuery({ store: readStore, experimentRunId: options.experimentRunId });
    } finally {
      readStore.close();
    }

    const runConsistency = evaluateRunConsistency({
      calls: dbQuery.calls,
      events: dbQuery.events,
      experimentRunId: options.experimentRunId,
      clientLabel: options.clientLabel,
      expectedCalls: task.steps
        .filter((step) => step.method === 'tools/call')
        .map((step) => ({ upstream_app: step.upstream_app, tool_name: step.tool_name })),
    });
    const extraChecks = gatewayEvidence.map((gateway) =>
      check(
        `client_sees_upstream_identity:${gateway.gateway_id}`,
        gateway.client_observed_server_info?.name === gateway.upstream_app &&
          gateway.client_observed_server_info?.version === MOCK_SERVER_VERSION,
        `${gateway.upstream_app}@${MOCK_SERVER_VERSION}`,
        gateway.client_observed_server_info
          ? `${gateway.client_observed_server_info.name}@${gateway.client_observed_server_info.version}`
          : null,
        '客户端看到的是上游身份（Gateway 镜像，不伪装成自己的名字）',
      ),
    );
    const consistency = {
      ok: task.consistency.ok && runConsistency.ok && extraChecks.every((item) => item.ok),
      checks: [...task.consistency.checks, ...runConsistency.checks, ...extraChecks],
      failures: [
        ...task.consistency.failures,
        ...runConsistency.failures,
        ...extraChecks
          .filter((item) => !item.ok)
          .map((item) => ({ name: item.name, expected: item.expected, actual: item.actual })),
      ],
    };

    const endedAtUtc = nowUtcIso();
    const evidence = buildEvidence({
      mode,
      producer: 'bin/demo.js',
      startedAtUtc,
      endedAtUtc,
      startMs,
      environment: {
        node_version: process.versions.node,
        node_bin: nodeBin.bin,
        node_bin_source: nodeBin.source,
        platform: process.platform,
        arch: process.arch,
        cwd: process.cwd(),
        repo_root: REPO_ROOT,
        sandbox_pipe_stdio: probe.ok !== true,
        pipe_probe: probe,
        process_boundary:
          mode === 'inproc'
            ? 'in-process (real SDK stdio transports over in-memory streams)'
            : 'real child processes + stdio pipes',
        transport_note:
          mode === 'inproc'
            ? '仅把 OS 进程边界换成内存流边界；JSON 分帧、协商、错误语义均为真实 SDK 实现'
            : '真实 spawn bin/gateway.js（每个 Gateway 再 spawn 上游 Mock Server）+ StdioClientTransport',
      },
      run: {
        experiment_run_id: options.experimentRunId,
        client_label: options.clientLabel,
        db_path: options.dbRelative,
        started_at_utc: startedAtUtc,
        ended_at_utc: endedAtUtc,
        duration_ms: Date.now() - startMs,
        gateways: gatewayEvidence,
      },
      task: {
        name: TASK_NAME,
        steps: task.steps,
        mail_record: {
          title: task.mail_record.title,
          date: task.mail_record.date,
          time: task.mail_record.time,
          phone: task.mail_record.phone,
          notice_id: task.mail_record.notice_id,
        },
        requested_event: task.requested_event,
      },
      calendar: {
        store_file: options.calendarStoreRelative,
        cleared_before: reset.cleared,
        requested_event: task.requested_event,
        create_result: task.create_result?.structuredContent ?? null,
        create_is_error: task.create_result?.isError === true,
        list_result_count: task.list_result?.structuredContent?.count ?? null,
        stored_events: task.stored_events,
        stored_matches_mail:
          task.stored_events.length === 1 &&
          task.stored_events[0]?.title === task.mail_record.title &&
          task.stored_events[0]?.date === task.mail_record.date &&
          task.stored_events[0]?.time === task.mail_record.time,
        mail_record: {
          title: task.mail_record.title,
          date: task.mail_record.date,
          time: task.mail_record.time,
        },
      },
      consistency,
      dbQuery,
      transportFrames,
      extraFailures,
    });

    let evidencePath = null;
    if (options.writeEvidence) {
      evidencePath = writeEvidenceFile(options.evidenceOut, evidence);
      err(`[demo] 证据已写入 ${repoRelative(evidencePath)}（schema=${EVIDENCE_SCHEMA}）`);
    }
    if (options.json) out(JSON.stringify(evidence, null, 2));
    else out(renderReport(evidence));
    if (evidencePath) err(`[demo] 逐字段比对：keys=${evidence.comparable_keys.join(',')}`);

    return { evidence, exitCode: evidence.verdict.ok ? 0 : 1, evidencePath };
  } catch (error) {
    await cleanup();
    throw error;
  }
}

async function main() {
  const argv = process.argv.slice(2);
  let options;
  try {
    options = parseDemoArgs(argv);
  } catch (error) {
    if (error instanceof CliError) {
      writeErr(`[demo] ${error.message}`);
      if (error.showUsage) writeErr(DEMO_USAGE);
      process.exit(error.exitCode);
    }
    throw error;
  }
  if (options.help) {
    writeOut(DEMO_USAGE);
    process.exit(0);
  }

  try {
    const result = await runDemo(options);
    process.exit(result.exitCode);
  } catch (error) {
    if (error instanceof CliError) {
      writeErr(`[demo] ${error.message}`);
      if (error.showUsage) writeErr(DEMO_USAGE);
      process.exit(error.exitCode);
    }
    const spawnFailure = classifySpawnFailure(error);
    const probe = await probePipeSupport();
    if (options.mode === 'subprocess' && (spawnFailure.is_pipe_limitation || probe.ok !== true)) {
      writeErr(
        sandboxLimitationMessage({
          probe,
          error: spawnFailure.code || spawnFailure.syscall ? spawnFailure : undefined,
          extraArgs: [`--client-label ${options.clientLabel}`],
        }),
      );
      process.exit(3);
    }
    writeErr(`[demo] 运行失败：${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
    process.exit(1);
  }
}

/** 直接运行本文件时执行；被 import（测试）时不执行。 */
const isEntry = process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isEntry) {
  await main();
}
