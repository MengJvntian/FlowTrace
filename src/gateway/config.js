/**
 * src/gateway/config.js — Gateway 配置解析（S1）
 *
 * 契约：**所有**运行期配置只能来自命令行参数或环境变量（计划书要求「不得硬编码」）。
 * 支持形式：`--flag value`、`--flag=value`，以及等价的环境变量（`TRACE_*`）。
 *
 * 参数一览（`node bin/gateway.js --help`）：
 *   --upstream-command <cmd>      上游 MCP Server 可执行文件（必需）
 *   --upstream-arg <arg>          上游参数，可重复（顺序保留）
 *   --upstream-cwd <dir>          上游进程工作目录（可选）
 *   --gateway-id <id>             本 Gateway 实例标识（缺省 gw_<upstream-app>）
 *   --upstream-app <name>         上游应用名，例如 mock-mail / mock-calendar（必需）
 *   --client-label <label>        触发方标签：deterministic | codex | deepseek_harness
 *   --experiment-run-id <id>      一次实验运行 ID（缺省为空并告警）
 *   --db <path>                   事件库路径（缺省 demo-data/events.db）
 *   --max-payload-bytes <n>       单列载荷存储上限（缺省 262144）
 *   --timeout-ms <n>              单次上游请求超时（缺省 60000）
 *   --trace-enabled[=true|false]  是否留存原始载荷（缺省 true；关闭时只存摘要）
 *   --transport <name>            记录用传输名（缺省 stdio）
 *   --upstream-stderr <path>      上游 stderr 持续附加写入的日志路径
 *                                 （缺省 demo-data/logs/<gateway_id>.upstream.stderr.log，目录自动创建）
 *   --no-upstream-stderr          关闭上游 stderr 采集（不创建文件；等价 TRACE_UPSTREAM_STDERR=0）
 */
import process from 'node:process';
import { DEFAULT_MAX_PAYLOAD_BYTES } from '../shared/schemaversion.js';

export const DEFAULT_TIMEOUT_MS = 60000;
export const DEFAULT_DB_PATH = 'demo-data/events.db';

/** 需要取值的参数 → 目标字段名。 */
const VALUE_FLAGS = Object.freeze({
  '--upstream-command': 'upstreamCommand',
  '--upstream-arg': 'upstreamArg',
  '--upstream-cwd': 'upstreamCwd',
  '--gateway-id': 'gatewayId',
  '--upstream-app': 'upstreamApp',
  '--client-label': 'clientLabel',
  '--experiment-run-id': 'experimentRunId',
  '--db': 'dbPath',
  '--max-payload-bytes': 'maxPayloadBytes',
  '--timeout-ms': 'timeoutMs',
  '--transport': 'transport',
  '--trace-enabled': 'traceEnabled',
  '--upstream-stderr': 'upstreamStderr',
});

/** 无值参数。 */
const BOOL_FLAGS = Object.freeze({
  '--trace-disabled': 'traceDisabled',
  '--no-upstream-stderr': 'upstreamStderrDisabled',
  '--help': 'help',
  '-h': 'help',
});

/** 环境变量 → 配置字段。 */
const ENV_KEYS = Object.freeze({
  TRACE_UPSTREAM_COMMAND: 'upstreamCommand',
  TRACE_UPSTREAM_ARGS: 'upstreamArg',
  TRACE_UPSTREAM_CWD: 'upstreamCwd',
  TRACE_GATEWAY_ID: 'gatewayId',
  TRACE_UPSTREAM_APP: 'upstreamApp',
  TRACE_CLIENT_LABEL: 'clientLabel',
  TRACE_EXPERIMENT_RUN_ID: 'experimentRunId',
  TRACE_DB: 'dbPath',
  TRACE_MAX_PAYLOAD_BYTES: 'maxPayloadBytes',
  TRACE_TIMEOUT_MS: 'timeoutMs',
  TRACE_ENABLED: 'traceEnabled',
  TRACE_TRANSPORT: 'transport',
  TRACE_UPSTREAM_STDERR: 'upstreamStderr',
});

/**
 * 宽松布尔解析；无法识别返回 null（由调用方报错，不静默取默认值）。
 * @param {unknown} value
 * @returns {boolean | null}
 */
export function parseBoolean(value) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') {
    const v = value.trim().toLowerCase();
    if (['1', 'true', 'yes', 'on', 'enabled'].includes(v)) return true;
    if (['0', 'false', 'no', 'off', 'disabled'].includes(v)) return false;
  }
  return null;
}

/**
 * 解析 `--flag value` / `--flag=value` 形式的参数列表。
 * @param {string[]} argv
 * @returns {{values: Map<string, string[]>, flags: Set<string>, errors: string[]}}
 */
export function parseArgv(argv) {
  /** @type {Map<string, string[]>} */
  const values = new Map();
  const flags = new Set();
  const errors = [];

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    const eq = token.indexOf('=');
    const name = eq > 0 ? token.slice(0, eq) : token;
    const inlineValue = eq > 0 ? token.slice(eq + 1) : undefined;

    if (Object.prototype.hasOwnProperty.call(BOOL_FLAGS, name)) {
      if (inlineValue !== undefined) {
        const parsed = parseBoolean(inlineValue);
        if (parsed === null) errors.push(`参数 ${name} 的布尔值无法解析：${inlineValue}`);
        else if (parsed) flags.add(BOOL_FLAGS[name]);
      } else {
        flags.add(BOOL_FLAGS[name]);
      }
      continue;
    }

    if (Object.prototype.hasOwnProperty.call(VALUE_FLAGS, name)) {
      let value = inlineValue;
      if (value === undefined) {
        const next = argv[i + 1];
        if (next === undefined) {
          errors.push(`参数 ${name} 缺少取值`);
          continue;
        }
        value = next;
        i += 1;
      }
      const list = values.get(name) ?? [];
      list.push(value);
      values.set(name, list);
      continue;
    }

    errors.push(`未知参数：${token}（用 --help 查看用法）`);
  }

  return { values, flags, errors };
}

/**
 * @param {Map<string, string[]>} values
 * @param {string} flag
 * @returns {string | undefined}
 */
function lastValue(values, flag) {
  const list = values.get(flag);
  return list && list.length > 0 ? list[list.length - 1] : undefined;
}

/**
 * @param {string} raw
 * @param {string} flag
 * @param {string[]} errors
 * @returns {number | undefined}
 */
function parseIntFlag(raw, flag, errors) {
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    errors.push(`参数 ${flag} 需要正整数，实际为 ${JSON.stringify(raw)}`);
    return undefined;
  }
  return value;
}

/**
 * 标识类字段 → 命令行参数名（用于错误信息里指明字段）。
 * 这些字段一旦被写成文档占位符（含尖括号等），会**照常落库**并污染证据，必须在配置阶段拒绝。
 */
export const IDENTIFIER_FIELDS = Object.freeze({
  experimentRunId: '--experiment-run-id',
  gatewayId: '--gateway-id',
  clientLabel: '--client-label',
  upstreamApp: '--upstream-app',
  dbPath: '--db',
});

/** 标识类字段对应的环境变量名（错误信息里给出替代写法）。 */
export const IDENTIFIER_ENV_NAMES = Object.freeze({
  experimentRunId: 'TRACE_EXPERIMENT_RUN_ID',
  gatewayId: 'TRACE_GATEWAY_ID',
  clientLabel: 'TRACE_CLIENT_LABEL',
  upstreamApp: 'TRACE_UPSTREAM_APP',
  dbPath: 'TRACE_DB',
});

/**
 * 文档占位符识别（**刻意保守**，避免误伤真实 id）。
 *
 * 只命中三类明确形态：
 *   1. 尖括号：`<唯一后缀>` / `<RUN>` / `--run <id>`（含 `<` 或 `>` 任意一个即命中）；
 *   2. 全大写 `YOUR_...`：`YOUR_RUN_ID` / `YOUR_TOKEN`；
 *   3. shell 变量占位：`${RUN_ID}`（被引号包住而未被 shell 展开时才会到达这里）。
 *
 * **不**使用「只允许字母数字」这类过宽规则：真实 id 里的 `-`/`_`/`.`、ULID、
 * 十六进制串、中文标签都必须照常通过（有专门用例守护，见 tests/gateway.test.js）。
 *
 * @param {unknown} value
 * @returns {{kind: string, marker: string} | null}
 */
export function detectPlaceholder(value) {
  if (typeof value !== 'string' || value === '') return null;
  const angle = /[<>]/.exec(value);
  if (angle) return { kind: 'angle_brackets', marker: angle[0] };
  const yours = /\bYOUR_[A-Z0-9_]+\b/.exec(value);
  if (yours) return { kind: 'your_prefix', marker: yours[0] };
  const shellVar = /\$\{[^}]*\}/.exec(value);
  if (shellVar) return { kind: 'shell_variable', marker: shellVar[0] };
  return null;
}

/**
 * 校验标识类字段，命中占位符则写入 errors（调用方据此返回 ok:false → 退出码 2）。
 * 覆盖 **argv 与环境变量两个来源**（本函数在两者都解析完之后调用）。
 * @param {Record<string, any>} config
 * @param {string[]} errors
 */
export function assertNoPlaceholders(config, errors) {
  for (const [field, flag] of Object.entries(IDENTIFIER_FIELDS)) {
    const value = config[field];
    const hit = detectPlaceholder(value);
    if (!hit) continue;
    const hint =
      hit.kind === 'angle_brackets'
        ? `取值里含尖括号 ${JSON.stringify(hit.marker)}`
        : hit.kind === 'your_prefix'
          ? `取值里含占位前缀 ${JSON.stringify(hit.marker)}`
          : `取值里含未展开的 shell 变量 ${JSON.stringify(hit.marker)}`;
    errors.push(
      `${flag}（${field}）的取值 ${JSON.stringify(value)} 看起来是**文档占位符**：${hint}；` +
        '请替换为真实值（文档片段里的尖括号一律需要替换），' +
        `或改用环境变量注入（${IDENTIFIER_ENV_NAMES[field]}）；` +
        '这是防止把占位符写进证据库的守卫，本次未创建任何库文件、未写任何事件',
    );
  }
}

/**
 * 解析激活配置。
 * @param {string[]} [argv]
 * @param {Record<string, string | undefined>} [env]
 * @returns {{ok: boolean, config: Record<string, any> | null, errors: string[], help: boolean}}
 */
export function parseGatewayConfig(argv = process.argv.slice(2), env = process.env) {
  const { values, flags, errors } = parseArgv(argv);

  /** @type {Record<string, any>} */
  const config = {
    upstreamCommand: lastValue(values, '--upstream-command'),
    upstreamArgs: values.get('--upstream-arg') ?? [],
    upstreamCwd: lastValue(values, '--upstream-cwd'),
    gatewayId: lastValue(values, '--gateway-id'),
    upstreamApp: lastValue(values, '--upstream-app'),
    clientLabel: lastValue(values, '--client-label'),
    experimentRunId: lastValue(values, '--experiment-run-id'),
    dbPath: lastValue(values, '--db'),
    maxPayloadBytes: parseIntFlag(lastValue(values, '--max-payload-bytes'), '--max-payload-bytes', errors),
    timeoutMs: parseIntFlag(lastValue(values, '--timeout-ms'), '--timeout-ms', errors),
    transport: lastValue(values, '--transport'),
    traceEnabled: undefined,
    upstreamStderr: lastValue(values, '--upstream-stderr'),
    upstreamStderrDisabled: undefined,
  };

  const traceFlag = lastValue(values, '--trace-enabled');
  if (traceFlag !== undefined) {
    const parsed = parseBoolean(traceFlag);
    if (parsed === null) errors.push(`参数 --trace-enabled 的布尔值无法解析：${traceFlag}`);
    else config.traceEnabled = parsed;
  }
  if (flags.has('traceDisabled')) config.traceEnabled = false;
  if (flags.has('upstreamStderrDisabled')) config.upstreamStderrDisabled = true;

  // 环境变量兜底（命令行优先）
  for (const [envKey, field] of Object.entries(ENV_KEYS)) {
    const raw = env[envKey];
    if (raw === undefined || raw === '') continue;
    if (field === 'upstreamArg') {
      if (config.upstreamArgs.length > 0) continue;
      const trimmed = raw.trim();
      if (trimmed.startsWith('[')) {
        try {
          const parsed = JSON.parse(trimmed);
          if (Array.isArray(parsed)) config.upstreamArgs = parsed.map((item) => String(item));
          else errors.push(`环境变量 ${envKey} 需要 JSON 数组或空白分隔的字符串`);
        } catch (error) {
          errors.push(`环境变量 ${envKey} JSON 解析失败：${error instanceof Error ? error.message : error}`);
        }
      } else {
        config.upstreamArgs = trimmed.split(/\s+/);
      }
      continue;
    }
    if (config[field] !== undefined) continue;
    if (field === 'upstreamStderr') {
      // TRACE_UPSTREAM_STDERR: 0/false/off → 关闭；1/true → 默认路径；其它值 → 当作日志路径
      const parsed = parseBoolean(raw);
      if (parsed === false) {
        config.upstreamStderrDisabled = true;
        continue;
      }
      if (parsed === true) continue;
      config.upstreamStderr = raw.trim();
      continue;
    }
    if (field === 'maxPayloadBytes' || field === 'timeoutMs') {
      const value = Number(raw);
      if (!Number.isInteger(value) || value <= 0) {
        errors.push(`环境变量 ${envKey} 需要正整数，实际为 ${JSON.stringify(raw)}`);
        continue;
      }
      config[field] = value;
      continue;
    }
    if (field === 'traceEnabled') {
      const parsed = parseBoolean(raw);
      if (parsed === null) errors.push(`环境变量 ${envKey} 的布尔值无法解析：${raw}`);
      else config.traceEnabled = parsed;
      continue;
    }
    config[field] = raw;
  }

  if (flags.has('help')) {
    return { ok: errors.length === 0, config: null, errors, help: true };
  }

  if (!config.upstreamCommand) errors.push('缺少 --upstream-command（或环境变量 TRACE_UPSTREAM_COMMAND）');
  if (!config.upstreamApp) errors.push('缺少 --upstream-app（或环境变量 TRACE_UPSTREAM_APP）');
  if (!config.gatewayId) {
    config.gatewayId = config.upstreamApp ? `gw_${config.upstreamApp}` : undefined;
  }
  if (config.dbPath === undefined) config.dbPath = DEFAULT_DB_PATH;
  if (config.maxPayloadBytes === undefined) config.maxPayloadBytes = DEFAULT_MAX_PAYLOAD_BYTES;
  if (config.timeoutMs === undefined) config.timeoutMs = DEFAULT_TIMEOUT_MS;
  if (config.traceEnabled === undefined) config.traceEnabled = true;
  if (config.transport === undefined) config.transport = 'stdio';
  if (config.upstreamArgs === undefined) config.upstreamArgs = [];

  const warnings = [];
  if (!config.experimentRunId) {
    warnings.push('未提供 --experiment-run-id：事件仍会落库，但 experiment_run_id 为空，P2 血缘无法按运行聚合');
  }
  if (!config.clientLabel) {
    warnings.push('未提供 --client-label：client_label 为空（演示与验收要求给出 deterministic/codex/deepseek_harness 之一）');
  }
  if (config.upstreamArgs.length === 0 && /node(\.exe)?$/i.test(config.upstreamCommand)) {
    warnings.push('--upstream-command 指向 node 但没有任何 --upstream-arg：上游可能无法启动');
  }

  // 占位符守卫：必须在 argv 与环境变量都解析完之后执行（覆盖两个来源），
  // 且必须在 openStore 之前（bin/gateway.js 在 ok=false 时直接 exit 2，不建库、不写事件）。
  assertNoPlaceholders(config, errors);

  return { ok: errors.length === 0, config, errors, warnings, help: false };
}

/** @returns {string} 用法说明（供 stderr 输出） */
export function usage() {
  return [
    '用法: node bin/gateway.js --upstream-command <cmd> [--upstream-arg <arg> ...] [选项]',
    '      --upstream-command <cmd>    上游 MCP Server 可执行文件（必需）',
    '      --upstream-arg <arg>        上游参数，可重复（必需时多次给出）',
    '      --upstream-cwd <dir>        上游进程工作目录',
    '      --gateway-id <id>           本 Gateway 实例标识（缺省 gw_<upstream-app>）',
    '      --upstream-app <name>       上游应用名（必需），例如 mock-mail / mock-calendar',
    '      --client-label <label>      触发方标签 deterministic|codex|deepseek_harness',
    '      --experiment-run-id <id>    实验运行 ID',
    `      --db <path>                 事件库路径（缺省 ${DEFAULT_DB_PATH}）`,
    `      --max-payload-bytes <n>     单列载荷上限（缺省 ${DEFAULT_MAX_PAYLOAD_BYTES}）`,
    `      --timeout-ms <n>            上游请求超时（缺省 ${DEFAULT_TIMEOUT_MS}）`,
    '      --trace-enabled[=false]     是否留存原始载荷（缺省 true）',
    '      --trace-disabled            等价于 --trace-enabled=false',
    '      --transport <name>          记录用传输名（缺省 stdio）',
    '      --upstream-stderr <path>    上游 stderr 持续附加写入的日志路径',
    '                                  （缺省 demo-data/logs/<gateway-id>.upstream.stderr.log，目录自动创建）',
    '      --no-upstream-stderr        关闭上游 stderr 采集（不创建文件；等价 TRACE_UPSTREAM_STDERR=0）',
    '      --help                      输出本说明',
    '',
    '占位符守卫：--experiment-run-id / --gateway-id / --client-label / --upstream-app / --db',
    '  的取值若含尖括号（如 exp_dsh_mail_<唯一后缀>）、全大写 YOUR_... 或未展开的 ${...}，',
    '  一律按配置错误处理（exit 2），不会建库、不会写事件；请替换为真实值或改用 TRACE_* 环境变量。',
    '',
    '等价环境变量: TRACE_UPSTREAM_COMMAND TRACE_UPSTREAM_ARGS TRACE_UPSTREAM_CWD TRACE_GATEWAY_ID',
    '              TRACE_UPSTREAM_APP TRACE_CLIENT_LABEL TRACE_EXPERIMENT_RUN_ID TRACE_DB',
    '              TRACE_MAX_PAYLOAD_BYTES TRACE_TIMEOUT_MS TRACE_ENABLED TRACE_TRANSPORT',
    '              TRACE_UPSTREAM_STDERR（0/false/off 关闭；1/true 用默认路径；其它值当作日志路径）',
  ].join('\n');
}

/**
 * 启动摘要（只写 stderr；用于留证，绝不写 stdout）。
 * @param {Record<string, any>} config
 * @returns {string}
 */
export function formatConfig(config) {
  return [
    `gateway_id=${config.gatewayId}`,
    `upstream_app=${config.upstreamApp}`,
    `client_label=${config.clientLabel ?? '(none)'}`,
    `experiment_run_id=${config.experimentRunId ?? '(none)'}`,
    `db=${config.dbPath}`,
    `upstream_command=${config.upstreamCommand}`,
    `upstream_args=${JSON.stringify(config.upstreamArgs)}`,
    `upstream_cwd=${config.upstreamCwd ?? '(inherit)'}`,
    `max_payload_bytes=${config.maxPayloadBytes}`,
    `timeout_ms=${config.timeoutMs}`,
    `trace_enabled=${config.traceEnabled}`,
    `transport=${config.transport}`,
  ].join(' ');
}
