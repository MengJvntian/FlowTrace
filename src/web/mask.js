/**
 * src/web/mask.js — P3 展示层脱敏引擎（W1）
 *
 * 三层规则（相关实现 为人类可读唯一真源）：
 *
 * 1. **键名规则**：键名归一化后包含敏感词 → 该值按类别脱敏（手机号 / 邮箱）；
 *    包含密钥词 → 一律替换为 `<redacted:secret>`（原文永不进入响应）。
 * 2. **值模式规则**：任意字符串里出现的手机号 / 邮箱**无论键名**都被替换
 *    （例如手机号写在 `note` 或 `content[0].text` 里）。只对字符串生效，
 *    避免把 `monotonic_duration_ms` 这类长数字误判成手机号。
 * 3. **预览上限规则**：超过 `previewChars` 的字符串按字符截断并标记 `truncated`，
 *    截断只影响展示，不改动库内数据。
 *
 * 与 L1 `maskSensitiveResult()` 的关系：L1 的投影只按 `sensitive` /
 * `value_kind` 标记脱敏；本模块**更严格**——额外做值模式扫描与密钥键名扫描，
 * 并把手机号/邮箱的中文类别一并返回。两者都**只影响展示**，不改变任何血缘判定。
 *
 * 硬约束：本模块**只做替换，不补全、不推断、不重排**原始内容。
 */
import {
  maskValue as lineageMaskValue,
  SENSITIVE_LABELS,
} from '../lineage/index.js';

/** 脱敏模式。 */
export const MASK_MODE = Object.freeze({
  /** 默认：显示类别 + 脱敏值（手机号/邮箱），密钥显示占位符。 */
  CATEGORY_AND_MASKED_VALUE: 'category_and_masked_value',
  /** 受控查看原文（经审计的显式操作，见 audit.js）。 */
  CONTROLLED_RAW: 'controlled_raw',
});

/** 密钥占位符（原文不得出现在响应或页面里）。 */
export const SECRET_PLACEHOLDER = '<redacted:secret>';
/** 预览截断占位。 */
export const TRUNCATED_PLACEHOLDER = '<truncated:preview>';
/** 深度截断占位。 */
export const DEPTH_PLACEHOLDER = '<truncated:depth>';

/** 敏感类别（与 L1 的 SENSITIVE_SEMANTICS 对齐）。 */
export const SENSITIVE_KIND = Object.freeze({ PHONE: 'phone', EMAIL: 'email', SECRET: 'secret' });

export const SECRET_LABEL = '令牌/密钥';

/** 密钥词（键名归一化后做**子串**匹配；刻意不含 `key`/`auth`/`sig` 这类过宽词）。 */
const SECRET_WORDS = Object.freeze([
  'token',
  'secret',
  'password',
  'passwd',
  'pwd',
  'apikey',
  'authorization',
  'cookie',
  'credential',
  'bearer',
  'privatekey',
  'accesskey',
  'sessionid',
  'signature',
]);

/** 手机号词。 */
const PHONE_WORDS = Object.freeze(['phone', 'mobile', 'telephone', 'cellnumber', 'cellphone']);
/** 邮箱词。 */
const EMAIL_WORDS = Object.freeze(['email', 'e-mail', 'mail']);

/**
 * 键名归一化：去掉非字母数字（含 `_`、`-`、`.`、`[]`、空格）并小写。
 * `api_key` → `apikey`、`x-api-key` → `xapikey`、`clientSecret` → `clientsecret`。
 * @param {unknown} key
 * @returns {string}
 */
export function normalizeKey(key) {
  return String(key ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9\u3400-\u9fff]+/gu, '');
}

/**
 * 键名 → 敏感类别。
 * @param {unknown} key
 * @returns {{sensitive: string | null, secret: boolean, reason: string | null}}
 */
export function classifyKey(key) {
  const normalized = normalizeKey(key);
  if (normalized === '') return { sensitive: null, secret: false, reason: null };
  for (const word of SECRET_WORDS) {
    if (normalized.includes(word)) return { sensitive: null, secret: true, reason: `key_contains:${word}` };
  }
  for (const word of PHONE_WORDS) {
    if (normalized.includes(word)) return { sensitive: SENSITIVE_KIND.PHONE, secret: false, reason: `key_contains:${word}` };
  }
  for (const word of EMAIL_WORDS) {
    if (normalized.includes(word)) return { sensitive: SENSITIVE_KIND.EMAIL, secret: false, reason: `key_contains:${word}` };
  }
  return { sensitive: null, secret: false, reason: null };
}

/**
 * @param {unknown} key
 * @returns {boolean}
 */
export function isSecretKey(key) {
  return classifyKey(key).secret;
}

/**
 * 手机号正则：**必须**带数字边界，避免从长数字串（如 13 位耗时）里截出 11 位。
 * 覆盖：CN 手机号（可带 +86 前缀/空格/横线）与国际 `+<cc><number>`。
 */
export const PHONE_PATTERN = /(?<!\d)(?:\+?86[-\s]?)?1[3-9]\d{9}(?!\d)|(?<!\d)\+\d{1,3}[-\s]?\d{6,14}(?!\d)/gu;
/** 邮箱正则。 */
export const EMAIL_PATTERN = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/gu;

/**
 * @param {string} raw
 * @param {string} kind phone / email
 * @returns {string}
 */
export function maskSensitiveString(raw, kind) {
  return lineageMaskValue(raw, kind);
}

/**
 * 类别 → 中文名（手机号 / 邮箱 / 令牌·密钥）。
 * @param {string} kind
 * @returns {string}
 */
export function labelOf(kind) {
  if (kind === SENSITIVE_KIND.SECRET) return SECRET_LABEL;
  return SENSITIVE_LABELS[kind] ?? kind;
}

/**
 * 空统计对象。
 * @returns {{fields_masked: number, by_category: Record<string, number>, paths: Array<Record<string, any>>, truncated: number, notes: string[]}}
 */
export function newMaskStats() {
  return { fields_masked: 0, by_category: {}, paths: [], truncated: 0, notes: [] };
}

/**
 * @param {Record<string, any>} stats
 * @param {string} kind
 * @param {string} path
 * @param {string} preview
 * @param {string} reason
 */
function recordMask(stats, kind, path, preview, reason) {
  stats.fields_masked += 1;
  stats.by_category[kind] = (stats.by_category[kind] ?? 0) + 1;
  if (stats.paths.length < 200) {
    stats.paths.push({ json_path: path, category: kind, label: labelOf(kind), masked_preview: preview, reason });
  }
}

/**
 * 字符串值 → 脱敏字符串（值模式扫描；键名规则已判定为敏感时整值替换）。
 * @param {string} text
 * @param {string} path
 * @param {Record<string, any>} stats
 * @returns {string}
 */
export function maskTextValue(text, path, stats) {
  let out = text.replace(PHONE_PATTERN, (match) => {
    const masked = maskSensitiveString(match, SENSITIVE_KIND.PHONE);
    recordMask(stats, SENSITIVE_KIND.PHONE, path, masked, 'value_pattern:phone');
    return masked;
  });
  out = out.replace(EMAIL_PATTERN, (match) => {
    const masked = maskSensitiveString(match, SENSITIVE_KIND.EMAIL);
    recordMask(stats, SENSITIVE_KIND.EMAIL, path, masked, 'value_pattern:email');
    return masked;
  });
  return out;
}

/**
 * 任意 JSON 值 → 脱敏副本。
 *
 * @param {*} node
 * @param {{
 *   key?: string | number | null,
 *   path?: string,
 *   stats?: Record<string, any>,
 *   depth?: number,
 *   maxDepth?: number,
 *   previewChars?: number,
 *   maxNodes?: number,
 *   counter?: {nodes: number},
 * }} [options]
 * @returns {*}
 */
export function maskValue(node, options = {}) {
  const stats = options.stats ?? newMaskStats();
  const path = options.path ?? '';
  const depth = options.depth ?? 0;
  const maxDepth = options.maxDepth ?? 12;
  const previewChars = options.previewChars ?? 4000;
  const maxNodes = options.maxNodes ?? 50000;
  const counter = options.counter ?? { nodes: 0 };
  counter.nodes += 1;
  if (counter.nodes > maxNodes) return DEPTH_PLACEHOLDER;

  const key = options.key ?? null;
  const classified = key === null ? { sensitive: null, secret: false, reason: null } : classifyKey(key);

  if (classified.secret) {
    recordMask(stats, SENSITIVE_KIND.SECRET, path, SECRET_PLACEHOLDER, classified.reason ?? 'secret_key');
    return SECRET_PLACEHOLDER;
  }

  if (node === null || node === undefined) return node === undefined ? null : node;

  const type = typeof node;
  if (type === 'string') {
    if (classified.sensitive) {
      const masked = maskSensitiveString(node, classified.sensitive);
      recordMask(stats, classified.sensitive, path, masked, classified.reason ?? 'sensitive_key');
      return masked;
    }
    const scanned = maskTextValue(node, path, stats);
    if (scanned.length > previewChars) {
      stats.truncated += 1;
      return `${scanned.slice(0, previewChars)}${TRUNCATED_PLACEHOLDER}`;
    }
    return scanned;
  }
  if (type === 'number' || type === 'boolean') {
    if (classified.sensitive) {
      const masked = maskSensitiveString(String(node), classified.sensitive);
      recordMask(stats, classified.sensitive, path, masked, classified.reason ?? 'sensitive_key');
      return masked;
    }
    return node;
  }
  if (type !== 'object') return String(node);

  if (depth >= maxDepth) return DEPTH_PLACEHOLDER;

  if (Array.isArray(node)) {
    return node.map((item, index) => {
      counter.nodes += 1;
      return maskValue(item, {
        ...options,
        key: null,
        path: `${path}[${index}]`,
        stats,
        depth: depth + 1,
        maxDepth,
        previewChars,
        maxNodes,
        counter,
      });
    });
  }

  /** @type {Record<string, any>} */
  const out = {};
  for (const [childKey, childValue] of Object.entries(node)) {
    out[childKey] = maskValue(childValue, {
      ...options,
      key: childKey,
      path: path === '' ? childKey : `${path}.${childKey}`,
      stats,
      depth: depth + 1,
      maxDepth,
      previewChars,
      maxNodes,
      counter,
    });
  }
  return out;
}

/**
 * 内存中的值（**不用于响应**）：仅统计有多少敏感/密钥字段，供页面提示。
 * @param {*} node
 * @param {{path?: string, stats?: Record<string, any>, depth?: number, maxDepth?: number, key?: string|null}} [options]
 * @returns {{fields: number, by_category: Record<string, number>, secret_paths: string[]}}
 */
export function scanSensitive(node, options = {}) {
  const stats = { fields: 0, by_category: {}, secret_paths: [] };
  walk(node, options.path ?? '', options.depth ?? 0, options.maxDepth ?? 12, options.key ?? null);

  /**
   * @param {*} value
   * @param {string} path
   * @param {number} depth
   * @param {number} maxDepth
   * @param {string | number | null} key
   */
  function walk(value, path, depth, maxDepth, key) {
    if (depth > maxDepth) return;
    const classified = key === null ? { sensitive: null, secret: false } : classifyKey(key);
    if (classified.secret) {
      stats.fields += 1;
      stats.by_category.secret = (stats.by_category.secret ?? 0) + 1;
      if (stats.secret_paths.length < 50) stats.secret_paths.push(path);
      return;
    }
    if (classified.sensitive) {
      stats.fields += 1;
      stats.by_category[classified.sensitive] = (stats.by_category[classified.sensitive] ?? 0) + 1;
      return;
    }
    if (typeof value === 'string') {
      const phones = value.match(PHONE_PATTERN) ?? [];
      const emails = value.match(EMAIL_PATTERN) ?? [];
      if (phones.length > 0) {
        stats.fields += phones.length;
        stats.by_category.phone = (stats.by_category.phone ?? 0) + phones.length;
      }
      if (emails.length > 0) {
        stats.fields += emails.length;
        stats.by_category.email = (stats.by_category.email ?? 0) + emails.length;
      }
      return;
    }
    if (value === null || typeof value !== 'object') return;
    if (Array.isArray(value)) {
      value.forEach((item, index) => walk(item, `${path}[${index}]`, depth + 1, maxDepth, null));
      return;
    }
    for (const [childKey, childValue] of Object.entries(value)) {
      walk(childValue, path === '' ? childKey : `${path}.${childKey}`, depth + 1, maxDepth, childKey);
    }
  }

  return stats;
}

/**
 * 事件库行（calls / events）的脱敏：**先把 JSON 载荷字符串解析成对象再脱敏**，
 * 然后按原样重新序列化回字符串。
 *
 * 为什么必须这样做：`request_json` / `response_json` / `summary_json` 在库里是 **JSON 文本**，
 * 令牌/密钥是文本内部的**键**。若只把整行当普通字符串做值模式扫描（手机号/邮箱正则），
 * 键名规则就看不到它们，令牌原文会随导出的整行文本泄露（W1 实测到过这个漏洞，已加测试守住）。
 *
 * 与展示预览的区别：这里**不做预览长度截断**（审计导出必须完整，只是脱敏）。
 *
 * @param {Record<string, any>} row
 * @param {{stats?: Record<string, any>, previewChars?: number, maxDepth?: number}} [options]
 * @returns {{value: Record<string, any>, stats: Record<string, any>, payloads_masked: number}}
 */
export function maskPayloadRow(row, options = {}) {
  const stats = options.stats ?? newMaskStats();
  const previewChars = options.previewChars ?? 4000;
  const maxDepth = options.maxDepth ?? 24;
  /** @type {Record<string, any>} */
  const out = {};
  let payloadsMasked = 0;

  for (const [key, value] of Object.entries(row)) {
    if (PAYLOAD_COLUMNS.includes(key) && typeof value === 'string' && value.trim() !== '') {
      let parsed = null;
      try {
        parsed = JSON.parse(value);
      } catch {
        parsed = null;
      }
      if (parsed !== null && typeof parsed === 'object') {
        out[key] = JSON.stringify(maskValue(parsed, { key, stats, previewChars: Number.MAX_SAFE_INTEGER, maxDepth }));
      } else {
        // 非 JSON 文本（截断信封等）：按值模式扫描，不做长度截断
        out[key] = maskTextValue(value, key, stats);
      }
      payloadsMasked += 1;
      continue;
    }
    out[key] = maskValue(value, { key, path: key, stats, previewChars: Number.MAX_SAFE_INTEGER, maxDepth });
  }

  return { value: out, stats, payloads_masked: payloadsMasked };
}

/** 载荷列（库里以 JSON 文本存储，脱敏前必须先解析）。 */
export const PAYLOAD_COLUMNS = Object.freeze(['request_json', 'response_json', 'summary_json']);

/** 写进每个 API 响应的脱敏策略说明（页面直接原文展示）。 */export function maskPolicy(policy = {}) {
  if (policy.maskData === false) return {
    mode: 'original_values', label: '个人工作台：直接显示原始数据', rules: [],
    controlled_raw: { enabled: policy.allowRaw === true, requires: [], audited: true,
      note: '直接查看原文，无需填写理由；只读访问记录在内存中。' },
    boundaries: ['展示不脱敏；事件库和原始 UTC 时间不被修改。'],
  };
  return {
    mode: MASK_MODE.CATEGORY_AND_MASKED_VALUE,
    label: '默认：只显示类别与脱敏值',
    rules: [
      '键名规则：键名包含 phone/mobile/telephone 或 email/mail → 按手机号/邮箱脱敏。',
      '值模式规则：任意字符串里出现的手机号/邮箱，无论键名一律替换（只对字符串生效，避免把耗时等长数字误判成手机号）。',
      `密钥规则：键名包含 ${SECRET_WORDS.slice(0, 6).join('/')} 等词 → 一律替换为 ${SECRET_PLACEHOLDER}，原文不进入页面与 API。`,
      `预览规则：字符串超过 ${policy.previewChars ?? 4000} 字符只展示前段并标注 ${TRUNCATED_PLACEHOLDER}。`,
    ],
    controlled_raw: {
      enabled: policy.allowRaw === true,
      requires: ['ack=1', `reason（≥${policy.revealReasonMinLength ?? 3} 字符）`],
      audited: true,
      note: '受控查看原文只做读取与返回，不改动事件库；每次访问追加一条审计记录，页面「审计记录」区可读。',
    },
    boundaries: [
      '脱敏只作用于展示层：库内数据不被改写，血缘判定也不使用脱敏值。',
      '手机号/邮箱类别由键名或值模式判定；未命中规则的普通文本按原样展示。',
    ],
    secret_placeholder: SECRET_PLACEHOLDER,
  };
}
