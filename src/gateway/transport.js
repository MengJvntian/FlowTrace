/**
 * src/gateway/transport.js — 传输层适配（S1）
 *
 * 1. `RecordingTransport`：包一层**原样透传**的观察壳，记录每条进/出 JSON-RPC 消息的
 *    文本形式（`JSON.stringify(message)`，与 stdio 传输写出的字节一致）。
 *    它不解析、不加工、不拦截协议语义 —— 只观察，用于：
 *      - 事件里的 request_json / response_json 使用**客户端实际收发的那条消息文本**；
 *      - 断言「stdout 只有协议帧」。
 * 2. 上游传输工厂：默认 `StdioClientTransport`（spawn 子进程 + 管道），
 *    与配置项一一对应；测试可注入替代工厂（见 tests/helpers/gateway_harness.js）。
 * 3. 上游退出信息：SDK 未提供公开的退出码 API，这里按「ChildProcess 对象（若可达）→
 *    传输的 pid 属性 → 传输自定义 exitInfo()」的顺序兜底，拿不到就显式记 null。
 */
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { nowUtcIso } from '../shared/time.js';
import { discoveryFetch } from './http_discovery_fetch.js';

/** @typedef {{start: () => Promise<void>, send: (message: any) => Promise<void>, close: () => Promise<void>, onmessage?: Function, onerror?: Function, onclose?: Function}} Transport */

/**
 * @param {unknown} message
 * @returns {string}
 */
function safeStringify(message) {
  try {
    return JSON.stringify(message);
  } catch (error) {
    return JSON.stringify({ __unserializable__: true, error: error instanceof Error ? error.message : String(error) });
  }
}

export class RecordingTransport {
  /**
   * @param {Transport} inner
   * @param {{label?: string}} [options]
   */
  constructor(inner, options = {}) {
    if (!inner || typeof inner.send !== 'function') {
      throw new TypeError('RecordingTransport 需要一个 Transport 实例');
    }
    this.inner = inner;
    this.label = options.label ?? 'transport';
    /** @type {Array<{direction: 'in'|'out', text: string, message: any, timestamp_utc: string}>} */
    this.inbound = [];
    /** @type {Array<{direction: 'in'|'out', text: string, message: any, timestamp_utc: string}>} */
    this.outbound = [];
    /** @type {Set<(record: any) => void>} */
    this.listeners = new Set();
    /** @type {((message: any, extra?: any) => void) | undefined} */
    this.onmessage = undefined;
    /** @type {((error: Error) => void) | undefined} */
    this.onerror = undefined;
    /** @type {(() => void) | undefined} */
    this.onclose = undefined;

    this.inner.onmessage = (message, extra) => {
      this._record('in', message);
      this.onmessage?.(message, extra);
    };
    this.inner.onerror = (error) => {
      this.onerror?.(error);
    };
    this.inner.onclose = () => {
      this.onclose?.();
    };
  }

  /** @param {() => Promise<void>} */
  async start() {
    return this.inner.start();
  }

  /** @param {any} message */
  async send(message) {
    this._record('out', message);
    return this.inner.send(message);
  }

  async close() {
    return this.inner.close();
  }

  /**
   * @param {'in'|'out'} direction
   * @param {any} message
   */
  _record(direction, message) {
    const record = {
      direction,
      text: safeStringify(message),
      message,
      timestamp_utc: nowUtcIso(),
      label: this.label,
    };
    if (direction === 'in') this.inbound.push(record);
    else this.outbound.push(record);
    for (const listener of this.listeners) listener(record);
  }

  /**
   * @param {(record: {direction: 'in'|'out', text: string, message: any}) => void} listener
   * @returns {() => void} 取消订阅
   */
  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** @returns {string[]} 出站消息文本（stdout 上的每一帧） */
  outboundTexts() {
    return this.outbound.map((record) => record.text);
  }

  /** @returns {string[]} 入站消息文本 */
  inboundTexts() {
    return this.inbound.map((record) => record.text);
  }
}

/** 上游退出信息缓存（按 transport 实例）。 */
const exitRecords = new WeakMap();

/**
 * 若上游传输背后是 ChildProcess，则监听其 exit，记录退出码/信号。
 * @param {any} transport
 * @returns {boolean} 是否成功挂上监听
 */
export function attachUpstreamExitTracking(transport) {
  const proc = transport?._process;
  if (!proc || typeof proc.once !== 'function') return false;
  proc.once('exit', (code, signal) => {
    exitRecords.set(transport, {
      pid: typeof proc.pid === 'number' ? proc.pid : null,
      exit_code: typeof code === 'number' ? code : null,
      signal_code: signal ?? null,
      source: 'child_process.exit',
    });
  });
  return true;
}

/**
 * 尽力获取上游进程/退出信息（缺失时显式 null，不猜测）。
 * @param {any} transport
 * @returns {{pid: number|null, exit_code: number|null, signal_code: string|null, source: string}}
 */
export function upstreamExitInfo(transport) {
  if (!transport) return { pid: null, exit_code: null, signal_code: null, source: 'none' };

  const recorded = exitRecords.get(transport);
  if (recorded) return recorded;

  if (typeof transport.exitInfo === 'function') {
    const info = transport.exitInfo() ?? {};
    return {
      pid: info.pid ?? null,
      exit_code: info.exit_code ?? info.exitCode ?? null,
      signal_code: info.signal_code ?? info.signalCode ?? null,
      source: 'transport.exitInfo',
    };
  }

  const proc = transport._process;
  if (proc && typeof proc === 'object') {
    return {
      pid: typeof proc.pid === 'number' ? proc.pid : null,
      exit_code: typeof proc.exitCode === 'number' ? proc.exitCode : null,
      signal_code: proc.signalCode ?? null,
      source: 'child_process',
    };
  }

  if (typeof transport.pid === 'number') {
    return { pid: transport.pid, exit_code: null, signal_code: null, source: 'transport.pid' };
  }

  return { pid: null, exit_code: null, signal_code: null, source: 'none' };
}

/**
 * 默认上游传输：spawn 子进程并通过管道说 stdio MCP。
 *
 * stderr 处理（t13 加固）：
 *   - 采集开启（默认）→ `stderr: 'pipe'`，由 `UpstreamStderrCapture` 持续落盘并保留有界尾部；
 *     **必须在 `start()` 之前挂上 `transport.stderr`**，否则会漏掉早期输出；
 *   - 采集关闭（`--no-upstream-stderr` / `TRACE_UPSTREAM_STDERR=0`）→ `stderr: 'inherit'`，
 *     保持加固前行为（上游 stderr 直接进网关 stderr，不建文件）。
 *
 * 无论哪种模式，**stdout 始终只承载 MCP 协议帧**，stderr 采集不影响协议链路。
 * @param {Record<string, any>} config
 * @returns {Transport}
 */
export function createStdioUpstreamTransport(config) {
  const captureEnabled = config?.upstreamStderrDisabled !== true;
  const options = {
    command: config.upstreamCommand,
    args: config.upstreamArgs ?? [],
    stderr: /** @type {any} */ (captureEnabled ? 'pipe' : 'inherit'),
  };
  if (config.upstreamCwd) options.cwd = config.upstreamCwd;
  if (config.upstreamEnv && typeof config.upstreamEnv === 'object') {
    // t49：**为什么要在这里显式叠加**——MCP SDK 的 stdio 客户端只继承 12 个白名单环境变量
    // （`getDefaultEnvironment()`，win32 分支：APPDATA/HOMEDRIVE/HOMEPATH/LOCALAPPDATA/PATH/
    //  PROCESSOR_ARCHITECTURE/SYSTEMDRIVE/SYSTEMROOT/TEMP/USERNAME/USERPROFILE/PROGRAMFILES）。
    // 其余变量（含 `GOOGLE_OAUTH_CLIENT_ID` / `GOOGLE_OAUTH_CLIENT_SECRET`）**会被丢弃**，
    // 所以「在启动终端里 set 一下」永远到不了上游子进程 —— 这正是真实事故里
    // 「都配好了却还是 OAuth client credentials not found」的根因。
    // 正规路径是清单里的 `env`（`${VAR}` 引用）或 `envFromFile`（从文件读），
    // 由 manifest.js 解析成 `config.upstreamEnv` 后在这里叠加到白名单之上。
    // 秘密纪律：只传值，不打印、不落库；事件里的上游描述符只记 command/args/cwd。
    options.env = { ...getDefaultEnvironment(), ...config.upstreamEnv };
  }
  return /** @type {Transport} */ (/** @type {unknown} */ (new StdioClientTransport(options)));
}

/** @returns {string} 传输可读描述（用于 stderr 与事件摘要） */
export function describeUpstreamTransport(transport) {
  if (!transport) return '(none)';
  const info = upstreamExitInfo(transport);
  return `pid=${info.pid ?? 'n/a'} source=${info.source}`;
}

/**
 * t29：**远端 Streamable HTTP** 上游传输（Gateway 作为 MCP 客户端连远端服务，而非 spawn 子进程）。
 *
 * 用途：Google Workspace 官方 MCP 等**远程 HTTP 服务**只能这样接入。
 * 密钥纪律：`config.upstreamHeaders` 是从清单解析出来的**真实取值**（含 Authorization 令牌）；
 * 它只交给传输层发请求，**绝不**进入事件/日志（生命周期事件用 `upstreamDescriptor()` 的红acted 描述）。
 *
 * @param {Record<string, any>} config
 * @returns {Transport}
 */
export function createStreamableHttpUpstreamTransport(config) {
  const url = config?.upstreamUrl;
  if (typeof url !== 'string' || url === '') {
    throw new TypeError('streamable-http 上游需要 config.upstreamUrl');
  }
  /** @type {Record<string, any>} */
  const options = { fetch: discoveryFetch() };
  const headers = config?.upstreamHeaders;
  if (headers && typeof headers === 'object' && Object.keys(headers).length > 0) {
    options.requestInit = { headers: { ...headers } };
  }
  return /** @type {Transport} */ (
    /** @type {unknown} */ (new StreamableHTTPClientTransport(new URL(url), /** @type {any} */ (options)))
  );
}

/**
 * t29：把上游描述成**可入库的脱敏对象**（生命周期事件用）。
 *
 * - `stdio`：沿用加固前的字段（`upstream_command` / `upstream_args` / `upstream_cwd`），行为完全不变；
 * - `streamable-http`：只记录 **origin（scheme+host+port）**、**路径是否含 env 引用** 与 **头名列表**；
 *   URL 里出现 `${...}`（含令牌）时整体记为 `<redacted>`；头的**值在任何情况下都不写**。
 *
 * @param {Record<string, any>} config
 * @returns {Record<string, unknown>}
 */
export function upstreamDescriptor(config) {
  if (config?.upstreamUrl) {
    /** @type {Record<string, unknown>} */
    const detail = { upstream_transport: 'streamable-http' };
    try {
      const parsed = new URL(String(config.upstreamUrl));
      detail.upstream_url_origin = parsed.origin;
      detail.upstream_url_path = parsed.pathname;
    } catch {
      detail.upstream_url_origin = '<unparsable-url>';
    }
    if (config.upstreamUrlContainsEnvRef === true) {
      detail.upstream_url_origin = '<redacted>';
      detail.upstream_url_path = '<redacted>';
    }
    const headerNames = config.upstreamHeaders && typeof config.upstreamHeaders === 'object'
      ? Object.keys(config.upstreamHeaders).sort()
      : [];
    detail.upstream_header_names = headerNames;
    if (headerNames.length > 0) detail.upstream_header_values = '<redacted>';
    return detail;
  }
  return {
    upstream_command: config?.upstreamCommand,
    upstream_args: config?.upstreamArgs,
    upstream_cwd: config?.upstreamCwd ?? null,
  };
}
