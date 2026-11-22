/**
 * src/credentials/oauth.js — OAuth 2.0 纯逻辑（t32）
 *
 * 只有纯函数：PKCE、授权 URL 组装、token 响应解析与错误分类、过期/刷新判定、退出码表。
 * 「不联网、不落盘」——这样这些判定可以在单元测试里穷举，端到端再用本地 mock token 端点验证。
 *
 * 安全取向：**错误信息里绝不包含令牌原文**（token 端点的响应体可能回显 token；这里只保留
 * 错误码与一句安全的描述，绝不把 `access_token` / `refresh_token` 拼进 message）。
 */
import { createHash, randomBytes } from 'node:crypto';

/** 约定的退出码（与 bin/oauth-login.js 一致，文档里也写了一遍）。 */
export const EXIT_CODES = Object.freeze({
  ok: 0,
  runtime: 1,
  usage: 2,
  notLoggedIn: 3,
  authError: 4,
  network: 5,
});

/** 默认提前刷新窗口（秒）：过期前 60 秒就认为需要刷新。 */
export const DEFAULT_REFRESH_SKEW_SECONDS = 60;

/** base64url（无 padding）——PKCE 与 state 都用它。 */
/** @param {Buffer | string} input */
export function base64url(input) {
  return Buffer.from(input).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

/**
 * 生成 PKCE `code_verifier`（RFC 7636：43–128 个 unreserved 字符）。
 * @param {{bytes?: number, randomBytesImpl?: (n: number) => Buffer}} [options]
 * @returns {string}
 */
export function createCodeVerifier(options = {}) {
  const bytes = options.bytes ?? 32;
  const random = options.randomBytesImpl ?? randomBytes;
  const verifier = base64url(random(bytes));
  if (verifier.length < 43 || verifier.length > 128) {
    // 32 字节 → 43 字符；给调用方一个明确的错误而不是悄悄越界
    throw new Error(`code_verifier 长度必须在 43..128 之间（当前 ${verifier.length}）`);
  }
  return verifier;
}

/**
 * `code_challenge` = BASE64URL(SHA256(code_verifier))（S256）。
 * @param {string} verifier
 * @returns {string}
 */
export function codeChallengeS256(verifier) {
  if (typeof verifier !== 'string' || verifier === '') throw new Error('code_challenge 需要一个非空 code_verifier');
  return base64url(createHash('sha256').update(verifier, 'ascii').digest());
}

/**
 * 校验 PKCE 对是否自洽（S256）。用于单元测试与 `--status` 自检。
 * @param {string} verifier
 * @param {string} challenge
 */
export function verifyPkcePair(verifier, challenge) {
  return codeChallengeS256(verifier) === challenge;
}

/**
 * 生成 `state`（防 CSRF）。
 * @param {{bytes?: number, randomBytesImpl?: (n: number) => Buffer}} [options]
 */
export function createState(options = {}) {
  const random = options.randomBytesImpl ?? randomBytes;
  return base64url(random(options.bytes ?? 16));
}

/**
 * 组装授权 URL（authorization code + PKCE）。
 *
 * ⚠️ 关于 refresh token（**2026-10-05 修**）：Google 只有在以下两个条件同时满足时才会在
 * token 响应里返回 `refresh_token`：
 *   1. `access_type=offline` —— 否则只发 access token；
 *   2. 用户在**本次**授权里重新同意（`prompt=consent`）—— 否则重复授权时 Google 会省略
 *      refresh_token（它不会每次都发第二次）。
 * 之前的实现两个都没带，导致「access token 有、refresh token 没有」，Gateway 无法长期
 * 自动刷新。现改为**默认带上**（可用 `extraParams` 覆盖，传空串可移除）。
 *
 * @param {{authorizationEndpoint: string, clientId: string, redirectUri: string, scopes?: string[],
 *   state: string, codeChallenge: string, extraParams?: Record<string, string>}} input
 * @returns {string}
 */
export function buildAuthorizationUrl(input) {
  const missing = ['authorizationEndpoint', 'clientId', 'redirectUri', 'state', 'codeChallenge'].filter(
    (key) => typeof input[key] !== 'string' || input[key] === '',
  );
  if (missing.length > 0) {
    throw new Error(`组装授权 URL 缺少必需参数：${missing.join(', ')}`);
  }
  // 空 scope 必须**当场报错**，不能静默产出一个没有 scope 的授权 URL —— 那样用户会在浏览器里
  // 看到 Google 的 400「Missing required parameter: scope」，而原因（参数没传进来）完全看不出来。
  // 注意 `['']`（数组里只有空串）也会 join 成空串，因此按**去空后**的有效数量判定。
  const effectiveScopes = Array.isArray(input.scopes)
    ? input.scopes.map((s) => String(s).trim()).filter((s) => s !== '')
    : [];
  if (effectiveScopes.length === 0) {
    throw new Error('组装授权 URL 缺少 scopes：至少需要一个非空 scope（检查 --scope 是否传了空值）');
  }
  const url = new URL(input.authorizationEndpoint);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', input.clientId);
  url.searchParams.set('redirect_uri', input.redirectUri);
  url.searchParams.set('state', input.state);
  url.searchParams.set('code_challenge', input.codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('scope', effectiveScopes.join(' '));

  // Google 默认值（先设，允许 extraParams 覆盖或清空）
  const defaults = {
    access_type: 'offline',
    prompt: 'consent',
  };
  for (const [key, value] of Object.entries(defaults)) {
    if (!Object.prototype.hasOwnProperty.call(input.extraParams ?? {}, key)) {
      url.searchParams.set(key, value);
    }
  }
  for (const [key, value] of Object.entries(input.extraParams ?? {})) {
    // 空串 = 显式要求不带该参数（例如某些非 Google 的授权端点不认识 prompt）
    if (typeof value === 'string' && value !== '') url.searchParams.set(key, value);
    else url.searchParams.delete(key);
  }
  return url.toString();
}

/**
 * 解析 token 端点响应并分类（**绝不把响应体原文放进 message**，避免回显令牌）。
 *
 * @param {{status: number, bodyText: string}} response
 * @returns {{ok: boolean, tokens: Record<string, any> | null, error: string | null, errorCode: string | null,
 *   needsRelogin: boolean, httpStatus: number}}
 */
export function parseTokenResponse(response) {
  const status = Number(response?.status ?? 0);
  const bodyText = typeof response?.bodyText === 'string' ? response.bodyText : '';
  /** @type {Record<string, any> | null} */
  let payload = null;
  try {
    payload = JSON.parse(bodyText);
  } catch {
    payload = null;
  }
  if (status >= 200 && status < 300) {
    if (!payload || typeof payload !== 'object') {
      return {
        ok: false,
        tokens: null,
        error: `token 端点返回 ${status}，但响应体不是 JSON（无法解析令牌）`,
        errorCode: 'invalid_response',
        needsRelogin: false,
        httpStatus: status,
      };
    }
    if (typeof payload.access_token !== 'string' || payload.access_token === '') {
      return {
        ok: false,
        tokens: null,
        error: `token 响应缺少 access_token（HTTP ${status}）`,
        errorCode: 'missing_access_token',
        needsRelogin: false,
        httpStatus: status,
      };
    }
    const expiresIn = Number(payload.expires_in);
    return {
      ok: true,
      tokens: {
        access_token: payload.access_token,
        refresh_token: typeof payload.refresh_token === 'string' ? payload.refresh_token : null,
        token_type: typeof payload.token_type === 'string' ? payload.token_type : 'Bearer',
        scope: typeof payload.scope === 'string' ? payload.scope : null,
        expires_in: Number.isFinite(expiresIn) && expiresIn > 0 ? Math.floor(expiresIn) : null,
      },
      error: null,
      errorCode: null,
      needsRelogin: false,
      httpStatus: status,
    };
  }
  const errorCode = typeof payload?.error === 'string' ? payload.error : `http_${status}`;
  const description = typeof payload?.error_description === 'string' ? payload.error_description : null;
  // 注意：只保留 error/error_description，**绝不**把整个 body 带出来（body 可能回显 token）。
  const needsRelogin =
    errorCode === 'invalid_grant' || errorCode === 'invalid_client' || errorCode === 'unauthorized_client';
  const hint =
    errorCode === 'invalid_grant'
      ? '授权码/refresh token 已失效或被撤销：需要重新登录（node bin\\oauth-login.js）'
      : errorCode === 'invalid_client'
        ? 'client_id / client_secret 不被接受：核对客户端配置'
        : null;
  return {
    ok: false,
    tokens: null,
    error:
      `token 端点返回业务错误 ${errorCode}（HTTP ${status}）` +
      (description ? `：${description}` : '') +
      (hint ? `；${hint}` : ''),
    errorCode,
    needsRelogin,
    httpStatus: status,
  };
}

/**
 * 网络/传输失败的分类（可辨识，不静默）。
 * @param {unknown} error
 * @returns {{error: string, errorCode: string, retriable: boolean}}
 */
export function classifyNetworkError(error) {
  // Node 的 `fetch` 对底层失败只抛 `TypeError: fetch failed`，真正的 errno 在 `cause` 里
  // （实测：连不上本地端口时 cause.code = 'ECONNREFUSED'）。这里沿 cause 链找最具体的码。
  /** @type {{code: string | null, name: string | null}} */
  const probe = { code: null, name: null };
  let cursor = error;
  for (let depth = 0; depth < 5 && cursor; depth += 1) {
    if (probe.code === null && typeof cursor.code === 'string') probe.code = cursor.code;
    if (probe.name === null && typeof cursor.name === 'string') probe.name = cursor.name;
    cursor = cursor.cause;
  }
  const code = probe.code;
  const name = probe.name;
  if (name === 'AbortError' || code === 'ABORT_ERR') {
    return { error: '请求超时（token 端点无响应）', errorCode: 'timeout', retriable: true };
  }
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
    return { error: `DNS 解析失败（${code}）：检查网络或 token 端点域名`, errorCode: 'dns', retriable: true };
  }
  if (code === 'ECONNREFUSED') {
    return { error: '连接被拒绝（ECONNREFUSED）：token 端点没在监听或端口写错了', errorCode: 'connection_refused', retriable: true };
  }
  if (code === 'ECONNRESET' || code === 'EPIPE') {
    return { error: `连接被重置（${code}）`, errorCode: 'connection_reset', retriable: true };
  }
  if (code === 'CERT_HAS_EXPIRED' || String(code ?? '').startsWith('ERR_TLS') || String(code ?? '').startsWith('UNABLE_TO_VERIFY')) {
    return { error: `TLS 校验失败（${code}）：证书或系统时间有问题`, errorCode: 'tls', retriable: false };
  }
  const causeMessage = typeof error?.cause?.message === 'string' ? `（${error.cause.message}）` : '';
  return {
    error: `网络请求失败：${error instanceof Error ? error.message : String(error)}${causeMessage}`,
    errorCode: code ?? 'network',
    retriable: true,
  };
}

/**
 * 过期时间（ISO）。`expiresIn` 为空时不写 `expires_at_utc`（视为「未知」，由刷新策略按需刷新）。
 * @param {string} nowUtcIso
 * @param {number | null} expiresInSeconds
 * @returns {string | null}
 */
export function computeExpiresAt(nowUtcIso, expiresInSeconds) {
  if (!Number.isFinite(Number(expiresInSeconds)) || Number(expiresInSeconds) <= 0) return null;
  const at = new Date(new Date(nowUtcIso).getTime() + Number(expiresInSeconds) * 1000);
  return at.toISOString();
}

/**
 * 是否已过期（可带提前量）。
 * @param {{expires_at_utc?: string | null}} credentials
 * @param {{nowUtcIso?: string, skewSeconds?: number}} [options]
 */
export function isExpired(credentials, options = {}) {
  const expiresAt = credentials?.expires_at_utc;
  if (typeof expiresAt !== 'string' || expiresAt === '') return false; // 未知 → 不算过期（由 shouldRefresh 决定）
  const now = new Date(options.nowUtcIso ?? new Date().toISOString()).getTime();
  const skewMs = (options.skewSeconds ?? 0) * 1000;
  return new Date(expiresAt).getTime() - skewMs <= now;
}

/**
 * 是否需要刷新（`--ensure-fresh` 的判据）。
 *
 * 规则（可穷举测试）：
 *   - 没有 refresh_token → 不能刷新（`reason: 'no_refresh_token'`）；
 *   - `expires_at_utc` 未知 → **不**主动刷新（`reason: 'unknown_expiry'`，避免无谓的网络调用）；
 *   - 到期时间在「现在 + skew」之内 → 刷新（`reason: 'expiring'`）；
 *   - `force: true` → 无条件刷新（`reason: 'forced'`）。
 *
 * @param {Record<string, any>} credentials
 * @param {{nowUtcIso?: string, skewSeconds?: number, force?: boolean}} [options]
 * @returns {{refresh: boolean, reason: string}}
 */
export function shouldRefresh(credentials, options = {}) {
  if (!credentials || typeof credentials !== 'object') return { refresh: false, reason: 'no_credentials' };
  if (options.force === true) {
    return credentials.refresh_token ? { refresh: true, reason: 'forced' } : { refresh: false, reason: 'no_refresh_token' };
  }
  if (typeof credentials.refresh_token !== 'string' || credentials.refresh_token === '') {
    return { refresh: false, reason: 'no_refresh_token' };
  }
  const expiresAt = credentials.expires_at_utc;
  if (typeof expiresAt !== 'string' || expiresAt === '') return { refresh: false, reason: 'unknown_expiry' };
  const now = new Date(options.nowUtcIso ?? new Date().toISOString()).getTime();
  const skewMs = (options.skewSeconds ?? DEFAULT_REFRESH_SKEW_SECONDS) * 1000;
  if (new Date(expiresAt).getTime() - skewMs <= now) return { refresh: true, reason: 'expiring' };
  return { refresh: false, reason: 'fresh' };
}

/**
 * 把 token 响应合并进已有凭证（保留 refresh_token：Google 等提供商刷新时可能不返回新的）。
 * @param {Record<string, any>} previous
 * @param {Record<string, any>} tokens
 * @param {{nowUtcIso: string, endpoint?: string | null}} context
 */
export function mergeCredentials(previous, tokens, context) {
  const refreshToken =
    typeof tokens.refresh_token === 'string' && tokens.refresh_token !== ''
      ? tokens.refresh_token
      : previous?.refresh_token ?? null;
  return {
    ...previous,
    access_token: tokens.access_token,
    refresh_token: refreshToken,
    token_type: tokens.token_type ?? previous?.token_type ?? 'Bearer',
    scope: tokens.scope ?? previous?.scope ?? null,
    expires_at_utc: computeExpiresAt(context.nowUtcIso, tokens.expires_in),
    obtained_at_utc: context.nowUtcIso,
    token_endpoint: context.endpoint ?? previous?.token_endpoint ?? null,
  };
}

/**
 * 回调 URL 校验（state 必须匹配、必须有 code、或明确带 error）。
 * @param {string} redirectUrl
 * @param {{expectedState: string}} input
 * @returns {{ok: boolean, code: string | null, error: string | null, errorCode: string | null}}
 */
export function parseRedirectUrl(redirectUrl, input) {
  let parsed;
  try {
    parsed = new URL(redirectUrl);
  } catch {
    return { ok: false, code: null, error: `回调 URL 无法解析：${redirectUrl.slice(0, 120)}`, errorCode: 'invalid_redirect_url' };
  }
  const state = parsed.searchParams.get('state');
  const code = parsed.searchParams.get('code');
  const error = parsed.searchParams.get('error');
  if (error) {
    return {
      ok: false,
      code: null,
      error: `授权服务器返回错误 ${error}${
        parsed.searchParams.get('error_description') ? `：${parsed.searchParams.get('error_description')}` : ''
      }`,
      errorCode: error,
    };
  }
  if (state !== input.expectedState) {
    return {
      ok: false,
      code: null,
      error:
        `state 不匹配（防 CSRF 校验失败）：期望 ${input.expectedState.slice(0, 8)}…，实际 ${
          state === null ? '（缺失）' : `${String(state).slice(0, 8)}…`
        }。已拒绝本次回调，请重新发起登录`,
      errorCode: 'state_mismatch',
    };
  }
  if (typeof code !== 'string' || code === '') {
    return { ok: false, code: null, error: '回调里没有 authorization code', errorCode: 'missing_code' };
  }
  return { ok: true, code, error: null, errorCode: null };
}
