#!/usr/bin/env node
/**
 * bin/cred-audit.js — 凭据目录的**只读**权限审计。
 *
 * 为什么需要它（2026-10-05 用户提问「能不能只让 Gateway 读、不让 agent 读」）：
 *   这类问题只能靠看真实的 ACL 回答，不能靠猜。而 ACL 有一个容易误解的地方 ——
 *   **Windows 的权限只认「账户」/SID，不认「进程」**。如果 Gateway 与 agent 以**同一个
 *   账户**运行，那么无论把凭据目录的权限收得多紧，两个进程都会同时通过：
 *   因为它们共享同一个 SID。
 *
 *   本命令做三件事，全部**只读**：
 *     ① 列出每个凭据目录/文件的实际「可读者」；
 *     ② 标出**过宽**的授权（Everyone / Users / Authenticated Users 等）；
 *     ③ 说清隔离的真实边界：同账户 = 无法隔离、需不同账户才能隔离。
 *
 * 退出码：0 全部正常 / 3 有过宽授权（需要处理）/ 2 用法错误。
 *
 * 只依赖 node: 内置模块（ACL 通过系统自带的 icacls 读取，不修改任何东西）。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { execFileSync } from 'node:child_process';

const OK = '  [正常]';
const WARN = '  [注意]';
const NG = '  [过宽]';

/** 视为「过宽」的主体：这些意味着本机任何用户/进程都可能读到凭据。 */
export const BROAD_PRINCIPALS = Object.freeze([
  'Everyone',
  'BUILTIN\\Users',
  'Users',
  'NT AUTHORITY\\Authenticated Users',
  'Authenticated Users',
  'BUILTIN\\Guests',
  'Guests',
]);

/** 默认要审计的目录（相对用户主目录）。 */
export const DEFAULT_TARGETS = Object.freeze([
  '.google_workspace_mcp',
  '.google_workspace_mcp/credentials',
  '.google_workspace_mcp/credentials-gmail',
  '.google_workspace_mcp/credentials-calendar',
]);

/**
 * 解析 `icacls <path>` 的输出，取出「主体 → 权限」列表。
 *
 * 输出形如（首行把路径和第一个主体挤在一起，后续行只有主体）：
 *   C:\path\dir COMPUTER\user:(OI)(CI)(F)
 *               NT AUTHORITY\SYSTEM:(OI)(CI)(F)
 *               BUILTIN\Administrators:(OI)(CI)(F)
 *               成功处理 1 个文件; 处理 0 个文件失败
 *
 * @param {string} stdout
 * @param {string} [targetPath] 用于剥掉首行里粘在主体前的路径
 * @returns {Array<{principal: string, rights: string}>}
 */
export function parseIcacls(stdout, targetPath) {
  /** @type {Array<{principal: string, rights: string}>} */
  const out = [];
  for (const rawLine of String(stdout).split(/\r?\n/)) {
    let line = rawLine.trim();
    if (line === '') continue;
    // 跳过中文/英文的统计行
    if (/^(成功处理|Successfully processed|处理 \d+ 个文件)/.test(line)) continue;
    // 首行常把目标路径和主体粘在一起（icacls 的格式）；先剥掉路径，让主体名干净
    if (targetPath) {
      const candidates = [targetPath, targetPath.replace(/\\+$/, '')];
      for (const c of candidates) {
        if (line.startsWith(c)) {
          line = line.slice(c.length).trim();
          break;
        }
      }
    }
    // 主体:权限 —— 主体可能带域前缀，权限由一串括号或逗号分隔的单词组成
    const match = line.match(/^(.+?):((?:\([^)]*\))+|[A-Za-z, ]+)$/);
    if (!match) continue;
    const principal = match[1].trim();
    const rights = match[2].trim();
    if (principal === '') continue;
    out.push({ principal, rights });
  }
  return out;
}

/**
 * 判断某个主体是否属于「过宽」。
 * @param {string} principal
 * @returns {boolean}
 */
export function isBroadPrincipal(principal) {
  const normalized = String(principal).trim();
  if (BROAD_PRINCIPALS.includes(normalized)) return true;
  // 后缀匹配，兼容带域/机器名前缀的写法（如 DUOMENGSHENG\Users）
  return BROAD_PRINCIPALS.some((broad) => normalized.endsWith(`\\${broad}`) || normalized === broad);
}

/**
 * 读取一个路径的 ACL（只读；失败返回 null 而不是抛错）。
 * @param {string} target
 * @returns {{target: string, entries: Array<{principal: string, rights: string}>, error: string | null}}
 */
export function readAcl(target) {
  try {
    // ⚠️ 不要用默认的 stdio: 'pipe' —— 本项目的沙箱（以及部分受限环境）禁止带管道的子进程，
    // 会直接报 `spawnSync icacls EPERM`。改用文件重定向：把 icacls 的输出写进临时文件再读。
    // （与 CONVENTIONS §1.1.1 的要求一致：子进程输出走文件，不走管道。）
    const tmpFile = path.join(os.tmpdir(), `cred-audit-icacls-${process.pid}-${Math.random().toString(36).slice(2)}.txt`);
    const fd = fs.openSync(tmpFile, 'w');
    try {
      execFileSync('icacls', [target], { stdio: ['ignore', fd, fd], windowsHide: true, timeout: 10000 });
    } finally {
      fs.closeSync(fd);
    }
    const stdout = fs.readFileSync(tmpFile, 'utf8');
    fs.rmSync(tmpFile, { force: true });
    return { target, entries: parseIcacls(stdout, target), error: null };
  } catch (error) {
    return { target, entries: [], error: error instanceof Error ? error.message : String(error) };
  }
}

/** 当前进程身份（用于判断「同账户」这个关键前提）。 */
function currentIdentity() {
  return process.env.USERNAME ? `${process.env.USERDOMAIN ?? ''}\\${process.env.USERNAME}`.replace(/^\\/, '') : os.userInfo().username;
}

function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--help')) {
    console.log('用法: node bin/cred-audit.js [--json]');
    console.log('');
    console.log('  只读审计本平台相关凭据目录的访问权限（Windows ACL）：');
    console.log('    · 列出每个目录的实际可读者');
    console.log('    · 标出过宽授权（Everyone / Users / Authenticated Users 等）');
    console.log('    · 说明隔离边界：权限只认账户，同账户的 agent 与 Gateway 无法用 ACL 区分');
    console.log('');
    console.log('  本命令**不修改任何权限**。退出码：0 正常 / 3 有过宽授权 / 2 用法错误');
    process.exit(0);
  }
  if (argv.some((a) => a.startsWith('-') && a !== '--json')) {
    console.error(`未知参数：${argv.find((a) => a.startsWith('-'))}（用 --help 查看用法）`);
    process.exit(2);
  }
  const asJson = argv.includes('--json');

  const home = process.env.USERPROFILE || process.env.HOME || '';
  const results = [];
  /** @type {string[]} */
  const broadHits = [];

  for (const rel of DEFAULT_TARGETS) {
    const absolute = path.join(home, rel);
    if (!fs.existsSync(absolute)) {
      results.push({ target: rel, exists: false, entries: [], broad: [], error: null });
      continue;
    }
    const acl = readAcl(absolute);
    const broad = acl.entries.filter((entry) => isBroadPrincipal(entry.principal));
    if (broad.length > 0) broadHits.push(rel);
    results.push({
      target: rel,
      exists: true,
      absolute,
      entries: acl.entries,
      broad: broad.map((entry) => entry.principal),
      error: acl.error,
    });
  }

  const identity = currentIdentity();
  // 顺带检查每份凭据的 access token 是否已过期 —— 这是**真实踩过的故障**：
  // 令牌过期时上游会去 oauth2.googleapis.com 刷新；若此刻网络不可达，工具调用会**长时间挂住**
  // 直到超时（2026-10-05 实测：gmail 卡 60s、calendar 卡 30s，客户端只看到 "Request timed out"）。
  // 提前把「已过期」报出来，用户就能先判断是网络/授权问题，而不是以为平台坏了。
  for (const item of results) {
    if (!item.exists || item.error !== null) continue;
    item.tokens = [];
    const dir = path.join(home, item.target);
    let files = [];
    try {
      files = fs.readdirSync(dir).filter((name) => name.endsWith('.json') && name !== 'oauth_states.json');
    } catch { /* 读不到就算了，不影响 ACL 结论 */ }
    for (const name of files) {
      try {
        const parsed = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
        const expiry = parsed.expiry ? new Date(parsed.expiry) : null;
        item.tokens.push({
          file: name,
          has_refresh_token: Boolean(parsed.refresh_token),
          expiry: expiry ? expiry.toISOString() : null,
          expired: expiry ? expiry.getTime() < Date.now() : null,
        });
      } catch { /* 单个文件坏了不影响整体 */ }
    }
  }
  const expiredTokens = results.flatMap((item) =>
    (item.tokens || []).filter((t) => t.expired === true).map((t) => `${item.target}/${t.file}`));

  // 「读不到 ACL」必须算**未验证**，不能算通过 —— 否则就是本项目明令禁止的静默通过。
  // （2026-10-05：我第一版正是这样：读不到权限却打印「未发现过宽授权」，属自欺。）
  const unreadable = results.filter((item) => item.exists && item.error !== null);
  const payload = {
    ok: broadHits.length === 0 && unreadable.length === 0,
    identity,
    unverified: unreadable.map((item) => ({ target: item.target, error: item.error })),
    expired_tokens: expiredTokens,
    same_account_caveat:
      'Windows 权限只认「账户/SID」，不认「进程」。Gateway 与 agent 若以同一账户运行，' +
      '则任何 ACL 都无法把它们区分开 —— 要隔离必须让两者跑在不同账户下。',
    targets: results,
    broad_hits: broadHits,
  };

  if (asJson) {
    console.log(JSON.stringify(payload, null, 2));
  } else {
    console.log('凭据目录权限审计（只读，不修改任何东西）');
    console.log(`当前进程身份：${identity}\n`);
    for (const item of results) {
      if (!item.exists) {
        console.log(`${OK} ${item.target}：不存在（未使用）`);
        continue;
      }
      if (item.error) {
        console.log(`${WARN} ${item.target}：**未能读取权限**（${String(item.error).slice(0, 70)}）`);
        continue;
      }
      const tag = item.broad.length > 0 ? NG : OK;
      console.log(`${tag} ${item.target}`);
      for (const entry of item.entries) {
        const mark = isBroadPrincipal(entry.principal) ? '  ← 过宽' : '';
        console.log(`         ${entry.principal}  ${entry.rights}${mark}`);
      }
      // 令牌新鲜度：过期 + 网络不通 = 工具调用会长时间挂住（真实踩过的故障）
      for (const token of (item.tokens || [])) {
        const state = token.expired === true
          ? '已过期 ⚠️'
          : (token.expired === false ? '未过期' : '无到期时间');
        console.log(`         凭据 ${token.file}：${state}（expiry=${token.expiry ?? '未知'}，refresh_token=${token.has_refresh_token ? '有' : '无'}）`);
      }
    }
    console.log('\n结论：');
    if (unreadable.length > 0) {
      console.log(`  ⚠️ 有 ${unreadable.length} 个目录的权限**没能读到**（${unreadable.map((i) => i.target).join('、')}）：`);
      console.log('     对这些目录本次**未得出结论**，不代表它们没问题。');
      console.log('     请在允许执行系统命令的普通终端里重跑：node bin\\cred-audit.js');
    }
    if (expiredTokens.length > 0) {
      console.log(`  ⚠️ 有 ${expiredTokens.length} 份访问令牌**已过期**（${expiredTokens.join('、')}）。`);
      console.log('     下次调用时上游会去 oauth2.googleapis.com 刷新：');
      console.log('       · 网络通 → 自动续期，无感；');
      console.log('       · 网络不通 → 调用会**长时间挂住**直到超时（客户端只看到 "Request timed out"）。');
      console.log('     若此时调用卡住，先确认能否访问 google（curl https://oauth2.googleapis.com/token）。');
    }
    if (broadHits.length > 0) {
      console.log(`  ${broadHits.length} 个目录存在过宽授权（${broadHits.join('、')}）：本机任何用户都可能读到凭据。`);
      console.log('  → 建议移除 Everyone / Users / Authenticated Users，只保留你自己的账户。');
    } else if (unreadable.length === 0) {
      console.log('  已读到的目录都没有过宽授权：凭据只对系统、管理员与你自己账户可见。');
    }
    console.log('  ⚠️ 但请注意上一条的边界：如果你机器上的 agent 与 Gateway 是同一账户，');
    console.log('     那么 ACL 无法阻止它读取 —— 那种情况下只能靠「不同账户」或「改为远程 HTTP 上游」来隔离。');
  }

  process.exit(payload.ok ? 0 : 3);
}

// 仅在被当作入口执行时运行（便于单元测试直接 import 上面的纯函数）
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))) {
  main();
}
