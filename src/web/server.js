/**
 * src/web/server.js — P3 只读页面服务（W1）
 *
 * 三道只读防线（相关实现）：
 *   1. **SQLite**：连接以 `readOnly: true` 打开（见 readonly.js）；
 *   2. **store 门面**：只暴露查询方法白名单；
 *   3. **HTTP**：证据接口仅 GET/HEAD；独立的本机设置端点只允许修改监控模式。
 *
 * 隐私与加固（默认只绑回环）：
 *   - 绑定地址默认 `127.0.0.1`（`localhost`/`::1` 归一化为 `127.0.0.1`），非回环必须显式放开；
 *   - 校验 `Host` 头必须是回环主机（防 DNS rebinding：浏览器可以访问 127.0.0.1，但带自定义 Host 的请求会被拒）；
 *   - `Cache-Control: no-store`（证据页不允许被缓存留痕）、`nosniff`、CSP `default-src 'self'`、
 *     `form-action 'none'`（页面没有表单提交面）、`frame-ancestors 'none'`。
 */
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { dataVersion } from './view_cache.js';
import { readMonitoringMode, writeMonitoringMode } from '../setup/monitoring_mode.js';
import { applicationStatus, applicationGuide } from './applications.js';
import process from 'node:process';
import { AuditLog } from './audit.js';
import {
  ApiError,
  apiAudit,
  apiEdgeDetail,
  apiExport,
  apiFlows,
  apiMeta,
  apiOps,
  apiRaw,
  apiRun,
  apiRuns,
  apiTimeline,
} from './api.js';
import { collectionStatus } from './aggregate.js';
import { openWebStore } from './readonly.js';
import { readStatic } from './static.js';

const ALLOWED_HOSTNAME = new Set(['127.0.0.1', 'localhost', '::1', '0.0.0.0']);

/**
 * @param {string | undefined} hostHeader
 * @returns {string | null} 规范化主机名（非法返 null）
 */
export function hostnameOf(hostHeader) {
  if (typeof hostHeader !== 'string' || hostHeader.trim() === '') return null;
  const raw = hostHeader.trim();
  if (raw.startsWith('[')) {
    const close = raw.indexOf(']');
    if (close === -1) return null;
    return raw.slice(1, close).toLowerCase();
  }
  const lastColon = raw.lastIndexOf(':');
  const withoutPort = lastColon !== -1 && /^\d+$/u.test(raw.slice(lastColon + 1)) ? raw.slice(0, lastColon) : raw;
  return withoutPort.toLowerCase();
}

/**
 * 创建一个只读页面服务（不监听；由 start() 负责 listen）。
 *
 * @param {{
 *   config: Record<string, any>,
 *   audit?: AuditLog,
 *   now?: () => string,
 *   opened?: {store: Record<string, any> | null, db_exists: boolean, db_bytes: number, open_error: string | null, mode: string},
 *   logger?: (line: string) => void,
 * }} options
 * @returns {Record<string, any>}
 */
export function createWebServer(options) {
  const config = options.config;
  const audit = options.audit ?? new AuditLog({ max: config.auditMax });
  const now = options.now ?? (() => new Date().toISOString());
  const opened = options.opened ?? openWebStore(config.dbPath);
  const logger = options.logger ?? ((line) => process.stderr.write(`${line}\n`));

  /** @type {Record<string, any>} */
  const serverInfo = {
    host: config.host,
    port: () => (server.address() === null ? config.port : server.address().port),
    url: () => `http://${config.host}:${server.address() === null ? config.port : server.address().port}/`,
  };

  /** @type {import('./api.js').ApiContext} */
  const ctx = {
    config,
    audit,
    now,
    opened,
    store: opened.store,
    server: serverInfo,
    // t43：生命周期（由 bin/serve.js 注入；单独跑 web.js 时是 keep-alive）与心跳回调。
    lifecycle: options.lifecycle ?? { mode: 'keep-alive', idle_timeout_seconds: null },
    onAlive: options.onAlive ?? null,
    monitoringFile: options.monitoringFile ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../applications/agent-routing/monitoring.json'),
    controlToken: randomBytes(32).toString('hex'),
    demoMode: options.demoMode ?? process.env.TRACE_DEMO_MODE === '1',
  };

  const server = http.createServer((req, res) => {
    handleRequest(ctx, req, res, logger);
  });

  return {
    server,
    context: ctx,
    audit,
    opened,
    config,
    handler: (req, res) => handleRequest(ctx, req, res, logger),
    /**
     * @returns {Promise<{host: string, port: number, url: string, address: Record<string, any>, collection: Record<string, any>}>}
     */
    start() {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(config.port, config.host, () => {
          const address = server.address();
          resolve({
            host: config.host,
            port: address === null ? config.port : address.port,
            url: serverInfo.url(),
            address: address ?? {},
            collection: collectionStatus(opened, config.dbPath),
          });
        });
      });
    },
    /**
     * 关闭服务：先停止接受新连接，再强制关闭空闲/活跃连接
     * （否则 keep-alive 连接会让 close() 的回调迟迟不触发）。
     * @returns {Promise<void>}
     */
    close() {
      return new Promise((resolve) => {
        if (!server.listening) {
          resolve();
          return;
        }
        server.close(() => resolve());
        if (typeof server.closeIdleConnections === 'function') server.closeIdleConnections();
        if (typeof server.closeAllConnections === 'function') {
          setTimeout(() => {
            if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
          }, 20).unref?.();
        }
      });
    },
    /** 关闭只读 SQLite 连接（幂等；用底层 TraceStore，不经过只读门面）。 */
    closeStore() {
      if (opened.raw !== null && opened.raw !== undefined && typeof opened.raw.close === 'function') opened.raw.close();
    },
  };
}

/**
 * 请求处理（导出以便直接用 mock req/res 单测）。
 * @param {import('./api.js').ApiContext} ctx
 * @param {http.IncomingMessage} req
 * @param {http.ServerResponse} res
 * @param {(line: string) => void} logger
 */
export function handleRequest(ctx, req, res, logger) {
  const started = Date.now();
  let url;
  try {
    url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`);
  } catch {
    sendJson(res, 400, { ok: false, error: { code: 'bad_request', message: '请求 URL 无法解析' } });
    return;
  }
  const method = (req.method ?? 'GET').toUpperCase();

  /** @type {(status: number, body: *, type?: string, extra?: Record<string, string>) => void} */
  const respond = (status, body, type = 'application/json; charset=utf-8', extra = {}) => {
    if (typeof body === 'string' || Buffer.isBuffer(body)) sendRaw(res, status, type, body, method === 'HEAD', extra);
    else sendJson(res, status, body, method === 'HEAD', extra);
    logger(`${method} ${url.pathname}${url.search} ${status} ${Date.now() - started}ms`);
  };

  // 1) Host 校验（DNS rebinding 防护）
  const hostname = hostnameOf(req.headers.host);
  if (hostname === null || (!ALLOWED_HOSTNAME.has(hostname) && !ctx.config.allowNonLoopback)) {
    respond(403, {
      ok: false,
      error: {
        code: 'forbidden_host',
        message: `拒绝的 Host 头：${JSON.stringify(req.headers.host ?? null)}。本服务只服务回环地址（防 DNS rebinding）。`,
      },
    });
    return;
  }

  // Configuration only: never changes evidence or native client profiles.
  if (url.pathname === '/api/settings/monitoring') {
    if (method === 'GET' || method === 'HEAD') {
      respond(200, { ...readMonitoringMode(ctx.monitoringFile), token: ctx.controlToken });
      return;
    }
    if (method === 'POST') {
      if (req.headers.origin !== url.origin || req.headers['x-trace-control-token'] !== ctx.controlToken || req.headers['content-type'] !== 'application/json') {
        respond(403, { ok: false, error: { message: '请从本机应用中心操作开关。' } }); return;
      }
      let body = '', tooLarge = false;
      req.on('data', chunk => { if (Buffer.byteLength(body) + chunk.length > 1024) tooLarge = true; else body += chunk; });
      req.on('end', () => {
        let value;
        try { value = JSON.parse(body); } catch { respond(400, { ok: false, error: { message: '设置格式无效。' } }); return; }
        if (tooLarge || !value || Object.keys(value).length !== 1 || typeof value.enforce !== 'boolean') {
          respond(400, { ok: false, error: { message: '仅接受强制监控开关。' } }); return;
        }
        try { const mode = writeMonitoringMode(ctx.monitoringFile, value.enforce); ctx.applicationReads?.clear(); respond(200, { ok: true, ...mode }); }
        catch { respond(500, { ok: false, error: { message: '设置保存失败，原有模式未被确认更改。' } }); }
      });
      return;
    }
  }
  // Evidence endpoints remain read-only.
  if (method !== 'GET' && method !== 'HEAD') {
    respond(
      405,
      {
        ok: false,
        error: {
          code: 'read_only',
          message:
            `本服务为只读：只接受 GET/HEAD，收到 ${method}。` +
            '改库动作走 CLI 受控入口，例如：node bin/trace.js delete --run <experiment_run_id>',
        },
      },
      'application/json; charset=utf-8',
      { Allow: 'GET, HEAD' },
    );
    return;
  }

  // 3) 路由
  try {
    /** @type {string} */
    let pathname;
    try {
      pathname = decodeURIComponent(url.pathname);
    } catch {
      respond(400, { ok: false, error: { code: 'bad_request', message: `请求路径的百分号编码非法：${url.pathname}` } });
      return;
    }
    if (!pathname.startsWith('/api/')) {
      const asset = readStatic(pathname);
      if (asset === null) {
        respond(404, { ok: false, error: { code: 'not_found', message: `静态资源不存在：${pathname}` } });
        return;
      }
      respond(200, asset.body, asset.type);
      return;
    }

    const client = {
      remote_address: req.socket?.remoteAddress ?? null,
      host: req.headers.host ?? null,
      user_agent: typeof req.headers['user-agent'] === 'string' ? req.headers['user-agent'] : null,
    };
    const json = (status, body) => respond(status, body);
    const route = pathname.slice('/api/'.length);
    const segments = route.split('/').filter((segment) => segment !== '');

    if (segments.length === 0) {
      respond(404, { ok: false, error: { code: 'not_found', message: '未知 API 路径；用 /api/meta 查看服务状态' } });
      return;
    }

    switch (segments[0]) {
      case 'revision':
        json(200, { version: dataVersion(ctx) });
        return;
      case 'applications': {
        if (segments.length === 3 && segments[2] === 'guide') {
          const guide = applicationGuide(segments[1]);
          json(guide ? 200 : 404, guide || { ok: false, error: { code: 'not_found', message: '应用不存在' } });
          return;
        }
        if (segments.length !== 1) { json(404, { ok: false, error: { code: 'not_found', message: '未知应用中心接口' } }); return; }
        const live = url.searchParams.get('live') === '1';
        // Coalesce concurrent requests; brief TTL limits handshake pressure.
        const key = live ? 'live' : 'cached';
        ctx.applicationReads ??= new Map();
        let entry = ctx.applicationReads.get(key);
        if (!entry || Date.now() - entry.at > 5000) {
          entry = { at: Date.now(), value: applicationStatus(ctx, { live }) };
          ctx.applicationReads.set(key, entry);
        }
        entry.value.then(value => json(200, value), () => { ctx.applicationReads.delete(key); json(503, { ok: false, error: { code: 'application_status_failed', message: '应用状态暂不可读取，请稍后刷新。' } }); });
        return;
      }
      case 'meta':
        json(200, apiMeta(ctx));
        return;
      case 'alive': {
        // t43：**只读心跳端点**（GET/HEAD，不改任何状态、不写文件、不开写接口）。
        // 页面定期请求它；`bin/serve.js` 据此实现「页面停止汇报心跳后 N 秒内收尾退出」。
        // 注意表述：这不是「检测浏览器关闭」（网页做不到），只是「最近一次心跳时间」。
        const lifecycle = ctx.lifecycle ?? { mode: 'keep-alive', idle_timeout_seconds: null };
        const now = new Date().toISOString();
        ctx.onAlive?.(now);
        json(200, {
          ok: true,
          alive: true,
          server_time_utc: now,
          lifecycle,
          hint: '本端点只记录「最近一次心跳时间」；服务按心跳超时判断你可能已离开（不是精确检测浏览器关闭）',
        });
        return;
      }
      case 'ops':
        json(200, apiOps(ctx));
        return;
      case 'audit':
        json(200, apiAudit(ctx, url.searchParams));
        return;
      case 'raw':
        json(200, apiRaw(ctx, url.searchParams, client));
        return;
      case 'runs': {
        if (segments.length === 1) {
          json(200, apiRuns(ctx, url.searchParams));
          return;
        }
        const runKey = segments[1];
        if (segments.length === 2) {
          json(200, apiRun(ctx, runKey));
          return;
        }
        if (segments.length === 3 && segments[2] === 'timeline') {
          json(200, apiTimeline(ctx, runKey, url.searchParams));
          return;
        }
        if (segments.length === 3 && segments[2] === 'flows') {
          json(200, apiFlows(ctx, runKey, url.searchParams));
          return;
        }
        if (segments.length === 3 && segments[2] === 'export') {
          const result = apiExport(ctx, runKey, url.searchParams, client);
          respond(result.status, result.body, result.contentType);
          return;
        }
        if (segments.length === 4 && segments[2] === 'edges') {
          json(200, apiEdgeDetail(ctx, runKey, segments[3]));
          return;
        }
        respond(404, { ok: false, error: { code: 'not_found', message: `未知 API 路径：${pathname}` } });
        return;
      }
      default:
        respond(404, {
          ok: false,
          error: { code: 'not_found', message: `未知 API 路径：${pathname}（可用：/api/meta /api/ops /api/runs /api/audit /api/raw）` },
        });
        return;
    }
  } catch (error) {
    if (error instanceof ApiError) {
      respond(error.status, { ok: false, error: { code: error.code, message: error.message } });
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    logger(`[web] 内部错误 ${method} ${url.pathname}: ${message}`);
    respond(500, { ok: false, error: { code: 'internal', message: `内部错误：${message}` } });
  }
}

/** 统一响应头（证据页不允许缓存）。 */
function baseHeaders(extra = {}) {
  return {
    'Cache-Control': 'no-store, no-cache, must-revalidate',
    Pragma: 'no-cache',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy':
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    ...extra,
  };
}

/**
 * @param {http.ServerResponse} res
 * @param {number} status
 * @param {*} body
 * @param {boolean} headOnly
 * @param {Record<string, string>} [extra]
 */
function sendJson(res, status, body, headOnly = false, extra = {}) {
  const text = JSON.stringify(body, null, 2);
  sendRaw(res, status, 'application/json; charset=utf-8', text, headOnly, extra);
}

/**
 * @param {http.ServerResponse} res
 * @param {number} status
 * @param {string} type
 * @param {string | Buffer} body
 * @param {boolean} headOnly
 * @param {Record<string, string>} [extra]
 */
function sendRaw(res, status, type, body, headOnly = false, extra = {}) {
  const buffer = Buffer.isBuffer(body) ? body : Buffer.from(String(body), 'utf8');
  res.writeHead(status, baseHeaders({ 'Content-Type': type, 'Content-Length': String(buffer.length), ...extra }));
  if (headOnly) res.end();
  else res.end(buffer);
}
