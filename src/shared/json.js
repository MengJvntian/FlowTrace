/**
 * src/shared/json.js — JSON 解析、载荷归一化、截断与摘要提取（F1）
 *
 * 契约（相关实现）：
 *   1. 载荷超过 `maxBytes`（默认 256 KiB，Gateway 用 --max-payload-bytes 覆盖）时**不丢事件**：
 *      只存「截断信封 + 结构摘要 + 原始字节数 + sha256 摘要」，并用 truncated=1 标记；
 *   2. 内容块（MCP content blocks）逐块提取 `type / size_bytes / summary`；
 *   3. 工具结果的 `structuredContent` 与文本内容**分别保留**，不相互覆盖、不互相推断。
 */
import { createHash } from 'node:crypto';
import { DEFAULT_MAX_PAYLOAD_BYTES } from './schemaversion.js';

export const PREVIEW_BYTES = 512;
export const DEFAULT_SUMMARY_OPTIONS = Object.freeze({
  maxDepth: 4,
  maxKeys: 50,
  maxArrayItems: 5,
  maxStringLength: 160,
});

/**
 * @param {unknown} text
 * @returns {{ok: true, value: unknown} | {ok: false, error: string, value: undefined}}
 */
export function parseJsonSafe(text) {
  if (typeof text !== 'string') return { ok: false, error: 'not-a-string', value: undefined };
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error), value: undefined };
  }
}

/**
 * codepoint 安全截断（不产生孤立代理项）。
 * @param {string} value
 * @param {number} max
 * @returns {string}
 */
export function truncateString(value, max) {
  if (value.length <= max) return value;
  let cut = value.slice(0, max);
  const last = cut.charCodeAt(cut.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1);
  return `${cut}…`;
}

/**
 * 确定性 JSON 序列化（对象键排序；循环引用/深度/非 JSON 值有显式标记）。
 * 注意：这是**存储与比较**用的规范化形式，不保证与上游原始字节一致；
 * 「透明性对照」必须使用原始字节，不能使用本函数结果。
 * @param {unknown} value
 * @param {{maxDepth?: number}} [options]
 * @returns {string}
 */
export function stableStringify(value, options = {}) {
  const maxDepth = Number.isInteger(options.maxDepth) ? options.maxDepth : 64;
  const seen = new WeakSet();

  /**
   * @param {unknown} node
   * @param {number} depth
   * @returns {unknown}
   */
  function normalize(node, depth) {
    if (node === null) return null;
    const t = typeof node;
    if (t === 'string' || t === 'boolean') return node;
    if (t === 'number') return Number.isFinite(node) ? node : null;
    if (t === 'bigint') return `${node.toString()}n`;
    if (t === 'undefined' || t === 'function' || t === 'symbol') return undefined;
    if (node instanceof Date) return node.toISOString();
    if (depth >= maxDepth) return '[MaxDepth]';
    if (Array.isArray(node)) {
      if (seen.has(node)) return '[Circular]';
      seen.add(node);
      const out = node.map((item) => {
        const normalized = normalize(item, depth + 1);
        return normalized === undefined ? null : normalized;
      });
      seen.delete(node);
      return out;
    }
    if (t === 'object') {
      if (seen.has(node)) return '[Circular]';
      seen.add(node);
      const source = /** @type {Record<string, unknown>} */ (node);
      const out = {};
      for (const key of Object.keys(source).sort()) {
        let normalized;
        try {
          normalized = normalize(source[key], depth + 1);
        } catch (error) {
          normalized = `[GetterThrew: ${error instanceof Error ? error.message : String(error)}]`;
        }
        if (normalized !== undefined) out[key] = normalized;
      }
      seen.delete(node);
      return out;
    }
    return `[Unsupported:${t}]`;
  }

  return JSON.stringify(normalize(value, 0));
}

/**
 * 载荷字节数：字符串按 UTF-8 计；其他值按 stableStringify 结果计。
 * @param {unknown} value
 * @returns {number}
 */
export function byteLength(value) {
  const text = typeof value === 'string' ? value : stableStringify(value);
  return Buffer.byteLength(text === undefined ? '' : text, 'utf8');
}

/**
 * @param {string | unknown} value 字符串直接哈希；其他值先 stableStringify
 * @returns {string} `sha256:<64 位十六进制>`
 */
export function digestOf(value) {
  const text = typeof value === 'string' ? value : stableStringify(value);
  return `sha256:${createHash('sha256').update(text, 'utf8').digest('hex')}`;
}

/**
 * 结构摘要：类型、键集合、数组长度、字符串长度与预览；有深度/数量上限。
 * @param {unknown} value
 * @param {Partial<typeof DEFAULT_SUMMARY_OPTIONS>} [options]
 * @returns {Record<string, unknown>}
 */
export function summarize(value, options = {}) {
  const opts = { ...DEFAULT_SUMMARY_OPTIONS, ...options };

  /**
   * @param {unknown} node
   * @param {number} depth
   * @returns {Record<string, unknown>}
   */
  function walk(node, depth) {
    if (node === null) return { type: 'null' };
    const t = typeof node;
    if (t === 'string') {
      return { type: 'string', length: node.length, preview: truncateString(node, opts.maxStringLength) };
    }
    if (t === 'number' || t === 'boolean') return { type: t, value: node };
    if (t === 'bigint') return { type: 'bigint', value: node.toString() };
    if (t === 'undefined') return { type: 'undefined' };
    if (t === 'function' || t === 'symbol') return { type: t };
    if (node instanceof Date) return { type: 'date', value: node.toISOString() };
    if (depth >= opts.maxDepth) {
      return { type: Array.isArray(node) ? 'array' : 'object', depth_truncated: true };
    }
    if (Array.isArray(node)) {
      return {
        type: 'array',
        length: node.length,
        items: node.slice(0, opts.maxArrayItems).map((item) => walk(item, depth + 1)),
      };
    }
    const source = /** @type {Record<string, unknown>} */ (node);
    const keys = Object.keys(source);
    /** @type {Record<string, unknown>} */
    const children = {};
    for (const key of keys.slice(0, opts.maxKeys)) {
      try {
        children[key] = walk(source[key], depth + 1);
      } catch (error) {
        children[key] = { type: 'getter_threw', message: error instanceof Error ? error.message : String(error) };
      }
    }
    return { type: 'object', key_count: keys.length, keys: keys.slice(0, opts.maxKeys), children };
  }

  return walk(value, 0);
}

/**
 * 内容块摘要（MCP content block → type / size_bytes / summary）。
 * 支持 text / image / audio / resource / resource_link / embedded resource 及未知类型。
 * @param {unknown} block
 * @returns {{type: string, size_bytes: number, summary: string, mime_type?: string, uri?: string, truncated?: boolean}}
 */
export function contentBlockSummary(block) {
  if (block === null || typeof block !== 'object') {
    return { type: 'invalid', size_bytes: 0, summary: `非对象内容块: ${JSON.stringify(block)}` };
  }
  const b = /** @type {Record<string, any>} */ (block);
  const type = typeof b.type === 'string' ? b.type : 'unknown';
  switch (type) {
    case 'text': {
      const text = typeof b.text === 'string' ? b.text : '';
      return {
        type,
        size_bytes: Buffer.byteLength(text, 'utf8'),
        summary: truncateString(text, DEFAULT_SUMMARY_OPTIONS.maxStringLength),
      };
    }
    case 'image':
    case 'audio': {
      const data = typeof b.data === 'string' ? b.data : '';
      const mimeType = typeof b.mimeType === 'string' ? b.mimeType : 'application/octet-stream';
      return {
        type,
        size_bytes: Buffer.byteLength(data, 'utf8'),
        mime_type: mimeType,
        summary: `${mimeType} base64_chars=${data.length}`,
      };
    }
    case 'resource': {
      const resource = b.resource && typeof b.resource === 'object' ? b.resource : {};
      const text = typeof resource.text === 'string' ? resource.text : '';
      const blob = typeof resource.blob === 'string' ? resource.blob : '';
      const blockOut = {
        type,
        size_bytes: text ? Buffer.byteLength(text, 'utf8') : Buffer.byteLength(blob, 'utf8'),
        summary: text
          ? truncateString(text, DEFAULT_SUMMARY_OPTIONS.maxStringLength)
          : `resource(blob) chars=${blob.length}`,
      };
      if (typeof resource.uri === 'string') blockOut.uri = resource.uri;
      if (typeof resource.mimeType === 'string') blockOut.mime_type = resource.mimeType;
      return blockOut;
    }
    case 'resource_link': {
      const out = {
        type,
        size_bytes: 0,
        summary: `resource_link name=${b.name ?? '(none)'}`,
      };
      if (typeof b.uri === 'string') out.uri = b.uri;
      if (typeof b.mimeType === 'string') out.mime_type = b.mimeType;
      return out;
    }
    default: {
      const serialized = stableStringify(b);
      return {
        type,
        size_bytes: Buffer.byteLength(serialized, 'utf8'),
        summary: truncateString(serialized, DEFAULT_SUMMARY_OPTIONS.maxStringLength),
      };
    }
  }
}

/**
 * 从工具结果/载荷中提取内容块列表（接受 {content:[...]}、数组或单块）。
 * @param {unknown} payload
 * @returns {Array<ReturnType<typeof contentBlockSummary>>}
 */
export function extractContentBlocks(payload) {
  if (payload === null || typeof payload !== 'object') return [];
  if (Array.isArray(payload)) return payload.map(contentBlockSummary);
  const content = /** @type {Record<string, unknown>} */ (payload).content;
  if (Array.isArray(content)) return content.map(contentBlockSummary);
  if (content && typeof content === 'object') return [contentBlockSummary(content)];
  return [];
}

/**
 * 提取文本内容（仅 text 块拼接；不含 structuredContent）。
 * @param {unknown} payload
 * @returns {string}
 */
export function extractText(payload) {
  if (payload === null || typeof payload !== 'object') return '';
  const content = /** @type {Record<string, any>} */ (payload).content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((block) => block && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n');
}

/**
 * 载荷归一化 + 大小上限截断（保留摘要）。
 * @param {unknown} value
 * @param {{maxBytes?: number, previewBytes?: number, kind?: 'json'|'text', summaryOptions?: object}} [options]
 * @returns {{
 *   json: string | null,
 *   truncated: boolean,
 *   byte_size: number,
 *   stored_byte_size: number,
 *   original_byte_size: number,
 *   digest: string,
 *   summary: Record<string, unknown> | null,
 *   kind: 'json' | 'text' | 'empty'
 * }}
 */
export function normalizePayload(value, options = {}) {
  const maxBytes = Number.isFinite(options.maxBytes) ? Number(options.maxBytes) : DEFAULT_MAX_PAYLOAD_BYTES;
  const previewBytes = Number.isFinite(options.previewBytes) ? Number(options.previewBytes) : PREVIEW_BYTES;
  const kind = options.kind === 'text' || typeof value === 'string' ? 'text' : 'json';

  if (value === undefined || value === null) {
    return {
      json: null,
      truncated: false,
      byte_size: 0,
      stored_byte_size: 0,
      original_byte_size: 0,
      digest: digestOf(''),
      summary: null,
      kind: 'empty',
    };
  }

  const serialized = typeof value === 'string' ? value : stableStringify(value);
  const originalByteSize = Buffer.byteLength(serialized, 'utf8');
  const digest = digestOf(serialized);

  if (originalByteSize <= maxBytes) {
    return {
      json: serialized,
      truncated: false,
      byte_size: originalByteSize,
      stored_byte_size: originalByteSize,
      original_byte_size: originalByteSize,
      digest,
      summary: kind === 'json' ? summarize(value, options.summaryOptions) : null,
      kind,
    };
  }

  const summary = kind === 'json' ? summarize(value, options.summaryOptions) : { type: 'string', length: serialized.length };
  const envelope = {
    __truncated__: true,
    reason: `payload larger than max_bytes (${originalByteSize} > ${maxBytes})`,
    kind,
    original_byte_size: originalByteSize,
    max_bytes: maxBytes,
    digest,
    summary,
    preview: truncateString(serialized, previewBytes),
  };
  const envelopeJson = stableStringify(envelope);
  return {
    json: envelopeJson,
    truncated: true,
    byte_size: originalByteSize,
    stored_byte_size: Buffer.byteLength(envelopeJson, 'utf8'),
    original_byte_size: originalByteSize,
    digest,
    summary: /** @type {Record<string, unknown>} */ (summary),
    kind,
  };
}

/**
 * 工具结果归一化：**structuredContent 与文本分别保留**。
 * @param {unknown} result 形如 {content:[...], structuredContent:{...}, isError?:boolean}
 * @param {{maxBytes?: number, summaryOptions?: object}} [options]
 * @returns {{
 *   json: string | null,
 *   truncated: boolean,
 *   byte_size: number,
 *   stored_byte_size: number,
 *   original_byte_size: number,
 *   digest: string,
 *   summary: Record<string, unknown> | null,
 *   text: string,
 *   text_byte_size: number,
 *   structured_content: string | null,
 *   structured_content_byte_size: number,
 *   content_blocks: Array<Record<string, unknown>>,
 *   is_error: boolean
 * }}
 */
export function normalizeToolResult(result, options = {}) {
  const payload = normalizePayload(result, options);
  const text = extractText(result);
  const hasStructured =
    result !== null && typeof result === 'object' && /** @type {any} */ (result).structuredContent !== undefined;
  const structuredContent = hasStructured
    ? stableStringify(/** @type {any} */ (result).structuredContent)
    : null;
  const contentBlocks =
    result !== null && typeof result === 'object' && Array.isArray(/** @type {any} */ (result).content)
      ? /** @type {any} */ (result).content.map(contentBlockSummary)
      : [];
  return {
    ...payload,
    text,
    text_byte_size: Buffer.byteLength(text, 'utf8'),
    structured_content: structuredContent,
    structured_content_byte_size: structuredContent === null ? 0 : Buffer.byteLength(structuredContent, 'utf8'),
    content_blocks: contentBlocks,
    is_error:
      result !== null && typeof result === 'object' && /** @type {any} */ (result).isError === true,
  };
}
