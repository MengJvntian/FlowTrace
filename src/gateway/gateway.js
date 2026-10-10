/**
 * src/gateway/gateway.js — stdio MCP Gateway 透传代理 + 采集（S1）
 *
 * 拓扑：
 *
 *   MCP 客户端 ──stdio──▶ [本进程：Server(StdioServerTransport)] ──▶ 采集事件
 *                                          │ 原样转发（raw JSON-RPC 请求）
 *                                          ▼
 *                        [Client(StdioClientTransport)] ──stdio──▶ 上游 MCP Server
 *
 * 透明性做法：
 *   - 不对任何方法注册「改写型」处理器；`server.fallbackRequestHandler` 拿到的是**原始
 *     JSON-RPC 请求**（`{method, params}` 原样），转发时也把原始 `params` 原样交给上游；
 *   - 上游结果用宽松 schema（`z.unknown()`）接收，不裁剪字段、不重命名工具；
 *   - 上游的 JSON-RPC 错误（含 Method not found）按原错误码/消息回给客户端；
 *   - `initialize` 由 SDK 内部处理，Gateway 把上游的 serverInfo / capabilities /
 *     instructions 原样镜像给客户端（客户端看到的是上游身份）。
 *
 * 采集：tools/call → calls 行 + request/response(或 error) 事件（同一 gateway_call_id）；
 *      其余方法只记摘要事件（不做数据流判断）；上游启动/退出记 gateway_lifecycle 事件。
 */
import { Client } from '@modelcontextprotocol/client';
import { ProtocolError, Server } from '@modelcontextprotocol/server';
import { z } from 'zod';

import { PHASE, SCHEMA_VERSION } from '../shared/schemaversion.js';
import { createTimer, nowUtcIso } from '../shared/time.js';
import {
  ERROR_KIND_BY_STATUS,
  GATEWAY_ERROR_CODES,
  STATUS,
  classifyToolResult,
  classifyUpstreamError,
  errorCodeOf,
  validateArgumentsLoose,
} from './classify.js';
import { CallCollector } from './collector.js';
import {
  RecordingTransport,
  attachUpstreamExitTracking,
  createStdioUpstreamTransport,
  upstreamDescriptor,
  upstreamExitInfo,
} from './transport.js';
import { UpstreamStderrCapture, resolveUpstreamStderr } from './upstream_stderr.js';

export const GATEWAY_NAME = 'mcp-cross-app-trace-gateway';
export const GATEWAY_VERSION = '0.1.0';

/** 宽松结果 schema：原样接收上游结果（不做字段裁剪/转换）。 */
const PASSTHROUGH_RESULT_SCHEMA = z.unknown();

/** 上游 → 客户端需要透传的通知方法。 */
const FORWARDED_NOTIFICATIONS = [
  'notifications/tools/list_changed',
  'notifications/resources/list_changed',
  'notifications/resources/updated',
  'notifications/prompts/list_changed',
  'notifications/message',
];

/** 超时错误（Gateway 自产，可被 classify 识别）。 */
export class UpstreamTimeoutError extends Error {
  /** @param {number} timeoutMs */
  constructor(timeoutMs) {
    super(`upstream timeout: 上游在 ${timeoutMs}ms 内未返回结果`);
    this.name = 'UpstreamTimeoutError';
    this.code = GATEWAY_ERROR_CODES.UPSTREAM_TIMEOUT;
    this.is_timeout = true;
  }
}

/** 上游不可用（进程未启动 / 已退出 / 管道断开）：Gateway 自产，可被 classify 识别。 */
export class UpstreamUnavailableError extends ProtocolError {
  /** @param {string} reason */
  constructor(reason) {
    super(GATEWAY_ERROR_CODES.UPSTREAM_UNAVAILABLE, `upstream unavailable: ${reason}`);
    this.name = 'UpstreamUnavailableError';
    this.is_unavailable = true;
  }
}

/**
 * @param {unknown} error
 * @returns {boolean}
 */
function isTimeoutError(error) {
  return Boolean(error && typeof error === 'object' && /** @type {any} */ (error).is_timeout === true);
}

/**
 * @param {unknown} error
 * @returns {boolean}
 */
function isUnavailableError(error) {
  return Boolean(error && typeof error === 'object' && /** @type {any} */ (error).is_unavailable === true);
}

/**
 * 构造回给客户端的错误：优先原样回传上游的 JSON-RPC 错误码与消息（透明性），
 * 无错误码时用 Gateway 自产码（上游不可用/超时）。
 * @param {unknown} error
 * @param {{status: string, code: number | null, message: string}} classified
 * @returns {Error}
 */
function toClientError(error, classified) {
  const code = classified.code ?? (errorCodeOf(error) ?? GATEWAY_ERROR_CODES.UPSTREAM_UNAVAILABLE);
  const data = error && typeof error === 'object' ? /** @type {any} */ (error).data : undefined;
  try {
    return /** @type {unknown} */ (new ProtocolError(code, classified.message, data));
  } catch {
    const fallback = new Error(classified.message);
    // @ts-expect-error 运行时附加错误码，供 SDK 生成 JSON-RPC error
    fallback.code = code;
    return fallback;
  }
}

/**
 * @param {string} method
 * @returns {string} 摘要事件使用的 phase
 */
function phaseForMethod(method) {
  if (method === 'initialize') return PHASE.INITIALIZE;
  if (method === 'tools/list') return PHASE.TOOLS_LIST;
  if (method.startsWith('notifications/')) return PHASE.NOTIFICATION;
  return PHASE.OTHER;
}

/**
 * 创建并启动一个 Gateway 实例。
 *
 * @param {{
 *   config: Record<string, any>,
 *   store?: any,
 *   collector?: CallCollector,
 *   upstreamTransportFactory?: (config: Record<string, any>) => any,
 *   serverTransport?: any,
 *   logger?: (message: string) => void,
 * }} options
 * @returns {Promise<Record<string, any>>}
 */
export async function createGateway(options) {
  if (!options || !options.config) throw new TypeError('createGateway 需要 config');
  const config = options.config;
  const originalRequestText = (message) => {
    const id = options.originalRequestId?.();
    return JSON.stringify(id === undefined || message.id === undefined ? message : { ...message, id });
  };
  const logger = typeof options.logger === 'function' ? options.logger : (message) => process.stderr.write(`${message}\n`);

  const collector =
    options.collector ??
    new CallCollector({
      store: options.store,
      gatewayId: config.gatewayId,
      upstreamApp: config.upstreamApp,
      clientLabel: config.clientLabel ?? null,
      experimentRunId: config.experimentRunId ?? null,
      attributionProvider: options.attributionProvider,
      maxPayloadBytes: config.maxPayloadBytes,
      traceEnabled: config.traceEnabled,
      transport: config.transport ?? 'stdio',
      logger,
    });

  /** @type {Map<string, any>} 工具名 → 原始工具定义（用于只读参数预校验） */
  const toolsByName = new Map();

  /** @type {any} */
  const state = {
    started: false,
    stopped: false,
    upstream_ready: false,
    tools_discovery: 'unverified',
    tools_count: null,
    unavailable_reason: null,
    upstream_pid: null,
    upstream_protocol_version: null,
    client_protocol_version: null,
  };

  const upstreamTransportFactory = options.upstreamTransportFactory ?? createStdioUpstreamTransport;

  // ── 0. 上游 stderr 采集（t13 加固：只加可观测性，不改协议语义） ───────────────
  const stderrTarget = resolveUpstreamStderr({ config, gatewayId: config.gatewayId, env: options.env ?? process.env });
  /** @type {UpstreamStderrCapture | null} */
  let stderrCapture = null;
  if (stderrTarget.enabled) {
    stderrCapture = new UpstreamStderrCapture({
      filePath: stderrTarget.path,
      tailBytes: config.upstreamStderrTailBytes,
      eventTailBytes: config.upstreamStderrEventTailBytes,
      logger,
    });
    stderrCapture.open();
    // t16：文件**延迟创建**——上游全程静默时不产生任何 0 字节文件（事件里以
    // upstream_stderr_created=false 明确标注「路径是预期路径，文件不存在」）。
    logger(
      `[gateway][upstream-stderr] 采集开启 path=${stderrTarget.path} source=${stderrTarget.source} ` +
        `tail_bytes=${stderrCapture.tailBytes} file_creation=lazy(首个非空 stderr 数据才建文件)`,
    );
  } else {
    logger(`[gateway][upstream-stderr] 采集关闭（${stderrTarget.reason ?? 'disabled'}）：不创建文件，上游 stderr 走继承`);
  }
  /**
   * 事件 summary 里的上游 stderr 证据（关闭时返回空对象，事件不出现这些字段）。
   * @param {{includeTail?: boolean}} [options]
   */
  const stderrEvidence = (evidenceOptions = {}) => (stderrCapture ? stderrCapture.summary(evidenceOptions) : {});

  // ── 1. 连接上游 ────────────────────────────────────────────────────────────
  let upstreamInner = null;
  let upstreamTransport = null;
  let upstreamClient = null;
  let exitTrackingAttached = false;

  try {
    upstreamInner = upstreamTransportFactory(config);
    exitTrackingAttached = attachUpstreamExitTracking(upstreamInner);
    // 必须在 connect()（会 start() 并 spawn）之前挂上 stderr，否则会漏掉早期诊断输出
    if (stderrCapture) {
      const stderrStream = upstreamInner?.stderr ?? null;
      if (stderrStream && stderrCapture.attach(stderrStream)) {
        logger('[gateway][upstream-stderr] 已挂载上游 stderr 流（spawn 前）');
      } else if (stderrStream) {
        // 挂载失败：必须排空，避免上游因 stderr 管道写满而阻塞
        if (typeof stderrStream.resume === 'function') stderrStream.resume();
        logger('[gateway][upstream-stderr] 上游 stderr 流挂载失败，已排空（仅保留内存尾部缓冲）');
      } else {
        logger('[gateway][upstream-stderr] 上游传输未暴露 stderr 流（仅保留内存尾部缓冲）');
      }
    }
    upstreamTransport = new RecordingTransport(upstreamInner, { label: 'upstream' });
  } catch (error) {
    state.unavailable_reason = `创建上游传输失败：${error instanceof Error ? error.message : String(error)}`;
    collector.recordLifecycle({
      event: 'upstream_start_failed',
      status: STATUS.TRANSPORT_ERROR,
      detail: {
        error: state.unavailable_reason,
        ...upstreamDescriptor(config),
        ...stderrEvidence({ includeTail: true }),
      },
    });
    logger(`[gateway] 上游启动失败：${state.unavailable_reason}`);
  }

  if (upstreamTransport) {
    upstreamClient = new Client(
      { name: `${GATEWAY_NAME}-upstream-client`, version: GATEWAY_VERSION },
      { capabilities: {} },
    );
    upstreamClient.onerror = (error) => {
      logger(`[gateway] 上游连接错误：${error instanceof Error ? error.message : String(error)}`);
    };

    /** 上游进程/连接结束：记录生命周期 + 标记不可用（由链式 onclose 触发）。 */
    const handleUpstreamClosed = () => {
      if (state.stopped) return;
      state.upstream_ready = false;
      state.tools_discovery = 'unavailable';
      state.tools_count = null;
      state.unavailable_reason = state.unavailable_reason ?? '上游连接已关闭（进程退出或管道断开）';
      const exitInfo = upstreamExitInfo(upstreamInner);
      // 退出码 0 且无信号 → 正常退出：只记字节数与路径（不把普通 stderr 噪音升级为错误）；
      // 其它情况（非零退出、被信号杀死、退出信息缺失）→ 附带 tail 作为诊断证据。
      const cleanExit = exitInfo.exit_code === 0 && !exitInfo.signal_code;
      collector.recordLifecycle({
        event: 'upstream_exit',
        status: STATUS.TRANSPORT_ERROR,
        pid: exitInfo.pid,
        exitCode: exitInfo.exit_code,
        signalCode: exitInfo.signal_code,
        detail: { exit_info_source: exitInfo.source, ...stderrEvidence({ includeTail: !cleanExit }) },
      });
      logger(
        `[gateway] 上游已退出 pid=${exitInfo.pid ?? 'n/a'} exit_code=${exitInfo.exit_code ?? 'null'} signal=${
          exitInfo.signal_code ?? 'null'
        } upstream_stderr_bytes=${stderrCapture?.bytes ?? 0}${
          stderrCapture?.filePath ? ` upstream_stderr_path=${stderrCapture.filePath}` : ''
        }（后续调用将返回可辨识的 transport_error，不会挂死）`,
      );
    };

    try {
      await upstreamClient.connect(upstreamTransport);
      state.upstream_ready = true;
      // 链式挂钩：保留 SDK 在 connect() 期间安装的 onclose/onerror，再追加 Gateway 的观测。
      const sdkOnClose = upstreamTransport.onclose;
      upstreamTransport.onclose = () => {
        try {
          sdkOnClose?.();
        } finally {
          handleUpstreamClosed();
        }
      };
      const sdkOnError = upstreamTransport.onerror;
      upstreamTransport.onerror = (error) => {
        sdkOnError?.(error);
        logger(`[gateway] 上游传输错误：${error instanceof Error ? error.message : String(error)}`);
      };

      const exitInfo = upstreamExitInfo(upstreamInner);
      state.upstream_pid = exitInfo.pid;
      state.upstream_protocol_version = upstreamClient.getNegotiatedProtocolVersion() ?? null;
      collector.setUpstreamProtocolVersion(state.upstream_protocol_version);
      const serverInfo = upstreamClient.getServerVersion() ?? null;
      collector.recordLifecycle({
        event: 'upstream_started',
        status: STATUS.OK,
        pid: exitInfo.pid,
        detail: {
          ...upstreamDescriptor(config),
          upstream_server_info: serverInfo,
          upstream_protocol_version: state.upstream_protocol_version,
          upstream_capabilities: upstreamClient.getServerCapabilities() ?? null,
          exit_info_source: exitInfo.source,
          exit_tracking_attached: exitTrackingAttached,
          ...stderrEvidence({ includeTail: false }),
        },
      });
      logger(
        `[gateway] 上游已连接 pid=${exitInfo.pid ?? 'n/a'} server=${serverInfo?.name ?? 'unknown'}@${
          serverInfo?.version ?? 'unknown'
        } protocol_version=${state.upstream_protocol_version ?? 'unknown'}`,
      );
    } catch (error) {
      state.upstream_ready = false;
      state.unavailable_reason = `连接上游失败：${error instanceof Error ? error.message : String(error)}`;
      collector.recordLifecycle({
        event: 'upstream_start_failed',
        status: STATUS.TRANSPORT_ERROR,
        detail: {
          error: state.unavailable_reason,
          ...upstreamDescriptor(config),
          error_code: errorCodeOf(error),
          ...stderrEvidence({ includeTail: true }),
        },
      });
      logger(`[gateway] 上游启动失败：${state.unavailable_reason}`);
    }

    // 上游连接结束的观测已在 connect() 之后通过链式 onclose 安装（见上）。
  }

  // ── 2. 建立对客户端的 Server（镜像上游身份/能力） ──────────────────────────
  const upstreamServerInfo = state.upstream_ready ? upstreamClient.getServerVersion() : null;
  const upstreamCapabilities = state.upstream_ready ? upstreamClient.getServerCapabilities() : null;
  const upstreamInstructions = state.upstream_ready ? upstreamClient.getInstructions() : undefined;

  const serverOptions = {
    capabilities: /** @type {any} */ (upstreamCapabilities ?? {}),
    ...(upstreamInstructions ? { instructions: upstreamInstructions } : {}),
  };
  const server = new Server(
    {
      name: upstreamServerInfo?.name ?? GATEWAY_NAME,
      version: upstreamServerInfo?.version ?? GATEWAY_VERSION,
    },
    serverOptions,
  );

  // ── 3. 转发与采集 ──────────────────────────────────────────────────────────
  /**
   * 把原始请求转发给上游（原始 params，不做 schema 裁剪之外的加工）。
   * @param {{method: string, params?: any}} rawRequest
   * @returns {Promise<any>}
   */
  async function forward(rawRequest) {
    if (!state.upstream_ready || !upstreamClient) {
      throw new UpstreamUnavailableError(state.unavailable_reason ?? '未知原因');
    }
    const pending = upstreamClient.request({ method: rawRequest.method, params: rawRequest.params }, PASSTHROUGH_RESULT_SCHEMA);
    // 超时后上游仍可能返回：把迟到结果吞掉，避免 unhandled rejection
    pending.catch(() => {});
    const timeoutMs = Number.isFinite(config.timeoutMs) ? Number(config.timeoutMs) : 60000;
    /** @type {any} */
    let timer;
    const timeoutPromise = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new UpstreamTimeoutError(timeoutMs)), timeoutMs);
    });
    try {
      return await Promise.race([pending, timeoutPromise]);
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * 工具名 → 原始工具定义；缓存未命中时向上游预取一次 tools/list。
   * 预取只用于参数预校验（只读观测），失败不影响转发。
   * @param {string} toolName
   */
  async function toolDefinitionFor(toolName) {
    const cached = toolsByName.get(toolName);
    if (cached) return cached;
    if (!state.upstream_ready || !upstreamClient) return undefined;
    try {
      const result = await upstreamClient.request({ method: 'tools/list', params: {} }, PASSTHROUGH_RESULT_SCHEMA);
      if (result && Array.isArray(/** @type {any} */ (result).tools)) {
        for (const tool of /** @type {any} */ (result).tools) {
          if (tool && typeof tool.name === 'string') toolsByName.set(tool.name, tool);
        }
      }
    } catch (error) {
      logger(`[gateway] 预取 tools/list 失败（不影响转发）：${error instanceof Error ? error.message : String(error)}`);
    }
    return toolsByName.get(toolName);
  }

  /**
   * tools/call：请求前写 request 事件，结果/异常后写 response/error 事件。
   * @param {any} rawRequest
   * @param {string} rawRequestText
   */
  async function handleToolCall(rawRequest, rawRequestText) {
    const params = rawRequest.params ?? {};
    const toolName = typeof params.name === 'string' && params.name !== '' ? params.name : '(unnamed)';
    const args = params.arguments;
    const toolDefinition = await toolDefinitionFor(toolName);
    const validation = validateArgumentsLoose(toolDefinition?.inputSchema, args);

    const record = collector.beginCall({
      toolName,
      method: 'tools/call',
      rawRequestText,
      argumentsValue: args,
      inputSchema: toolDefinition?.inputSchema,
      validation,
    });

    try {
      const result = await forward(rawRequest);
      const responseText = JSON.stringify({ jsonrpc: '2.0', id: options.originalRequestId?.() ?? rawRequest.id ?? null, result });
      const classification = classifyToolResult(result, { violations: validation.violations, upstreamApp: config.upstreamApp });
      collector.endCallWithResult(record, {
        result,
        rawResponseText: responseText,
        status: classification.status,
        error_kind: classification.error_kind,
        validation,
      });
      return result;
    } catch (error) {
      const classified = classifyUpstreamError(error, {
        violations: validation.violations,
        timeout: isTimeoutError(error),
        unavailable: isUnavailableError(error),
      });
      const rawResponseText =
        errorCodeOf(error) !== null
          ? JSON.stringify({
              jsonrpc: '2.0',
              id: options.originalRequestId?.() ?? rawRequest.id ?? null,
              error: { code: errorCodeOf(error), message: classified.message },
            })
          : null;
      collector.endCallWithError(record, {
        error,
        status: classified.status,
        error_kind: classified.error_kind,
        code: classified.code,
        message: classified.message,
        rawResponseText,
        validation,
      });
      throw toClientError(error, classified);
    }
  }

  /**
   * 其他方法：只记摘要事件，不做数据流判断。
   * @param {any} rawRequest
   * @param {string} rawRequestText
   */
  async function handlePassThrough(rawRequest, rawRequestText) {
    const timer = createTimer();
    const method = rawRequest.method;
    try {
      let result;
      try { result = await forward(rawRequest); }
      catch (error) {
        if (method === 'tools/list') {
          state.tools_discovery = 'unavailable';
          state.tools_count = null;
        }
        throw error;
      }
      if (method === 'tools/list' && result && Array.isArray(/** @type {any} */ (result).tools)) {
        state.tools_discovery = 'available';
        state.tools_count = result.tools.length;
        toolsByName.clear();
        for (const tool of /** @type {any} */ (result).tools) {
          if (tool && typeof tool.name === 'string') toolsByName.set(tool.name, tool);
        }
      }
      collector.recordSummary({
        phase: phaseForMethod(method),
        method,
        requestText: rawRequestText,
        responseText: JSON.stringify({ jsonrpc: '2.0', id: options.originalRequestId?.() ?? rawRequest.id ?? null, result }),
        status: STATUS.OK,
        durationMs: timer.ms(),
        extra:
          method === 'tools/list'
            ? { tool_count: Array.isArray(/** @type {any} */ (result)?.tools) ? result.tools.length : 0 }
            : {},
      });
      return result;
    } catch (error) {
      const classified = classifyUpstreamError(error, {
        timeout: isTimeoutError(error),
        unavailable: isUnavailableError(error),
      });
      collector.recordSummary({
        phase: phaseForMethod(method),
        method,
        requestText: rawRequestText,
        responseText:
          errorCodeOf(error) !== null
            ? JSON.stringify({
                jsonrpc: '2.0',
                id: options.originalRequestId?.() ?? rawRequest.id ?? null,
                error: { code: errorCodeOf(error), message: classified.message },
              })
            : null,
        status: classified.status,
        errorKind: classified.error_kind,
        durationMs: timer.ms(),
        extra: { error: { status: classified.status, code: classified.code, message: classified.message } },
      });
      throw toClientError(error, classified);
    }
  }

  /** 所有未被 SDK 内部处理的方法都走这里（原始 JSON-RPC 请求）。 */
  server.fallbackRequestHandler = async (rawRequest) => {
    const rawRequestText = originalRequestText(rawRequest);
    if (rawRequest.method === 'tools/call') return handleToolCall(rawRequest, rawRequestText);
    return handlePassThrough(rawRequest, rawRequestText);
  };

  server.oninitialized = () => {
    const negotiated = server.getNegotiatedProtocolVersion() ?? null;
    state.client_protocol_version = negotiated;
    collector.setClientProtocolVersion(negotiated);
    collector.recordSummary({
      phase: PHASE.INITIALIZE,
      method: 'initialize',
      status: STATUS.OK,
      extra: {
        direction: 'initialize-negotiated',
        client_info: server.getClientVersion() ?? null,
        client_capabilities: server.getClientCapabilities() ?? null,
        negotiated_protocol_version: negotiated,
        upstream_protocol_version: state.upstream_protocol_version,
      },
    });
  };

  // 上游 → 客户端的通知：原样透传（失败只记摘要，不影响协议）
  if (state.upstream_ready) {
    upstreamClient.setNotificationHandler('notifications/tools/list_changed', async () => {
      toolsByName.clear();
      await forwardNotification('notifications/tools/list_changed', {});
    });
    for (const method of FORWARDED_NOTIFICATIONS.filter((m) => m !== 'notifications/tools/list_changed')) {
      upstreamClient.setNotificationHandler(method, async (notification) => {
        await forwardNotification(method, notification?.params ?? {});
      });
    }
  }

  /**
   * @param {string} method
   * @param {any} params
   */
  async function forwardNotification(method, params) {
    try {
      await server.notification({ method, params });
      collector.recordSummary({
        phase: PHASE.NOTIFICATION,
        method,
        responseText: JSON.stringify({ method, params }),
        status: STATUS.OK,
        extra: { direction: 'upstream-to-client', forwarded: true },
      });
    } catch (error) {
      collector.recordSummary({
        phase: PHASE.NOTIFICATION,
        method,
        status: STATUS.PROTOCOL_ERROR,
        errorKind: ERROR_KIND_BY_STATUS.protocol_error,
        extra: {
          direction: 'upstream-to-client',
          forwarded: false,
          error: error instanceof Error ? error.message : String(error),
        },
      });
      logger(`[gateway] 通知透传失败 method=${method}：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // ── 4. 观察客户端入站消息（init / 通知摘要；不改变协议语义） ───────────────
  const rawServerTransport = options.serverTransport ?? null;
  const clientTap = rawServerTransport ? new RecordingTransport(rawServerTransport, { label: 'client-facing' }) : null;
  if (clientTap) {
    clientTap.subscribe((record) => {
      if (record.direction !== 'in') return;
      const message = record.message;
      if (!message || typeof message !== 'object') return;
      const method = typeof message.method === 'string' ? message.method : null;
      if (method === null) return; // 客户端对 server→client 请求的响应，不记录
      if (method === 'tools/call') return; // 由 handleToolCall 记录
      if (Object.prototype.hasOwnProperty.call(message, 'id')) {
        if (method === 'initialize') {
          collector.recordSummary({
            phase: PHASE.INITIALIZE,
            method,
            requestText: originalRequestText(message),
            status: STATUS.OK,
            extra: {
              direction: 'initialize-request',
              declared_protocol_version: message.params?.protocolVersion ?? null,
              client_info: message.params?.clientInfo ?? null,
            },
          });
        }
        return; // 其他请求由 fallback 路径记录（含响应）
      }
      // 客户端通知（notifications/initialized、cancelled 等）：只记摘要
      collector.recordSummary({
        phase: PHASE.NOTIFICATION,
        method,
        requestText: record.text,
        status: STATUS.OK,
        extra: { direction: 'client-to-server' },
      });
    });
  }

  // ── 5. 生命周期收尾 ────────────────────────────────────────────────────────
  let stopReason = null;
  let stopped = false;

  /**
   * @param {{reason?: string, exitCode?: number | null, signalCode?: string | null, status?: string}} [params]
   */
  async function stop(params = {}) {
    if (stopped) return;
    stopped = true;
    state.stopped = true;
    stopReason = params.reason ?? 'client-disconnected';
    const exitInfo = upstreamExitInfo(upstreamInner);
    collector.recordLifecycle({
      event: 'gateway_exit',
      status: params.status ?? STATUS.OK,
      exitCode: params.exitCode ?? 0,
      signalCode: params.signalCode ?? null,
      pid: exitInfo.pid,
      detail: {
        reason: stopReason,
        upstream_exit_code: exitInfo.exit_code,
        upstream_signal_code: exitInfo.signal_code,
        ...stderrEvidence({ includeTail: false }),
      },
    });
    try {
      if (upstreamClient) await upstreamClient.close();
    } catch (error) {
      logger(`[gateway] 关闭上游失败：${error instanceof Error ? error.message : String(error)}`);
    }
    try {
      await server.close();
    } catch {
      /* 已关闭 */
    }
    // 采集句柄在生命周期事件写完之后关闭，保证最后一条事件里的字节数是终值。
    if (stderrCapture) stderrCapture.close();
  }

  // 客户端关闭（stdin EOF）的处理在 start() 中于 connect() 之后链式安装，
  // 因为 `server.connect()` 会覆盖 transport.onclose。

  return {
    config,
    collector,
    server,
    upstreamClient,
    upstreamTransport,
    clientTap,
    rawServerTransport,
    toolsByName,
    state,
    /** 客户端 → 网关侧连接（含观察壳）。 */
    async start() {
      if (!clientTap) throw new Error('createGateway 未提供 serverTransport，无法 start()');
      await server.connect(clientTap);
      // connect() 会安装 SDK 自己的 onclose：链式追加收尾逻辑（不覆盖）。
      const sdkOnClose = clientTap.onclose;
      clientTap.onclose = () => {
        try {
          sdkOnClose?.();
        } finally {
          stop({ reason: 'client-disconnected' })
            .catch((error) => logger(`[gateway] 停止时出错：${error instanceof Error ? error.message : String(error)}`))
            .finally(() => options.onClientClosed?.());
        }
      };
      state.started = true;
      return this;
    },
    stop,
    forward,
    get stopReason() {
      return stopReason;
    },
    get stats() {
      return {
        ...collector.stats,
        upstream_ready: state.upstream_ready,
        upstream_pid: state.upstream_pid,
        client_protocol_version: state.client_protocol_version,
        upstream_protocol_version: state.upstream_protocol_version,
        unavailable_reason: state.unavailable_reason,
        // 上游 stderr 采集（与网关自身 stderr 统计分开命名，便于区分来源）
        upstream_stderr_enabled: stderrCapture !== null,
        // t16：created=false 表示上游全程静默 → 该文件**未创建**（path 只是预期路径）
        upstream_stderr_created: stderrCapture?.created ?? false,
        upstream_stderr_path: stderrCapture?.filePath ?? null,
        upstream_stderr_bytes: stderrCapture?.bytes ?? 0,
        upstream_stderr_lines: stderrCapture?.lines ?? 0,
        upstream_stderr_file_error: stderrCapture?.fileError ?? null,
        schema_version: SCHEMA_VERSION,
        started_at_utc: state.started_at_utc ?? nowUtcIso(),
      };
    },
    /** 上游 stderr 采集器（测试/诊断用；关闭时为 null）。 */
    get upstreamStderr() {
      return stderrCapture;
    },
  };
}
