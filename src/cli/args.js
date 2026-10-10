/**
 * src/cli/args.js — CLI 参数解析与退出码约定（S2）
 *
 * 退出码（bin/trace.js 与 bin/reset.js 统一）：
 *   0  成功
 *   1  运行期错误（数据库打不开、写文件失败等）
 *   2  用法/参数错误（缺必填参数、未知命令或未知参数）
 *   3  查询对象不存在（--run / --call 在库里查不到）
 *
 * 输出约定：**人类可读输出与机器可读输出（--json）一律写 stdout**，
 * 用法与错误信息一律写 stderr；因此 `trace ... > out.txt` 拿到的永远是结果本身。
 */
import process from 'node:process';

/** 带退出码的 CLI 错误。 */
export class CliError extends Error {
  /**
   * @param {string} message
   * @param {number} [exitCode]
   * @param {{showUsage?: boolean}} [options]
   */
  constructor(message, exitCode = 2, options = {}) {
    super(message);
    this.name = 'CliError';
    this.exitCode = exitCode;
    this.showUsage = options.showUsage === true;
  }
}

/**
 * @param {string} message
 * @returns {never}
 */
export function usageError(message) {
  throw new CliError(message, 2, { showUsage: true });
}

/**
 * @param {string} message
 * @param {number} [exitCode]
 * @returns {never}
 */
export function fail(message, exitCode = 1) {
  throw new CliError(message, exitCode);
}

/** 常见选项（两个入口共用）。 */
export const COMMON_FLAGS = Object.freeze({
  '--db': { type: 'string', key: 'db', doc: '事件库路径（缺省 demo-data/events.db）' },
  '--json': { type: 'boolean', key: 'json', doc: '输出机器可读 JSON（stdout）' },
  '--quiet': { type: 'boolean', key: 'quiet', doc: '只输出最少信息' },
  '--limit': { type: 'number', key: 'limit', doc: '限制返回条数（缺省不限）' },
  '--order': { type: 'string', key: 'order', doc: 'asc|desc（缺省 asc）' },
  '--help': { type: 'boolean', key: 'help', doc: '输出用法' },
  '-h': { type: 'boolean', key: 'help', doc: '输出用法' },
});

/**
 * 解析 `--flag value` / `--flag=value` / `-x` 形式；重复给出的取最后一次。
 * @param {string[]} argv 已去掉命令名的参数
 * @param {Record<string, {type: 'string'|'number'|'boolean', key: string, doc?: string}>} spec
 * @param {{allowPositionals?: boolean}} [options]
 * @returns {{values: Record<string, any>, positionals: string[], help: boolean}}
 */
export function parseOptions(argv, spec, options = {}) {
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
      if (options.allowPositionals === false) usageError(`未知参数：${token}`);
      positionals.push(token);
      continue;
    }

    const eq = token.indexOf('=');
    const name = eq > 0 ? token.slice(0, eq) : token;
    const inline = eq > 0 ? token.slice(eq + 1) : undefined;
    const definition = spec[name];
    if (!definition) usageError(`未知参数：${token}（用 --help 查看用法）`);

    if (definition.type === 'boolean') {
      let value = true;
      if (inline !== undefined) {
        const parsed = parseBoolean(inline);
        if (parsed === null) usageError(`参数 ${name} 的布尔值无法解析：${inline}`);
        value = parsed;
      }
      if (definition.key === 'help') help = true;
      values[definition.key] = value;
      continue;
    }

    let raw = inline;
    if (raw === undefined) {
      raw = argv[index + 1];
      if (raw === undefined) usageError(`参数 ${name} 缺少取值`);
      index += 1;
    }
    if (definition.type === 'number') {
      const number = Number(raw);
      if (!Number.isFinite(number) || number < 0) usageError(`参数 ${name} 需要非负数字，实际为 ${JSON.stringify(raw)}`);
      values[definition.key] = number;
    } else {
      values[definition.key] = raw;
    }
  }

  return { values, positionals, help };
}

/**
 * @param {unknown} value
 * @returns {boolean | null}
 */
export function parseBoolean(value) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const lowered = value.trim().toLowerCase();
    if (['1', 'true', 'yes', 'on', 'enabled'].includes(lowered)) return true;
    if (['0', 'false', 'no', 'off', 'disabled'].includes(lowered)) return false;
  }
  return null;
}

/**
 * 校验 --order 取值。
 * @param {unknown} value
 * @returns {'asc' | 'desc'}
 */
export function normalizeOrder(value) {
  if (value === undefined || value === null || value === '') return 'asc';
  const lowered = String(value).toLowerCase();
  if (lowered === 'asc' || lowered === 'desc') return lowered;
  usageError(`--order 只接受 asc|desc，实际为 ${JSON.stringify(value)}`);
}

/**
 * @param {unknown} value
 * @param {string} flag
 * @returns {string}
 */
export function requireString(value, flag) {
  if (typeof value !== 'string' || value.trim() === '') usageError(`缺少必需参数 ${flag}`);
  return value.trim();
}

/**
 * @param {string} message
 */
export function writeErr(message) {
  process.stderr.write(`${message}\n`);
}

/**
 * @param {string} message
 */
export function writeOut(message) {
  process.stdout.write(`${message}\n`);
}
