/**
 * src/credentials/store.js — 令牌的安全存储（t32）
 *
 * 三条硬要求：
 *   1. **原子替换**：先写同目录的临时文件（`<file>.<pid>.<rand>.tmp`，mode 0600），再 `rename` 覆盖目标。
 *      这样永远不会出现「写到一半的半个 JSON」把用户的凭证弄坏。
 *   2. **权限尽量收紧**：POSIX 下 `chmod 0600`（文件）/ `0700`（目录）真实生效；
 *      **Windows 上没有 POSIX mode 语义**——Node 的 `chmod` 只能翻转只读位，无法表达「仅本人可读」。
 *      实际保护来自 `%LOCALAPPDATA%` 的 ACL 继承（用户目录本身默认只有本人与管理员可访问）。
 *      本模块**不谎称**做了严格的 ACL 控制：`describePermissionReality()` 如实说明，并在文档里重复一遍。
 *   3. 任何路径都**不得落在仓库内**（由 `assertOutsideRepo` 强制）。
 */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

import { assertOutsideRepo } from './paths.js';

/** 凭证文件格式版本。 */
export const CREDENTIALS_VERSION = 1;

/**
 * 读取凭证文件（只读；不存在时 `exists:false`，不抛错）。
 * @param {{filePath: string, repoRoot?: string}} input
 * @returns {{exists: boolean, credentials: Record<string, any> | null, error: string | null, permissions: Record<string, any> | null}}
 */
export function readCredentials(input) {
  assertOutsideRepo(input.filePath, { repoRoot: input.repoRoot, label: '凭证文件' });
  if (!fs.existsSync(input.filePath)) {
    return { exists: false, credentials: null, error: null, permissions: null };
  }
  try {
    const text = fs.readFileSync(input.filePath, 'utf8');
    const parsed = JSON.parse(text);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { exists: true, credentials: null, error: '凭证文件顶层不是对象', permissions: describeFile(input.filePath) };
    }
    return { exists: true, credentials: parsed, error: null, permissions: describeFile(input.filePath) };
  } catch (error) {
    return {
      exists: true,
      credentials: null,
      error: `凭证文件无法解析：${error instanceof Error ? error.message : String(error)}`,
      permissions: describeFile(input.filePath),
    };
  }
}

/**
 * 原子写入凭证文件（临时文件 + rename，覆盖式）。
 *
 * @param {{filePath: string, credentials: Record<string, any>, repoRoot?: string}} input
 * @returns {{ok: boolean, filePath: string, bytes: number, permissions: Record<string, any>, error: string | null}}
 */
export function writeCredentialsAtomic(input) {
  const filePath = input.filePath;
  assertOutsideRepo(filePath, { repoRoot: input.repoRoot, label: '凭证文件' });
  const dir = path.dirname(filePath);
  const tmpPath = path.join(
    dir,
    `${path.basename(filePath)}.${process.pid}.${Math.random().toString(36).slice(2, 10)}.tmp`,
  );
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const payload = `${JSON.stringify({ version: CREDENTIALS_VERSION, ...input.credentials }, null, 2)}\n`;
    const fd = fs.openSync(tmpPath, 'w', 0o600);
    try {
      fs.writeFileSync(fd, payload, 'utf8');
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    try {
      fs.chmodSync(tmpPath, 0o600);
    } catch {
      /* Windows：chmod 语义有限，忽略（见 describePermissionReality） */
    }
    // rename 覆盖：同一目录内的 rename 是原子的（Windows 上用 rm+rename 兜底）。
    try {
      fs.renameSync(tmpPath, filePath);
    } catch (error) {
      if ((error && typeof error === 'object' && error.code === 'EPERM') || error?.code === 'EEXIST') {
        fs.rmSync(filePath, { force: true });
        fs.renameSync(tmpPath, filePath);
      } else {
        throw error;
      }
    }
    try {
      fs.chmodSync(filePath, 0o600);
    } catch {
      /* 同上 */
    }
    return {
      ok: true,
      filePath,
      bytes: Buffer.byteLength(payload, 'utf8'),
      permissions: describeFile(filePath),
      error: null,
    };
  } catch (error) {
    try {
      fs.rmSync(tmpPath, { force: true });
    } catch {
      /* 忽略 */
    }
    return {
      ok: false,
      filePath,
      bytes: 0,
      permissions: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * 删除凭证文件（撤销本地登录；幂等）。
 * @param {{filePath: string, repoRoot?: string}} input
 * @returns {{deleted: boolean, filePath: string}}
 */
export function deleteCredentials(input) {
  assertOutsideRepo(input.filePath, { repoRoot: input.repoRoot, label: '凭证文件' });
  const existed = fs.existsSync(input.filePath);
  if (existed) fs.rmSync(input.filePath, { force: true });
  return { deleted: existed, filePath: input.filePath };
}

/**
 * 目标的权限实况。
 * @param {string} filePath
 * @returns {Record<string, any> | null}
 */
export function describeFile(filePath) {
  try {
    const st = fs.statSync(filePath);
    return {
      mode_octal: `0${(st.mode & 0o777).toString(8)}`,
      // POSIX 上「仅本人可读」靠 0600；Windows 上 mode 恒为 0666/0444 一类，
      // 真正的保护来自 %LOCALAPPDATA% 的 ACL 继承——这里如实标出平台差异。
      posix_mode_meaningful: process.platform !== 'win32',
      size: st.size,
    };
  } catch {
    return null;
  }
}

/** 如实说明「权限能限制到什么程度」（文档与 CLI 都用这段文字）。 */
export function describePermissionReality(platform = process.platform) {
  if (platform === 'win32') {
    return [
      'Windows：Node 的 chmod 只能翻转只读位，**无法**表达 POSIX 的 0600 语义。',
      '实际保护来自 `%LOCALAPPDATA%` 的 ACL 继承（该目录默认只有当前用户与管理员可访问）；',
      '本工具会在创建时尝试 chmod 0600，但**不声称**在 Windows 上做到了严格的文件级权限控制。',
      '需要更严的隔离时：把 `--store` 指到受 BitLocker/EFS 保护的卷，或用凭据管理器代管。',
    ].join('\n');
  }
  return [
    'POSIX：目录 0700、文件 0600（仅本人可读写），由 `chmod` 真实生效。',
    '注意：如果凭证文件在 NFS/共享目录上，或系统有额外的 ACL，实际可见范围由那些机制决定。',
  ].join('\n');
}
