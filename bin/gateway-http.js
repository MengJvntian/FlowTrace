#!/usr/bin/env node
/**
 * bin/gateway-http.js — **Streamable HTTP** MCP Gateway 启动器（t25）
 *
 * 为什么需要它：在某些环境里（例如本项目的沙箱）**禁止带管道的子进程 stdio**，
 * 于是「客户端用 `StdioClientTransport` 拉起 Gateway」这条路第一步就 `spawn EPERM`
 * ——DSH 的 mcp-client 正是这样拉起 Gateway 的（`failOnStartupError: true` 时整个插件不激活，
 * 一个 `mcp__*` 工具都不会注册）。把**客户端 → Gateway** 这一段换成 Streamable HTTP 后，
 * 这一跳不再需要管道（普通 HTTP 请求）；Gateway → 上游那一段仍是 stdio 管道子进程。
 *
 * 因此运行前提要说清楚：
 *   - 客户端 ↔ Gateway：**HTTP**，不需要管道（沙箱内也能跑）；
 *   - Gateway ↔ 上游：**仍是 stdio 管道 spawn 独立子进程**，因此**运行 Gateway 的进程必须有管道权限**。
 *     在禁管道沙箱里，Gateway 自身作为「被 DSH 拉起的子进程」时，它 spawn 上游仍会被拒（实测 EPERM）；
 *     这种环境必须把 Gateway 放到**沙箱外的普通终端**里启动（见 相关实现「DSH 走 HTTP 传输」）。
 *
 * 纪律（与 bin/gateway.js 一致）：
 *   - 全部日志/诊断走 **stderr**（HTTP 模式下 stdout 不作协议通道，但仍保持同一约定，便于两种模式共用解析脚本）；
 *   - 上游启动失败或中途退出时本进程**不退出**：客户端会收到可辨识的 transport_error，而不是挂死；
 *   - 退出码：0 正常（含上游不可用）、2 配置错误、1 未捕获异常。
 *
 * 复用：配置解析、透传、采集、分类全部来自 `src/gateway/*`（本文件只负责传输与进程生命周期，不改其语义）。
 */
import http from 'node:http';
import process from 'node:process';
import { Readable } from 'node:stream';

import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/server';

import { openStore } from '../src/collector/store.js';
import { formatConfig, parseGatewayConfig, usage } from '../src/gateway/config.js';
import { createGateway } from '../src/gateway/gateway.js';

/** 默认监听端口（文档里给出的就是这个值）。 */
export const DEFAULT_HTTP_PORT = 8787;
/** 默认端点路径。 */
export const DEFAULT_HTTP_PATH = '/mcp';
/** 只绑回环地址：本实验不对外暴露。 */
export const HTTP_HOST = '127.0.0.1';

/** @param {string} message */
function log(message) {
  process.stderr.write(`${message}\n`);
}

/**
 * 从 argv 里剥离本文件专属的 HTTP 参数（`parseGatewayConfig` 不认这些旗标，必须自己解析）。
 * @param {string[]} argv
 * @returns {{ok: boolean, port: number, path: string, responseMode: 'json'|'sse', rest: string[], errors: string[]}}
 */
export function parseHttpOptions(argv, env = process.env) {
  /** @type {string[]} */
  const rest = [];
  /** @type {string[]} */
  const errors = [];
  let portRaw = null;
  let pathRaw = null;
  let responseRaw = null;

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    const eq = token.startsWith('--') ? token.indexOf('=') : -1;
    const name = eq > 0 ? token.slice(0, eq) : token;
    const inline = eq > 0 ? token.slice(eq + 1) : null;
    if (name !== '--port' && name !== '--http-path' && name !== '--http-response') {
      rest.push(token);
      continue;
    }
    const value = inline ?? argv[index + 1] ?? null;
    if (value === null || value.startsWith('--')) {
      errors.push(`${name} 缺少取值`);
      continue;
    }
    if (inline === null) index += 1; // 吃掉取值
    if (name === '--port') portRaw = value;
    else if (name === '--http-path') pathRaw = value;
    else responseRaw = value;
  }

  const portSource = portRaw ?? env.TRACE_GATEWAY_HTTP_PORT ?? String(DEFAULT_HTTP_PORT);
  const port = Number(portSource);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    errors.push(
      `--port 需要 0..65535 的整数（0 = 任意空闲端口；当前 ${JSON.stringify(portSource)}；也可用 TRACE_GATEWAY_HTTP_PORT）`,
    );
  }

  const pathValue = pathRaw ?? env.TRACE_GATEWAY_HTTP_PATH ?? DEFAULT_HTTP_PATH;
  const normalizedPath = String(pathValue).startsWith('/') ? String(pathValue) : `/${String(pathValue)}`;

  const responseValue = String(responseRaw ?? env.TRACE_GATEWAY_HTTP_RESPONSE ?? 'json').toLowerCase();
  if (responseValue !== 'json' && responseValue !== 'sse') {
    errors.push(`--http-response 只能是 json 或 sse（当前 ${JSON.stringify(responseRaw ?? env.TRACE_GATEWAY_HTTP_RESPONSE)}）`);
  }

  return {
    ok: errors.length === 0,
    port,
    path: normalizedPath,
    responseMode: responseValue === 'sse' ? 'sse' : 'json',
    rest,
    errors,
  };
}

/** @returns {string} HTTP 模式专属用法（追加在通用用法之后） */
export function httpUsage() {
  // 通用用法文本以 `node bin/gateway.js` 开头，这里替换成本文件的调用方式，避免误导。
  const base = usage().replace(/node bin[/\\]gateway\.js/g, 'node bin/gateway-http.js');
  return [
    base,
    '',
    '── Streamable HTTP 模式（bin/gateway-http.js，t25）──────────────────────────',
    `      --port <n>                   HTTP 监听端口（缺省 ${DEFAULT_HTTP_PORT}；0 = 任意空闲端口；也可用 TRACE_GATEWAY_HTTP_PORT）`,
    `      --http-path <path>           端点路径（缺省 ${DEFAULT_HTTP_PATH}；也可用 TRACE_GATEWAY_HTTP_PATH）`,
    '      --http-response <json|sse>   响应形态（缺省 json；若客户端只接受 SSE 就改成 sse）',
    '',
    `  监听地址固定 127.0.0.1（只绑回环，不对外暴露）；端点 url = http://${HTTP_HOST}:<port><path>（实际端口见就绪日志）。`,
    '  客户端侧不再用管道 stdio，因此禁管道环境里 DSH 也能接入；',
    '  上游仍是 stdio 管道子进程 → **本进程必须有管道权限**（禁管道沙箱内请把 Gateway 放到沙箱外终端运行）。',
    '  另有健康检查：GET /healthz → {"ok":true,"gateway_id":…,"upstream_ready":…}',
  ].join('\n');
}

/**
 * Node `IncomingMessage` → Web `Request`（Streamable HTTP 传输要求 Web 标准请求）。
 * @param {import('node:http').IncomingMessage} req
 * @returns {Request}
 */
export function toWebRequest(req) {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? HTTP_HOST}`);
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (typeof value === 'string') headers.set(key, value);
    else if (Array.isArray(value)) headers.set(key, value.join(', '));
  }
  const method = req.method ?? 'GET';
  const body = method === 'GET' || method === 'HEAD' ? undefined : Readable.toWeb(req);
  return new Request(url, { method, headers, body, duplex: 'half' });
}

/**
 * Web `Response` → Node `ServerResponse`。
 * @param {import('node:http').ServerResponse} res
 * @param {Response} response
 */
export async function writeWebResponse(res, response) {
  res.statusCode = response.status;
  for (const [key, value] of response.headers.entries()) res.setHeader(key, value);
  if (!response.body) {
    res.end();
    return;
  }
  await new Promise((resolve, reject) => {
    const stream = Readable.fromWeb(/** @type {any} */ (response.body));
    stream.on('error', reject);
    res.on('close', () => stream.destroy());
    stream.pipe(res);
    res.on('finish', resolve);
  });
}

async function main() {
  const httpOptions = parseHttpOptions(process.argv.slice(2));
  if (!httpOptions.ok) {
    for (const error of httpOptions.errors) log(`[gateway-http] 配置错误：${error}`);
    log(httpUsage());
    process.exit(2);
  }

  const parsed = parseGatewayConfig(httpOptions.rest);
  if (parsed.help) {
    log(httpUsage());
    process.exit(0);
  }
  if (!parsed.ok) {
    for (const error of parsed.errors) log(`[gateway-http] 配置错误：${error}`);
    log(httpUsage());
    process.exit(2);
  }
  const config = parsed.config;
  // 记录用传输名：HTTP 模式下默认记为 `streamable-http`（否则会沿用 stdio 版的 'stdio' 默认，
  // 让「客户端是怎么接入的」这条信息失真）。显式传 --transport / TRACE_TRANSPORT 时以用户为准。
  const transportSpecified =
    httpOptions.rest.some((token) => token === '--transport' || token.startsWith('--transport=')) ||
    Boolean(process.env.TRACE_TRANSPORT);
  const transportRecorded = transportSpecified ? config.transport : 'streamable-http';
  if (!transportSpecified) config.transport = transportRecorded;
  for (const warning of parsed.warnings ?? []) log(`[gateway-http] 警告：${warning}`);

  const url = `http://${HTTP_HOST}:${httpOptions.port}${httpOptions.path}`;
  const clientTransport = new WebStandardStreamableHTTPServerTransport({
    // stateless：每个 HTTP 请求都是一次完整交换，不需要 Mcp-Session-Id，
    // 因此单个 Gateway 实例即可服务同一客户端的连续请求（本地单客户端场景）。
    sessionIdGenerator: undefined,
    enableJsonResponse: httpOptions.responseMode === 'json',
  });

  log(
    `[gateway-http] 启动 transport=streamable-http port=${httpOptions.port} path=${httpOptions.path} ` +
      `response=${httpOptions.responseMode}`,
  );
  log(`[gateway-http] 配置 ${formatConfig(config)}`);

  let store;
  try {
    store = openStore(config.dbPath, { maxPayloadBytes: config.maxPayloadBytes });
  } catch (error) {
    log(`[gateway-http] 打开事件库失败：${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }

  let finished = false;
  /** @param {number} code */
  const finish = (code) => {
    if (finished) return;
    finished = true;
    try {
      const stats = gateway?.stats ?? {};
      log(
        `[gateway-http] 退出 code=${code} db=${config.dbPath} url=${url}` +
          ` upstream_ready=${gateway?.state?.upstream_ready ?? false}` +
          ` upstream_stderr_enabled=${stats.upstream_stderr_enabled ?? false}` +
          ` upstream_stderr_created=${stats.upstream_stderr_created ?? false}` +
          ` upstream_stderr_path=${stats.upstream_stderr_path ?? '(none)'}` +
          ` upstream_stderr_bytes=${stats.upstream_stderr_bytes ?? 0}`,
      );
    } catch {
      /* stderr 已关闭 */
    }
    try {
      store.close();
    } catch {
      /* 忽略 */
    }
    process.exit(code);
  };

  const gateway = await createGateway({
    config,
    store,
    // 注意：这里**不**传 onClientClosed —— HTTP 是请求/响应式的，客户端「断开」不是进程该退出的信号；
    // 进程存活由 SIGINT/SIGTERM 控制（DSH 长期驻留时 Gateway 必须一直在）。
    serverTransport: clientTransport,
    logger: log,
  });

  const httpServer = http.createServer((req, res) => {
    const requestUrl = new URL(req.url ?? '/', `http://${req.headers.host ?? HTTP_HOST}`);
    if (req.method === 'GET' && requestUrl.pathname === '/healthz') {
      const payload = JSON.stringify({
        ok: true,
        transport: 'streamable-http',
        url: actualUrl(),
        gateway_id: config.gatewayId,
        upstream_ready: gateway.state.upstream_ready === true,
        upstream_pid: gateway.state.upstream_pid ?? null,
        unavailable_reason: gateway.state.unavailable_reason ?? null,
        db: config.dbPath,
      });
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json; charset=utf-8');
      res.end(`${payload}\n`);
      return;
    }
    if (requestUrl.pathname !== httpOptions.path) {
      // 只有文档化的端点路径对外服务；其余路径一律 404（避免「随便什么路径都能连上」的模糊行为）。
      res.statusCode = 404;
      res.setHeader('content-type', 'application/json; charset=utf-8');
      res.end(`${JSON.stringify({ error: 'not_found', endpoint: httpOptions.path })}\n`);
      return;
    }
    Promise.resolve()
      .then(() => toWebRequest(req))
      .then((request) => clientTransport.handleRequest(request))
      .then((response) => writeWebResponse(res, response))
      .catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        log(`[gateway-http] 处理请求失败：${message}`);
        if (!res.headersSent) {
          res.statusCode = 500;
          res.setHeader('content-type', 'text/plain; charset=utf-8');
        }
        res.end(message);
      });
  });

  await new Promise((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(httpOptions.port, HTTP_HOST, resolve);
  });

  /** 实际监听到的 URL（`--port 0` 时端口由 OS 分配）。 */
  const actualUrl = () => `http://${HTTP_HOST}:${httpServer.address().port}${httpOptions.path}`;
  log(`[gateway-http] 已监听 ${actualUrl()}（healthz: http://${HTTP_HOST}:${httpServer.address().port}/healthz）`);

  for (const signal of /** @type {const} */ (['SIGINT', 'SIGTERM'])) {
    process.on(signal, () => {
      log(`[gateway-http] 收到 ${signal}，开始收尾`);
      gateway
        .stop({ reason: `signal:${signal}`, signalCode: signal, exitCode: 0, status: 'ok' })
        .catch((error) => log(`[gateway-http] 收尾出错：${error instanceof Error ? error.message : String(error)}`))
        .finally(() => {
          httpServer.close(() => finish(0));
          // HTTP server 可能被长连接占住：给一个短兜底，别让进程挂死。
          setTimeout(() => finish(0), 500).unref?.();
        });
    });
  }

  process.on('uncaughtException', (error) => {
    log(`[gateway-http] 未捕获异常：${error?.stack ?? error}`);
    finish(1);
  });
  process.on('unhandledRejection', (reason) => {
    log(`[gateway-http] 未处理的 Promise 拒绝：${reason instanceof Error ? reason.stack : String(reason)}`);
    finish(1);
  });

  await gateway.start();
  log(
    `[gateway-http] 就绪 transport=streamable-http url=${actualUrl()} gateway_id=${config.gatewayId} ` +
      `upstream_ready=${gateway.state.upstream_ready} upstream_pid=${gateway.state.upstream_pid ?? 'n/a'} ` +
      `db=${config.dbPath}（HTTP 客户端侧不使用管道 stdio）`,
  );
}

// 仅在被直接执行时启动（被测试 import 时只取导出函数，不产生副作用）。
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1].replace(/\\/g, '/')}`).href) {
  main().catch((error) => {
    process.stderr.write(
      `[gateway-http] 启动失败：${error instanceof Error ? error.stack ?? error.message : String(error)}\n`,
    );
    process.exit(1);
  });
}
