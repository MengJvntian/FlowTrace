/**
 * src/web/config.js — P3 只读页面服务的配置（W1）
 *
 * 全部配置来自命令行参数或环境变量（不硬编码，CONVENTIONS §4.7）：
 *
 * | 参数 | 环境变量 | 缺省 | 说明 |
 * |---|---|---|---|
 * | `--db <path>` | `TRACE_DB` | `demo-data/events.db` | 事件库路径（与 CLI/Gateway 同一变量名） |
 * | `--host <ip>` | `TRACE_WEB_HOST` | `127.0.0.1` | 只允许回环地址；非回环必须显式 `--allow-non-loopback` |
 * | `--port <n>` | `TRACE_WEB_PORT` | `8787` | `0` = 由系统分配空闲端口（测试与自检用） |
 * | `--retention-days <n>` | `TRACE_RETENTION_DAYS` | `30` | 保留期天数；`0` = 不启用保留期过滤 |
 * | `--retention-mode <m>` | `TRACE_RETENTION_MODE` | `active` | 缺省列表模式：active / all / expired |
 * | `--allow-raw[=bool]` | `TRACE_WEB_ALLOW_RAW` | `true` | 是否允许受控查看原文（每次访问都进审计日志，见 相关实现） |
 * | `--allow-non-loopback` | `TRACE_WEB_ALLOW_NON_LOOPBACK` | `false` | 允许绑定非回环地址（默认拒绝，隐私边界） |
 * | `--audit-max <n>` | `TRACE_WEB_AUDIT_MAX` | `200` | 页面内审计日志（环形缓冲）条数上限 |
 * | `--preview-chars <n>` | `TRACE_WEB_PREVIEW_CHARS` | `4000` | 时间线/证据里的脱敏载荷预览上限 |
 * | `--quiet` | — | `false` | 启动时只打印 URL |
 *
 * 退出码（bin/web.js）：`0` 成功/`--help`、`1` 运行期错误、`2` 用法错误。
 */
import path from 'node:path';
import process from 'node:process';

/** 缺省端口。 */
export const DEFAULT_PORT = 8787;
/** 缺省绑定地址：只监听回环。 */
export const DEFAULT_HOST = '127.0.0.1';
/** 缺省保留期（天）；计划书要求「默认与可配置」。 */
export const DEFAULT_RETENTION_DAYS = 30;
/** 缺省审计日志条数上限。 */
export const DEFAULT_AUDIT_MAX = 200;
/** 缺省脱敏载荷预览字符数。 */
export const DEFAULT_PREVIEW_CHARS = 4000;
/** `--self-exit-when-idle` 不带值时用的缺省空闲阈值（秒），与 serve 的空闲退出保持一致。 */
export const DEFAULT_SELF_EXIT_SECONDS = 90;
/** 缺省事件库路径（与 CLI 一致）。 */
export const DEFAULT_DB_RELATIVE = 'demo-data/events.db';
/** 允许绑定的回环主机名（其余一律拒绝，除非显式 --allow-non-loopback）。 */
export const LOOPBACK_HOSTS = Object.freeze(['127.0.0.1', 'localhost', '::1', '[::1]']);
/** 保留期模式。 */
export const RETENTION_MODES = Object.freeze(['active', 'all', 'expired']);
/** 受控查看原文时，理由字段的最短长度。 */
export const MIN_REVEAL_REASON_LENGTH = 3;

/** 用法错误（退出码 2）。 */
export class WebConfigError extends Error {
  /**
   * @param {string} message
   * @param {number} [exitCode]
   */
  constructor(message, exitCode = 2) {
    super(message);
    this.name = 'WebConfigError';
    this.exitCode = exitCode;
  }
}

export const WEB_USAGE = `用法: node bin/web.js [选项]

P3 本地只读可视化服务（只监听回环地址；只有 GET/HEAD，没有任何改库端点）。

选项：
  --db <path>              事件库路径（缺省 ${DEFAULT_DB_RELATIVE}；环境变量 TRACE_DB）
  --host <ip>              绑定地址（缺省 ${DEFAULT_HOST}；非回环地址需 --allow-non-loopback）
  --port <n>               端口（缺省 ${DEFAULT_PORT}；0 = 系统分配空闲端口）
  --retention-days <n>     保留期天数（缺省 ${DEFAULT_RETENTION_DAYS}；0 = 不启用保留期过滤）
  --retention-mode <m>     缺省列表模式 active|all|expired（缺省 active）
  --allow-raw[=true|false] 是否允许受控查看原文（缺省 true；每次访问都写审计记录）
  --mask[=true|false]      是否启用展示脱敏（缺省 false，个人工作台直接显示数据）
  --allow-non-loopback     允许绑定非回环地址（默认拒绝：隐私边界）
  --audit-max <n>          页面审计日志条数上限（缺省 ${DEFAULT_AUDIT_MAX}）
  --preview-chars <n>      脱敏载荷预览上限（缺省 ${DEFAULT_PREVIEW_CHARS}）
  --quiet                  启动时只打印 URL
  --self-exit-when-idle[=<秒>]  页面停止汇报心跳后自行退出（缺省 ${DEFAULT_SELF_EXIT_SECONDS} 秒）；
                           不带本开关则永不自退（单独跑 npm run web 的原有行为）
  --self-check             启动服务并对自身发起真实 HTTP 自检，打印 JSON 结果后退出（0 成功 / 1 失败）
  --help, -h               输出本说明

等价环境变量: TRACE_DB TRACE_WEB_HOST TRACE_WEB_PORT TRACE_RETENTION_DAYS TRACE_RETENTION_MODE
              TRACE_WEB_ALLOW_RAW TRACE_WEB_MASK TRACE_WEB_ALLOW_NON_LOOPBACK TRACE_WEB_AUDIT_MAX TRACE_WEB_PREVIEW_CHARS
              TRACE_WEB_SELF_EXIT_WHEN_IDLE

页面（默认 http://127.0.0.1:${DEFAULT_PORT}/）为只读：删除/重置等改库动作走 CLI 受控入口
  node bin/trace.js delete --run <experiment_run_id>
  node bin/reset.js --events --yes
`;

/**
 * @param {unknown} raw
 * @param {string} name
 * @returns {boolean | null}
 */
export function parseBool(raw, name) {
  if (typeof raw === 'boolean') return raw;
  if (typeof raw === 'string') {
    const lowered = raw.trim().toLowerCase();
    if (['1', 'true', 'yes', 'on', 'enabled'].includes(lowered)) return true;
    if (['0', 'false', 'no', 'off', 'disabled'].includes(lowered)) return false;
  }
  if (raw === undefined || raw === null || raw === '') return null;
  throw new WebConfigError(`参数 ${name} 只接受 true|false，实际为 ${JSON.stringify(raw)}`);
}

/**
 * @param {unknown} raw
 * @param {string} name
 * @param {{min?: number, max?: number}} [bounds]
 * @returns {number}
 */
function parseIntStrict(raw, name, bounds = {}) {
  const value = Number(raw);
  if (!Number.isFinite(value) || !Number.isInteger(value)) {
    throw new WebConfigError(`参数 ${name} 需要整数，实际为 ${JSON.stringify(raw)}`);
  }
  if (bounds.min !== undefined && value < bounds.min) {
    throw new WebConfigError(`参数 ${name} 不能小于 ${bounds.min}，实际为 ${value}`);
  }
  if (bounds.max !== undefined && value > bounds.max) {
    throw new WebConfigError(`参数 ${name} 不能大于 ${bounds.max}，实际为 ${value}`);
  }
  return value;
}

/** 选项表：`boolean` 型支持 `--flag` / `--flag=false` / `--flag false`。 */
const OPTION_SPEC = Object.freeze({
  '--db': { type: 'string', key: 'db' },
  '--host': { type: 'string', key: 'host' },
  '--port': { type: 'string', key: 'port' },
  '--retention-days': { type: 'string', key: 'retentionDays' },
  '--retention-mode': { type: 'string', key: 'retentionMode' },
  '--allow-raw': { type: 'boolean', key: 'allowRaw' },
  '--mask': { type: 'boolean', key: 'maskData' },
  '--no-raw-access': { type: 'boolean-false', key: 'allowRaw' },
  '--allow-non-loopback': { type: 'boolean', key: 'allowNonLoopback' },
  '--audit-max': { type: 'string', key: 'auditMax' },
  '--preview-chars': { type: 'string', key: 'previewChars' },
  '--quiet': { type: 'boolean', key: 'quiet' },
  // 页面服务的**空闲自退**（2026-10-07 修的真缺陷）：
  // 当页面被 serve 的复用分支以 detached 子进程拉起时，它只由 manager 通过 stop-file 收尾；
  // 一旦 manager 自己先退出（崩溃/被杀/沙箱回收），这个页面子进程就**成了孤儿**：
  // 永远占着 8787、且没有任何东西能停它 —— 用户随即陷入
  // 「stop 说没在运行 / start 说正在运行并复用它 / 打开却没有数据」的死循环。
  // 打开这个开关后，页面服务在**收到过第一次心跳**之后开始计时，心跳停止超过阈值即自行退出。
  // 刻意要求「先有过心跳」：否则刚起好、用户还没打开浏览器时就会被自己判为空闲而退出。
  '--self-exit-when-idle': { type: 'number-optional', key: 'selfExitWhenIdle' },
  '--self-check': { type: 'boolean', key: 'selfCheck' },
  '--help': { type: 'boolean', key: 'help' },
  '-h': { type: 'boolean', key: 'help' },
});

/**
 * 解析 `--flag value` / `--flag=value`；重复给出取最后一次；未知参数报用法错误。
 * @param {string[]} argv
 * @returns {{values: Record<string, any>, help: boolean, positionals: string[]}}
 */
export function parseWebOptions(argv) {
  /** @type {Record<string, any>} */
  const values = {};
  /** @type {string[]} */
  const positionals = [];
  let help = false;

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--') {
      positionals.push(...argv.slice(index + 1));
      break;
    }
    if (!token.startsWith('-')) {
      positionals.push(token);
      continue;
    }
    const eq = token.indexOf('=');
    const name = eq > 0 ? token.slice(0, eq) : token;
    const inline = eq > 0 ? token.slice(eq + 1) : undefined;
    const spec = OPTION_SPEC[name];
    if (!spec) throw new WebConfigError(`未知参数：${token}（用 --help 查看用法）`);

    if (spec.type === 'boolean' || spec.type === 'boolean-false') {
      const parsed = parseBool(inline === undefined ? spec.type === 'boolean' : inline, name);
      values[spec.key] = spec.type === 'boolean-false' ? false : parsed !== null ? parsed : true;
      if (spec.key === 'help' && values.help === true) help = true;
      continue;
    }

    let raw = inline;
    if (raw === undefined) {
      // 可选值型：裸写 `--flag` 时**不**吞下一个 token（`--self-exit-when-idle` 后面常常直接跟别的开关），
      // 只有下一个 token 不是开关时才当作它的取值。
      if (spec.type === 'number-optional') {
        const next = argv[index + 1];
        if (next !== undefined && !next.startsWith('-')) {
          raw = next;
          index += 1;
        } else {
          values[spec.key] = true;
          continue;
        }
      } else {
        raw = argv[index + 1];
        if (raw === undefined) throw new WebConfigError(`参数 ${name} 缺少取值`);
        index += 1;
      }
    }
    values[spec.key] = raw;
  }

  return { values, help, positionals };
}

/**
 * 事件库路径解析（与 CLI 同一规则：相对路径按 cwd 解析）。
 * @param {string | undefined} explicit
 * @param {string} [cwd]
 * @returns {string}
 */
export function resolveDbPath(explicit, cwd = process.cwd()) {
  const raw = typeof explicit === 'string' && explicit.trim() !== '' ? explicit.trim() : DEFAULT_DB_RELATIVE;
  if (raw === ':memory:') return raw;
  return path.isAbsolute(raw) ? raw : path.resolve(cwd, raw);
}

/**
 * 规范化绑定地址：`localhost`/`[::1]` 统一成回环 IP，便于断言「只监听 127.0.0.1」。
 * @param {string} host
 * @returns {string}
 */
export function normalizeHost(host) {
  const lowered = String(host).trim().toLowerCase();
  if (lowered === 'localhost' || lowered === '[::1]' || lowered === '::1') return '127.0.0.1';
  return lowered;
}

/**
 * @param {string} host
 * @returns {boolean}
 */
export function isLoopbackHost(host) {
  if (LOOPBACK_HOSTS.includes(String(host).trim().toLowerCase())) return true;
  return /^127(?:\.\d{1,3}){3}$/u.test(String(host).trim());
}

/**
 * 解析并校验配置。
 * @param {string[]} argv
 * @param {NodeJS.ProcessEnv} [env]
 * @param {{cwd?: string}} [options]
 * @returns {Record<string, any>}
 */
export function resolveWebConfig(argv, env = process.env, options = {}) {
  const { values, help, positionals } = parseWebOptions(argv);
  if (positionals.length > 0) throw new WebConfigError(`本命令不接受位置参数：${positionals.join(' ')}`);

  const pick = (parsedKey, envKey) => {
    if (values[parsedKey] !== undefined) return values[parsedKey];
    const fromEnv = env[envKey];
    return fromEnv === undefined || fromEnv === '' ? undefined : fromEnv;
  };

  const allowNonLoopback = parseBool(pick('allowNonLoopback', 'TRACE_WEB_ALLOW_NON_LOOPBACK'), 'TRACE_WEB_ALLOW_NON_LOOPBACK') === true;
  const rawHost = pick('host', 'TRACE_WEB_HOST') ?? DEFAULT_HOST;
  const host = normalizeHost(rawHost);
  if (!isLoopbackHost(host) && !allowNonLoopback) {
    throw new WebConfigError(
      `拒绝绑定非回环地址 ${JSON.stringify(rawHost)}：本页面默认只服务本机（隐私边界）。` +
        '确实需要时显式加 --allow-non-loopback（或 TRACE_WEB_ALLOW_NON_LOOPBACK=true），并在 相关实现 记录。',
    );
  }

  const portRaw = pick('port', 'TRACE_WEB_PORT') ?? DEFAULT_PORT;
  const port = parseIntStrict(portRaw, '--port', { min: 0, max: 65535 });
  const retentionDaysRaw = pick('retentionDays', 'TRACE_RETENTION_DAYS') ?? DEFAULT_RETENTION_DAYS;
  const retentionDays = parseIntStrict(retentionDaysRaw, '--retention-days', { min: 0, max: 36500 });
  const retentionModeRaw = String(pick('retentionMode', 'TRACE_RETENTION_MODE') ?? 'active').toLowerCase();
  if (!RETENTION_MODES.includes(retentionModeRaw)) {
    throw new WebConfigError(`--retention-mode 只接受 ${RETENTION_MODES.join('|')}，实际为 ${JSON.stringify(retentionModeRaw)}`);
  }
  const auditMax = parseIntStrict(pick('auditMax', 'TRACE_WEB_AUDIT_MAX') ?? DEFAULT_AUDIT_MAX, '--audit-max', {
    min: 1,
    max: 100000,
  });
  const previewChars = parseIntStrict(
    pick('previewChars', 'TRACE_WEB_PREVIEW_CHARS') ?? DEFAULT_PREVIEW_CHARS,
    '--preview-chars',
    { min: 64, max: 1000000 },
  );
  const allowRawParsed = parseBool(pick('allowRaw', 'TRACE_WEB_ALLOW_RAW'), '--allow-raw');
  const allowRaw = allowRawParsed === null ? true : allowRawParsed;
  const maskData = parseBool(pick('maskData', 'TRACE_WEB_MASK'), '--mask') === true;
  const quiet = values.quiet === true || parseBool(env.TRACE_WEB_QUIET, 'TRACE_WEB_QUIET') === true;
  // 空闲自退阈值（秒）。缺省 null = 永不自退（单独 `npm run web` 时的原有行为保持不变）。
  const selfExitRaw = values.selfExitWhenIdle;
  const selfExitWhenIdleSeconds = selfExitRaw === undefined
    ? null
    : parseIntStrict(
      selfExitRaw === true ? DEFAULT_SELF_EXIT_SECONDS : selfExitRaw,
      '--self-exit-when-idle',
      { min: 5, max: 86400 },
    );

  return {
    dbPath: resolveDbPath(pick('db', 'TRACE_DB'), options.cwd ?? process.cwd()),
    host,
    port,
    retentionDays,
    retentionMode: retentionModeRaw,
    allowRaw,
    maskData,
    allowNonLoopback,
    auditMax,
    previewChars,
    revealReasonMinLength: MIN_REVEAL_REASON_LENGTH,
    quiet,
    selfExitWhenIdleSeconds,
    selfCheck: values.selfCheck === true,
    help,
    cwd: options.cwd ?? process.cwd(),
  };
}

/**
 * 启动前的一行摘要（写 stderr，便于排查）。
 * @param {Record<string, any>} config
 * @returns {string}
 */
export function describeWebConfig(config) {
  return (
    `db=${config.dbPath} host=${config.host} port=${config.port} ` +
    `retention_days=${config.retentionDays} retention_mode=${config.retentionMode} ` +
    `allow_raw=${config.allowRaw} mask=${config.maskData} preview_chars=${config.previewChars} audit_max=${config.auditMax}`
  );
}
