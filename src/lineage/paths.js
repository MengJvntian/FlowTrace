/**
 * src/lineage/paths.js — P2 JSON 路径提取与格式化（L1）
 *
 * 路径记法（相关实现）：
 *   - 对象键：`a.b`（键名符合 `/^[A-Za-z_$][A-Za-z0-9_$]*$/` 时用点号）；
 *     否则用 JSON 引号段：`a["k.with.dots"]`；
 *   - 数组元素：`a[0]`；
 *   - 根就是解析后的载荷：事件里的 `request_json` / `response_json` 是**原始 JSON-RPC 帧**
 *     （S1 实测：`{"jsonrpc":"2.0","id":…,"method":"tools/call","params":{"name":…,"arguments":{…}}}`），
 *     因此写侧字段路径形如 `params.arguments.title`，读侧形如 `result.structuredContent.title`；
 *   - 文本内容块里解析出的值不是 JSON 叶子，用**文本锚点**形式记录：
 *     `<内容块路径>#<类型>[<序号>]`，例如 `result.content[0].text#date[0]`。
 *     该形式不是合法 JSON 路径，用 `isTextAnchorPath()` 区分。
 */

/** 点号记法允许的键名。 */
export const BARE_KEY_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/** 逐叶子遍历时默认跳过的协议/控制键（记录在 相关实现）。 */
export const DEFAULT_SKIP_KEYS = Object.freeze([
  'jsonrpc',
  'id',
  '_meta',
  'isError',
  'nextCursor',
  'mock_inconsistent',
]);

/**
 * 单个路径段格式化。
 * @param {string | number} segment
 * @param {boolean} isFirst
 * @returns {string}
 */
export function formatSegment(segment, isFirst) {
  if (typeof segment === 'number') return `[${segment}]`;
  if (BARE_KEY_RE.test(segment)) return isFirst ? segment : `.${segment}`;
  return `[${JSON.stringify(segment)}]`;
}

/**
 * 段数组 → 路径字符串。
 * @param {Array<string|number>} segments
 * @returns {string}
 */
export function formatPath(segments) {
  let out = '';
  segments.forEach((segment, index) => {
    out += formatSegment(segment, index === 0 && typeof segment !== 'number');
  });
  return out;
}

/**
 * 路径字符串 → 段数组（与 formatPath 互逆）。
 * @param {string} path
 * @returns {Array<string|number>}
 */
export function parsePath(path) {
  if (typeof path !== 'string' || path === '') throw new TypeError('parsePath 需要非空路径字符串');
  /** @type {Array<string|number>} */
  const segments = [];
  let index = 0;
  while (index < path.length) {
    const char = path[index];
    if (char === '.') {
      index += 1;
      continue;
    }
    if (char === '[') {
      const close = path.indexOf(']', index);
      if (close === -1) throw new SyntaxError(`路径 ${JSON.stringify(path)} 的 [ 未闭合`);
      const inner = path.slice(index + 1, close);
      if (/^\d+$/u.test(inner)) segments.push(Number(inner));
      else if (inner.startsWith('"')) segments.push(JSON.parse(inner));
      else throw new SyntaxError(`路径 ${JSON.stringify(path)} 的段 ${JSON.stringify(inner)} 非法`);
      index = close + 1;
      continue;
    }
    // 裸键：读到 . 或 [
    let end = index;
    while (end < path.length && path[end] !== '.' && path[end] !== '[') end += 1;
    const key = path.slice(index, end);
    if (key === '') throw new SyntaxError(`路径 ${JSON.stringify(path)} 在位置 ${index} 处为空键`);
    segments.push(key);
    index = end;
  }
  if (segments.length === 0) throw new SyntaxError(`路径 ${JSON.stringify(path)} 未解析出任何段`);
  return segments;
}

/**
 * 文本锚点路径（内容块里的值）。
 * @param {string} blockPath
 * @param {string} kind date / time / datetime / phone / email / title / text
 * @param {number} index 同一块内同类型的序号
 * @returns {string}
 */
export function textAnchorPath(blockPath, kind, index) {
  return `${blockPath}#${kind}[${index}]`;
}

/**
 * @param {string} path
 * @returns {boolean}
 */
export function isTextAnchorPath(path) {
  return typeof path === 'string' && /#[a-z_]+\[\d+\]$/u.test(path);
}

/**
 * 文本锚点路径 → 内容块路径。
 * @param {string} path
 * @returns {string}
 */
export function textAnchorBlockPath(path) {
  const index = path.indexOf('#');
  return index === -1 ? path : path.slice(0, index);
}

/**
 * 逐叶子提取标量字段。
 * @param {*} payload
 * @param {{prefix?: string, skipKeys?: string[], maxDepth?: number}} [options]
 * @returns {{fields: Array<{path: string, value: *, json_type: string, leaf_key: string, depth: number}>, skipped_keys: string[], depth_truncated: boolean}}
 */
export function extractLeaves(payload, options = {}) {
  const prefix = options.prefix ?? '';
  const skipKeys = options.skipKeys ?? DEFAULT_SKIP_KEYS;
  const maxDepth = Number.isInteger(options.maxDepth) ? options.maxDepth : 8;
  const skip = new Set(skipKeys);
  /** @type {Array<{path: string, value: *, json_type: string, leaf_key: string, depth: number}>} */
  const fields = [];
  /** @type {Set<string>} */
  const skippedKeys = new Set();
  let depthTruncated = false;

  /**
   * @param {*} node
   * @param {Array<string|number>} segments
   * @param {number} depth
   */
  function walk(node, segments, depth) {
    if (node === null || node === undefined) return;
    const type = typeof node;
    const path = formatPath(segments);
    if (type === 'string' || type === 'number' || type === 'boolean') {
      fields.push({
        path,
        value: node,
        json_type: type,
        leaf_key: typeof segments[segments.length - 1] === 'string' ? String(segments[segments.length - 1]) : String(segments[segments.length - 1]),
        depth,
      });
      return;
    }
    if (type !== 'object') return;
    if (depth >= maxDepth) {
      depthTruncated = true;
      return;
    }
    if (Array.isArray(node)) {
      node.forEach((item, index) => walk(item, [...segments, index], depth + 1));
      return;
    }
    for (const [key, value] of Object.entries(node)) {
      if (skip.has(key)) {
        skippedKeys.add(key);
        continue;
      }
      walk(value, [...segments, key], depth + 1);
    }
  }

  const baseSegments = prefix === '' ? [] : parsePath(prefix);
  walk(payload, baseSegments, 0);
  return { fields, skipped_keys: [...skippedKeys], depth_truncated: depthTruncated };
}
