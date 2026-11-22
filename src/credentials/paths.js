/**
 * src/credentials/paths.js — 凭证文件的默认位置与「绝不进仓库」守卫（t32）
 *
 * 安全取向（硬约束）：
 *   - 令牌文件**默认**放在用户目录（Windows: `%LOCALAPPDATA%\mcp-cross-app-trace\credentials.json`；
 *     POSIX: `$XDG_CONFIG_HOME|~/.config/mcp-cross-app-trace/credentials.json`）；
 *   - 任何写入路径都**不得**落在仓库内（含 `demo-data/`）——`assertOutsideRepo()` 在代码层强制执行，
 *     而不是只写在文档里；
 *   - `--store <path>` 可以指到别处，但同样受这条守卫约束（指到仓库内会直接报配置错误）。
 */
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

/** 用户目录下的应用子目录名。 */
export const APP_DIRNAME = 'mcp-cross-app-trace';
/** 凭证文件名。 */
export const CREDENTIALS_FILENAME = 'credentials.json';
/** 两阶段流程用的会话文件名（内含 PKCE code_verifier，属敏感文件，用完即删）。 */
export const SESSION_FILENAME = 'oauth-session.json';

/** 仓库根（用于「不得写进仓库」的守卫）。 */
export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * 用户目录下的凭证目录。
 * @param {Record<string, string | undefined>} [env]
 * @param {string} [platform]
 * @returns {string}
 */
export function defaultCredentialsDir(env = process.env, platform = process.platform) {
  if (platform === 'win32') {
    const base =
      env.LOCALAPPDATA ||
      env.APPDATA ||
      path.join(env.USERPROFILE || os.homedir(), 'AppData', 'Local');
    return path.join(base, APP_DIRNAME);
  }
  const xdg = env.XDG_CONFIG_HOME;
  const base = xdg && path.isAbsolute(xdg) ? xdg : path.join(os.homedir(), '.config');
  return path.join(base, APP_DIRNAME);
}

/**
 * 默认凭证文件路径。
 * @param {Record<string, string | undefined>} [env]
 * @param {string} [platform]
 * @returns {string}
 */
export function defaultCredentialsPath(env = process.env, platform = process.platform) {
  return path.join(defaultCredentialsDir(env, platform), CREDENTIALS_FILENAME);
}

/** 默认会话文件路径（两阶段流程用）。 @param {Record<string, string | undefined>} [env] @param {string} [platform] */
export function defaultSessionPath(env = process.env, platform = process.platform) {
  return path.join(defaultCredentialsDir(env, platform), SESSION_FILENAME);
}

/**
 * 目标路径是否落在仓库内（含 `demo-data/`）。
 * @param {string} target
 * @param {string} [repoRoot]
 * @returns {boolean}
 */
export function isInsideRepo(target, repoRoot = REPO_ROOT) {
  const resolved = path.resolve(target);
  const root = path.resolve(repoRoot);
  const relative = path.relative(root, resolved);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

/**
 * 断言目标路径在仓库之外。仓库内（含 `demo-data/tmp`）一律拒绝：
 * 令牌与密钥**绝不写进仓库**——即使那只是临时目录。
 * @param {string} target
 * @param {{repoRoot?: string, label?: string}} [options]
 */
export function assertOutsideRepo(target, options = {}) {
  const repoRoot = options.repoRoot ?? REPO_ROOT;
  if (isInsideRepo(target, repoRoot)) {
    throw new CredentialPathError(
      `${options.label ?? '凭证文件'}路径落在仓库内（${path.resolve(target)}）：` +
        '令牌/密钥绝不写进仓库（含 demo-data/），请用 --store 指到用户目录或系统临时目录',
    );
  }
}

/** 路径类配置错误（退出码 2）。 */
export class CredentialPathError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = 'CredentialPathError';
    this.code = 'CREDENTIAL_PATH_INSIDE_REPO';
  }
}
