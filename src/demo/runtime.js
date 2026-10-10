/**
 * src/demo/runtime.js — 演示/协议客户端共用的环境事实（G1）
 *
 * 这里只做「环境探测 + 路径解析 + 失败措辞」，不含任何 MCP 业务逻辑。
 *
 * 为什么另起一份 Node 运行时解析（而不是 `import '../tools/node.js'`）：
 *   `tools/node.js` 是**启动器脚本**，import 它就会执行其顶层代码（spawn 子进程 + exit），
 *   把 demo 的 argv 当成它自己的参数。因此这里复刻同一解析顺序（TRACE_NODE_BIN → 捆绑
 *   Node 24 → process.execPath），并在注释里标注来源，避免把启动器当模块用。
 *
 * 沙箱事实（CONVENTIONS §1.1.2，M1/S1 已独立复验）：
 *   `spawn(node, …, {stdio:['ignore','pipe','ignore']})` 在本会话直接 `Error: spawn EPERM`。
 *   因此 `StdioClientTransport`（必然使用 stdin/stdout 管道）在沙箱内**必然连不上**。
 *   `probePipeSupport()` 给出可证伪的探测结果，供路径 B 明确失败、供测试断言。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

/** 仓库根（`<repo>/src/demo/runtime.js` → `<repo>`）。 */
export const REPO_ROOT = path.resolve(here, '..', '..');

/** 捆绑 Node 24（本机实测 v24.21.0；与 tools/node.js / CONVENTIONS §1 同一路径）。 */
export const BUNDLED_NODE = path.join(os.homedir(), '.dsh', 'dsh-runtimes', 'dsh-primary-runtime', 'dependencies', 'node', 'bin', 'node.exe');

/**
 * 解析要用于**子进程**的 Node 可执行文件。
 * @returns {{bin: string, source: 'env'|'bundled'|'fallback'}}
 */
export function resolveNodeBin() {
  const fromEnv = process.env.TRACE_NODE_BIN;
  if (typeof fromEnv === 'string' && fromEnv !== '' && fs.existsSync(fromEnv)) return { bin: fromEnv, source: 'env' };
  if (Number(process.versions.node.split('.')[0]) >= 24) return { bin: process.execPath, source: 'fallback' };
  if (fs.existsSync(BUNDLED_NODE)) return { bin: BUNDLED_NODE, source: 'bundled' };
  return { bin: process.execPath, source: 'fallback' };
}

/**
 * 仓库相对 POSIX 路径（与 M1 结果里的 `store_file` 表示一致）。
 * @param {string} absolute
 * @returns {string}
 */
export function repoRelative(absolute) {
  return path.relative(REPO_ROOT, absolute).split(path.sep).join('/');
}

/**
 * 解析一个**必须落在仓库内**的路径（演示数据不得写到仓库外，CONVENTIONS §6.1/§7）。
 * @param {string} candidate 相对（相对仓库根）或绝对路径
 * @param {string} [label] 出错时的说明标签
 * @returns {string} 绝对路径
 */
export function resolveInRepo(candidate, label = 'path') {
  const raw = typeof candidate === 'string' && candidate.trim() !== '' ? candidate.trim() : '.';
  const absolute = path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(REPO_ROOT, raw);
  const relative = path.relative(REPO_ROOT, absolute);
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`拒绝使用仓库外路径（${label}）：解析为 ${absolute}，仓库根为 ${REPO_ROOT}`);
  }
  return absolute;
}

/**
 * @param {string} dir
 */
export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

/** 单次管道探测的上限（防挂死）。 */
const PROBE_TIMEOUT_MS = 8000;

/** @type {Promise<{ok: boolean, code?: string, syscall?: string, message?: string, timed_out?: boolean}> | null} */
let pipeProbe = null;

/**
 * 探测本环境是否允许「spawn + 管道 stdio」。
 *
 * 探测命令本身**不使用管道做 I/O 通信**，只是让子进程持有管道 fd —— 沙箱会在 spawn 层拒绝，
 * 与 `StdioClientTransport` 遇到的失败完全同源。
 * @returns {Promise<{ok: boolean, code?: string, syscall?: string, message?: string, timed_out?: boolean}>}
 */
export function probePipeSupport() {
  pipeProbe ??= new Promise((resolve) => {
    /** @type {import('node:child_process').ChildProcess} */
    let child;
    let settled = false;
    /** @param {Record<string, any>} value */
    const settle = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => {
      try {
        child?.kill();
      } catch {
        /* 忽略 */
      }
      settle({ ok: false, code: 'PROBE_TIMEOUT', syscall: 'spawn', message: `探测超时（${PROBE_TIMEOUT_MS}ms）`, timed_out: true });
    }, PROBE_TIMEOUT_MS);

    try {
      child = spawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: ['ignore', 'pipe', 'ignore'] });
    } catch (error) {
      settle({
        ok: false,
        code: /** @type {any} */ (error)?.code ?? 'SPAWN_THREW',
        syscall: /** @type {any} */ (error)?.syscall ?? 'spawn',
        message: error instanceof Error ? error.message : String(error),
      });
      return;
    }
    child.on('error', (error) =>
      settle({
        ok: false,
        code: /** @type {any} */ (error)?.code ?? 'SPAWN_ERROR',
        syscall: /** @type {any} */ (error)?.syscall ?? 'spawn',
        message: error.message,
      }),
    );
    child.on('close', () => settle({ ok: true }));
  });
  return pipeProbe;
}

/**
 * 判断一个异常是否就是「沙箱禁止管道 stdio」这一类失败（只认已实测的证据：EPERM + syscall=spawn）。
 * @param {unknown} error
 * @returns {{is_pipe_limitation: boolean, code: string|null, syscall: string|null, message: string}}
 */
export function classifySpawnFailure(error) {
  const code = typeof /** @type {any} */ (error)?.code === 'string' ? /** @type {any} */ (error).code : null;
  const syscall = typeof /** @type {any} */ (error)?.syscall === 'string' ? /** @type {any} */ (error).syscall : null;
  const message = error instanceof Error ? error.message : String(error ?? '');
  const isPipeLimitation = code === 'EPERM' || /spawn EPERM/i.test(message);
  return { is_pipe_limitation: isPipeLimitation, code, syscall, message };
}

/**
 * 「沙箱外如何复现」的可执行命令（路径 B 失败时原样打印，绝不静默降级）。
 * @param {{nodeBin?: string, entry?: string, extraArgs?: string[], label?: string}} [options]
 * @returns {string}
 */
export function outsideSandboxCommands(options = {}) {
  const label = options.label ?? 'demo';
  const node = options.nodeBin ?? resolveNodeBin().bin;
  const entry = options.entry ?? path.join(REPO_ROOT, 'bin', 'demo.js');
  const extra = (options.extraArgs ?? []).join(' ');
  const lines = [];
  if (label === 'demo') {
    lines.push(`  cmd /c "cd /d ${REPO_ROOT} && npm run demo -- --mode=subprocess ${extra}"`.trimEnd());
  }
  lines.push(`  "${node}" "${entry}" --mode=subprocess ${extra}`.trimEnd());
  lines.push(`  cmd /c "cd /d ${REPO_ROOT} && set "TRACE_MCP_REQUIRE_PIPES=1" && npm test"`);
  lines.push(`  cmd /c "cd /d ${REPO_ROOT} && npm run trace -- timeline --run <experiment_run_id>"`);
  return lines.join('\n');
}

/**
 * 路径 B 在沙箱内的可辨识失败文本（stdout 不得出现，只写 stderr）。
 * @param {{probe: {code?: string, syscall?: string, message?: string}, error?: {code: string|null, syscall: string|null, message: string},
 *   extraArgs?: string[], label?: string, entry?: string}} input
 * @returns {string}
 */
export function sandboxLimitationMessage(input) {
  const label = input.label ?? 'demo';
  const entry = input.entry ?? path.join(REPO_ROOT, 'bin', 'demo.js');
  const lines = [
    `[${label}] TRACE_${label.replace(/-/g, '_').toUpperCase()}_SUBPROCESS_UNAVAILABLE 当前环境无法启动 stdio 子进程。`,
    `[${label}] 原因：当前运行环境禁止带管道的子进程 stdio（实测 ${input.probe.code ?? input.error?.code ?? 'EPERM'} / syscall=${
      input.probe.syscall ?? input.error?.syscall ?? 'spawn'
    }）。StdioClientTransport 必然使用 stdin/stdout 管道，因此在 spawn 阶段即失败。`,
  ];
  if (input.error) {
    lines.push(`[${label}] 真实 spawn 结果：${input.error.code ?? 'null'} / syscall=${input.error.syscall ?? 'null'} / ${input.error.message}`);
  }
  lines.push(
    `[${label}] 请在允许启动子进程的普通终端运行；此启动失败不会自动切换运行模式。`,
    `[${label}] 启动与排障步骤见 docs/user/INSTALL.md 和 docs/user/troubleshooting.md。`,
    outsideSandboxCommands({ extraArgs: input.extraArgs, label, entry }),
  );
  return lines.join('\n');
}
