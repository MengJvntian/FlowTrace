#!/usr/bin/env node
/**
 * bin/trace-manager.js — 一条命令启动清单里的**全部上游**（t29）
 *
 * 解决的痛点（用户原话：「感觉现在启动和配置好麻烦」）：
 *   改造前要开 N 个终端、各手写一条 100+ 字符命令、**人工保证各 Gateway 的 `--experiment-run-id` 一致**、
 *   再逐个 `curl /healthz` 自检。人工对齐**真的失败过**：Mail 读与 Calendar 写落在两个 run id 的两个运行里，
 *   P2 字段级血缘根本做不出来。
 *   改造后：`trace.manifest.json`（唯一真源）+ `node bin/trace-manager.js` 一条命令。
 *   **一个 `experimentRunId` 覆盖全部上游**——参数漂移在设计上不可能发生（本入口不提供 run id 参数）。
 *
 * 架构（单进程、单端口、按路径路由）：
 *   DSH/Codex ──HTTP──▶ :PORT/mail/mcp      ──▶ Gateway(mail)      ──stdio/HTTP──▶ 上游 A
 *                       :PORT/calendar/mcp  ──▶ Gateway(calendar)  ──stdio/HTTP──▶ 上游 B
 *                       :PORT/healthz       ──▶ 全部上游的就绪状态与原因
 *   每个路径一个独立的 `WebStandardStreamableHTTPServerTransport`（stateless）+ 一个独立 Gateway 实例；
 *   它们**共享同一个 SQLite 库与同一个 experiment_run_id**，但各自保留 gateway_id / upstream_app / transport。
 *
 * 退出码：0 正常（含上游不可用）/ 1 未捕获异常 / 2 用法或清单错误 / 3 未就绪（--status / --once 未通过）。
 * 输出约定：报告（人读或 --json）走 **stdout**；日志与诊断走 **stderr**。
 */
import http from 'node:http';
import process from 'node:process';
import { Readable } from 'node:stream';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/server';

import { openStore } from '../src/collector/store.js';
import { DEFAULT_MAX_PAYLOAD_BYTES } from '../src/shared/schemaversion.js';
import { createGateway } from '../src/gateway/gateway.js';
import {
  DEFAULT_MANIFEST_PATH,
  gatewayConfigFor,
  loadManifest,
  manifestUsage,
} from '../src/gateway/manifest.js';
import { createStreamableHttpUpstreamTransport } from '../src/gateway/transport.js';
import { resolveOAuthProviders, tokenUnavailableReason } from '../src/credentials/provider.js';
import { toWebRequest, writeWebResponse } from './gateway-http.js';

/**
 * `--once` / 启动时等待全部上游「确定下来」的缺省上限（毫秒）。
 *
 * 2026-10-05 由 20000 提高到 60000：真实 Google 上游是 `uvx workspace-mcp`（Python），
 * **每次启动都要重新检查/安装约 96 个依赖包**，然后才把 Gmail/Calendar 的全部工具注册进 MCP
 * —— 单个 Python 上游实测就要 30–40 秒。旧的 20 秒预算会把 gmail 判成
 * `连接上游失败：Request timed out`（用户用 `npm run start` 手起时反复撞到）。
 * Mock 上游是瞬间就绪的，所以这个缺省值此前从未暴露问题。
 */
export const DEFAULT_READY_TIMEOUT_MS = 60000;

/** @param {string} message */
function log(message) {
  process.stderr.write(`${message}\n`);
}

/** @param {string} text */
function out(text) {
  process.stdout.write(`${text}\n`);
}

/** @returns {string} 用法 */
export function managerUsage() {
  return [
    '用法: node bin/trace-manager.js [--manifest <path>] [--port <n>] [--once] [--status] [--json] [--timeout <ms>] [--help]',
    '',
    '  默认（无 --status/--once）  按清单启动全部上游，常驻直到 SIGINT/SIGTERM（收尾时打印汇总统计）',
    '  --status                  查询正在运行的 manager（GET /healthz），报告每个上游的就绪状态；未全就绪 → exit 3',
    '  --once                    启动 → 等全部上游确定下来 → 打印报告 → 优雅退出（全就绪 exit 0，否则 exit 3）',
    '  --json                    报告用机器可读 JSON（配合 --status / --once）',
    '  --manifest <path>         清单路径（缺省 trace.manifest.json）',
    '  --port <n>                覆盖清单里的 http.port（0 = 任意空闲端口）',
    `  --timeout <ms>            --once 等待上限（缺省 ${DEFAULT_READY_TIMEOUT_MS}）`,
    '  --help                    本说明 + 清单字段说明',
    '',
    `清单缺省位置：${DEFAULT_MANIFEST_PATH}（仓库根）`,
    '',
    manifestUsage(),
    '',
    '密钥纪律：清单里 HTTP 头的值支持两类引用：',
    '  · 环境变量（写 `$` + `{VAR}`，需要你自己导出）；',
    '  · **令牌提供者**（写 `$` + `{oauth:名字}`，例如 "Authorization": "Bearer ${oauth:google}"）——',
    '    启动时自动读取凭证文件，临近/已过期会**自动刷新并原子写回**，无需手动导出令牌。',
    '    提供者在清单顶层 `oauthProviders` 里声明（store 缺省 = 用户目录里的凭证文件）。',
    '头的**值**绝不写入事件库/日志/证据（事件只记头名与 <redacted>；`--status` 只显示状态与过期时间）。',
    '令牌缺失或刷新失败时，对应上游**不会被启动**（如实报 failed + 原因，绝不用空令牌继续）。',
    '清单里以 `_` 开头的键是**文档**（`_readme` / `_usage` / `_httpUpstreamExample` …），不参与取值与校验。',
    '本入口**不提供** run id / db 参数——它们只来自清单，这样「两个 Gateway 用了不同 run id」不会发生。',
  ].join('\n');
}

/**
 * 解析本命令的参数。
 * @param {string[]} argv
 * @param {Record<string, string | undefined>} [env]
 */
export function parseManagerArgs(argv, env = process.env) {
  /** @type {string[]} */
  const errors = [];
  /** @type {Record<string, any>} */
  const options = {
    help: false,
    status: false,
    once: false,
    json: false,
    manifestPath: DEFAULT_MANIFEST_PATH,
    port: null,
    timeoutMs: DEFAULT_READY_TIMEOUT_MS,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    const eq = token.startsWith('--') ? token.indexOf('=') : -1;
    const name = eq > 0 ? token.slice(0, eq) : token;
    const inline = eq > 0 ? token.slice(eq + 1) : null;
    const takeValue = () => {
      if (inline !== null) return inline;
      const next = argv[index + 1];
      if (next === undefined || next.startsWith('--')) {
        errors.push(`${name} 缺少取值`);
        return null;
      }
      index += 1;
      return next;
    };
    switch (name) {
      case '--help':
        options.help = true;
        break;
      case '--status':
        options.status = true;
        break;
      case '--once':
        options.once = true;
        break;
      case '--json':
        options.json = true;
        break;
      case '--manifest': {
        const value = takeValue();
        if (value !== null) options.manifestPath = value;
        break;
      }
      case '--port': {
        const value = takeValue();
        if (value === null) break;
        const port = Number(value);
        if (!Number.isInteger(port) || port < 0 || port > 65535) {
          errors.push(`--port 需要 0..65535 的整数（当前 ${JSON.stringify(value)}）`);
        } else {
          options.port = port;
        }
        break;
      }
      case '--timeout': {
        const value = takeValue();
        if (value === null) break;
        const timeoutMs = Number(value);
        if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
          errors.push(`--timeout 需要正整数毫秒（当前 ${JSON.stringify(value)}）`);
        } else {
          options.timeoutMs = timeoutMs;
        }
        break;
      }
      default:
        errors.push(`未知参数：${token}（用 --help 查看用法）`);
        break;
    }
  }
  if (options.status && options.once) errors.push('--status 与 --once 不能同时使用（前者查正在跑的实例，后者自己起一遍）');
  if (options.json && !options.status && !options.once) errors.push('--json 只与 --status / --once 搭配使用');
  void env;
  return { ok: errors.length === 0, options, errors };
}

/**
 * 启动清单里的全部上游 + 单端口路由。
 * @param {{manifest: Record<string, any>, logger?: (message: string) => void, maxPayloadBytes?: number}} input
 * @returns {Promise<Record<string, any>>}
 */
export async function startManager(input) {
  const manifest = input.manifest;
  const logger = input.logger ?? log;
  const attribution = new AsyncLocalStorage();
  const store = openStore(manifest.dbPath, {
    maxPayloadBytes: input.maxPayloadBytes ?? DEFAULT_MAX_PAYLOAD_BYTES,
  });

  // ── t35：先把令牌提供者解析成**当前有效** access token（必要时自动刷新并原子写回）──
  // 解析结果里只有「状态」（提供者名/存储/过期时间/错误码），**绝不含令牌原文**。
  const oauth = await resolveOAuthProviders(manifest.oauthProviders ?? new Map(), {
    nowUtcIso: input.nowUtcIso,
    fetchImpl: input.fetchImpl,
  });
  for (const status of oauth.statuses) {
    const label = status.status === 'valid' || status.status === 'refreshed' ? '就绪' : '不可用';
    logger(
      `[trace-manager] 令牌提供者 ${status.name}：${label}（${status.status}${
        status.refreshed ? '，已自动刷新并写回' : ''
      }；过期时间 ${status.expires_at_utc ?? '未知'}）${status.reason ? `——${status.reason}` : ''}`,
    );
  }

  /** @type {Array<Record<string, any>>} */
  const entries = [];
  const pendingEntries = [];
  /** @type {Array<Record<string, any>>} */
  const blocked = [];
  for (const upstream of manifest.upstreams) {
    // 有令牌引用但提供者不可用 → **不启动**该上游（绝不静默用空令牌去连远端）
    const refs = Array.isArray(upstream.tokenRefs) ? upstream.tokenRefs : [];
    const missingRefs = refs.filter((ref) => !oauth.tokenValues.has(ref));
    if (missingRefs.length > 0) {
      const reason = `令牌不可用：${tokenUnavailableReason(oauth.statuses, missingRefs)}`;
      logger(`[trace-manager] 上游 ${upstream.serverName} 未启动：${reason}`);
      blocked.push({ upstream, reason });
      continue;
    }
    const config = gatewayConfigFor(upstream, {
      manifest,
      maxPayloadBytes: input.maxPayloadBytes,
      tokenValues: oauth.tokenValues,
    });
    const clientTransport = new WebStandardStreamableHTTPServerTransport({
      // stateless：每个 POST 是一次完整交换，不需要 Mcp-Session-Id；
      // 因此「一个路径 = 一个上游」的按路径路由不会破坏 MCP 的 Streamable HTTP 会话语义。
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    const pendingGateway = createGateway({
      config,
      store,
      logger,
      serverTransport: clientTransport,
      attributionProvider: () => attribution.getStore(),
      originalRequestId: () => attribution.getStore()?.originalRequestId,
      upstreamTransportFactory:
        upstream.transport === 'streamable-http' ? createStreamableHttpUpstreamTransport : undefined,
    });
    pendingEntries.push(pendingGateway.then(gateway => ({ upstream, config, gateway, clientTransport, endpointPath: upstream.path })));
  }
  // Independent applications initialize concurrently; one slow handshake must
  // not add its timeout to every other application before the HTTP port opens.
  entries.push(...await Promise.all(pendingEntries));

  for (const entry of entries) await entry.gateway.start();

  const endpointFor = (entry, port) => `http://${manifest.http.host}:${port}${entry.endpointPath}`;

  /** 令牌提供者的**对外状态**（只有名字/存储/过期时间/错误码，没有令牌）。 */
  const oauthReport = () => ({
    configured: oauth.statuses.length,
    all_usable: oauth.usable,
    providers: oauth.statuses.map((status) => ({
      name: status.name,
      store: status.store,
      token_endpoint: status.tokenEndpoint,
      status: status.status,
      expires_at_utc: status.expires_at_utc,
      refreshed: status.refreshed,
      wrote: status.wrote,
      reason: status.reason,
      error_code: status.errorCode,
    })),
  });

  /** 汇总报告（`/healthz`、`--status`、`--once` 共用同一形状）。 */
  const report = (port) => {
    const upstreams = entries.map((entry) => {
      const stats = entry.gateway.stats ?? {};
      const state = entry.gateway.state ?? {};
      const ready = state.upstream_ready === true;
      const reason = state.unavailable_reason ?? null;
      return {
        serverName: entry.upstream.serverName,
        upstream_app: entry.config.upstreamApp,
        gateway_id: entry.config.gatewayId,
        transport: entry.upstream.transport,
        path: entry.endpointPath,
        endpoint: endpointFor(entry, port),
        client_endpoints: {
          codex: `http://${manifest.http.host}:${port}/codex${entry.endpointPath}`,
          deepseek_harness: `http://${manifest.http.host}:${port}/dsh${entry.endpointPath}`,
        },
        upstream_ready: ready,
        tools_discovery: state.tools_discovery ?? 'unverified',
        tools_count: state.tools_count ?? null,
        upstream_pid: state.upstream_pid ?? null,
        unavailable_reason: reason,
        state: ready ? 'ready' : reason ? 'failed' : 'connecting',
        token_providers: entry.upstream.tokenRefs ?? [],
        events_written: stats.events_written ?? 0,
        calls_written: stats.calls_written ?? 0,
        write_failures: stats.write_failures ?? 0,
      };
    });
    // 因令牌不可用而未启动的上游：如实列为 failed（不静默消失）
    for (const item of blocked) {
      upstreams.push({
        serverName: item.upstream.serverName,
        upstream_app: item.upstream.upstreamApp,
        gateway_id: item.upstream.gatewayId,
        transport: item.upstream.transport,
        path: item.upstream.path,
        endpoint: `http://${manifest.http.host}:${port}${item.upstream.path}`,
        upstream_ready: false,
        upstream_pid: null,
        unavailable_reason: item.reason,
        state: 'failed',
        token_providers: item.upstream.tokenRefs ?? [],
        events_written: 0,
        calls_written: 0,
        write_failures: 0,
      });
    }
    return {
      ok: true,
      transport: 'trace-manager',
      url: `http://${manifest.http.host}:${port}`,
      db: manifest.dbPath,
      experiment_run_id: manifest.experimentRunId,
      client_label: manifest.clientLabel,
      manifest: manifest.path,
      oauth: oauthReport(),
      all_ready: upstreams.every((item) => item.upstream_ready),
      upstreams,
    };
  };

  const httpServer = http.createServer((req, res) => {
    const requestUrl = new URL(req.url ?? '/', `http://${req.headers.host ?? manifest.http.host}`);
    const port = /** @type {import('node:net').AddressInfo} */ (httpServer.address()).port;
    if (req.method === 'GET' && requestUrl.pathname === '/healthz') {
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json; charset=utf-8');
      res.end(`${JSON.stringify(report(port), null, 2)}\n`);
      return;
    }
    const prefix = /^\/(codex|dsh)(\/.*)$/u.exec(requestUrl.pathname);
    const routePath = prefix ? prefix[2] : requestUrl.pathname;
    const entry = entries.find((item) => item.endpointPath === routePath);
    if (!entry) {
      res.statusCode = 404;
      res.setHeader('content-type', 'application/json; charset=utf-8');
      res.end(
        `${JSON.stringify({
          error: 'not_found',
          endpoints: [...entries.map((item) => item.endpointPath), '/healthz'],
        })}\n`,
      );
      return;
    }
    const context = prefix ? {
      clientLabel: prefix[1] === 'codex' ? 'codex' : 'deepseek_harness',
      experimentRunId: `${manifest.experimentRunId}__${prefix[1]}`,
    } : {};
    if (prefix) {
      const requestedRun = req.headers['x-trace-task'];
      if (requestedRun !== undefined && (typeof requestedRun !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/u.test(requestedRun))) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'invalid_trace_task' }));
        return;
      }
      if (requestedRun) context.experimentRunId += `__${requestedRun}`;
      if (!store.getRun(context.experimentRunId)) {
        store.upsertRun({ experiment_run_id: context.experimentRunId, client_label: context.clientLabel,
          notes: '通过独立客户端入口采集；入口标签不构成身份认证。' });
      }
    }
    attribution.run(context, () => Promise.resolve()
      .then(() => toWebRequest(req))
      .then(async (request) => {
        // Stateless transports index active responses by JSON-RPC id. Different
        // clients commonly both use id=1; isolate these ids at the HTTP boundary.
        if (request.method !== 'POST') return entry.clientTransport.handleRequest(request);
        let message;
        try { message = await request.clone().json(); }
        catch { return entry.clientTransport.handleRequest(request); }
        if (!message || Array.isArray(message) || message.id === undefined) return entry.clientTransport.handleRequest(request);
        context.originalRequestId = message.id;
        const internalId = 'trace-' + randomUUID();
        message.id = internalId;
        const headers = new Headers(request.headers);
        headers.delete('content-length');
        const isolated = new Request(request.url, { method: request.method, headers, body: JSON.stringify(message) });
        const response = await entry.clientTransport.handleRequest(isolated);
        if (!response.headers.get('content-type')?.includes('application/json')) return response;
        const body = await response.json();
        if (body?.id === internalId) body.id = context.originalRequestId;
        const responseHeaders = new Headers(response.headers);
        responseHeaders.delete('content-length');
        return new Response(JSON.stringify(body), { status: response.status, headers: responseHeaders });
      })
      .then((response) => writeWebResponse(res, response))
      .catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        logger(`[trace-manager] 处理 ${requestUrl.pathname} 失败：${message}`);
        if (!res.headersSent) {
          res.statusCode = 500;
          res.setHeader('content-type', 'text/plain; charset=utf-8');
        }
        res.end(message);
      }));
  });

  await new Promise((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(manifest.http.port, manifest.http.host, resolve);
  });
  const actualPort = /** @type {import('node:net').AddressInfo} */ (httpServer.address()).port;

  let stopped = false;
  const stop = async (reason) => {
    if (stopped) return { reason, stats: null };
    stopped = true;
    for (const entry of entries) {
      try {
        await entry.gateway.stop({ reason, exitCode: 0, status: 'ok' });
      } catch (error) {
        logger(`[trace-manager] 停止 ${entry.upstream.serverName} 出错：${error instanceof Error ? error.message : String(error)}`);
      }
    }
    await new Promise((resolve) => httpServer.close(resolve));
    const stats = entries.reduce(
      (acc, entry) => {
        const item = entry.gateway.stats ?? {};
        acc.events_written += item.events_written ?? 0;
        acc.calls_written += item.calls_written ?? 0;
        acc.write_failures += item.write_failures ?? 0;
        return acc;
      },
      { events_written: 0, calls_written: 0, write_failures: 0 },
    );
    try {
      store.close();
    } catch {
      /* 忽略 */
    }
    return { reason, stats, port: actualPort, report: report(actualPort) };
  };

  return {
    manifest,
    entries,
    store,
    httpServer,
    get port() {
      return actualPort;
    },
    report: () => report(actualPort),
    stop,
    /** 等全部上游「确定下来」（就绪或已给出原因）。 */
    async waitAllSettled(timeoutMs = DEFAULT_READY_TIMEOUT_MS) {
      const startedAt = Date.now();
      for (;;) {
        const list = report(actualPort).upstreams;
        if (list.every((item) => item.state !== 'connecting')) return list;
        if (Date.now() - startedAt > timeoutMs) return list;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    },
  };
}

/**
 * 把报告渲染成人读形态。
 * @param {Record<string, any>} report
 */
export function renderReport(report) {
  /** @type {string[]} */
  const lines = [];
  lines.push(`实验运行：${report.experiment_run_id}   客户端标签：${report.client_label}`);
  lines.push(`库：${report.db}`);
  lines.push(`入口：${report.url}   healthz：${report.url}/healthz   整体就绪：${report.all_ready ? '是' : '否'}`);
  lines.push('');
  // t35：令牌提供者状态（只有状态与过期时间，**没有令牌原文**）
  const oauth = report.oauth ?? null;
  if (oauth && oauth.configured > 0) {
    lines.push(`令牌提供者（${oauth.providers.length} 个；全部可用：${oauth.all_usable ? '是' : '否'}）`);
    for (const provider of oauth.providers) {
      const mark = provider.status === 'valid' || provider.status === 'refreshed' ? '[就绪]' : '[未就绪]';
      lines.push(
        `  ${mark} ${provider.name}（${provider.status}${provider.refreshed ? '，已自动刷新' : ''}）` +
          ` 存储=${provider.store} 端点=${provider.token_endpoint ?? '（取自凭证文件）'}` +
          ` 过期时间=${provider.expires_at_utc ?? '未知'}`,
      );
      if (provider.reason) lines.push(`        ${provider.reason}`);
    }
    lines.push('');
  }
  for (const item of report.upstreams) {
    const mark = item.upstream_ready ? '[就绪]' : `[未就绪:${item.state}]`;
    lines.push(
      `${mark} ${item.serverName}（${item.transport}）→ ${item.endpoint}` +
        `  gateway_id=${item.gateway_id} upstream_app=${item.upstream_app}` +
        ` calls=${item.calls_written} events=${item.events_written} write_failures=${item.write_failures}` +
        (item.token_providers?.length ? ` 令牌=${item.token_providers.join(',')}` : ''),
    );
    lines.push(`        不可用原因：${item.unavailable_reason ?? '（无）'}`);
  }
  return lines.join('\n');
}

/** @param {number} port @param {string} host @param {number} [timeoutMs] */
async function fetchHealth(port, host, timeoutMs = 5000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`http://${host}:${port}/healthz`, { signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

async function main() {
  const parsed = parseManagerArgs(process.argv.slice(2));
  if (parsed.options.help) {
    out(managerUsage());
    process.exit(0);
  }
  if (!parsed.ok) {
    for (const error of parsed.errors) log(`[trace-manager] 配置错误：${error}`);
    log(managerUsage());
    process.exit(2);
  }
  const options = parsed.options;

  const loaded = loadManifest({ manifestPath: options.manifestPath });
  if (!loaded.ok) {
    for (const error of loaded.errors) log(`[trace-manager] 清单错误：${error}`);
    log(managerUsage());
    process.exit(2);
  }
  const manifest = loaded.manifest;
  for (const warning of loaded.warnings) log(`[trace-manager] 警告：${warning}`);
  if (options.port !== null) manifest.http.port = options.port;

  // ── --status：查正在运行的 manager（不自己起）──────────────────────────────
  if (options.status) {
    try {
      const report = await fetchHealth(manifest.http.port, manifest.http.host);
      out(options.json ? JSON.stringify(report, null, 2) : renderReport(report));
      process.exit(report.all_ready ? 0 : 3);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const payload = {
        ok: false,
        transport: 'trace-manager',
        url: `http://${manifest.http.host}:${manifest.http.port}`,
        db: manifest.dbPath,
        experiment_run_id: manifest.experimentRunId,
        client_label: manifest.clientLabel,
        all_ready: false,
        error: `无法连接 ${manifest.http.host}:${manifest.http.port}：${message}（trace-manager 未运行？端口不对？）`,
        upstreams: [],
      };
      out(options.json ? JSON.stringify(payload, null, 2) : payload.error);
      process.exit(3);
    }
  }

  const manager = await startManager({ manifest, maxPayloadBytes: manifest.maxPayloadBytes }).catch((error) => {
    // 端口被占用是**用户可理解**的配置/运行错误：给一句话 + 建议 + 约定退出码（不抛原生异常栈）。
    const code = error && typeof error === 'object' ? error.code : null;
    if (code === 'EADDRINUSE') {
      log(
        `[trace-manager] 端口 ${manifest.http.port} 已被占用（可能已经有一个 trace-manager 在跑）：\n` +
          `  · 先看正在跑的实例：node bin/trace-manager.js --status\n` +
          `  · 或换端口：node bin/trace-manager.js --port 8791（或改清单里的 http.port）\n` +
          `  · 或先停掉旧实例：在它的窗口按 Ctrl+C`,
      );
      process.exit(2);
    }
    if (code === 'EACCES') {
      log(
        `[trace-manager] 无法监听 ${manifest.http.host}:${manifest.http.port}（权限不足）：` +
          `换一个端口或改用清单里的 http.port=0（任意空闲端口）`,
      );
      process.exit(2);
    }
    log(`[trace-manager] 启动失败：${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
  const settled = await manager.waitAllSettled(options.once ? options.timeoutMs : 0);

  if (options.once) {
    const report = manager.report();
    out(options.json ? JSON.stringify(report, null, 2) : renderReport(report));
    const stopped = await manager.stop('once');
    log(
      `[trace-manager] 汇总 events_written=${stopped.stats?.events_written ?? 0} ` +
        `calls_written=${stopped.stats?.calls_written ?? 0} write_failures=${stopped.stats?.write_failures ?? 0}`,
    );
    process.exit(report.all_ready ? 0 : 3);
  }

  for (const signal of /** @type {const} */ (['SIGINT', 'SIGTERM'])) {
    process.on(signal, () => {
      log(`[trace-manager] 收到 ${signal}，开始优雅收尾`);
      manager
        .stop(`signal:${signal}`)
        .then((stopped) => {
          log(
            `[trace-manager] 汇总 events_written=${stopped.stats?.events_written ?? 0} ` +
              `calls_written=${stopped.stats?.calls_written ?? 0} write_failures=${stopped.stats?.write_failures ?? 0}`,
          );
          process.exit(0);
        })
        .catch((error) => {
          log(`[trace-manager] 收尾出错：${error instanceof Error ? error.message : String(error)}`);
          process.exit(1);
        });
    });
  }
  process.on('uncaughtException', (error) => {
    log(`[trace-manager] 未捕获异常：${error?.stack ?? error}`);
    process.exit(1);
  });
  process.on('unhandledRejection', (reason) => {
    log(`[trace-manager] 未处理的 Promise 拒绝：${reason instanceof Error ? reason.stack : String(reason)}`);
    process.exit(1);
  });

  const pending = settled.filter((item) => !item.upstream_ready).map((item) => item.serverName);
  log(
    `[trace-manager] 已启动 ${manager.entries.length} 个上游，监听 ${manager.report().url}，` +
      `experiment_run_id=${manifest.experimentRunId}（一个 run id 覆盖全部上游）`,
  );
  if (pending.length > 0) {
    log(`[trace-manager] 尚未就绪：${pending.join(', ')}（原因见 /healthz；不阻塞启动，客户端调用会得到 -32001）`);
  }
  log(`[trace-manager] 端点：${manager.entries.map((entry) => entry.endpointPath).join(' , ')} , /healthz`);
}

// 仅在被直接执行时启动（测试 import 不产生副作用）。
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1].replace(/\\/g, '/')}`).href) {
  main().catch((error) => {
    process.stderr.write(
      `[trace-manager] 启动失败：${error instanceof Error ? error.stack ?? error.message : String(error)}\n`,
    );
    process.exit(1);
  });
}
