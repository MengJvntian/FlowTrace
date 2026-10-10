#!/usr/bin/env node
/**
 * bin/oauth-login.js — OAuth 2.0 authorization code + PKCE 登录助手与令牌治理（t32）
 *
 * 为什么单独做一个命令：真实应用接入（Google 官方远程 MCP / 第三方 workspace-mcp / 飞书）路线不同，
 * 但**凭证治理完全同构**——都需要「浏览器授权一次 → 拿到 access/refresh token → 安全存放 → 过期自动刷新」。
 * 本命令只依赖标准 OAuth 2.0 与 PKCE，端点全部可配置，因此对任何路线都适用。
 *
 * 安全取向（硬约束，代码里强制）：
 *   - 令牌文件默认在**用户目录**（`%LOCALAPPDATA%\mcp-cross-app-trace\credentials.json`），
 *     **绝不写进仓库、绝不写进 `demo-data/`**（`assertOutsideRepo` 在写入路径上强制，不是文档口号）；
 *   - 写入用**原子替换**（临时文件 + rename），失败不会留半个文件；
 *   - **令牌绝不进日志**：stdout/stderr 只出现状态、端点、错误码与过期时间；任何路径都不打印 token 原文；
 *     错误信息也只用 token 端点的 `error`/`error_description`，绝不回显整个响应体；
 *   - 缺 client_id、state 不匹配、`invalid_grant`、网络失败……每类都给**可辨识**的一句话 + 约定退出码，
 *     绝不静默用空令牌继续。
 *
 * 退出码：0 成功 / 1 未捕获异常 / 2 用法或配置错误 / 3 未登录（无凭证或无 refresh_token）
 *        / 4 授权或令牌端点业务错误（含 invalid_grant、state 不匹配、回调失败）/ 5 网络失败
 */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { createInterface } from 'node:readline';

import {
  DEFAULT_CALLBACK_TIMEOUT_MS,
  exchangeAuthorizationCode,
  openInBrowser,
  refreshStoredCredentials,
  startCallbackServer,
} from '../src/credentials/flow.js';
import {
  EXIT_CODES,
  buildAuthorizationUrl,
  codeChallengeS256,
  createCodeVerifier,
  createState,
  parseRedirectUrl,
  shouldRefresh,
} from '../src/credentials/oauth.js';
import {
  defaultCredentialsPath,
  defaultSessionPath,
  assertOutsideRepo,
} from '../src/credentials/paths.js';
import {
  deleteCredentials,
  describeFile,
  describePermissionReality,
  readCredentials,
  writeCredentialsAtomic,
} from '../src/credentials/store.js';

/** 默认端点（Google；本会话**未**对真实 Google 验证，见 docs/user/credentials.md）。 */
export const DEFAULT_AUTHORIZATION_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
export const DEFAULT_TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
export const DEFAULT_SCOPES = Object.freeze(['openid', 'email']);

/** @param {string} message */
function log(message) {
  process.stderr.write(`${message}\n`);
}
/** @param {string} text */
function out(text) {
  process.stdout.write(`${text}\n`);
}

/** @returns {string} */
export function usage() {
  return [
    '用法: node bin/oauth-login.js <模式> [选项]',
    '',
    '模式（互斥，任选一个；不写则默认 --login）：',
    '  --login                浏览器授权（authorization code + PKCE）并把令牌写入凭证文件',
    '  --prepare              只生成 PKCE/state 与授权 URL（两阶段流程第一步；写会话文件，含 code_verifier）',
    '  --complete             用 --redirect-url 或 --code 完成两阶段流程（读会话文件）',
    '  --ensure-fresh         需要时用 refresh_token 换新 access_token 并原子写回',
    '  --status               只读报告凭证状态（存在/是否可能过期/端点/下一步命令）',
    '  --logout               删除本地凭证文件（远端撤销需在提供商控制台做）',
    '  --help                 本说明',
    '',
    '选项：',
    '  --store <path>             凭证文件路径（缺省 ' + defaultCredentialsPath() + '）',
    '  --session <path>           两阶段流程的会话文件路径（缺省 ' + defaultSessionPath() + '）',
    '  --client-id <id>           OAuth 客户端 ID（也可用 TRACE_OAUTH_CLIENT_ID）',
    '  --client-secret <secret>   机密客户端用（可选；也可用 TRACE_OAUTH_CLIENT_SECRET）',
    '  --authorization-endpoint <url>  缺省 ' + DEFAULT_AUTHORIZATION_ENDPOINT,
    '  --token-endpoint <url>          缺省 ' + DEFAULT_TOKEN_ENDPOINT + '（测试可指向本地 mock）',
    '  --scope <a,b,c>            逗号或空格分隔（缺省 ' + DEFAULT_SCOPES.join(',') + '）',
    '  --redirect-port <n>        本地回调端口（缺省 0 = 随机空闲端口）',
    '  --redirect-url <url>       非交互模式直接给出的回调 URL（含 code 与 state）',
    '  --code <authorization_code> 直接给出授权码（需同时给 --redirect-url 的 redirect_uri 语义）',
    '  --manual                   不开浏览器 / 不起回调服务器，打印 URL 等你自己粘贴回调 URL',
    '  --no-browser               仍起回调服务器，但不尝试打开浏览器',
    '  --force                    与 --ensure-fresh 连用：无条件刷新',
    '  --json                     机器可读输出（--status / --ensure-fresh / --prepare 支持）',
    '  --timeout <seconds>        回调等待上限（缺省 ' + Math.round(DEFAULT_CALLBACK_TIMEOUT_MS / 1000) + 's）',
    '',
    '退出码：0 成功 / 1 未捕获异常 / 2 用法或配置错误 / 3 未登录 / 4 授权或令牌端点业务错误 / 5 网络失败',
    '',
    '安全说明：',
    '  · 凭证文件默认在用户目录，**绝不写进仓库或 demo-data/**；写入是原子替换（临时文件 + rename）。',
    describePermissionReality(),
  ].join('\n');
}

/**
 * 解析 CLI 参数。
 * @param {string[]} argv
 * @param {Record<string, string | undefined>} [env]
 */
export function parseArgs(argv, env = process.env) {
  /** @type {string[]} */
  const errors = [];
  /** @type {Record<string, any>} */
  const options = {
    mode: null,
    store: env.TRACE_OAUTH_CREDENTIALS || defaultCredentialsPath(env),
    session: defaultSessionPath(env),
    clientId: env.TRACE_OAUTH_CLIENT_ID || null,
    clientSecret: env.TRACE_OAUTH_CLIENT_SECRET || null,
    authorizationEndpoint: env.TRACE_OAUTH_AUTHORIZATION_ENDPOINT || DEFAULT_AUTHORIZATION_ENDPOINT,
    tokenEndpoint: env.TRACE_OAUTH_TOKEN_ENDPOINT || DEFAULT_TOKEN_ENDPOINT,
    scopes: env.TRACE_OAUTH_SCOPES ? env.TRACE_OAUTH_SCOPES.split(/[,\s]+/).filter(Boolean) : [...DEFAULT_SCOPES],
    redirectPort: 0,
    redirectUrl: null,
    code: null,
    manual: false,
    openBrowser: true,
    force: false,
    json: false,
    timeoutMs: DEFAULT_CALLBACK_TIMEOUT_MS,
  };
  const MODES = ['--login', '--prepare', '--complete', '--ensure-fresh', '--status', '--logout'];
  // 用户是否显式给过 --scope。用于区分「没给 → 用缺省」与「给了但为空 → 报错」。
  let explicitScopeGiven = false;
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    const eq = token.startsWith('--') ? token.indexOf('=') : -1;
    const name = eq > 0 ? token.slice(0, eq) : token;
    const inline = eq > 0 ? token.slice(eq + 1) : null;
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
    if (MODES.includes(name)) {
      if (options.mode !== null && options.mode !== name) errors.push(`模式只能选一个（已有 ${options.mode}，又给了 ${name}）`);
      options.mode = name;
      continue;
    }
    switch (name) {
      case '--help':
        options.help = true;
        break;
      case '--store':
      case '--session':
      case '--client-id':
      case '--client-secret':
      case '--authorization-endpoint':
      case '--token-endpoint':
      case '--redirect-url':
      case '--code':
      case '--scope': {
        const value = take();
        if (value === null) break;
        if (name === '--store') options.store = value;
        else if (name === '--session') options.session = value;
        else if (name === '--client-id') options.clientId = value;
        else if (name === '--client-secret') options.clientSecret = value;
        else if (name === '--authorization-endpoint') options.authorizationEndpoint = value;
        else if (name === '--token-endpoint') options.tokenEndpoint = value;
        else if (name === '--redirect-url') options.redirectUrl = value;
        else if (name === '--code') options.code = value;
        else {
          // `--scope` 可重复：累积而不是覆盖（后者覆盖前者是 2026-10-05 修掉的缺陷）。
          // 首次显式给出 `--scope` 时清掉缺省 scopes，避免「缺省 + 用户给的」混在一起让人意外。
          const firstExplicit = !explicitScopeGiven;
          explicitScopeGiven = true;
          if (firstExplicit) options.scopes = [];
          const parsed = value.split(/[,\s]+/).filter(Boolean);
          options.scopes = [...options.scopes, ...parsed];
        }
        break;
      }
      case '--redirect-port': {
        const value = take();
        if (value === null) break;
        const port = Number(value);
        if (!Number.isInteger(port) || port < 0 || port > 65535) errors.push(`--redirect-port 需要 0..65535 的整数（当前 ${JSON.stringify(value)}）`);
        else options.redirectPort = port;
        break;
      }
      case '--timeout': {
        const value = take();
        if (value === null) break;
        const seconds = Number(value);
        if (!Number.isFinite(seconds) || seconds <= 0) errors.push(`--timeout 需要正数秒（当前 ${JSON.stringify(value)}）`);
        else options.timeoutMs = Math.round(seconds * 1000);
        break;
      }
      case '--manual':
        options.manual = true;
        break;
      case '--no-browser':
        options.openBrowser = false;
        break;
      case '--force':
        options.force = true;
        break;
      case '--json':
        options.json = true;
        break;
      default:
        errors.push(`未知参数：${token}（用 --help 查看用法）`);
        break;
    }
  }

  // `--scope` 给了但解析为空（例如 `--scope ""`）必须**当场报错**。
  // 否则会继续产出一个没有 scope 的授权 URL，用户在浏览器里看到 Google 的
  // 400「Missing required parameter: scope」，完全看不出原因是参数没传进来。
  if (explicitScopeGiven && (!Array.isArray(options.scopes) || options.scopes.length === 0)) {
    errors.push('--scope 给了但没有解析出任何 scope（当前为空）：请传具体 scope，例如 --scope "https://www.googleapis.com/auth/gmail.readonly"');
  }
  if (options.mode === null) options.mode = '--login';
  if (options.mode !== '--prepare' && options.mode !== '--login' && options.mode !== '--complete') {
    if (options.redirectUrl || options.code) errors.push('--redirect-url / --code 只与 --complete 连用');
  }
  if (options.mode === '--complete' && !options.redirectUrl && !options.code) {
    errors.push('--complete 需要 --redirect-url <回调URL>（或 --code <授权码>）');
  }
  return { ok: errors.length === 0, options, errors };
}

/** 从会话文件读取（只读；缺失/损坏都给可辨识原因）。 @param {string} sessionPath */
function readSession(sessionPath) {
  if (!fs.existsSync(sessionPath)) {
    return { ok: false, error: `会话文件不存在：${sessionPath}（先跑 --prepare）`, session: null };
  }
  try {
    return { ok: true, error: null, session: JSON.parse(fs.readFileSync(sessionPath, 'utf8')) };
  } catch (error) {
    return { ok: false, error: `会话文件无法解析：${error instanceof Error ? error.message : String(error)}`, session: null };
  }
}

/**
 * 只读地汇总凭证状态（供 --status 与 bin/setup.js 共用）。
 * @param {{store?: string, env?: Record<string, string | undefined>, nowUtcIso?: string}} [input]
 */
export function describeCredentialStatus(input = {}) {
  const storePath = input.store ?? defaultCredentialsPath(input.env ?? process.env);
  let read;
  try {
    read = readCredentials({ filePath: storePath });
  } catch (error) {
    return {
      file: storePath,
      exists: false,
      error: error instanceof Error ? error.message : String(error),
      usable: false,
      expired: null,
      permissions: null,
      next_command: 'node bin\\oauth-login.js --help',
    };
  }
  if (!read.exists) {
    return {
      file: storePath,
      exists: false,
      error: null,
      usable: false,
      expired: null,
      permissions: null,
      next_command: 'node bin\\oauth-login.js --login',
    };
  }
  if (read.error || !read.credentials) {
    return {
      file: storePath,
      exists: true,
      error: read.error ?? '凭证文件内容不可用',
      usable: false,
      expired: null,
      permissions: read.permissions,
      next_command: 'node bin\\oauth-login.js --login',
    };
  }
  const credentials = read.credentials;
  const hasRefresh = typeof credentials.refresh_token === 'string' && credentials.refresh_token !== '';
  const { refresh, reason } = shouldRefresh(credentials, { nowUtcIso: input.nowUtcIso });
  const expired = refresh && reason === 'expiring';
  return {
    file: storePath,
    exists: true,
    error: null,
    usable: typeof credentials.access_token === 'string' && credentials.access_token !== '',
    has_refresh_token: hasRefresh,
    expires_at_utc: credentials.expires_at_utc ?? null,
    obtained_at_utc: credentials.obtained_at_utc ?? null,
    token_endpoint: credentials.token_endpoint ?? null,
    client_id_present: typeof credentials.client_id === 'string' && credentials.client_id !== '',
    expired,
    refresh_reason: reason,
    permissions: read.permissions,
    next_command: expired ? 'node bin\\oauth-login.js --ensure-fresh' : 'node bin\\oauth-login.js --status',
  };
}

/** @param {number} code */
function exitWith(code) {
  process.exit(code);
}

async function main() {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.options.help) {
    out(usage());
    exitWith(EXIT_CODES.ok);
  }
  if (!parsed.ok) {
    for (const error of parsed.errors) log(`[oauth-login] 配置错误：${error}`);
    log(usage());
    exitWith(EXIT_CODES.usage);
  }
  const options = parsed.options;

  // 路径守卫先跑：任何模式都不允许把凭证/会话文件放进仓库（含 demo-data/）——配置错误(2)，不静默继续。
  for (const [label, target] of [
    ['凭证文件（--store）', options.store],
    ['会话文件（--session）', options.session],
  ]) {
    try {
      assertOutsideRepo(target, { label });
    } catch (error) {
      log(`[oauth-login] 配置错误：${error instanceof Error ? error.message : String(error)}`);
      exitWith(EXIT_CODES.usage);
    }
  }

  // ── --status：只读 ────────────────────────────────────────────────────────
  if (options.mode === '--status') {
    const status = describeCredentialStatus({ store: options.store });
    if (options.json) out(JSON.stringify(status, null, 2));
    else {
      out(`凭证文件：${status.file}`);
      out(`存在：${status.exists ? '是' : '否'}`);
      if (status.exists) {
        out(`可用 access_token：${status.usable ? '是' : '否'}`);
        out(`有 refresh_token：${status.has_refresh_token ? '是' : '否'}`);
        out(`过期时间：${status.expires_at_utc ?? '（服务端未给 expires_in）'}`);
        out(`是否可能需要刷新：${status.expired ? '是' : '否'}（判据：${status.refresh_reason}）`);
        out(`文件权限实况：${JSON.stringify(status.permissions)}`);
      }
      if (status.error) out(`问题：${status.error}`);
      out(`下一步：${status.next_command}`);
    }
    exitWith(status.exists && status.usable && !status.error ? EXIT_CODES.ok : EXIT_CODES.notLoggedIn);
  }

  // ── --logout：删除本地凭证 ────────────────────────────────────────────────
  if (options.mode === '--logout') {
    const result = deleteCredentials({ filePath: options.store });
    out(result.deleted ? `已删除本地凭证文件：${result.filePath}` : `本地没有凭证文件（无需删除）：${result.filePath}`);
    out('注意：这只是删除本地副本；要真正撤销授权，请到提供商控制台撤销该应用的访问权限。');
    exitWith(EXIT_CODES.ok);
  }

  if (!options.clientId) {
    log('[oauth-login] 配置错误：缺少 --client-id（或环境变量 TRACE_OAUTH_CLIENT_ID）——没有它无法发起授权，也不会用空值继续');
    log(usage());
    exitWith(EXIT_CODES.usage);
  }

  // ── --prepare：生成 PKCE/state 与授权 URL（会话文件含 code_verifier，属敏感文件）────
  if (options.mode === '--prepare') {
    const codeVerifier = createCodeVerifier();
    const state = createState();
    const codeChallenge = codeChallengeS256(codeVerifier);
    const redirectUri = options.redirectUrl
      ? new URL(options.redirectUrl).origin + new URL(options.redirectUrl).pathname
      : `http://127.0.0.1:${options.redirectPort}/callback`;
    const authorizationUrl = buildAuthorizationUrl({
      authorizationEndpoint: options.authorizationEndpoint,
      clientId: options.clientId,
      redirectUri,
      scopes: options.scopes,
      state,
      codeChallenge,
    });
    fs.mkdirSync(path.dirname(options.session), { recursive: true, mode: 0o700 });
    fs.writeFileSync(
      options.session,
      `${JSON.stringify({ version: 1, state, codeVerifier, redirectUri, authorizationUrl, created_at_utc: new Date().toISOString() }, null, 2)}\n`,
      { mode: 0o600 },
    );
    if (options.json) {
      out(JSON.stringify({ ok: true, authorization_url: authorizationUrl, redirect_uri: redirectUri, session: options.session }, null, 2));
    } else {
      out('在浏览器打开这个授权 URL（或在 --manual 模式下手动粘贴回调 URL）：');
      out(authorizationUrl);
      out(`会话文件（含 PKCE code_verifier，用完请删除）：${options.session}`);
    }
    exitWith(EXIT_CODES.ok);
  }

  // ── --complete：用回调 URL / 授权码完成两阶段流程 ─────────────────────────
  if (options.mode === '--complete') {
    const loaded = readSession(options.session);
    if (!loaded.ok) {
      log(`[oauth-login] ${loaded.error}`);
      exitWith(EXIT_CODES.usage);
    }
    const session = loaded.session;
    let code = options.code;
    if (!code) {
      const parsedRedirect = parseRedirectUrl(options.redirectUrl, { expectedState: session.state });
      if (!parsedRedirect.ok) {
        log(`[oauth-login] 回调失败：${parsedRedirect.error}`);
        exitWith(parsedRedirect.errorCode === 'state_mismatch' ? EXIT_CODES.authError : EXIT_CODES.authError);
      }
      code = parsedRedirect.code;
    }
    const exchanged = await exchangeAuthorizationCode({
      tokenEndpoint: options.tokenEndpoint,
      clientId: options.clientId,
      clientSecret: options.clientSecret,
      code,
      codeVerifier: session.codeVerifier,
      redirectUri: session.redirectUri,
    });
    if (!exchanged.ok) {
      log(`[oauth-login] 换取令牌失败：${exchanged.error}`);
      exitWith(exchanged.httpStatus === null ? EXIT_CODES.network : EXIT_CODES.authError);
    }
    const written = writeCredentialsAtomic({
      filePath: options.store,
      credentials: {
        ...exchanged.credentials,
        client_id: options.clientId,
        client_secret: options.clientSecret ?? null,
        provider: 'oauth2-authorization-code-pkce',
      },
    });
    if (!written.ok) {
      log(`[oauth-login] 凭证写入失败：${written.error}`);
      exitWith(EXIT_CODES.runtime);
    }
    fs.rmSync(options.session, { force: true });
    out(options.json
      ? JSON.stringify({ ok: true, store: written.filePath, bytes: written.bytes, permissions: written.permissions, expires_at_utc: exchanged.credentials.expires_at_utc }, null, 2)
      : `已获取令牌并原子写入：${written.filePath}（${written.bytes} 字节；过期时间 ${exchanged.credentials.expires_at_utc ?? '未知'}）`);
    exitWith(EXIT_CODES.ok);
  }

  // ── --ensure-fresh：需要时刷新 ────────────────────────────────────────────
  if (options.mode === '--ensure-fresh') {
    const read = readCredentials({ filePath: options.store });
    if (!read.exists || !read.credentials) {
      log(`[oauth-login] 未登录：${options.store} ${read.exists ? '内容不可用' : '不存在'}（先跑 --login）`);
      exitWith(EXIT_CODES.notLoggedIn);
    }
    const decision = shouldRefresh(read.credentials, { force: options.force });
    if (!decision.refresh) {
      const message = `无需刷新（判据：${decision.reason}；过期时间 ${read.credentials.expires_at_utc ?? '未知'}）`;
      out(options.json ? JSON.stringify({ ok: true, refreshed: false, reason: decision.reason, store: options.store }, null, 2) : message);
      exitWith(decision.reason === 'no_refresh_token' ? EXIT_CODES.notLoggedIn : EXIT_CODES.ok);
    }
    const refreshed = await refreshStoredCredentials({
      credentials: read.credentials,
      clientId: options.clientId ?? read.credentials.client_id,
      clientSecret: options.clientSecret ?? read.credentials.client_secret ?? null,
      tokenEndpoint: options.tokenEndpoint,
    });
    if (!refreshed.ok) {
      log(`[oauth-login] 刷新失败：${refreshed.error}`);
      exitWith(
        refreshed.needsRelogin
          ? EXIT_CODES.authError
          : refreshed.httpStatus === null
            ? EXIT_CODES.network
            : EXIT_CODES.authError,
      );
    }
    const written = writeCredentialsAtomic({ filePath: options.store, credentials: refreshed.credentials });
    if (!written.ok) {
      log(`[oauth-login] 刷新后的凭证写入失败：${written.error}`);
      exitWith(EXIT_CODES.runtime);
    }
    out(options.json
      ? JSON.stringify({ ok: true, refreshed: true, reason: decision.reason, store: written.filePath, expires_at_utc: refreshed.credentials.expires_at_utc }, null, 2)
      : `已刷新 access_token 并原子写回：${written.filePath}（过期时间 ${refreshed.credentials.expires_at_utc ?? '未知'}）`);
    exitWith(EXIT_CODES.ok);
  }

  // ── --login：完整交互流程 ─────────────────────────────────────────────────
  const codeVerifier = createCodeVerifier();
  const state = createState();
  const codeChallenge = codeChallengeS256(codeVerifier);

  /** @type {{redirectUri: string, waitForRedirect: () => Promise<string>, close: () => Promise<void>} | null} */
  let callback = null;
  let redirectUri;
  if (options.manual) {
    redirectUri = `http://127.0.0.1:${options.redirectPort}/callback`;
  } else {
    callback = await startCallbackServer({ port: options.redirectPort, timeoutMs: options.timeoutMs });
    redirectUri = callback.redirectUri;
  }

  // 把「回调服务器正在哪里等」直接说出来（2026-10-05 加）。
  // 起因：用户遇到浏览器跳转后 ERR_CONNECTION_REFUSED，但无法判断是「服务器没在听」
  // 还是「Google 跳到了别的地址」。这里把实际监听的地址与端口选择都显式打印，便于当场核对。
  log(`[oauth-login] 回调服务器已在 ${redirectUri} 等待（请在 ${Math.round(options.timeoutMs / 1000)}s 内完成授权）`);
  if (!options.manual && options.redirectPort === 0) {
    const actual = Number(new URL(redirectUri).port);
    log(
      `[oauth-login] 注意：--redirect-port 未指定（缺省 0 = 随机端口），本次实际用了 ${actual}。\n` +
        `             这个地址必须已登记在该 OAuth 客户端的「已授权的重定向 URI」里，否则 Google 会拒绝；\n` +
        `             想固定端口就用 --redirect-port 8765（并确保 8765 空闲）。`,
    );
  }

  const authorizationUrl = buildAuthorizationUrl({
    authorizationEndpoint: options.authorizationEndpoint,
    clientId: options.clientId,
    redirectUri,
    scopes: options.scopes,
    state,
    codeChallenge,
  });

  log(`[oauth-login] 打开浏览器完成授权；若没有自动打开，请手动复制下面的 URL：`);
  out(authorizationUrl);
  if (options.manual) {
    out('（--manual：请把浏览器最终跳转到的那条完整回调 URL 粘贴到下面并回车）');
  } else if (options.openBrowser) {
    const opened = await openInBrowser(authorizationUrl);
    log(opened.opened
      ? '[oauth-login] 已尝试用系统浏览器打开授权页'
      : `[oauth-login] 打不开浏览器（${opened.reason ?? '未知原因'}）——请手动复制上面的 URL`);
  }

  /** @returns {Promise<string>} */
  const getRedirectUrl = async () => {
    if (options.redirectUrl) return options.redirectUrl;
    if (callback) return callback.waitForRedirect();
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    const answer = await new Promise((resolve) => rl.question('回调 URL: ', resolve));
    rl.close();
    return String(answer).trim();
  };

  let exchanged;
  try {
    const redirectUrl = await getRedirectUrl();
    const parsedRedirect = parseRedirectUrl(redirectUrl, { expectedState: state });
    if (!parsedRedirect.ok) {
      log(`[oauth-login] 回调失败：${parsedRedirect.error}`);
      exitWith(EXIT_CODES.authError);
    }
    exchanged = await exchangeAuthorizationCode({
      tokenEndpoint: options.tokenEndpoint,
      clientId: options.clientId,
      clientSecret: options.clientSecret,
      code: parsedRedirect.code,
      codeVerifier,
      redirectUri,
    });
  } catch (error) {
    log(`[oauth-login] 回调等待失败：${error instanceof Error ? error.message : String(error)}`);
    exitWith(EXIT_CODES.authError);
  } finally {
    await callback?.close();
  }

  if (!exchanged.ok) {
    log(`[oauth-login] 换取令牌失败：${exchanged.error}`);
    exitWith(exchanged.httpStatus === null ? EXIT_CODES.network : EXIT_CODES.authError);
  }

  const written = writeCredentialsAtomic({
    filePath: options.store,
    credentials: {
      ...exchanged.credentials,
      client_id: options.clientId,
      client_secret: options.clientSecret ?? null,
      provider: 'oauth2-authorization-code-pkce',
    },
  });
  if (!written.ok) {
    log(`[oauth-login] 凭证写入失败：${written.error}`);
    exitWith(EXIT_CODES.runtime);
  }
  out(
    options.json
      ? JSON.stringify({ ok: true, store: written.filePath, bytes: written.bytes, permissions: written.permissions, expires_at_utc: exchanged.credentials.expires_at_utc }, null, 2)
      : `登录成功：已把令牌原子写入 ${written.filePath}（${written.bytes} 字节；权限实况 ${JSON.stringify(written.permissions)}；过期时间 ${exchanged.credentials.expires_at_utc ?? '未知'}）`,
  );
  out(`下一步自检：node bin\\oauth-login.js --status`);
  exitWith(EXIT_CODES.ok);
}

// 仅在被直接执行时运行（测试 import 不产生副作用）。
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1].replace(/\\/g, '/')}`).href) {
  main().catch((error) => {
    process.stderr.write(`[oauth-login] 未捕获异常：${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exit(EXIT_CODES.runtime);
  });
}
