/**
 * src/gateway/upstream_stderr.js — 上游子进程 stderr 采集与有界尾部缓冲（S1 后续加固：t13 + t16）
 *
 * 背景：网关此前完全丢弃上游 stderr（`demo-data/demo/gateway-gw-mail.stderr.log` 实测 0 字节），
 * 而上游的崩溃/启动失败/EPERM 诊断本来都写在 stderr 上，导致排障时几乎没有信息。
 *
 * 本模块只做**可观测性**，不改协议语义、不改已有事件字段语义：
 *   1. 持续附加写入 `<path>`（UTF-8，逐块 `writeSync`，行序与到达顺序一致）；
 *   2. 内存保留最近 `tailBytes`（默认 64 KiB）的有界尾部，供生命周期事件附带证据；
 *   3. 事件里的 tail 先做**密钥脱敏**（`TOKEN=…`/`PASSWORD: …` → `***`）；
 *      落盘文件保留原始内容（文件是诊断用途，见 相关实现 的差异说明）；
 *   4. **t16：延迟创建**——只有收到**非空** stderr 数据时才创建文件；
 *      静默上游（启动即失败、或全程不输出）**不会**留下 0 字节文件。
 *      此时事件仍给出**预期路径** `upstream_stderr_path`，并显式标注
 *      `upstream_stderr_created=false`（文件不存在 ≠ 存在但为空）。
 *   5. **t22：绝不留下 0 字节文件**——即便「文件已创建、首次写入失败」这个失败窗口被踩中，
 *      也会立刻（并在 `close()` 时兜底）删掉这个空文件；`upstream_stderr_file_error` 仍如实进事件，
 *      诊断不丢。即不变量：**该路径要么不存在，要么大小 > 0**。
 *
 * 边界：上游把日志写到 **stdout** 的情况仍不可辨识（SDK ReadBuffer 静默丢弃非法行），
 * 不属本模块范围，见 相关实现。
 */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { StringDecoder } from 'node:string_decoder';

/** 内存尾部缓冲上限（字节）。 */
export const DEFAULT_TAIL_BYTES = 64 * 1024;
/** 单个事件 summary 里附带的 tail 上限（字节）——避免事件行被撑大。 */
export const DEFAULT_EVENT_TAIL_BYTES = 8 * 1024;
/** 默认日志目录（仓库相对，可用 --upstream-stderr 覆盖）。 */
export const DEFAULT_LOG_DIR = 'demo-data/logs';

/**
 * 疑似「键名 + 赋值」形式的密钥（只匹配键名里含 TOKEN/SECRET/PASSWORD/KEY 的形态）。
 * 例：`TOKEN=abc`、`api_key: xyz`、`MY_PASSWORD = p`。
 */
export const SECRET_PATTERN =
  /([A-Za-z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|APIKEY|API_KEY|ACCESS_KEY|PRIVATE_KEY)[A-Za-z0-9_]*)(\s*[=:]\s*)(\S+)/gi;

/**
 * 事件 summary 用的脱敏：只替换赋值右侧，保留键名与分隔符。
 * @param {string} text
 * @returns {{text: string, redacted: boolean}}
 */
export function redactSecrets(text) {
  let redacted = false;
  const output = String(text).replace(SECRET_PATTERN, (_match, key, separator) => {
    redacted = true;
    return `${key}${separator}***`;
  });
  return { text: output, redacted };
}

/**
 * 默认日志路径：`demo-data/logs/<gateway_id>.upstream.stderr.log`。
 * @param {string | null | undefined} gatewayId
 * @returns {string} 仓库相对（POSIX）路径
 */
export function defaultUpstreamStderrPath(gatewayId) {
  const safe = String(gatewayId ?? 'gateway').replace(/[^A-Za-z0-9._-]/g, '_');
  return `${DEFAULT_LOG_DIR}/${safe}.upstream.stderr.log`;
}

/**
 * @param {unknown} value
 * @returns {boolean | null} 宽松布尔（不识别返回 null）
 */
function parseLooseBoolean(value) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const lowered = value.trim().toLowerCase();
    if (['1', 'true', 'yes', 'on', 'enabled'].includes(lowered)) return true;
    if (['0', 'false', 'no', 'off', 'disabled', ''].includes(lowered)) return false;
  }
  return null;
}

/**
 * 解析上游 stderr 采集目标。
 *
 * 优先级：`--no-upstream-stderr` > `--upstream-stderr <path>` > `TRACE_UPSTREAM_STDERR`
 * （`0/false/off` 关闭；`1/true` 用默认路径；其它值当作路径）> 默认路径。
 *
 * @param {{config?: Record<string, any>, gatewayId?: string, env?: Record<string, string | undefined>}} [options]
 * @returns {{enabled: boolean, path: string | null, source: 'flag'|'explicit'|'env'|'env-path'|'default', reason: string | null}}
 */
export function resolveUpstreamStderr(options = {}) {
  const config = options.config ?? {};
  const env = options.env ?? process.env;
  const gatewayId = config.gatewayId ?? options.gatewayId;

  if (config.upstreamStderrDisabled === true) {
    return { enabled: false, path: null, source: 'flag', reason: '--no-upstream-stderr' };
  }

  const explicit = typeof config.upstreamStderr === 'string' ? config.upstreamStderr.trim() : '';
  if (explicit !== '' && explicit !== '0') {
    return {
      enabled: true,
      path: path.isAbsolute(explicit) ? explicit : path.resolve(process.cwd(), explicit),
      source: 'explicit',
      reason: null,
    };
  }
  if (explicit === '0') {
    return { enabled: false, path: null, source: 'explicit', reason: '--upstream-stderr 0' };
  }

  const envRaw = env.TRACE_UPSTREAM_STDERR;
  if (typeof envRaw === 'string' && envRaw.trim() !== '') {
    const asBoolean = parseLooseBoolean(envRaw);
    if (asBoolean === false) {
      return { enabled: false, path: null, source: 'env', reason: 'TRACE_UPSTREAM_STDERR=0' };
    }
    if (asBoolean === null) {
      const asPath = envRaw.trim();
      return {
        enabled: true,
        path: path.isAbsolute(asPath) ? asPath : path.resolve(process.cwd(), asPath),
        source: 'env-path',
        reason: null,
      };
    }
    // asBoolean === true → 走默认路径
  }

  return {
    enabled: true,
    path: path.resolve(process.cwd(), defaultUpstreamStderrPath(gatewayId)),
    source: 'default',
    reason: null,
  };
}

/**
 * 上游 stderr 采集器：文件（原始）+ 有界尾部（脱敏后进事件）。
 */
export class UpstreamStderrCapture {
  /**
   * @param {{filePath?: string | null, tailBytes?: number, eventTailBytes?: number,
   *   logger?: (message: string) => void, enabled?: boolean}} [options]
   */
  constructor(options = {}) {
    this.enabled = options.enabled !== false;
    this.filePath = options.filePath ?? null;
    this.tailBytes = Number.isFinite(options.tailBytes) ? Number(options.tailBytes) : DEFAULT_TAIL_BYTES;
    this.eventTailBytes = Number.isFinite(options.eventTailBytes)
      ? Number(options.eventTailBytes)
      : DEFAULT_EVENT_TAIL_BYTES;
    this.logger = typeof options.logger === 'function' ? options.logger : (message) => process.stderr.write(`${message}\n`);

    /** @type {number | null} */
    this._fd = null;
    this._decoder = new StringDecoder('utf8');
    this._tail = '';
    this._bytes = 0;
    this._lines = 0;
    this._fileError = null;
    this._attached = null;
    this._closed = false;
    /** t16：只有真正收到非空 stderr 并落盘后才为 true（静默上游保持 false 且不建文件）。 */
    this._created = false;
    /** t22：该文件是不是**本次运行**新建的（用于「绝不留下 0 字节文件」的兜底清理）。 */
    this._createdByUs = false;
  }

  /** 累计写入的字节数（上游 stderr 的字节数，不是网关自身的）。 */
  get bytes() {
    return this._bytes;
  }

  /** 累计行数（按 `\n` 计）。 */
  get lines() {
    return this._lines;
  }

  /** 当前内存尾部（未脱敏；仅内部/测试使用）。 */
  get tail() {
    return this._tail;
  }

  /** 文件写入失败原因（null 表示正常）。 */
  get fileError() {
    return this._fileError;
  }

  /** 是否已挂上上游 stderr 流。 */
  get attached() {
    return this._attached !== null;
  }

  /** 本次运行是否真的创建/写入过日志文件（t16：静默上游不建文件）。 */
  get created() {
    return this._created;
  }

  /**
   * 准备采集（t16 起**不创建文件**）。
   *
   * 延迟创建：只有真正收到非空 stderr 数据时才 `mkdirSync` + `openSync(..., 'a')`。
   * 这样静默上游（例如启动即失败、或全程不输出）不会在 `demo-data/logs/` 留下 0 字节文件；
   * 同时保留了「首次非空写入」之前的全部内存尾部缓冲，诊断能力不退化。
   *
   * 并发/竞态：创建与写入都在同一个同步 `push()` 调用里完成（Node 单线程、无 await 打断），
   * 跨进程时 `openSync(path, 'a')` 是 O_CREAT|O_APPEND 的原子操作，两个进程同时创建也只会
   * 得到一个文件、各自持有独立追加句柄（与 t13 的追加语义一致，不做临时文件改名）。
   *
   * @returns {UpstreamStderrCapture}
   */
  open() {
    return this;
  }

  /**
   * 首次非空写入时创建目录与文件（失败只告警，内存尾部继续可用）。
   * @returns {boolean} 是否可写
   */
  _ensureFile() {
    if (!this.enabled || this.filePath === null) return false;
    if (this._fd !== null) return true;
    if (this._fileError !== null) return false;
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      // 记录「本次是否由我们新建」：只有新建的文件才允许在「没写进任何字节」时兜底删除，
      // 避免误删并发进程正在追加的文件。
      const existedBefore = fs.existsSync(this.filePath);
      this._fd = fs.openSync(this.filePath, 'a');
      this._created = true;
      this._createdByUs = !existedBefore;
      return true;
    } catch (error) {
      this._fileError = error instanceof Error ? error.message : String(error);
      this.logger(
        `[gateway][upstream-stderr] 无法创建/打开日志文件 ${this.filePath}：${this._fileError}（仅保留内存尾部缓冲）`,
      );
      return false;
    }
  }

  /**
   * t22：删除「由本次运行新建、且一个字节都没写进去」的空文件。
   *
   * 为什么需要：文件创建与写入之间仍有一个失败窗口（磁盘满、句柄失效等）。若首次 `writeSync`
   * 失败，就会留下一个 0 字节文件——那正是 t16/t22 契约要消灭的用户可感知垃圾。这里把它兜底删掉，
   * 让「0 字节日志文件」在任何分支下都不可能留存；`_file_error` 仍会进事件，诊断不丢。
   *
   * 安全的边界：仅在 `_createdByUs === true`（文件是本次新建的）**且**当前大小为 0 时才删除；
   * 并发进程若也打开了该文件并写入，则大小不为 0，不会被删；若不是我们新建的，一律不碰。
   *
   * @returns {boolean} 是否删除成功
   */
  _discardEmptyFileIfOurs() {
    if (!this._createdByUs || this.filePath === null) return false;
    try {
      if (fs.statSync(this.filePath).size !== 0) return false;
      fs.unlinkSync(this.filePath);
      this._created = false;
      this._createdByUs = false;
      return true;
    } catch {
      return false;
    }
  }

  /**
   * 挂载上游 stderr 流（在 `connect()`/spawn **之前**调用，避免漏掉早期输出）。
   * @param {{on?: Function}} stream
   * @returns {boolean}
   */
  attach(stream) {
    if (!this.enabled) return false;
    if (!stream || typeof stream.on !== 'function') return false;
    if (this._attached !== null) return true;
    this._attached = stream;
    stream.on('data', (chunk) => this.push(typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk));
    // 上游 stderr 流自身出错只记录，不影响协议链路
    if (typeof stream.on === 'function') {
      stream.on('error', (error) => {
        this.logger(`[gateway][upstream-stderr] stderr 流错误：${error instanceof Error ? error.message : String(error)}`);
      });
    }
    return true;
  }

  /**
   * 接收一块 stderr 数据：**非空**数据才落盘（首次写入时才创建文件）+ 有界尾部。
   * @param {Buffer | string} chunk
   */
  push(chunk) {
    if (!this.enabled) return;
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8');
    if (buffer.length === 0) return;
    this._bytes += buffer.length;
    this._lines += countNewlines(buffer);

    if (this._ensureFile() && this._fd !== null) {
      try {
        fs.writeSync(this._fd, buffer);
      } catch (error) {
        this._fileError = error instanceof Error ? error.message : String(error);
        this.logger(`[gateway][upstream-stderr] 写入 ${this.filePath} 失败：${this._fileError}（后续仅保留内存尾部缓冲）`);
        try {
          fs.closeSync(this._fd);
        } catch {
          /* 忽略 */
        }
        this._fd = null;
        // t22：若刚才这个失败是「首次写入」，文件还是 0 字节 → 立刻删掉，绝不留空文件垃圾。
        this._discardEmptyFileIfOurs();
      }
    }

    this._tail += this._decoder.write(buffer);
    this._trimTail();
  }

  /** 把尾部裁剪到 <= tailBytes，尽量从行边界开始。 */
  _trimTail() {
    const size = Buffer.byteLength(this._tail, 'utf8');
    if (size <= this.tailBytes) return;
    const buffer = Buffer.from(this._tail, 'utf8');
    let text = buffer.subarray(buffer.length - this.tailBytes).toString('utf8');
    const newline = text.indexOf('\n');
    if (newline >= 0 && newline < 512) text = text.slice(newline + 1);
    // 丢掉可能被切断的首个不完整字符（U+FFFD）
    if (text.startsWith('\uFFFD')) text = text.slice(1);
    this._tail = text;
  }

  /**
   * 生成事件 summary 附加字段。
   *
   * 路径字段语义（t16，必须在文档中如实说明）：
   *   - `upstream_stderr_path` 是**预期/实际路径**，始终给出（便于知道该去哪里找）；
   *   - `upstream_stderr_created` 表示**本次运行是否真的创建/写入过该文件**：
   *     静默上游为 `false` —— 此时**文件不存在**，不要把它当成「存在但为空」。
   *
   * @param {{includeTail?: boolean, eventTailBytes?: number}} [options]
   * @returns {Record<string, unknown>} 关闭时返回空对象（事件里**不出现**这些字段）
   */
  summary(options = {}) {
    if (!this.enabled || this.filePath === null) return {};
    /** @type {Record<string, unknown>} */
    const summary = {
      upstream_stderr_path: this.filePath,
      upstream_stderr_created: this._created,
      upstream_stderr_bytes: this._bytes,
      upstream_stderr_lines: this._lines,
    };
    if (this._fileError !== null) summary.upstream_stderr_file_error = this._fileError;
    if (options.includeTail === true && this._tail !== '') {
      const limit = Number.isFinite(options.eventTailBytes) ? Number(options.eventTailBytes) : this.eventTailBytes;
      const raw = Buffer.from(this._tail, 'utf8');
      const clipped = raw.length > limit ? raw.subarray(raw.length - limit).toString('utf8') : this._tail;
      const { text, redacted } = redactSecrets(clipped);
      summary.upstream_stderr_tail = text;
      summary.upstream_stderr_tail_truncated = raw.length > limit;
      if (redacted) summary.upstream_stderr_redacted = true;
    }
    return summary;
  }

  /** 关闭文件句柄（幂等）。 */
  close() {
    if (this._closed) return;
    this._closed = true;
    if (this._fd !== null) {
      try {
        fs.closeSync(this._fd);
      } catch {
        /* 忽略 */
      }
      this._fd = null;
    }
    // t22 兜底：本次运行新建、但一个字节都没写进去的文件（例如首次写入失败）在收尾时清掉，
    // 使「0 字节日志文件」在任何分支下都不可能留存。文件已有关闭后再删（Windows 需先释放句柄）。
    this._discardEmptyFileIfOurs();
  }
}

/**
 * @param {Buffer} buffer
 * @returns {number}
 */
function countNewlines(buffer) {
  let count = 0;
  for (const byte of buffer) if (byte === 0x0a) count += 1;
  return count;
}
