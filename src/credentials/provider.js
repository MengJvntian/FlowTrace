/**
 * src/credentials/provider.js — 令牌提供者（t35）：让清单 headers 自动取用**当前有效**的 access token
 *
 * 解决的问题（t32 留下的待办）：t32 交付了 OAuth 登录与令牌治理，但令牌仍要人工导出成环境变量
 * （`--ensure-fresh` → `set GOOGLE_ACCESS_TOKEN=…` → 启动 trace-manager）。t35 把这一步消掉：
 *
 * ```json
 * "oauthProviders": { "google": { "store": "default", "tokenEndpoint": "https://oauth2.googleapis.com/token" } },
 * "upstreams": [{ "transport": "streamable-http", "url": "...",
 *                 "headers": { "Authorization": "Bearer ${oauth:google}" } }]
 * ```
 *
 * 启动时（Gateway 侧）解析 `${oauth:<提供者>}`：读 `src/credentials/store.js` 的凭证文件 →
 * 复用 `shouldRefresh()` / `refreshStoredCredentials()` / `writeCredentialsAtomic()` 的既有逻辑，
 * 临近或已过期就自动刷新并**原子写回**；缺失或刷新失败**绝不静默用空令牌继续**。
 *
 * 密钥纪律：access token 只在「解析 → 放进 HTTP 头」这条路径上流动，
 * **不打印、不进事件、不进 `/healthz`、不进错误信息**（状态里只出现提供者名、存储路径、过期时间与错误码）。
 */
import process from 'node:process';

import { shouldRefresh } from './oauth.js';
import { refreshStoredCredentials } from './flow.js';
import { defaultCredentialsPath, assertOutsideRepo } from './paths.js';
import { readCredentials, writeCredentialsAtomic } from './store.js';

/** `${oauth:<名字>}` 引用（名字允许字母数字与 `_ . -`）。 */
export const OAUTH_REF_PATTERN = /\$\{oauth:([A-Za-z0-9_.-]{1,64})\}/g;

/** 令牌状态（对外可见的词表，与 --status / /healthz 一致）。 */
export const TOKEN_STATUSES = Object.freeze(['valid', 'refreshed', 'missing', 'unreadable', 'refresh_failed']);

/**
 * 收集字符串里的令牌提供者引用名。
 * @param {unknown} value
 * @returns {string[]}
 */
export function collectOAuthRefs(value) {
  if (typeof value !== 'string') return [];
  /** @type {string[]} */
  const names = [];
  for (const match of value.matchAll(OAUTH_REF_PATTERN)) {
    if (!names.includes(match[1])) names.push(match[1]);
  }
  return names;
}

/**
 * 用已解析的令牌替换 `${oauth:<名字>}`。
 * **缺令牌时返回 `null`**（调用方必须报错，不得退化成空串——否则就是「静默用空令牌继续」）。
 *
 * @param {unknown} value
 * @param {Map<string, string>} tokenValues
 * @returns {{value: unknown, missing: string[]}}
 */
export function substituteOAuthRefs(value, tokenValues) {
  if (typeof value !== 'string') return { value, missing: [] };
  /** @type {string[]} */
  const missing = [];
  const replaced = value.replace(OAUTH_REF_PATTERN, (_all, name) => {
    const token = tokenValues?.get?.(name);
    if (typeof token === 'string' && token !== '') return token;
    if (!missing.includes(name)) missing.push(name);
    return '';
  });
  return { value: replaced, missing };
}

/**
 * 静态校验清单里的 `oauthProviders`（不联网、不读文件），并规范化成可用的配置表。
 *
 * @param {unknown} source
 * @param {{env?: Record<string, string | undefined>, repoRoot?: string, cwd?: string, where?: string,
 *   errors: string[], resolveTemplate: (value: unknown, env: any, ctx: any) => {value: unknown, containsEnvRef: boolean}}} input
 * @returns {Map<string, Record<string, any>>}
 */
export function parseOAuthProviders(source, input) {
  /** @type {Map<string, Record<string, any>>} */
  const providers = new Map();
  const where = input.where ?? 'oauthProviders';
  const env = input.env ?? process.env;
  if (source === undefined || source === null) return providers;
  if (typeof source !== 'object' || Array.isArray(source)) {
    input.errors.push(`${where} 必须是对象（形如 { "google": { "store": "default" } }）`);
    return providers;
  }
  for (const [name, raw] of Object.entries(source)) {
    if (!/^[A-Za-z0-9_.-]{1,64}$/.test(name)) {
      input.errors.push(`${where}.${name} 名字非法（只能用字母数字与 _ . -）`);
      continue;
    }
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      input.errors.push(`${where}.${name} 必须是对象`);
      continue;
    }
    const storeRaw = input.resolveTemplate(raw.store ?? 'default', env, { errors: input.errors, where: `${where}.${name}.store` });
    const storeValue = typeof storeRaw.value === 'string' && storeRaw.value !== '' ? storeRaw.value : 'default';
    const storePath = storeValue === 'default' ? defaultCredentialsPath(env) : storeValue;
    if (storeValue !== 'default') {
      try {
        assertOutsideRepo(storePath, { repoRoot: input.repoRoot, label: `oauthProviders.${name}.store` });
      } catch (error) {
        input.errors.push(error instanceof Error ? error.message : String(error));
        continue;
      }
    }
    const endpointRaw = raw.tokenEndpoint === undefined
      ? { value: null, containsEnvRef: false }
      : input.resolveTemplate(raw.tokenEndpoint, env, { errors: input.errors, where: `${where}.${name}.tokenEndpoint` });
    const endpoint = endpointRaw.value === null ? null : String(endpointRaw.value);
    if (endpoint !== null) {
      try {
        const parsedEndpoint = new URL(endpoint);
        if (parsedEndpoint.protocol !== 'http:' && parsedEndpoint.protocol !== 'https:') {
          input.errors.push(`${where}.${name}.tokenEndpoint 必须是 http(s) URL（当前 ${JSON.stringify(endpoint)}）`);
          continue;
        }
      } catch {
        input.errors.push(`${where}.${name}.tokenEndpoint 不是合法 URL（当前 ${JSON.stringify(endpoint)}）`);
        continue;
      }
    }
    // 「端点未知」必须静态报错：要么清单里给端点，要么明确让 Gateway 从凭证文件里取（store 非 default 或 default 都行，
    // 但必须至少有一个来源，否则启动时无从刷新）。
    if (endpoint === null && storeValue === 'default' && raw.clientId === undefined) {
      input.errors.push(
        `${where}.${name} 缺少端点信息：请给 tokenEndpoint（或确保凭证文件里记录了 token_endpoint）`,
      );
      continue;
    }
    const clientIdRaw = raw.clientId === undefined
      ? { value: null }
      : input.resolveTemplate(raw.clientId, env, { errors: input.errors, where: `${where}.${name}.clientId` });
    const clientSecretRaw = raw.clientSecret === undefined
      ? { value: null }
      : input.resolveTemplate(raw.clientSecret, env, { errors: input.errors, where: `${where}.${name}.clientSecret` });
    providers.set(name, {
      name,
      store: storeValue,
      storePath,
      tokenEndpoint: endpoint,
      clientId: clientIdRaw.value === null ? null : String(clientIdRaw.value),
      clientSecret: clientSecretRaw.value === null ? null : String(clientSecretRaw.value),
      scopes: Array.isArray(raw.scopes) ? raw.scopes.map((item) => String(item)) : [],
      containsEnvRef: storeRaw.containsEnvRef || endpointRaw.containsEnvRef,
    });
  }
  return providers;
}

/**
 * 解析**单个**提供者的当前有效 access token（必要时自动刷新并原子写回）。
 *
 * @param {Record<string, any>} provider  `parseOAuthProviders()` 的产物
 * @param {{nowUtcIso?: string, skewSeconds?: number, fetchImpl?: typeof fetch, forceRefresh?: boolean}} [options]
 * @returns {Promise<{name: string, store: string, tokenEndpoint: string | null, status: string,
 *   accessToken: string | null, expires_at_utc: string | null, expiring_soon: boolean,
 *   reason: string | null, errorCode: string | null, refreshed: boolean, wrote: boolean}>}
 */
export async function resolveOAuthProvider(provider, options = {}) {
  const base = {
    name: provider.name,
    store: provider.store === 'default' ? 'default' : provider.storePath,
    tokenEndpoint: provider.tokenEndpoint ?? null,
    accessToken: null,
    expires_at_utc: null,
    expiring_soon: false,
    reason: null,
    errorCode: null,
    refreshed: false,
    wrote: false,
  };
  const read = readCredentials({ filePath: provider.storePath });
  if (!read.exists) {
    return {
      ...base,
      status: 'missing',
      reason: `凭证文件不存在：${provider.storePath}（先跑 node bin\\oauth-login.js --login）`,
    };
  }
  if (read.error || !read.credentials) {
    return { ...base, status: 'unreadable', reason: read.error ?? '凭证文件内容不可用' };
  }
  const credentials = read.credentials;
  const tokenEndpoint = provider.tokenEndpoint ?? credentials.token_endpoint ?? null;
  const clientId = provider.clientId ?? credentials.client_id ?? null;
  const clientSecret = provider.clientSecret ?? credentials.client_secret ?? null;
  const decision = shouldRefresh(credentials, {
    nowUtcIso: options.nowUtcIso,
    force: options.forceRefresh === true,
  });
  const expiresAt = typeof credentials.expires_at_utc === 'string' ? credentials.expires_at_utc : null;
  const hasAccess = typeof credentials.access_token === 'string' && credentials.access_token !== '';
  const hasRefresh = typeof credentials.refresh_token === 'string' && credentials.refresh_token !== '';

  if (decision.refresh) {
    if (!tokenEndpoint) {
      return {
        ...base,
        tokenEndpoint: null,
        expires_at_utc: expiresAt,
        status: 'refresh_failed',
        errorCode: 'missing_endpoint',
        reason: '需要刷新但不知道 token 端点：清单里给 tokenEndpoint，或确保证券文件里记录了 token_endpoint',
      };
    }
    const refreshed = await refreshStoredCredentials({
      credentials,
      clientId,
      clientSecret,
      tokenEndpoint,
      fetchImpl: options.fetchImpl,
      nowUtcIso: options.nowUtcIso,
    });
    if (!refreshed.ok) {
      return {
        ...base,
        tokenEndpoint,
        expires_at_utc: expiresAt,
        status: 'refresh_failed',
        errorCode: refreshed.errorCode ?? 'refresh_failed',
        reason: refreshed.needsRelogin
          ? `${refreshed.error}（需要重新登录：node bin\\oauth-login.js --login）`
          : refreshed.error,
      };
    }
    const written = writeCredentialsAtomic({ filePath: provider.storePath, credentials: refreshed.credentials });
    if (!written.ok) {
      return {
        ...base,
        tokenEndpoint,
        expires_at_utc: refreshed.credentials.expires_at_utc ?? null,
        status: 'refresh_failed',
        errorCode: 'write_failed',
        reason: `刷新成功但凭证写回失败：${written.error}`,
      };
    }
    return {
      ...base,
      tokenEndpoint,
      accessToken: refreshed.credentials.access_token,
      expires_at_utc: refreshed.credentials.expires_at_utc ?? null,
      status: 'refreshed',
      refreshed: true,
      wrote: true,
      reason: decision.reason === 'forced' ? '按需强制刷新' : '临近/已过期，已自动刷新',
    };
  }

  if (!hasAccess) {
    return {
      ...base,
      tokenEndpoint,
      status: 'missing',
      errorCode: 'no_access_token',
      reason: '凭证文件里没有 access_token（先跑 node bin\\oauth-login.js --login）',
    };
  }
  if (decision.reason === 'no_refresh_token') {
    // 还有效但**永远刷新不了**：如实标注，过期后会变成 missing
    return {
      ...base,
      tokenEndpoint,
      accessToken: credentials.access_token,
      expires_at_utc: expiresAt,
      status: 'valid',
      reason: '有效，但凭证里没有 refresh_token：过期后需要重新登录',
    };
  }
  return {
    ...base,
    tokenEndpoint,
    accessToken: credentials.access_token,
    expires_at_utc: expiresAt,
    status: 'valid',
    reason:
      decision.reason === 'unknown_expiry'
        ? '有效（凭证未记录 expires_in，无法判断是否快要过期）'
        : expiresAt
          ? '有效'
          : '有效',
  };
}

/**
 * 解析清单里全部提供者；返回可用的令牌表与**不含令牌**的状态列表。
 *
 * @param {Map<string, Record<string, any>> | Record<string, Record<string, any>>} providers
 * @param {{nowUtcIso?: string, skewSeconds?: number, fetchImpl?: typeof fetch}} [options]
 * @returns {Promise<{tokenValues: Map<string, string>, statuses: Array<Record<string, any>>, usable: boolean}>}
 */
export async function resolveOAuthProviders(providers, options = {}) {
  const entries = providers instanceof Map ? [...providers.values()] : Object.values(providers ?? {});
  /** @type {Map<string, string>} */
  const tokenValues = new Map();
  /** @type {Array<Record<string, any>>} */
  const statuses = [];
  for (const provider of entries) {
    const status = await resolveOAuthProvider(provider, options);
    statuses.push(status);
    if (typeof status.accessToken === 'string' && status.accessToken !== '') {
      tokenValues.set(provider.name, status.accessToken);
    }
  }
  return {
    tokenValues,
    statuses,
    usable: statuses.every((status) => typeof status.accessToken === 'string' && status.accessToken !== ''),
  };
}

/**
 * 把 `oauthProviders` 的**状态**转成清单上游的「令牌不可用」原因（可辨识，不泄露令牌）。
 * @param {Array<Record<string, any>>} statuses
 * @param {string[]} refs
 */
export function tokenUnavailableReason(statuses, refs) {
  const byName = new Map(statuses.map((status) => [status.name, status]));
  const parts = [];
  for (const ref of refs) {
    const status = byName.get(ref);
    if (!status) parts.push(`${ref}：清单未声明该提供者`);
    else if (typeof status.accessToken !== 'string' || status.accessToken === '') {
      parts.push(`${ref}：${status.status}${status.errorCode ? ` (${status.errorCode})` : ''}——${status.reason ?? '令牌不可用'}`);
    }
  }
  return parts.join('；');
}
