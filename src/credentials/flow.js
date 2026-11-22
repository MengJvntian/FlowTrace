/**
 * src/credentials/flow.js — 授权码兑换、刷新与本地回调服务器（t32）
 *
 * 这里做「会联网、会监听端口」的部分；所有判定逻辑在 `oauth.js`（纯函数，可穷举测试）。
 * 密钥纪律：本模块**不打印**任何令牌；日志只出现在调用方（bin/oauth-login.js），且只打印状态与错误码。
 */
import http from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import process from 'node:process';

import { classifyNetworkError, mergeCredentials, parseTokenResponse } from './oauth.js';

/** 默认请求超时（毫秒）。 */
export const DEFAULT_HTTP_TIMEOUT_MS = 15000;
/** 回调服务器等待授权码的默认上限（毫秒）。 */
export const DEFAULT_CALLBACK_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * 起一个**只绑 127.0.0.1** 的回调服务器，等待一次 `GET /callback?code=…&state=…`。
 *
 * @param {{host?: string, port?: number, path?: string, timeoutMs?: number,
 *   onListening?: (info: {port: number, redirectUri: string}) => void}} [options]
 * @returns {Promise<{port: number, redirectUri: string, waitForRedirect: () => Promise<string>,
 *   close: () => Promise<void>, server: import('node:http').Server}>}
 */
export async function startCallbackServer(options = {}) {
  const host = options.host ?? '127.0.0.1';
  const pathName = options.path ?? '/callback';
  /** @type {((url: string) => void) | null} */
  let resolveRedirect = null;
  /** @type {((error: Error) => void) | null} */
  let rejectRedirect = null;
  const redirectPromise = new Promise((resolve, reject) => {
    resolveRedirect = resolve;
    rejectRedirect = reject;
  });

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://${host}`);
    if (url.pathname !== pathName) {
      res.statusCode = 404;
      res.end('not found');
      return;
    }
    res.statusCode = 200;
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.end(
      '<!doctype html><meta charset="utf-8"><title>登录回调</title>' +
        '<h3>已收到授权结果，可以关闭本页面并回到终端。</h3>' +
        '<p>（本页面不回显任何令牌内容。）</p>',
    );
    resolveRedirect?.(url.toString());
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 0, host, resolve);
  });
  const address = /** @type {import('node:net').AddressInfo} */ (server.address());
  const redirectUri = `http://${host}:${address.port}${pathName}`;
  options.onListening?.({ port: address.port, redirectUri });

  const timeoutMs = options.timeoutMs ?? DEFAULT_CALLBACK_TIMEOUT_MS;
  const timer = setTimeout(() => {
    rejectRedirect?.(new Error(`等待回调超时（${Math.round(timeoutMs / 1000)}s）：浏览器里没完成授权？可改用 --manual 手动粘贴回调 URL`));
  }, timeoutMs);
  timer.unref?.();

  return {
    server,
    port: address.port,
    redirectUri,
    async waitForRedirect() {
      try {
        return await redirectPromise;
      } finally {
        clearTimeout(timer);
      }
    },
    async close() {
      clearTimeout(timer);
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

/**
 * 用 authorization code 换令牌（PKCE：带 code_verifier）。
 *
 * @param {{tokenEndpoint: string, clientId: string, clientSecret?: string | null, code: string,
 *   codeVerifier: string, redirectUri: string, fetchImpl?: typeof fetch,
 *   timeoutMs?: number, nowUtcIso?: string}} input
 * @returns {Promise<{ok: boolean, credentials: Record<string, any> | null, error: string | null,
 *   errorCode: string | null, needsRelogin: boolean, httpStatus: number | null}>}
 */
export async function exchangeAuthorizationCode(input) {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code: input.code,
    code_verifier: input.codeVerifier,
    redirect_uri: input.redirectUri,
    client_id: input.clientId,
  });
  if (input.clientSecret) body.set('client_secret', input.clientSecret);
  return postTokenRequest({ ...input, body });
}

/**
 * 用 refresh_token 换新的 access_token。
 *
 * @param {{tokenEndpoint: string, clientId: string, clientSecret?: string | null, refreshToken: string,
 *   fetchImpl?: typeof fetch, timeoutMs?: number, nowUtcIso?: string}} input
 */
export async function refreshAccessToken(input) {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: input.refreshToken,
    client_id: input.clientId,
  });
  if (input.clientSecret) body.set('client_secret', input.clientSecret);
  return postTokenRequest({ ...input, body });
}

/**
 * 共用的 POST：只返回**分类后**的结果，绝不把响应体原文带进 message。
 * @param {{tokenEndpoint: string, body: URLSearchParams, fetchImpl?: typeof fetch,
 *   timeoutMs?: number, nowUtcIso?: string, clientSecret?: string | null}} input
 */
async function postTokenRequest(input) {
  const fetchImpl = input.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), input.timeoutMs ?? DEFAULT_HTTP_TIMEOUT_MS);
  try {
    const response = await fetchImpl(input.tokenEndpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: input.body.toString(),
      signal: controller.signal,
    });
    const text = await response.text();
    const parsed = parseTokenResponse({ status: response.status, bodyText: text });
    if (!parsed.ok) {
      return {
        ok: false,
        credentials: null,
        error: parsed.error,
        errorCode: parsed.errorCode,
        needsRelogin: parsed.needsRelogin,
        httpStatus: parsed.httpStatus,
      };
    }
    const nowUtcIso = input.nowUtcIso ?? new Date().toISOString();
    return {
      ok: true,
      credentials: mergeCredentials({}, parsed.tokens, { nowUtcIso, endpoint: input.tokenEndpoint }),
      error: null,
      errorCode: null,
      needsRelogin: false,
      httpStatus: parsed.httpStatus,
    };
  } catch (error) {
    const classified = classifyNetworkError(error);
    return {
      ok: false,
      credentials: null,
      error: classified.error,
      errorCode: classified.errorCode,
      needsRelogin: false,
      httpStatus: null,
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 刷新并合并进已有凭证（保留原 refresh_token 等元数据）。
 * @param {{credentials: Record<string, any>, clientId: string, clientSecret?: string | null,
 *   tokenEndpoint?: string | null, fetchImpl?: typeof fetch, nowUtcIso?: string}} input
 */
export async function refreshStoredCredentials(input) {
  const tokenEndpoint = input.tokenEndpoint ?? input.credentials.token_endpoint;
  if (!tokenEndpoint) {
    return { ok: false, credentials: null, error: '凭证里没有记录 token 端点：请用 --token-endpoint 指定', errorCode: 'missing_endpoint', needsRelogin: false, httpStatus: null };
  }
  if (typeof input.credentials.refresh_token !== 'string' || input.credentials.refresh_token === '') {
    return { ok: false, credentials: null, error: '凭证里没有 refresh_token：无法刷新，需要重新登录', errorCode: 'no_refresh_token', needsRelogin: true, httpStatus: null };
  }
  const result = await refreshAccessToken({
    tokenEndpoint,
    clientId: input.clientId ?? input.credentials.client_id,
    clientSecret: input.clientSecret ?? input.credentials.client_secret ?? null,
    refreshToken: input.credentials.refresh_token,
    fetchImpl: input.fetchImpl,
    nowUtcIso: input.nowUtcIso,
  });
  if (!result.ok) return result;
  const nowUtcIso = input.nowUtcIso ?? new Date().toISOString();
  const tokens = {
    access_token: result.credentials.access_token,
    refresh_token: result.credentials.refresh_token,
    token_type: result.credentials.token_type,
    scope: result.credentials.scope,
    expires_in: result.credentials.expires_in,
  };
  return { ...result, credentials: mergeCredentials(input.credentials, tokens, { nowUtcIso, endpoint: tokenEndpoint }) };
}

/**
 * 依次尝试多种「用系统默认浏览器打开 URL」的方式，**第一个成功的就返回**。
 *
 * 为什么不是单一方式（2026-10-05 实测教训）：
 * 先用了 `cmd.exe /d /s /c start "" "<url>"`，其中 `/s` 的引号剥离规则与 `start` 的
 * 「第一个引号参数当窗口标题」叠加后行为不可预测 —— 实测**浏览器完全没打开**。
 * 因此改为：**优先用不经过 cmd 解析的方式**（rundll32 / PowerShell），
 * 最后才回退到最朴素的 `cmd /c start` 形态（该形态此前被实测为可用）。
 *
 * 注意：**不做 cmd 元字符转义**。转义只对「用户手动把 URL 粘进 cmd」有意义，
 * 对 `spawn` 的 argv 传递反而会引入字面 `^`；而 `start` 收到的 URL 由引号包裹，
 * `&` 不构成命令分隔。想要更强的可预测性就干脆别用 cmd（见下面的首选方式）。
 *
 * @param {string} url
 * @param {{platform?: string, spawnImpl?: typeof import('node:child_process').spawn}} [options] 测试注入，避免打开真实浏览器。
 * @returns {Promise<{opened: boolean, reason: string | null}>}
 */
export async function openInBrowser(url, options = {}) {
  const { spawn } = await import('node:child_process');
  const spawnImpl = options.spawnImpl ?? spawn;
  const platform = options.platform ?? process.platform;

  /** @type {{command: string, args: string[]}[]} */
  let candidates;
  if (platform === 'win32') {
    candidates = [
      // 首选：ShellExecute 直连，不经过 cmd 的命令行解析（对含 & 的长 URL 最稳）
      { command: 'rundll32.exe', args: ['url.dll,FileProtocolHandler', url] },
      // 次选：PowerShell Start-Process（同样不走 cmd 元字符解析）
      {
        command: 'powershell.exe',
        args: ['-NoProfile', '-NonInteractive', '-Command', 'Start-Process', '-FilePath', url],
      },
      // 最后回退：最朴素的 cmd start 形态（历史上可用；不做 /s 与转义）
      { command: 'cmd.exe', args: ['/c', 'start', '', url] },
    ];
  } else if (platform === 'darwin') {
    candidates = [{ command: 'open', args: [url] }];
  } else {
    candidates = [{ command: 'xdg-open', args: [url] }];
  }

  const reasons = [];
  for (const { command, args } of candidates) {
    try {
      const child = spawnImpl(command, args, { stdio: 'ignore', detached: true, windowsHide: true });
      child.unref();
      // Windows 上这些启动器基本立即返回；给一点时间让明显的失败（ENOENT 等）浮现
      await delay(120);
      return { opened: true, reason: null };
    } catch (error) {
      reasons.push(`${command}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { opened: false, reason: reasons.join(' | ') };
}
