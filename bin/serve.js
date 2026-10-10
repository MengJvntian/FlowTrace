#!/usr/bin/env node
/**
 * bin/serve.js — 一键启动器（t40）：像应用一样启动监控
 *
 * 一条命令做完：环境自检 → 起 Gateway（复用 `startManager`）→ 等全部上游就绪 → 起只读页面 →
 * 打印「库」与「页面」两行 → 用系统默认浏览器打开页面。
 *
 * 它顺手根治一个真实坑（t37 实测）：**demo 缺省写 `demo-data/demo/events.db`，而页面缺省读
 * `demo-data/events.db`** → 新用户看到「页面一片空白」且不知道原因。本启动器把**同一个 db 路径**
 * 同时交给 Gateway 与页面服务（`--db` 显式给定时两者都以它为准），并在启动 Gateway 时就把库文件建好，
 * 因此页面一打开就能看到本次实验的数据。
 *
 * 行为约定：
 *   - `--help`：只打印用法、exit 0、**不启动任何服务、不打开浏览器、不写任何文件**；
 *   - 默认：常驻（Ctrl+C 优雅停止：收尾 Gateway + 页面 + 打印汇总统计）；
 *   - `--print-url-only`：等就绪、打印状态后**立即退出**（脚本/CI 用）；全就绪 exit 0，否则 exit 3；
 *   - `--no-open`：不起浏览器（服务照常）；
 *   - 无桌面/无默认浏览器时**只提示**，不影响服务。
 *
 * 退出码：0 正常 / 1 未捕获异常 / 2 用法或配置错误 / 3 就绪等待超时或上游未就绪（不静默通过）
 */
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { createWebServer } from '../src/web/index.js';
import { WebConfigError, resolveWebConfig } from '../src/web/config.js';
import { DEFAULT_MANIFEST_PATH, loadManifest } from '../src/gateway/manifest.js';
import { startManager } from './trace-manager.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** 仓库根。 */
export const REPO_ROOT = path.resolve(HERE, '..');
/** 本文件路径（`--mount` 时用来分离启动自己）。 */
const ENTRY = fileURLToPath(import.meta.url);
/**
 * 就绪等待缺省上限（毫秒）。
 *
 * 2026-10-05 由 20000 提高到 60000：真实 Google 上游是 `uvx workspace-mcp`（Python），
 * **每次启动都要重新检查/安装约 96 个依赖包**，然后才把全部 Gmail/Calendar 工具注册进 MCP
 * —— 单个 Python 上游就要 20–40 秒。旧的 20 秒预算会让网关先放弃、把上游标成
 * `Request timed out` 并重试（`~/.google_workspace_mcp/logs/mcp_server_debug.log` 里能看到
 * 短时间出现两个不同 PID 的实例）。Mock 上游是瞬间就绪的，所以这个缺省值此前一直没暴露问题。
 */
export const DEFAULT_TIMEOUT_MS = 60000;
/** 页面缺省端口（与 bin/web.js 一致）。 */
export const DEFAULT_WEB_PORT = 8787;
/** 就绪轮询间隔（毫秒）。 */
export const POLL_INTERVAL_MS = 200;
/** 心跳空闲退出的缺省阈值（秒）。 */
export const DEFAULT_IDLE_TIMEOUT_SECONDS = 90;
/** 生命周期轮询间隔（毫秒）：检查心跳超时与停止文件。 */
export const LIFECYCLE_POLL_MS = 500;
/** PID/状态文件与停止文件的缺省位置（**仓库内**，绝不在用户目录）。 */
export const DEFAULT_PID_FILE = path.join('demo-data', 'serve.pid');
/** `--web-only` 页面子进程的 PID 文件（与 manager 分开，见复用分支里的说明）。 */
export const DEFAULT_WEB_PID_FILE = path.join('demo-data', 'serve-web.pid');
export const DEFAULT_STATUS_FILE = path.join('demo-data', 'serve.status.json');
export const DEFAULT_STOP_FILE = path.join('demo-data', 'serve.stop');
/** 收尾记录（原因 + 汇总）：后台挂载的子进程 stdout 被忽略，用它让退出对用户可见。 */
export const DEFAULT_LAST_EXIT_FILE = path.join('demo-data', 'serve.last-exit.json');
/**
 * `--mount` 等待子进程状态文件的上限（毫秒）。
 * **刻意与 `--timeout` 分开**：`--timeout` 的语义是「等上游就绪」，这里等的是「子进程写出状态文件」。
 */
export const DEFAULT_STATUS_TIMEOUT_MS = 10000;
/** t45：`--mount` 等待期间「仍在启动中…」的周期提示间隔（毫秒）。 */
export const DEFAULT_PROGRESS_INTERVAL_MS = 5000;

/** @param {string} text */
function out(text) {
  process.stdout.write(`${text}\n`);
}
/** @param {string} text */
function log(text) {
  process.stderr.write(`${text}\n`);
}
/** @param {number} ms */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 目标路径是否在仓库内（PID/状态/停止文件只允许写在仓库内）。
 * @param {string} target
 */
export function isInsideRepo(target) {
  const relative = path.relative(REPO_ROOT, path.resolve(REPO_ROOT, target));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

/** @returns {string} */
export function usage() {
  return [
    '用法: node bin\\serve.js [选项]',
    '',
    '一键启动监控：起 Gateway（单进程多上游）→ 起只读页面 → 打印「库」「页面」→ 用默认浏览器打开。',
    'Gateway 与页面**共用同一个事件库**（不会再出现「页面空白」），未就绪会给出原因与建议。',
    '',
    '选项：',
    `  --manifest <path>     实验清单（缺省 ${DEFAULT_MANIFEST_PATH}）`,
    '  --db <path>           事件库路径（**同时**给 Gateway 与页面；缺省用清单里的 db）',
    `  --port <n>            页面端口（缺省 ${DEFAULT_WEB_PORT}）`,
    '  --manager-port <n>    Gateway 监听端口（缺省用清单里的 http.port）',
    `  --timeout <ms>        等待全部上游就绪的上限（缺省 ${DEFAULT_TIMEOUT_MS}）`,
    `  --status-timeout <ms> --mount 等子进程状态文件的上限（缺省 ${DEFAULT_STATUS_TIMEOUT_MS}；与 --timeout 语义不同）`,
    '  --self-exit-when-idle[=<秒>]  页面子进程的空闲自退阈值（缺省跟随 --exit-when-idle）；',
    '                           用于避免 manager 先退出后，留下一个占着端口、又没有任何记录的孤儿页面进程',
    `  --progress-interval <ms> --mount 等待期间「仍在启动中…」的提示间隔（缺省 ${DEFAULT_PROGRESS_INTERVAL_MS}；0 = 只提示一次）`,
    '  --no-open             不自动打开浏览器（服务照常运行）',
    '  --print-url-only      等就绪并打印状态后立即退出（脚本/CI；全就绪 exit 0，否则 exit 3）',
    '  --json                机器可读输出（含库路径、页面 URL、上游就绪明细、生命周期模式）',
    '  --help                本说明',
    '',
    '生命周期（三选一，缺省 keep-alive）：',
    `  --keep-alive                常驻，直到 Ctrl+C 或 --stop（**不会**因页面空闲退出）`,
    `  --exit-when-idle[=<秒>]     页面停止汇报心跳后超过阈值就收尾退出（缺省 ${DEFAULT_IDLE_TIMEOUT_SECONDS}s）`,
    '  --mount                     分离到后台运行（父进程立即返回），打印 URL/库/PID/停止方法',
    '  --stop                      停止后台实例（读 PID 文件 → 优雅收尾 → 打印汇总）',
    '',
    '说明（不粉饰）：网页**无法**检测「浏览器被关闭」。`--exit-when-idle` 的语义是',
    '「页面停止汇报心跳后 N 秒内退出」——页面每 10 秒 GET 一次只读端点 /api/alive。',
    '',
    '退出码：0 正常 / 1 未捕获异常 / 2 用法或配置错误 / 3 就绪等待超时或上游未就绪',
    '',
    '停止：Ctrl+C（SIGINT）或 node bin\\serve.js --stop 都会同时收尾 Gateway 与页面，',
    '      并打印 events/calls/write_failures 汇总；退出前会打印**退出原因**。',
    `  文件（都在仓库内）：PID ${DEFAULT_PID_FILE}、状态 ${DEFAULT_STATUS_FILE}、停止信号 ${DEFAULT_STOP_FILE}`,
  ].join('\n');
}

/**
 * 解析参数。
 * @param {string[]} argv
 */
export function parseServeArgs(argv) {
  /** @type {string[]} */
  const errors = [];
  /** @type {Record<string, any>} */
  const options = {
    help: false,
    manifestPath: DEFAULT_MANIFEST_PATH,
    db: null,
    webPort: DEFAULT_WEB_PORT,
    managerPort: null,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    noOpen: false,
    printUrlOnly: false,
    json: false,
    // t43：生命周期
    keepAlive: false,
    exitWhenIdle: null, // number 秒 = 启用；null = 不启用
    mount: false,
    stop: false,
    // t51：只起只读页面（不起 Gateway）。见 parseArgs 里 --web-only 的说明。
    webOnly: false,
    pidFile: DEFAULT_PID_FILE,
    statusFile: DEFAULT_STATUS_FILE,
    stopFile: DEFAULT_STOP_FILE,
    idleTimeoutSeconds: DEFAULT_IDLE_TIMEOUT_SECONDS,
    // 页面子进程的空闲自退阈值；null = 运行时派生（跟随 idleTimeoutSeconds）
    selfExitWhenIdleSeconds: null,
    statusTimeoutMs: null, // null = 运行时按「等上游就绪的 --timeout + 余量」推导（见 main）
    progressIntervalMs: DEFAULT_PROGRESS_INTERVAL_MS,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    const eq = token.startsWith('--') ? token.indexOf('=') : -1;
    const name = eq > 0 ? token.slice(0, eq) : token;
    const inline = eq > 0 ? token.slice(eq + 1) : null;
    /** @returns {string | null} */
    const take = () => {
      if (inline !== null) return inline;
      const next = argv[index + 1];
      if (next === undefined || next.startsWith('--')) {
        errors.push(`${name} 缺少取值`);
        return null;
      }
      index += 1;
      return next;
    };
    switch (name) {
      case '--help':
        options.help = true;
        break;
      case '--manifest':
      case '--db': {
        const value = take();
        if (value === null) break;
        if (name === '--manifest') options.manifestPath = value;
        else options.db = value;
        break;
      }
      // `--self-exit-when-idle[=<秒>]`：页面**子进程**的空闲自退阈值。
      // 通常由 serve 自己派生（见复用分支），这里也接受显式传入，便于测试与手工调参。
      // 注意 `take()` 会把后面紧跟的开关判成「缺少取值」，所以必须走可选值分支。
      case '--self-exit-when-idle': {
        if (inline !== null) {
          const parsed = Number(inline);
          if (!Number.isInteger(parsed) || parsed < 5 || parsed > 86400) {
            errors.push(`--self-exit-when-idle 需要 5..86400 的整数秒（当前 ${JSON.stringify(inline)}）`);
            break;
          }
          options.selfExitWhenIdleSeconds = parsed;
          break;
        }
        const next = argv[index + 1];
        if (next !== undefined && !next.startsWith('--')) {
          const parsed = Number(next);
          if (!Number.isInteger(parsed) || parsed < 5 || parsed > 86400) {
            errors.push(`--self-exit-when-idle 需要 5..86400 的整数秒（当前 ${JSON.stringify(next)}）`);
            break;
          }
          options.selfExitWhenIdleSeconds = parsed;
          index += 1;
          break;
        }
        options.selfExitWhenIdleSeconds = DEFAULT_IDLE_TIMEOUT_SECONDS;
        break;
      }
      case '--port':
      case '--manager-port': {
        const value = take();
        if (value === null) break;
        const number = Number(value);
        if (!Number.isInteger(number) || number < 0 || number > 65535) {
          errors.push(`${name} 需要 0..65535 的整数（当前 ${JSON.stringify(value)}）`);
          break;
        }
        if (name === '--port') options.webPort = number;
        else options.managerPort = number;
        break;
      }
      // ⚠️ `--timeout` 是**毫秒预算**，不是端口 —— 它曾被错误地和上面两个端口参数共用同一个
      // case 分支，于是套上了 0..65535 的上限。后果：任何大于 65 秒的超时都传不进来，
      // 而真实 Google 上游（uvx workspace-mcp 每次重装约 96 个 Python 包）恰恰需要 >65 秒，
      // 于是 `start-monitor.bat` 传 `--timeout=90000` 直接报「需要 0..65535 的整数」并 exit 2。
      // （2026-10-05 用户实测踩到。）现在独立校验：1 秒 ~ 1 小时。
      case '--timeout': {
        const value = take();
        if (value === null) break;
        const number = Number(value);
        if (!Number.isInteger(number) || number < 1000 || number > 3600000) {
          errors.push(`--timeout 需要 1000..3600000 的整数毫秒（当前 ${JSON.stringify(value)}）`);
          break;
        }
        options.timeoutMs = number;
        break;
      }
      case '--no-open':
        options.noOpen = true;
        break;
      case '--print-url-only':
        options.printUrlOnly = true;
        break;
      case '--json':
        options.json = true;
        break;
      // ── t43：生命周期 ──────────────────────────────────────────────────────
      case '--keep-alive':
        options.keepAlive = true;
        break;
      case '--exit-when-idle': {
        // `--exit-when-idle`（用缺省阈值）或 `--exit-when-idle=<秒>`
        const raw = inline !== null ? inline : null;
        if (raw === null || raw === '') {
          options.exitWhenIdle = options.idleTimeoutSeconds;
          break;
        }
        const seconds = Number(raw);
        if (!Number.isFinite(seconds) || seconds <= 0) {
          errors.push(`--exit-when-idle 需要正数秒（当前 ${JSON.stringify(raw)}）`);
          break;
        }
        options.exitWhenIdle = Math.max(1, Math.round(seconds));
        break;
      }
      case '--mount':
        options.mount = true;
        break;
      case '--mount-child':
        // 内部标志：由 `--mount` 的父进程传给分离出去的子进程，表示「你负责写 PID/状态文件」。
        // 这样前台普通运行（含被 Windows 强杀的场景）不会留下任何运行时文件。
        options.mountChild = true;
        break;
      case '--web-only':
        // 内部/高级用途：**只起只读页面服务**，不去起 Gateway（也不碰 manager 端口）。
        // 用途：`--mount` 复用分支发现「Gateway 已在跑、但页面没起」时，用它把页面补起来
        // （2026-10-05 用户实测：先 `npm run start` 起网关，再跑 start-monitor.bat → 复用分支
        //  只探测页面却照样打开浏览器，于是页面端口无人监听、浏览器打不开）。
        options.webOnly = true;
        break;
      case '--stop':
        options.stop = true;
        break;
      case '--status-timeout': {
        // 只影响 `--mount` 等状态文件的时限（与 --timeout「等上游就绪」分开，不混用）
        const value = take();
        if (value === null) break;
        const number = Number(value);
        if (!Number.isInteger(number) || number < 200 || number > 600000) {
          errors.push(`--status-timeout 需要 200..600000 的整数毫秒（当前 ${JSON.stringify(value)}）`);
          break;
        }
        options.statusTimeoutMs = number;
        break;
      }
      case '--progress-interval': {
        // t45：等启动期间的周期提示间隔（写 0 = 只在出现 starting 时提示一次）
        const value = take();
        if (value === null) break;
        const number = Number(value);
        if (!Number.isInteger(number) || number < 0 || number > 600000) {
          errors.push(`--progress-interval 需要 0..600000 的整数毫秒（当前 ${JSON.stringify(value)}）`);
          break;
        }
        options.progressIntervalMs = number;
        break;
      }
      case '--pid-file':
      case '--status-file':
      case '--stop-file': {
        const value = take();
        if (value === null) break;
        if (name === '--pid-file') options.pidFile = value;
        else if (name === '--status-file') options.statusFile = value;
        else options.stopFile = value;
        break;
      }
      default:
        errors.push(`未知参数：${token}（用 --help 查看用法）`);
        break;
    }
  }
  if (options.mount && options.printUrlOnly) errors.push('--mount 与 --print-url-only 不能同时用（前者分离到后台，后者当场退出）');
  if (options.keepAlive && options.exitWhenIdle !== null) errors.push('--keep-alive 与 --exit-when-idle 互斥（前者永不因空闲退出）');
  for (const [flag, value] of [
    ['--pid-file', options.pidFile],
    ['--status-file', options.statusFile],
    ['--stop-file', options.stopFile],
  ]) {
    if (!isInsideRepo(value)) errors.push(`${flag} 只允许写在仓库内（当前 ${JSON.stringify(value)}）：绝不写用户目录`);
  }
  return { ok: errors.length === 0, options, errors };
}

/**
 * 进程是否还活着（跨平台；Windows 上没有信号语义，只用它做「在不在」判断）。
 * @param {number} pid
 */
export function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return /** @type {any} */ (error)?.code === 'EPERM';
  }
}

/** 读 PID 文件（不存在/损坏返回 null）。 @param {string} pidFile */
export function readPidFile(pidFile) {
  try {
    return JSON.parse(fs.readFileSync(path.resolve(REPO_ROOT, pidFile), 'utf8'));
  } catch {
    return null;
  }
}

/** 写 PID 文件（仓库内，含停止方法与人读提示）。 @param {string} pidFile @param {Record<string, any>} payload */
function writePidFile(pidFile, payload) {
  const target = path.resolve(REPO_ROOT, pidFile);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  return target;
}

/**
 * 从报告里汇总统计（Gateway 侧写入计数）。
 * @param {Record<string, any>} report
 */
export function summarize(report) {
  const upstreams = report.upstreams ?? [];
  return {
    events_written: upstreams.reduce((sum, item) => sum + (item.events_written ?? 0), 0),
    calls_written: upstreams.reduce((sum, item) => sum + (item.calls_written ?? 0), 0),
    write_failures: upstreams.reduce((sum, item) => sum + (item.write_failures ?? 0), 0),
  };
}

/**
 * 未就绪时给可操作建议（逐条对应真实失败家族）。
 * @param {Array<Record<string, any>>} upstreams
 */
export function readinessAdvice(upstreams) {
  /** @type {string[]} */
  const advice = [];
  for (const item of upstreams) {
    const reason = String(item.unavailable_reason ?? '');
    if (/EPERM|spawn/i.test(reason)) {
      advice.push(`「${item.serverName}」上游起不来（spawn/EPERM）：**在允许创建带管道子进程的普通终端里启动**（沙箱/受限环境会拒绝），或用 HTTP 上游形态`);
    } else if (/令牌不可用|oauth/i.test(reason)) {
      advice.push(`「${item.serverName}」需要 OAuth 令牌：先跑 node bin\\oauth-login.js --login，再看 node bin\\trace-manager.js --status`);
    } else if (/ENOENT|不存在|not found/i.test(reason)) {
      advice.push(`「${item.serverName}」的上游命令/脚本不存在：检查清单里的 command/args 与 cwd`);
    } else if (reason) {
      advice.push(`「${item.serverName}」未就绪：${reason}`);
    }
  }
  if (advice.length === 0) advice.push('没有上游就绪：先用 node bin\\trace-manager.js --status 看明细');
  advice.push('随时可以单独看 Gateway 明细：node bin\\trace-manager.js --status');
  return advice;
}

/**
 * 用系统默认浏览器打开 URL（失败只提示，不影响服务）。
 * @param {string} url
 * @returns {Promise<{opened: boolean, reason: string | null}>}
 */
export async function openUrl(url) {
  const platform = process.platform;
  const command = platform === 'win32' ? 'cmd' : platform === 'darwin' ? 'open' : 'xdg-open';
  const args = platform === 'win32' ? ['/c', 'start', '', url] : [url];
  try {
    const child = spawn(command, args, { stdio: 'ignore', detached: true, windowsHide: true });
    child.unref();
    return { opened: true, reason: null };
  } catch (error) {
    return { opened: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

/** 页面报告（人读）。 @param {Record<string, any>} payload */
function renderHuman(payload) {
  const lines = [];
  lines.push(`库：${payload.db}`);
  lines.push(`页面：${payload.web.url}   （自检：${payload.web.self_check.ok ? `HTTP ${payload.web.self_check.status} ✓` : `失败——${payload.web.self_check.error}`}）`);
  lines.push(`Gateway：${payload.manager.url}   （全部上游就绪：${payload.manager.all_ready ? '是' : '否'}）`);
  lines.push('');
  for (const item of payload.manager.upstreams) {
    const mark = item.upstream_ready ? '[就绪]' : '[未就绪]';
    lines.push(`  ${mark} ${item.serverName}（${item.transport}）→ ${item.endpoint}`);
    if (!item.upstream_ready) lines.push(`        原因：${item.unavailable_reason ?? '（连接中）'}`);
  }
  if (!payload.manager.all_ready) {
    lines.push('');
    lines.push('  建议：');
    for (const tip of payload.advice) lines.push(`    · ${tip}`);
  }
  lines.push('');
  lines.push(payload.opened === null ? '（未尝试打开浏览器：--no-open 或 --print-url-only）' : payload.opened ? '已在系统默认浏览器中打开页面。' : `打不开浏览器（${payload.open_reason}）：请手动把上面的「页面」地址粘进浏览器。`);
  return lines.join('\n');
}

/**
 * 判断某个 manager 端口上的占用情形（t48）——三种情形必须区分清楚，不得混为一谈：
 *   `free`     TCP 连不上 → 端口空闲，可以正常挂载；
 *   `platform` TCP 通且 `/healthz` 返回 200 + 本平台指纹（`transport==='trace-manager'` 且有 upstreams）→ **健康实例，应复用**；
 *   `foreign`  TCP 通但 /healthz 非 200 或不是本平台指纹 → 别的程序占着；
 *   `dead`     TCP 通但完全没人应答 HTTP（陈旧套接字 / 正在启动）→ 明确报「占用但无应答」。
 * @param {number} port
 * @param {{timeoutMs?: number, fetchImpl?: typeof fetch}} [options]
 * @returns {Promise<{kind: 'free'|'platform'|'foreign'|'dead', health?: Record<string, any>, status?: number | null, reason?: string | null}>}
 */
export async function probePlatformInstance(port, options = {}) {
  const timeoutMs = options.timeoutMs ?? 1500;
  const connected = await new Promise((resolve) => {
    const socket = net.createConnection({ host: '127.0.0.1', port });
    const done = (value) => {
      socket.destroy();
      resolve(value);
    };
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
    socket.setTimeout(timeoutMs, () => done(false));
  });
  if (!connected) return { kind: 'free' };
  const fetchImpl = options.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(`http://127.0.0.1:${port}/healthz`, { signal: controller.signal });
    const text = await response.text();
    /** @type {Record<string, any> | null} */
    let body = null;
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }
    if (response.status === 200 && body?.transport === 'trace-manager' && Array.isArray(body.upstreams)) {
      return { kind: 'platform', health: body };
    }
    return { kind: 'foreign', status: response.status };
  } catch (error) {
    return { kind: 'dead', reason: error instanceof Error ? error.message : String(error) };
  } finally {
    clearTimeout(timer);
  }
}

/** 探测一个 URL 是否是 200（用于报告已有实例的页面是否可访问）。 */
export async function probeHttpOk(url, timeoutMs = 1500) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    return { ok: response.status === 200, status: response.status, reason: null };
  } catch (error) {
    return { ok: false, status: null, reason: error instanceof Error ? error.message : String(error) };
  } finally {
    clearTimeout(timer);
  }
}

/** 页面身份与库路径必须来自 API；任意网站返回 HTTP 200 不代表本平台。 */
export async function probeWebInstance(url, dbPath = null, timeoutMs = 1500) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(new URL('/api/meta', url), { signal: controller.signal });
    const body = await response.json();
    if (response.status !== 200 || body?.service?.name !== 'mcp-cross-app-trace-web' || body.service.read_only !== true) {
      return { ok: false, status: response.status, reason: '页面端口被非本平台程序占用' };
    }
    if (dbPath && (typeof body.store?.db_path !== 'string' || path.resolve(REPO_ROOT, body.store.db_path) !== path.resolve(REPO_ROOT, dbPath))) {
      return { ok: false, status: response.status, reason: '页面与 Gateway 的事件库不一致' };
    }
    return { ok: true, status: response.status, reason: null };
  } catch (error) {
    return { ok: false, status: null, reason: error instanceof Error ? error.message : String(error) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 跑一条系统命令并把 stdout 读成字符串。
 *
 * ⚠️ **不要用默认的 `stdio: 'pipe'`** —— 本项目的沙箱（以及部分受限环境）禁止带管道的子进程，
 * 会直接报 `spawnSync ... EPERM`。这里改成写临时文件再读（与 bin/cred-audit.js 同一套办法，
 * 符合 CONVENTIONS §1.1.1：子进程输出走文件，不走管道）。
 *
 * @param {string} command
 * @param {string[]} args
 * @returns {string | null} 失败返回 null（调用方必须自己决定怎么表述，不得静默当成成功）
 */
export function runCapture(command, args) {
  const tmp = path.join(os.tmpdir(), `serve-capture-${process.pid}-${Math.random().toString(36).slice(2)}.txt`);
  let fd = null;
  try {
    fd = fs.openSync(tmp, 'w');
    execFileSync(command, args, { stdio: ['ignore', fd, fd], windowsHide: true, timeout: 15000 });
    fs.closeSync(fd);
    fd = null;
    const text = fs.readFileSync(tmp, 'utf8');
    fs.rmSync(tmp, { force: true });
    return text;
  } catch {
    try {
      if (fd !== null) fs.closeSync(fd);
    } catch {
      /* ignore */
    }
    fs.rmSync(tmp, { force: true });
    return null;
  }
}

/**
 * 找出**正在监听某个回环端口**的进程 PID（用于发现「孤儿页面」）。
 *
 * 为什么需要它（2026-10-07 用户实际卡住的死循环）：
 *   页面子进程是 detached 拉起的，只靠 manager 的 stop-file 收尾。manager 一旦先退出，
 *   页面就成了孤儿：它占着端口，但 PID 文件已经不存在 —— 于是 `--stop` 说「没有在运行」，
 *   而 `--mount` 探测到端口有 HTTP 200 又说「正在运行，复用它」。用户两头都得不到真相。
 *   这里直接问系统「谁占着这个端口」，PID 文件缺失也能把它揪出来。
 *
 * @param {number} port
 * @returns {number[]} 监听该端口的 PID 列表（可能为空）
 */
export function findPortHolders(port) {
  const output = runCapture('netstat', ['-ano', '-p', 'TCP']);
  if (output === null) return [];
  /** @type {Set<number>} */
  const pids = new Set();
  for (const line of output.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.includes('LISTENING')) continue;
    // 形如：TCP    127.0.0.1:8787    0.0.0.0:0    LISTENING    40488
    const match = trimmed.match(/^TCP\s+\S+:(\d+)\s+\S+\s+LISTENING\s+(\d+)$/);
    if (!match) continue;
    if (Number(match[1]) !== Number(port)) continue;
    pids.add(Number(match[2]));
  }
  return [...pids];
}

/**
 * `--stop` 没拿到 `--manager-port` 时，用清单里声明的网关端口作为线索。
 *
 * 为什么是「线索」而不是权威值：`--stop` 不加载完整清单（那会引入一堆与停止无关的校验，
 * 比如环境变量缺失），只做一次**只读**的 JSON 读取；读不到就回落到缺省端口。
 * 保守取值的意义：宁愿找不到残留进程（并如实说明），也不要误杀别的程序。
 *
 * @param {{manifestPath?: string}} options
 * @returns {number | null}
 */
function manifestPortHint(options) {
  try {
    const manifestPath = options.manifestPath ?? DEFAULT_MANIFEST_PATH;
    const raw = fs.readFileSync(path.resolve(REPO_ROOT, manifestPath), 'utf8');
    const parsed = JSON.parse(raw);
    const port = Number(parsed?.http?.port);
    return Number.isInteger(port) && port > 0 ? port : null;
  } catch {
    return null;
  }
}

async function main() {
  const parsed = parseServeArgs(process.argv.slice(2));
  if (parsed.options.help) {
    out(usage());
    process.exit(0);
  }
  if (!parsed.ok) {
    for (const error of parsed.errors) log(`[serve] 配置错误：${error}`);
    log(usage());
    process.exit(2);
  }
  const options = parsed.options;
  // `--mount` 等状态文件的时限：显式给了就用它；否则取 max(10s, 等上游就绪的时限 + 15s)。
  // 理由（t44）：子进程要**先等上游就绪**才写出最终状态文件，父进程的默认时限必须留足余量，
  // 否则「上游慢但一切正常」又会被误判成失败。
  const statusTimeoutMs = options.statusTimeoutMs ?? Math.max(DEFAULT_STATUS_TIMEOUT_MS, options.timeoutMs + 15000);

  // ── 0) `--stop`：读 PID 文件 → 写停止信号文件 → 等它优雅收尾（跨平台；Windows 上没有真信号语义）
  if (options.stop) {
    // 先收「页面子进程」（由 --mount 的复用分支 detached 拉起，不在 manager 的进程组里，
    // 必须按它自己的 PID 收；否则它会一直占着页面端口与库连接）。2026-10-05 修。
    const webRecord = readPidFile(DEFAULT_WEB_PID_FILE);
    if (webRecord && Number.isInteger(webRecord.pid)) {
      if (isProcessAlive(webRecord.pid)) {
        try {
          process.kill(webRecord.pid);
          out(`已停止页面子进程（PID ${webRecord.pid}，端点 ${webRecord.url ?? '?'}）`);
        } catch (error) {
          log(`[serve] 停止页面子进程失败（PID ${webRecord.pid}）：${error instanceof Error ? error.message : String(error)}`);
        }
      } else {
        out(`页面子进程 PID ${webRecord.pid} 已不在运行（PID 文件是陈旧的）`);
      }
      fs.rmSync(path.resolve(REPO_ROOT, DEFAULT_WEB_PID_FILE), { force: true });
    }
    const record = readPidFile(options.pidFile);
    if (!record || !Number.isInteger(record.pid)) {
      // PID 文件不存在/不可解析 —— 但这**不代表没有东西在跑**：页面子进程是 detached 拉起的，
      // manager 先退出时它会变成孤儿，占着端口却没有任何 PID 记录。
      // 所以这里改为直接问系统「谁占着我们的端口」，把它收掉（2026-10-07 修）。
      const ports = [
        { label: '页面端口', port: options.webPort },
        { label: '网关端口', port: options.managerPort ?? manifestPortHint(options) },
      ];
      const found = [];
      for (const entry of ports) {
        if (!Number.isInteger(entry.port) || entry.port <= 0) continue;
        for (const pid of findPortHolders(entry.port)) found.push({ ...entry, pid });
      }
      if (found.length === 0) {
        out(`没有找到后台实例（PID 文件：${options.pidFile} 不存在或不可解析；端口 ${ports.map((p) => p.port).filter(Boolean).join(' / ')} 也无人监听）`);
        out('可能已经停过了；要启动：node bin\\serve.js --mount');
        process.exit(0);
      }
      out('没有 PID 文件，但端口仍被占用 —— 这是一个**没有记录的残留进程**（孤儿）：');
      for (const item of found) {
        out(`  ${item.label} ${item.port} ← PID ${item.pid}`);
      }
      let killed = 0;
      for (const item of found) {
        if (item.pid === process.pid) continue;
        try {
          process.kill(item.pid);
          killed += 1;
          out(`  已停止 PID ${item.pid}（${item.label} ${item.port}）`);
        } catch (error) {
          log(`[serve] 停止 PID ${item.pid} 失败：${error instanceof Error ? error.message : String(error)}`);
        }
      }
      // 残留的状态类文件一并清掉，避免下次又按陈旧信息判断
      fs.rmSync(path.resolve(REPO_ROOT, options.statusFile), { force: true });
      fs.rmSync(path.resolve(REPO_ROOT, options.stopFile), { force: true });
      fs.rmSync(path.resolve(REPO_ROOT, DEFAULT_WEB_PID_FILE), { force: true });
      if (killed === 0) {
        log('[serve] 没能停止任何残留进程（可能是权限不足）；可在任务管理器里按上面的 PID 结束它。');
        process.exit(1);
      }
      out(`已清理 ${killed} 个残留进程；现在可以重新启动：node bin\\serve.js --mount`);
      process.exit(0);
    }
    if (!isProcessAlive(record.pid)) {
      out(`PID ${record.pid} 已不在运行（PID 文件是陈旧的：${options.pidFile}）`);
      fs.rmSync(path.resolve(REPO_ROOT, options.pidFile), { force: true });
      // 陈旧状态文件也顺手清掉：它只对「写出它的那个 pid」有意义（其它实例会按 pid 忽略它，但留着会让人困惑）
      fs.rmSync(path.resolve(REPO_ROOT, options.statusFile), { force: true });
      fs.rmSync(path.resolve(REPO_ROOT, options.stopFile), { force: true });
      out('要启动：node bin\\serve.js --mount');
      process.exit(0);
    }
    const stopFile = path.resolve(REPO_ROOT, options.stopFile);
    fs.mkdirSync(path.dirname(stopFile), { recursive: true });
    fs.writeFileSync(stopFile, `stop requested at ${new Date().toISOString()}\n`, 'utf8');
    out(`已请求停止 PID ${record.pid}（把停止信号写进 ${options.stopFile}）；等它优雅收尾…`);
    const waitUntil = Date.now() + Math.max(options.timeoutMs, 10000);
    while (Date.now() < waitUntil && isProcessAlive(record.pid)) await sleep(LIFECYCLE_POLL_MS);
    if (isProcessAlive(record.pid)) {
      log(`[serve] PID ${record.pid} 在等待窗口内没有退出；汇总统计见它的日志（stdout/stderr 由挂载方忽略，可改用 --no-open 前台运行观察）`);
      process.exit(1);
    }
    fs.rmSync(stopFile, { force: true });
    out(`已停止（PID ${record.pid} 已退出，停止文件已清理）`);
    // 后台实例的 stdout 被忽略：把它的收尾记录读回来，让「退出原因 + 汇总统计」对用户可见
    try {
      const lastExit = JSON.parse(fs.readFileSync(path.resolve(REPO_ROOT, DEFAULT_LAST_EXIT_FILE), 'utf8'));
      if (lastExit?.pid === record.pid) {
        out(`  退出原因：${lastExit.reason}`);
        out(
          `  汇总 events_written=${lastExit.totals?.events_written ?? 0} calls_written=${lastExit.totals?.calls_written ?? 0} write_failures=${lastExit.totals?.write_failures ?? 0}`,
        );
      }
    } catch {
      /* 没有收尾记录也能正常停 */
    }
    process.exit(0);
  }

  // ── 0.05) `--web-only`：只起只读页面服务，**不去起 Gateway**（内部/高级用途）
  //
  // 为什么需要它（2026-10-05 用户实测的真缺陷）：用户先 `npm run start` 起了 Gateway（8790），
  // 之后跑 start-monitor.bat → `--mount` 的复用分支检测到「已有实例」→ 只**探测**页面端口却
  // 照样调用 openUrl(页面)，于是浏览器打开一个没人监听的端口。复用分支现在会用本模式把页面补起来。
  if (options.webOnly) {
    const manifest = loadManifest({ manifestPath: options.manifestPath, cwd: REPO_ROOT });
    if (!manifest.ok) {
      log(`[serve] 清单错误：${manifest.errors.join('；')}`);
      process.exit(2);
    }
    const dbPath = options.db ?? manifest.manifest.dbPath;
    let config;
    try {
      config = resolveWebConfig(['--db', dbPath, '--port', String(options.webPort)], process.env);
    } catch (error) {
      log(`[serve] 页面配置错误：${error instanceof Error ? error.message : String(error)}`);
      process.exit(2);
    }
    let lastAliveMs = null;
    const idleSeconds = options.selfExitWhenIdleSeconds;
    const web = createWebServer({
      config, logger: (line) => log(`[页面] ${line}`),
      lifecycle: idleSeconds === null ? { mode: 'keep-alive', idle_timeout_seconds: null } : { mode: 'idle-exit', idle_timeout_seconds: idleSeconds },
      onAlive: () => { lastAliveMs = Date.now(); },
    });
    let info;
    try {
      info = await web.start();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log(`[serve] 页面启动失败：${message}`);
      if (/EADDRINUSE/i.test(message)) log(`[serve] → 端口 ${options.webPort} 被占用：换 --port，或先停掉旧进程`);
      process.exit(1);
    }
    const url = info?.url ?? `http://127.0.0.1:${options.webPort}/`;
    out(`[serve] 只读页面已启动（--web-only，未启动 Gateway）：${url}`);
    out(`  库：${config.dbPath}`);
    // 常驻；SIGINT 与停止文件都能收尾
    let closing = false;
    const close = async (reason) => {
      if (closing) return;
      closing = true;
      log(`[serve] 页面服务收尾（${reason}）`);
      await web.close?.();
      web.closeStore?.();
      process.exit(0);
    };
    process.on('SIGINT', () => void close('收到 Ctrl+C'));
    process.on('SIGTERM', () => void close('收到 SIGTERM'));
    const stopFile = path.resolve(REPO_ROOT, options.stopFile);
    const timer = setInterval(() => {
      if (fs.existsSync(stopFile)) void close('收到停止文件');
      else if (idleSeconds !== null && lastAliveMs !== null && Date.now() - lastAliveMs >= idleSeconds * 1000) {
        void close('心跳停止后自行退出');
      }
    }, LIFECYCLE_POLL_MS);
    timer.unref?.();
    return;
  }

  // ── 0.1) `--mount`：分离到后台（detached + stdio:ignore + unref；不依赖 nohup），等状态文件后打印信息
  if (options.mount) {
    // 先读清单：复用判定需要它声明的 manager 端口
    const mountLoaded = loadManifest({ manifestPath: options.manifestPath, cwd: REPO_ROOT });
    if (!mountLoaded.ok) {
      for (const error of mountLoaded.errors) log(`[serve] 清单错误：${error}`);
      log('[serve] → 先跑 node bin\\setup.js 看环境自检，或 node bin\\wrap-config.js 生成配置');
      process.exit(2);
    }
    const managerPort = options.managerPort ?? mountLoaded.manifest.http.port;
    const probe = await probePlatformInstance(managerPort);

    // ① manager 端口已被**本平台健康实例**占用 → 复用（不新起进程，也不碰 PID/状态文件）
    if (probe.kind === 'platform') {
      const health = probe.health;
      const pageUrl = `http://127.0.0.1:${options.webPort}/`;
      let pageProbe = await probeWebInstance(pageUrl, health.db);
      // 页面没在跑 → **真把它起起来**（t51 修的真缺陷：以前只探测却照样打开浏览器，
      // 结果是「Gateway 在跑但页面端口无人监听 → 浏览器打不开」）。
      // 用 --web-only 分离一个只读页面进程，与已在运行的 Gateway 共用同一个库。
      let pageStarted = false;
      if (!pageProbe.ok) {
        // 已占用的端口不能再拉起一个页面，更不能把错误页面当成复用成功。
        const occupied = await probeHttpOk(pageUrl);
        if (occupied.status !== null) {
          log(`[serve] 无法复用页面：${pageProbe.reason}。请停止旧页面，或换 --port。`);
          process.exit(2);
        }
        const webOnlyArgs = [
          ENTRY,
          '--web-only',
          '--manifest', options.manifestPath,
          '--port', String(options.webPort),
          // 库以**正在运行的 Gateway 报的库**为准，保证两边同库（否则页面会空白）
          ...(health.db ? ['--db', health.db] : options.db ? ['--db', options.db] : []),
          '--stop-file', options.stopFile,
          // ⚠️ 必须给页面子进程**自己的空闲自退**（2026-10-07 修的真缺陷）。
          // 它是 detached 的，正常情况下由 manager 通过 stop-file 收尾；但 manager 一旦先退出
          // （崩溃/被杀/沙箱回收），它就变成**孤儿**：永远占着页面端口、没有任何东西能停它，
          // 用户随即陷入「stop 说没在运行 / start 说正在运行并复用它 / 打开却没有数据」的死循环。
          // 打开自退后，即使 manager 已经不在，页面也会在心跳停止超过阈值后自己退出。
          '--self-exit-when-idle=' + String(
            options.selfExitWhenIdleSeconds ?? options.idleTimeoutSeconds ?? DEFAULT_IDLE_TIMEOUT_SECONDS,
          ),
        ];
        try {
          // 分离子进程的 stdout/stderr 默认被 ignore —— 那它「起不来」时谁也看不到原因
          // （2026-10-05 实测：--web-only 因参数问题立刻退出，却完全无声）。
          // 因此把它的输出记到仓库内的日志文件，便于事后排查。
          const webLogPath = path.resolve(REPO_ROOT, 'demo-data', 'logs', 'serve-web-only.log');
          fs.mkdirSync(path.dirname(webLogPath), { recursive: true });
          const logFd = fs.openSync(webLogPath, 'a');
          const child = spawn(process.execPath, webOnlyArgs, {
            cwd: REPO_ROOT,
            detached: true,
            stdio: ['ignore', logFd, logFd],
            windowsHide: true,
          });
          child.unref();
          fs.closeSync(logFd);
          pageStarted = true;
          // ⚠️ 记下页面子进程的 PID（2026-10-05 修的真缺陷）：
          // 这个 `--web-only` 是 **detached** 的，不在父进程的进程组里 —— 父进程退出后它就
          // 成了无人管辖的孤儿：继续占着页面端口与 SQLite 连接、继续轮询，而 `--stop` 只看
          // manager 的 PID 文件，根本收不到它。实测后果：跑完 serve 相关用例后套件整体挂起
          // （日志里能持续看到它的 GET /api/runs），后续用例也再绑不上那个端口。
          // 因此把它的 PID 单独落盘，让 `--stop` 能按 PID 收尾。
          if (Number.isInteger(child.pid)) {
            const webPidPath = path.resolve(REPO_ROOT, DEFAULT_WEB_PID_FILE);
            fs.mkdirSync(path.dirname(webPidPath), { recursive: true });
            fs.writeFileSync(webPidPath, `${JSON.stringify({ pid: child.pid, url: pageUrl, db: health.db ?? null }, null, 2)}\n`, 'utf8');
          }
          // 等它真的能应答（最多 ~6s），别把「刚起好还没 listen」误报成失败
          for (let i = 0; i < 30; i += 1) {
            await sleep(200);
            pageProbe = await probeWebInstance(pageUrl, health.db);
            if (pageProbe.ok) break;
          }
        } catch (error) {
          pageStarted = false;
          log(`[serve] 页面服务拉起失败：${error instanceof Error ? error.message : String(error)}`);
        }
      }
      const upstreams = health.upstreams ?? [];
      const payload = {
        ok: pageProbe.ok,
        reused: true,
        new_process: false,
        page_started: pageStarted,
        manager: { url: health.url ?? `http://127.0.0.1:${managerPort}`, healthz: `http://127.0.0.1:${managerPort}/healthz` },
        db: health.db ?? null,
        experiment_run_id: health.experiment_run_id ?? null,
        client_label: health.client_label ?? null,
        all_ready: health.all_ready === true,
        upstreams: upstreams.map((item) => ({
          serverName: item.serverName,
          transport: item.transport,
          upstream_ready: item.upstream_ready === true,
          unavailable_reason: item.unavailable_reason ?? null,
          endpoint: item.endpoint ?? null,
        })),
        page: { url: pageUrl, http_status: pageProbe.status, ok: pageProbe.ok },
        stop_command: 'node bin\\serve.js --stop',
      };
      // 只有页面**确实可访问**时才打开浏览器；否则给出可操作提示，不做「打开一个死页面」这种假成功
      if (!options.noOpen && pageProbe.ok) {
        const opened = await openUrl(pageUrl);
        payload.opened = opened.opened;
        payload.open_reason = opened.reason;
      } else if (!options.noOpen && !pageProbe.ok) {
        payload.opened = false;
        payload.open_reason = `页面未应答（${pageProbe.reason ?? '未知'}），不打开浏览器`;
      }
      if (options.json) out(JSON.stringify(payload, null, 2));
      else {
        out(`[serve] 检测到已有实例在运行，复用它（本次**没有**新起进程，也没有改任何文件）：`);
        out(`  入口：${payload.manager.url}   healthz：${payload.manager.healthz}`);
        out(`  库：${payload.db ?? '（未报告）'}`);
        out(`  实验运行：${payload.experiment_run_id ?? '（未报告）'}   客户端标签：${payload.client_label ?? '（未报告）'}`);
        out(`  上游（${upstreams.length} 个，全部就绪：${payload.all_ready ? '是' : '否'}）：`);
        for (const item of payload.upstreams) {
          out(
            `    ${item.upstream_ready ? '[就绪]' : '[未就绪]'} ${item.serverName}（${item.transport}）→ ${item.endpoint ?? '（无端点）'}` +
              (item.upstream_ready ? '' : `   原因：${item.unavailable_reason ?? '（连接中）'}`),
          );
        }
        out(`  页面：${pageUrl}（${pageProbe.ok ? `HTTP ${pageProbe.status} ✓` : `未应答——${pageProbe.reason ?? '可能页面端口不同'}`}${
          pageStarted ? '；本次已用 --web-only 把它拉起来' : ''
        }）`);
        if (!pageProbe.ok) {
          out(`  → 页面没能起来。手动起它：node bin\\web.js --db ${health.db ?? '<库路径>'} --port ${options.webPort}`);
        }
        out(`  停止这个实例：${payload.stop_command}    （或 npm run unmount）`);
        out('  提示：想跑一个全新的实例，请先停止它，或换端口：--manager-port <新端口> --port <新端口>。');
      }
      process.exit(pageProbe.ok ? 0 : 3);
    }

    // ② TCP 被占但 /healthz 不是本平台（非 200 或指纹不符）→ 别起第二个，明确说是谁占了
    if (probe.kind === 'foreign') {
      log(`[serve] 端口 ${managerPort} 被**非本平台程序**占用（/healthz 返回 ${
        probe.status === null ? '非本平台内容' : `HTTP ${probe.status}`
      }）：本工具不会去动别的程序`);
      log(`[serve] → 换端口再挂载：node bin\\serve.js --mount --manager-port 8890 --port 8891`);
      log('[serve] → 或先确认那是什么：curl.exe -s http://127.0.0.1:' + managerPort + '/healthz');
      process.exit(2);
    }
    // ③ TCP 通但完全没人应答（陈旧套接字 / 正在启动的程序）→ 也不硬起，给出可操作建议
    if (probe.kind === 'dead') {
      log(`[serve] 端口 ${managerPort} 已被占用，但没有任何服务应答 /healthz（陈旧套接字或正在启动的程序）：${probe.reason ?? '无响应'}`);
      log('[serve] → 等几秒再试；或换端口：node bin\\serve.js --mount --manager-port 8890 --port 8891');
      process.exit(2);
    }

    const record = readPidFile(options.pidFile);
    if (record && isProcessAlive(record.pid)) {
      log(`[serve] 已有实例在运行：PID ${record.pid}（库 ${record.db ?? '?'}，页面 ${record.url ?? '?'}）`);
      log('[serve] → 停止它：node bin\\serve.js --stop；或换端口/库再挂载');
      process.exit(2);
    }
    if (record) fs.rmSync(path.resolve(REPO_ROOT, options.pidFile), { force: true });
    // 页面端口预检 —— **必须区分「谁占着」**（2026-10-05 修的真缺陷）：
    // 用户先 `npm run start` 起了网关，再跑 start-monitor.bat 时，复用分支会先把本平台的
    // 只读页面拉起来；于是第二次跑 bat 时 8787 已被**本平台自己的页面**占着，而这里的旧逻辑
    // 只看「TCP 能否连上」就报「端口已被占用」并 exit 2 —— 用户看到「挂载和 start-monitor
    // 不能同时用」，实际上两边都正常，只是一个在服务、另一个想再起一遍。
    // Gateway 已确认不存在；页面单独存活不能代表整套监控已启动。
    const pageUrl = `http://127.0.0.1:${options.webPort}/`;
    const existingPage = await probeHttpOk(pageUrl);
    if (existingPage.ok) {
      const identity = await probeWebInstance(pageUrl);
      log(identity.ok
        ? `[serve] 只有页面在运行，Gateway 未运行（:${managerPort}）：监控未启动，不能复用成功。`
        : `[serve] 页面端口 ${options.webPort} 被非本平台程序占用：本工具不会去动别的程序。`);
      log(identity.ok
        ? `[serve] → 先停止旧页面：node bin\\serve.js --stop --port ${options.webPort} --manager-port ${managerPort}；然后重新挂载。`
        : '[serve] → 换页面端口：--port 8891');
      process.exit(2);
    }
    const portTaken = await new Promise((resolve) => {
      const pageProbe = net.createConnection({ host: '127.0.0.1', port: options.webPort });
      pageProbe.once('connect', () => {
        pageProbe.destroy();
        resolve(true);
      });
      pageProbe.once('error', () => resolve(false));
    });
    if (portTaken) {
      log(`[serve] 页面端口 ${options.webPort} 被**非本平台程序**占用（它不响应本平台的页面探测）：本工具不会去动别的程序`);
      log(`[serve] → 换端口再挂载：node bin\\serve.js --mount --port 8891`);
      log(`[serve] → 或先确认那是什么：curl.exe -s -o NUL -w "%{http_code}" ${pageUrl}`);
      process.exit(2);
    }
    const childArgs = [
      ENTRY,
      '--mount-child',
      '--manifest', options.manifestPath,
      '--port', String(options.webPort),
      '--timeout', String(options.timeoutMs),
      '--pid-file', options.pidFile,
      '--status-file', options.statusFile,
      '--stop-file', options.stopFile,
      ...(options.db ? ['--db', options.db] : []),
      ...(options.managerPort !== null ? ['--manager-port', String(options.managerPort)] : []),
      // 父进程带 --no-open 时子进程也不要弹浏览器（服务器/测试环境下尤其重要）
      ...(options.noOpen ? ['--no-open'] : []),
      ...(options.exitWhenIdle !== null ? [`--exit-when-idle=${options.exitWhenIdle}`] : ['--keep-alive']),
    ];
    const child = spawn(process.execPath, childArgs, {
      cwd: REPO_ROOT,
      detached: true,
      stdio: 'ignore', // 本项目沙箱禁止**管道**子进程；ignore 是允许的
      windowsHide: true,
    });
    child.unref();
    const statusPath = path.resolve(REPO_ROOT, options.statusFile);
    // ⚠️ 这里**不能**先删状态文件：子进程可能已经写好了它（t44 修的真实竞态——
    // 先删会让父进程永远等不到文件，于是服务明明起来了却报「START FAILED」假失败）。
    // 改用「按 pid 匹配」识别自己那份状态：陈旧文件天然被忽略。
    /** @type {number | string | null} */
    let childExit = null;
    child.once('exit', (code, signal) => {
      childExit = code === null ? `signal:${signal ?? '?'}` : code;
    });
    const deadline = Date.now() + statusTimeoutMs;
    const waitStartedAt = Date.now();
    let announcedStarting = false;
    let lastProgressAt = 0;
    /** @type {Record<string, any> | null} */
    let status = null;
    let foreignStatus = null;
    let starting = false;
    while (Date.now() < deadline) {
      const waitedMs = Date.now() - waitStartedAt;
      if (fs.existsSync(statusPath)) {
        try {
          const parsed = JSON.parse(fs.readFileSync(statusPath, 'utf8'));
          if (parsed?.pid === child.pid) {
            if (parsed.phase === 'ready' && parsed.url) {
              status = parsed;
              break;
            }
            starting = true; // 子进程活着、正在启动（等上游就绪）——继续等，不误判
            // t45：一观察到「正在启动」就立刻给一行反馈，用户不会对着黑窗口发呆
            if (!announcedStarting) {
              announcedStarting = true;
              lastProgressAt = Date.now();
              out(
                `[serve] 启动中…（正在等待上游就绪，最多 ${Math.round(statusTimeoutMs / 1000)} 秒；完成后会打印 PID/页面/停止方法）`,
              );
            }
          } else {
            foreignStatus = parsed?.pid ?? '(无 pid)';
          }
        } catch {
          /* 子进程还在写，继续等 */
        }
      }
      // t45：长时间启动给周期性反馈（含已等待秒数与上限），避免「看着像卡死」
      if (announcedStarting && Date.now() - lastProgressAt >= options.progressIntervalMs) {
        lastProgressAt = Date.now();
        out(
          `[serve] 仍在启动中…已等待 ${Math.round(waitedMs / 1000)} 秒（上限 ${Math.round(statusTimeoutMs / 1000)} 秒）——桌面窗口请不要关，或者看 node bin\\trace-manager.js --status 的原因`,
        );
      }
      // 子进程立刻失败（端口被占/清单非法/端口被抢）：立即判定，**不**等满时限
      if (childExit !== null) break;
      await sleep(LIFECYCLE_POLL_MS);
    }
    if (!status) {
      if (childExit !== null) {
        log(`[serve] 后台进程已退出（exit ${childExit}），没有写出状态文件：${options.statusFile}`);
      } else if (starting) {
        log(`[serve] 后台进程已在启动中，但在 ${statusTimeoutMs}ms 内还没就绪（上游可能一直起不来）`);
        log('[serve] → 看原因：node bin\\trace-manager.js --status');
      } else if (foreignStatus !== null) {
        log(`[serve] 状态文件不是本实例写的（文件里的 pid=${foreignStatus}，本次子进程 pid=${child.pid}）：${options.statusFile}`);
      } else {
        const dir = path.dirname(statusPath);
        let writable = true;
        try {
          fs.accessSync(dir, fs.constants.W_OK);
        } catch {
          writable = false;
        }
        log(
          `[serve] 等状态文件超时（${statusTimeoutMs}ms）——${
            writable ? '子进程没写出状态文件（可能启动很慢或启动失败）' : `状态文件目录不可写：${dir}`
          }`,
        );
      }
      fs.rmSync(path.resolve(REPO_ROOT, options.pidFile), { force: true }); // 失败路径绝不留陈旧 PID 文件
      log(`[serve] → 前台跑一次看原因：node bin\\serve.js --manifest ${options.manifestPath} --port ${options.webPort}`);
      log(`[serve] → 也可以调大等待上限：--status-timeout 20000（当前 ${statusTimeoutMs}ms）`);
      process.exit(1);
    }
    const idleText =
      status.lifecycle?.mode === 'idle-exit'
        ? `关闭页面约 ${status.lifecycle.idle_timeout_seconds} 秒后自动退出（页面停止汇报心跳的语义，不是精确检测浏览器关闭）`
        : '不会因页面空闲退出（keep-alive）';
    out('已在后台挂载（分离进程，父进程现在退出）：');
    out(`  PID：${status.pid}`);
    out(`  库：${status.db}`);
    out(`  页面：${status.url}`);
    out(`  Gateway：${status.manager_url}`);
    out(`  生命周期：${status.lifecycle?.mode} — ${idleText}`);
    out('  停止：node bin\\serve.js --stop    （或 npm run unmount）');
    out(`  状态文件：${options.statusFile}；PID 文件：${options.pidFile}`);
    process.exit(0);
  }

  // ── 1) 环境自检：清单 + 库路径 ────────────────────────────────────────────
  const loaded = loadManifest({ manifestPath: options.manifestPath, cwd: REPO_ROOT });
  if (!loaded.ok) {
    for (const error of loaded.errors) log(`[serve] 清单错误：${error}`);
    log('[serve] → 先跑 node bin\\setup.js 看环境自检，或 node bin\\wrap-config.js 生成配置');
    process.exit(2);
  }
  const manifest = loaded.manifest;
  // **统一库路径**（本任务的硬要求）：同一个 db 字符串同时给 Gateway 与页面
  const dbPath = options.db ?? manifest.dbPath;
  if (options.managerPort !== null) manifest.http = { ...manifest.http, port: options.managerPort };
  const unifiedManifest = { ...manifest, dbPath };

  if (options.mountChild) {
    fs.mkdirSync(path.dirname(path.resolve(REPO_ROOT, options.statusFile)), { recursive: true });
    fs.writeFileSync(path.resolve(REPO_ROOT, options.statusFile), JSON.stringify({ pid: process.pid, phase: 'starting', url: null, db: dbPath }) + '\n');
  }
  const manager = await startManager({ manifest: unifiedManifest, logger: (line) => log(line) });
  const managerReport = () => manager.report();
  const statusPath = path.resolve(REPO_ROOT, options.statusFile);
  /** 写状态文件（挂载子进程专用）。`phase='starting'` 让父进程知道「活着但在启动」，不会误判为失败。 */
  const writeStatusFile = (payload) => {
    if (!options.mountChild) return;
    try {
      fs.mkdirSync(path.dirname(statusPath), { recursive: true });
      fs.writeFileSync(statusPath, `${JSON.stringify({ pid: process.pid, phase: 'starting', url: null, ...payload }, null, 2)}\n`, 'utf8');
    } catch {
      /* 状态文件写不了不致命：父进程会按超时给可辨识原因 */
    }
  };

  // 生命周期配置（心跳端点会把它回给页面，页面照实显示）
  const lifecycle =
    options.exitWhenIdle === null
      ? { mode: 'keep-alive', idle_timeout_seconds: null }
      : { mode: 'idle-exit', idle_timeout_seconds: options.exitWhenIdle };
  let lastAliveMs = Date.now(); // 起始宽限期：浏览器还没打开之前不算空闲

  // 先写一份「开始启动」的状态：父进程据此知道子进程活着（只是还在等上游就绪），
  // 不会因为等不到最终状态就误判成失败（t44 的假失败就是这样发生的）。
  writeStatusFile({ db: dbPath, lifecycle });

  // ── 2) 等全部上游就绪（有上限，绝不静默通过）────────────────────────────
  const deadline = Date.now() + options.timeoutMs;
  let report = managerReport();
  while (!report.all_ready && Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS);
    report = managerReport();
  }

  // ── 3) 起页面服务（同一个库）────────────────────────────────────────────
  let config;
  try {
    config = resolveWebConfig(['--db', dbPath, '--port', String(options.webPort)], process.env);
  } catch (error) {
    log(`[serve] 页面配置错误：${error instanceof Error ? error.message : String(error)}`);
    await manager.stop('serve-config-error');
    process.exit(2);
  }
  const web = createWebServer({
    config,
    logger: (line) => log(`[页面] ${line}`),
    lifecycle,
    onAlive: () => {
      lastAliveMs = Date.now();
    },
  });
  let info;
  try {
    info = await web.start();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log(`[serve] 页面启动失败：${message}`);
    if (/EADDRINUSE/i.test(message)) log(`[serve] → 端口 ${options.webPort} 被占用：换 --port，或先停掉旧进程`);
    await web.close?.();
    web.closeStore?.();
    await manager.stop('serve-web-failed');
    process.exit(1);
  }

  // 页面自检：自己发一次真实 HTTP 请求，确认「页面真的能打开」（而不是只打印了一个 URL）
  const pageSelfCheck = await (async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    try {
      const response = await fetch(info.url, { signal: controller.signal });
      const text = await response.text();
      return { url: info.url, status: response.status, ok: response.status === 200 && text.length > 0, error: null };
    } catch (error) {
      return { url: info.url, status: null, ok: false, error: error instanceof Error ? error.message : String(error) };
    } finally {
      clearTimeout(timer);
    }
  })();

  const payload = {
    ok: report.all_ready,
    db: dbPath,
    db_shared: { manager: unifiedManifest.dbPath, web: config.dbPath, same: path.resolve(unifiedManifest.dbPath) === path.resolve(config.dbPath) },
    db_exists: fs.existsSync(path.resolve(REPO_ROOT, dbPath)),
    lifecycle,
    manager: {
      url: report.url,
      all_ready: report.all_ready,
      upstreams: report.upstreams,
      experiment_run_id: report.experiment_run_id,
      client_label: report.client_label,
    },
    web: { url: info.url, port: info.port, collection: info.collection, self_check: pageSelfCheck },
    advice: readinessAdvice(report.upstreams),
    opened: null,
    open_reason: null,
  };

  // ── 4) 打印（给人看）+ 打开浏览器 ────────────────────────────────────────
  const shouldOpen = !options.noOpen && !options.printUrlOnly;
  if (shouldOpen) {
    const opened = await openUrl(info.url);
    payload.opened = opened.opened;
    payload.open_reason = opened.reason;
  }
  // `--print-url-only` 先不打印：等收尾后把「退出原因」并进同一份输出（保证 --json 仍是**一份**可解析 JSON）
  if (!options.printUrlOnly) {
    if (options.json) out(JSON.stringify(payload, null, 2));
    else out(renderHuman(payload));
  }

  /** 收尾：页面 + Gateway + 汇总统计。返回原因与统计（**不在这里打印**，由调用方决定 stdout 形态）。 @param {string} reason */
  const shutdown = async (reason) => {
    await web.close?.();
    web.closeStore?.();
    const finalReport = managerReport();
    await manager.stop(reason);
    const totals = summarize(finalReport);
    log(`[serve] 汇总 events_written=${totals.events_written} calls_written=${totals.calls_written} write_failures=${totals.write_failures}`);
    return { reason, totals };
  };

  if (options.printUrlOnly) {
    const finished = await shutdown('打印 URL 后退出（--print-url-only）');
    if (options.json) out(JSON.stringify({ ...payload, exit_reason: finished.reason, totals: finished.totals }, null, 2));
    else {
      out(renderHuman(payload));
      out(`[serve] 退出原因：${finished.reason}`);
    }
    process.exit(report.all_ready ? 0 : 3);
  }

  // ── 5) 常驻 + 生命周期（心跳空闲退出 / 停止文件 / 信号）──────────────────
  // 只有**后台挂载的子进程**才写 PID/状态文件：前台普通运行不留运行时文件
  // （Windows 上 SIGTERM 是 TerminateProcess，处理器可能不跑，所以「少写」比「事后清理」可靠）。
  const writeRuntimeFiles = options.mountChild === true;
  const pidPath = writeRuntimeFiles
    ? writePidFile(options.pidFile, {
        pid: process.pid,
        url: info.url,
        manager_url: report.url,
        db: dbPath,
        lifecycle,
        manifest: options.manifestPath,
        started_at_utc: new Date().toISOString(),
        stop_command: 'node bin\\serve.js --stop',
        note: '这是**仓库内**的运行时文件（不是用户配置）；停止请求写进 demo-data/serve.stop',
      })
    : null;
  if (writeRuntimeFiles) {
    // 测试钩子：让状态文件**延迟**出现，用来证伪「父进程只查一次 → 假失败」这条竞态（t44）。
    const delayMs = Number(process.env.TRACE_SERVE_STATUS_DELAY_MS ?? 0);
    if (Number.isFinite(delayMs) && delayMs > 0) await sleep(Math.min(delayMs, 30000));
    // 最终状态（`phase:'ready'` + 真实 URL）；父进程只认 pid 与自己一致、且 phase=ready 的这一份。
    writeStatusFile({
      phase: 'ready',
      url: info.url,
      manager_url: report.url,
      db: dbPath,
      lifecycle,
      all_ready: report.all_ready,
      started_at_utc: new Date().toISOString(),
    });
  }

  let stopping = false;
  /** @param {string} reason */
  const finish = (reason) => {
    if (stopping) return;
    stopping = true;
    void shutdown(reason).then(({ reason: why, totals }) => {
      // 后台挂载的子进程 stdout 被 ignore（父进程已退出），所以把「原因 + 汇总」落一份**仓库内**的收尾记录，
      // 供 `--stop` 与用户事后查看——否则这次退出对用户是不可见的。
      try {
        fs.writeFileSync(
          path.resolve(REPO_ROOT, DEFAULT_LAST_EXIT_FILE),
          `${JSON.stringify({ pid: process.pid, reason: why, totals, at_utc: new Date().toISOString() }, null, 2)}\n`,
          'utf8',
        );
      } catch {
        /* 收尾记录失败不影响退出 */
      }
      out(`[serve] 退出原因：${why}`);
      if (pidPath) fs.rmSync(pidPath, { force: true });
      if (writeRuntimeFiles) fs.rmSync(statusPath, { force: true });      fs.rmSync(path.resolve(REPO_ROOT, options.stopFile), { force: true });
      process.exit(0);
    });
  };

  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
      log(`[serve] 收到 ${signal}，正在收尾…`);
      finish(`收到信号 ${signal}`);
    });
  }

  log('[serve] 已启动：页面与 Gateway 共用同一个库；按 Ctrl+C 停止。');
  log(
    lifecycle.mode === 'idle-exit'
      ? `[serve] 生命周期：idle-exit(${lifecycle.idle_timeout_seconds}s) —— 页面停止汇报心跳后 ${lifecycle.idle_timeout_seconds} 秒内会收尾退出（不是精确检测浏览器关闭）`
      : '[serve] 生命周期：keep-alive —— 不会因页面空闲退出（Ctrl+C 或 --stop 才停）',
  );
  if (!report.all_ready) log('[serve] 注意：有上游未就绪（见上面的原因与建议），页面仍可打开查看已有数据。');

  // 轮询：停止文件 + 心跳超时
  const stopFilePath = path.resolve(REPO_ROOT, options.stopFile);
  for (;;) {
    await sleep(LIFECYCLE_POLL_MS);
    if (fs.existsSync(stopFilePath)) {
      log('[serve] 收到停止请求（--stop），正在收尾…');
      finish('收到停止命令（--stop）');
      return;
    }
    if (lifecycle.mode === 'idle-exit') {
      const idleMs = Date.now() - lastAliveMs;
      if (idleMs >= lifecycle.idle_timeout_seconds * 1000) {
        log(`[serve] 页面已 ${Math.round(idleMs / 1000)} 秒没有汇报心跳（阈值 ${lifecycle.idle_timeout_seconds}s），正在收尾…`);
        finish(`空闲超时（页面已 ${Math.round(idleMs / 1000)} 秒未汇报心跳，阈值 ${lifecycle.idle_timeout_seconds}s）`);
        return;
      }
    }
  }
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1].replace(/\\/g, '/')}`).href) {
  main().catch((error) => {
    process.stderr.write(`[serve] 未捕获异常：${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exit(1);
  });
}
