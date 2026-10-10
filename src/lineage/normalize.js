/**
 * src/lineage/normalize.js — P2 值规范化、通用值判定与脱敏（L1）
 *
 * 规范化的**边界**（计划书 §P2 明确限定为「确定性规范化」，不得超过）：
 *   1. 空白：trim + 内部连续空白折叠为单个空格；
 *   2. 大小写：`toLowerCase()` 折叠；
 *   3. 日期时间**格式**：显式列举的等价形式
 *      `2026-10-08` / `2026/10/08` / `2026.10.08` / `10-08-2026`（MM-DD-YYYY）/
 *      `20261008` / `2026年10月8日` / `10月8日`（无年份，标记 incomplete）；
 *      `14:00` / `14:00:00` / `9:00` / `14时00分`；
 *      `2026-10-08T14:00:00Z` / `2026-10-08 14:00:00` / `2026-10-08 14:00`；
 *   4. 数字与字符串等价：`'042'` == `42` == `'42.0'`（字符串数值规范化，不做浮点运算）。
 *
 * 明确**不做**（越界即为缺陷，见 相关实现）：
 *   语义/同义词/模糊匹配、Unicode 兼容等价（NFC/NFKC）、时区换算、DD-MM-YYYY 歧义形式、
 *   把纯 4 位年份当日期、把 8 位数字以外的数字当日期、子串包含关系。
 *
 * 散列（sha256）只用于**同一规范化值的分桶查找**；是否成立一律再由 `canonicallyEqual()`
 * 逐字校验（见 rules.js），**不得凭散列声明来源**（计划书 §P2 原文）。
 */
import { digestOf } from '../shared/json.js';
import { SENSITIVE_SEMANTICS, SEMANTIC, VALUE_KIND } from './constants.js';

const PHONE_RE = /^1[3-9]\d{9}$/;
const NUMERIC_RE = /^[+-]?\d+(?:\.\d+)?$/;
const DATETIME_RE =
  /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})[T ](\d{1,2}):(\d{2})(?::(\d{2}))?(\.\d{1,3})?([zZ]|[+-]\d{2}:?\d{2})?$/;
const DATE_YMD_RE = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/;
const DATE_MDY_RE = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/;
const DATE_COMPACT_RE = /^(\d{4})(\d{2})(\d{2})$/;
const DATE_CJK_RE = /^(\d{4})年(\d{1,2})月(\d{1,2})日?$/;
const DATE_CJK_MD_RE = /^(\d{1,2})月(\d{1,2})日$/;
const TIME_RE = /^(\d{1,2}):(\d{2})(?::(\d{2}))?(\.\d{1,3})?$/;
const TIME_CJK_RE = /^(\d{1,2})[时點点](\d{1,2})?分?$/;

/** 常见通用词（计划书要求第 2 条明确点名的「常见词」；大小写已折叠）。 */
export const GENERIC_WORDS = Object.freeze([
  'ok', 'okay', 'yes', 'no', 'true', 'false', 'none', 'null', 'n/a', 'na',
  'test', 'demo', 'example', 'unknown', 'sample', 'today', 'tomorrow', 'yesterday',
  '上午', '下午', '早上', '晚上', '今天', '明天', '昨天', '会议', '通知', '日程',
  '提醒', '标题', '内容', '无', '暂无', '是', '否', '待定', '其他',
]);

const GENERIC_WORD_SET = new Set(GENERIC_WORDS);

/** 小整数上限：|n| ≤ 31 视为通用值（计划书「小整数」）。 */
export const SMALL_INTEGER_LIMIT = 31;

/** 字符串语义 → 语义字段名（路径叶子名推断）。 */
const SEMANTIC_BY_LEAF = Object.freeze([
  [/^(title|subject|heading|name|案由)$/i, SEMANTIC.TITLE],
  [/(^|_)(title|subject|heading)$/i, SEMANTIC.TITLE],
  [/^(date|day|meeting_day|event_date)$/i, SEMANTIC.DATE],
  [/(^|_)(date|day)$/i, SEMANTIC.DATE],
  [/^(time|hour|start_time|begin_time)$/i, SEMANTIC.TIME],
  [/(^|_)(time|hour)$/i, SEMANTIC.TIME],
  [/^(datetime|starts_at|start_at)$/i, SEMANTIC.DATETIME],
  [/(^|_)(datetime|starts_at)$/i, SEMANTIC.DATETIME],
  [/^(phone|mobile|tel|telephone|phone_number|mobile_number)$/i, SEMANTIC.PHONE],
  [/(^|_)(phone|mobile|tel|telephone)$/i, SEMANTIC.PHONE],
  [/^(email|mail|e_mail|mail_address)$/i, SEMANTIC.EMAIL],
  [/(^|_)(email|e_mail)$/i, SEMANTIC.EMAIL],
  [/(^|_)(id|ids|no|number|code)$/i, SEMANTIC.ID],
  [/^(count|total|limit|offset|size|len|length)$/i, SEMANTIC.COUNT],
  [/(^|_)(count|total|limit)$/i, SEMANTIC.COUNT],
  [/^(body|content|text|description|summary|message|note)$/i, SEMANTIC.TEXT],
  [/^(place|location|address|room|venue)$/i, SEMANTIC.PLACE],
  [/(^|_)(place|location|address|venue)$/i, SEMANTIC.PLACE],
  [/^(sender|from|author|owner)$/i, SEMANTIC.NAME],
]);

/** 文本标签（中文）→ 语义字段名。 */
const SEMANTIC_BY_LABEL = Object.freeze([
  [/标题|主题|名称/, SEMANTIC.TITLE],
  [/日期|时间日期/, SEMANTIC.DATE],
  [/^时间$|开始时间|结束时间/, SEMANTIC.TIME],
  [/电话|手机|联系方式|联系电话/, SEMANTIC.PHONE],
  [/邮箱|邮件地址/, SEMANTIC.EMAIL],
  [/编号|号码|标识/, SEMANTIC.ID],
  [/地点|位置|会议室|地址/, SEMANTIC.PLACE],
  [/发送方|发件人|来自|来源|作者/, SEMANTIC.NAME],
  [/接收方|收件人|参与人/, SEMANTIC.NAME],
  [/正文|内容|描述|摘要|备注/, SEMANTIC.TEXT],
  [/数量|条数|计数/, SEMANTIC.COUNT],
]);

/**
 * @param {number} value
 * @returns {string} 两位零填充
 */
export function pad2(value) {
  return String(Math.trunc(Math.abs(value))).padStart(2, '0');
}

/**
 * 空白折叠（trim + 内部连续空白 → 单个空格）。
 * @param {string} text
 * @returns {string}
 */
export function collapseWhitespace(text) {
  return text.replace(/\s+/gu, ' ').trim();
}

/**
 * @param {number} year
 * @param {number} month
 * @param {number} day
 * @returns {boolean} 是否为真实存在的日期（拒绝 2026-02-30 / 2026-13-01）
 */
export function isValidYmd(year, month, day) {
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return false;
  if (year < 1000 || year > 9999) return false;
  if (month < 1 || month > 12) return false;
  if (day < 1 || day > 31) return false;
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  );
}

/**
 * @param {number} hour
 * @param {number} minute
 * @param {number} second
 * @returns {boolean}
 */
export function isValidHms(hour, minute, second) {
  return (
    Number.isInteger(hour) && hour >= 0 && hour <= 23 &&
    Number.isInteger(minute) && minute >= 0 && minute <= 59 &&
    Number.isInteger(second) && second >= 0 && second <= 59
  );
}

/**
 * 字符串数值规范化（纯字符串运算，不使用浮点数，避免精度损失）。
 * @param {string} text
 * @returns {{canonical: string, transforms: string[]}}
 */
export function canonicalNumericString(text) {
  /** @type {string[]} */
  const transforms = [];
  let rest = text.trim();
  let sign = '';
  if (rest.startsWith('+')) {
    rest = rest.slice(1);
    transforms.push('strip_plus');
  } else if (rest.startsWith('-')) {
    sign = '-';
    rest = rest.slice(1);
  }
  const dot = rest.indexOf('.');
  const intPart = dot === -1 ? rest : rest.slice(0, dot);
  const fracPart = dot === -1 ? undefined : rest.slice(dot + 1);
  const strippedInt = intPart.replace(/^0+(?=\d)/u, '');
  if (strippedInt !== intPart) transforms.push('strip_leading_zeros');
  let outInt = strippedInt === '' ? '0' : strippedInt;
  let outFrac = fracPart;
  if (outFrac !== undefined) {
    const trimmedFrac = outFrac.replace(/0+$/u, '');
    if (trimmedFrac !== outFrac) transforms.push('strip_trailing_zeros');
    outFrac = trimmedFrac;
    if (outFrac === '') outFrac = undefined;
  }
  let canonical = outFrac === undefined ? outInt : `${outInt}.${outFrac}`;
  if (canonical === '0') sign = '';
  if (sign === '-') canonical = `-${canonical}`;
  return { canonical, transforms };
}

/**
 * 把「纯时间的日期时间」拆成日期部分与时间部分（供格式转换规则使用）。
 * @param {string} canonicalDatetime 形如 `2026-10-08T14:00:00`
 * @returns {{date: string, time: string, offset: string}}
 */
export function splitDatetime(canonicalDatetime) {
  const [datePart, timePartRaw = ''] = canonicalDatetime.split('T');
  const match = /^(\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?)(.*)$/u.exec(timePartRaw);
  return { date: datePart, time: match ? match[1] : timePartRaw, offset: match ? match[2] : '' };
}

/**
 * 日期/时间/日期时间格式解析（只认显式列举的形式，绝不猜测）。
 * @param {string} text 已 trim 的值
 * @returns {{value_kind: string, canonical: string, transforms: string[], incomplete: boolean} | null}
 */
export function parseTemporal(text) {
  let match = DATETIME_RE.exec(text);
  if (match) {
    const [, year, month, day, hour, minute, second, fraction, zone] = match;
    if (!isValidYmd(Number(year), Number(month), Number(day))) return null;
    if (!isValidHms(Number(hour), Number(minute), Number(second ?? 0))) return null;
    /** @type {string[]} */
    const transforms = [];
    let canonical =
      `${year}-${pad2(Number(month))}-${pad2(Number(day))}T` +
      `${pad2(Number(hour))}:${pad2(Number(minute))}:${pad2(Number(second ?? 0))}`;
    if (fraction) canonical += fraction;
    if (zone) {
      const upper = zone.toUpperCase();
      if (upper === 'Z') canonical += 'Z';
      else {
        canonical += zone;
        transforms.push('datetime_offset_preserved');
      }
    }
    if (canonical !== text) transforms.unshift(text.includes(' ') ? 'datetime_space_separator' : 'datetime_format');
    return { value_kind: VALUE_KIND.DATETIME, canonical, transforms, incomplete: false };
  }

  match = DATE_YMD_RE.exec(text) ?? DATE_COMPACT_RE.exec(text);
  if (match) {
    const [, year, month, day] = match;
    if (!isValidYmd(Number(year), Number(month), Number(day))) return null;
    const canonical = `${year}-${pad2(Number(month))}-${pad2(Number(day))}`;
    /** @type {string[]} */
    const transforms = [];
    if (canonical !== text) {
      if (DATE_COMPACT_RE.test(text)) transforms.push('date_yyyymmdd');
      else if (/[/.]/u.test(text)) transforms.push('date_separator');
      else transforms.push('date_reformat');
    }
    return { value_kind: VALUE_KIND.DATE, canonical, transforms, incomplete: false };
  }

  match = DATE_MDY_RE.exec(text);
  if (match) {
    const [, month, day, year] = match;
    if (!isValidYmd(Number(year), Number(month), Number(day))) return null;
    return {
      value_kind: VALUE_KIND.DATE,
      // 计划书 §P2 明确把 `10-08-2026` 与 `2026-10-08` 列为等价形式 → 采用 MM-DD-YYYY。
      // DD-MM-YYYY 与 MM-DD-YYYY 无法从字面区分，本实现**只**接受 MM-DD-YYYY（相关实现）。
      canonical: `${year}-${pad2(Number(month))}-${pad2(Number(day))}`,
      transforms: ['date_mm_dd_yyyy'],
      incomplete: false,
    };
  }

  match = DATE_CJK_RE.exec(text);
  if (match) {
    const [, year, month, day] = match;
    if (!isValidYmd(Number(year), Number(month), Number(day))) return null;
    return {
      value_kind: VALUE_KIND.DATE,
      canonical: `${year}-${pad2(Number(month))}-${pad2(Number(day))}`,
      transforms: ['date_cjk'],
      incomplete: false,
    };
  }

  match = DATE_CJK_MD_RE.exec(text);
  if (match) {
    const [, month, day] = match;
    if (!isValidYmd(2000, Number(month), Number(day))) return null;
    return {
      value_kind: VALUE_KIND.DATE,
      // 无年份：canonical 用 `--MM-DD`；**永不**与完整日期相等（不做年份推断）。
      canonical: `--${pad2(Number(month))}-${pad2(Number(day))}`,
      transforms: ['date_yearless'],
      incomplete: true,
    };
  }

  match = TIME_RE.exec(text);
  if (match) {
    const [, hour, minute, second, fraction] = match;
    if (!isValidHms(Number(hour), Number(minute), Number(second ?? 0))) return null;
    let canonical = `${pad2(Number(hour))}:${pad2(Number(minute))}:${pad2(Number(second ?? 0))}`;
    if (fraction) canonical += fraction;
    /** @type {string[]} */
    const transforms = [];
    if (canonical !== text) {
      if (second === undefined) transforms.push('time_seconds_added');
      else transforms.push('time_zero_pad');
    }
    return { value_kind: VALUE_KIND.TIME, canonical, transforms, incomplete: false };
  }

  match = TIME_CJK_RE.exec(text);
  if (match) {
    const [, hour, minute] = match;
    if (!isValidHms(Number(hour), Number(minute ?? 0), 0)) return null;
    return {
      value_kind: VALUE_KIND.TIME,
      canonical: `${pad2(Number(hour))}:${pad2(Number(minute ?? 0))}:00`,
      transforms: ['time_cjk'],
      incomplete: false,
    };
  }

  return null;
}

/**
 * 由 JSON 路径叶子名推断语义字段名（只作标注，不参与匹配）。
 * @param {string} leaf
 * @returns {string}
 */
export function semanticFromLeaf(leaf) {
  const name = String(leaf ?? '').trim();
  if (name === '') return SEMANTIC.OTHER;
  for (const [pattern, semantic] of SEMANTIC_BY_LEAF) {
    if (pattern.test(name)) return semantic;
  }
  return SEMANTIC.OTHER;
}

/**
 * 由文本标签推断语义字段名。
 * @param {string} label
 * @returns {string}
 */
export function semanticFromLabel(label) {
  const text = String(label ?? '').trim();
  if (text === '') return SEMANTIC.OTHER;
  for (const [pattern, semantic] of SEMANTIC_BY_LABEL) {
    if (pattern.test(text)) return semantic;
  }
  return SEMANTIC.OTHER;
}

/**
 * 标题类文本脱掉外层装饰符（《》「」【】引号括号）。
 * @param {string} text
 * @returns {string}
 */
export function stripTitleDecorations(text) {
  let out = text.trim();
  let changed = true;
  while (changed && out.length > 0) {
    changed = false;
    const head = /^[《「【"'（(]/u.exec(out);
    if (head) {
      out = out.slice(head[0].length);
      changed = true;
    }
    const tail = /[》」】"'）)]$/u.exec(out);
    if (tail) {
      out = out.slice(0, out.length - tail[0].length);
      changed = true;
    }
  }
  return out;
}

/**
 * 值规范化结果（字段的核心数据）。
 * @typedef {object} NormalizedValue
 * @property {*} raw 原始值
 * @property {string} json_type string / number / boolean
 * @property {string} value_kind 见 VALUE_KIND
 * @property {string} canonical 规范化后的比较键
 * @property {string[]} transforms 发生过的确定性变换（证据用）
 * @property {boolean} incomplete 是否缺少年份等不完整信息
 * @property {boolean} empty 是否为空值（null/undefined/空字符串/NaN）
 * @property {boolean} sensitive 是否敏感字段（手机号 / 邮箱）
 * @property {boolean} generic 是否通用值
 * @property {string[]} generic_reasons 通用值原因
 * @property {string} digest `sha256:` + 64 位十六进制（**只用于分桶**）
 */

/**
 * 规范化一个字段值。
 * @param {*} raw
 * @param {{semantic?: string, leaf?: string}} [options]
 * @returns {NormalizedValue}
 */
export function normalizeValue(raw, options = {}) {
  const semantic = options.semantic ?? (options.leaf ? semanticFromLeaf(options.leaf) : SEMANTIC.OTHER);
  /** @type {NormalizedValue} */
  const base = {
    raw,
    json_type: typeof raw === 'string' ? 'string' : typeof raw === 'number' ? 'number' : typeof raw === 'boolean' ? 'boolean' : 'unknown',
    value_kind: VALUE_KIND.STRING,
    canonical: '',
    transforms: [],
    incomplete: false,
    empty: false,
    sensitive: false,
    generic: false,
    generic_reasons: [],
    digest: '',
  };

  if (raw === null || raw === undefined) return finish({ ...base, empty: true });
  if (typeof raw === 'number') {
    if (!Number.isFinite(raw)) return finish({ ...base, empty: true });
    const { canonical, transforms } = canonicalNumericString(String(raw));
    return finish({ ...base, value_kind: VALUE_KIND.NUMBER, canonical, transforms });
  }
  if (typeof raw === 'boolean') {
    return finish({ ...base, value_kind: VALUE_KIND.BOOLEAN, canonical: raw ? 'true' : 'false' });
  }
  if (typeof raw !== 'string') return finish({ ...base, empty: true });

  const trimmed = raw.trim();
  if (trimmed === '') return finish({ ...base, empty: true });

  // 1) 敏感语义：手机号 / 邮箱（由路径叶子名或文本标签决定，不从裸数字猜手机号）
  if (semantic === SEMANTIC.PHONE) {
    const digits = trimmed.replace(/[^\d]/gu, '');
    /** @type {string[]} */
    const transforms = digits === trimmed ? [] : ['phone_digits'];
    if (PHONE_RE.test(digits) && digits !== trimmed) transforms.push('phone_format');
    return finish({
      ...base,
      value_kind: VALUE_KIND.PHONE,
      canonical: digits,
      transforms,
      sensitive: true,
    });
  }
  if (semantic === SEMANTIC.EMAIL) {
    const lower = trimmed.toLowerCase();
    return finish({
      ...base,
      value_kind: VALUE_KIND.EMAIL,
      canonical: lower,
      transforms: lower === trimmed ? [] : ['lowercase'],
      sensitive: true,
    });
  }

  // 2) 日期时间格式
  const temporal = parseTemporal(trimmed);
  if (temporal) return finish({ ...base, ...temporal });

  // 3) 数字/字符串等价（'042' == 42 == '42.0'）
  if (NUMERIC_RE.test(trimmed)) {
    const { canonical, transforms } = canonicalNumericString(trimmed);
    return finish({
      ...base,
      value_kind: VALUE_KIND.NUMBER,
      canonical,
      transforms: ['number_string', ...transforms],
    });
  }

  // 4) 普通字符串：空白折叠 + 大小写折叠
  /** @type {string[]} */
  const transforms = [];
  if (trimmed !== raw) transforms.push('trim');
  if (/[\t\n\r]|\s{2,}/u.test(trimmed)) transforms.push('collapse_whitespace');
  const collapsed = collapseWhitespace(raw);
  const semanticDecorated = semantic === SEMANTIC.TITLE ? stripTitleDecorations(collapsed) : collapsed;
  if (semanticDecorated !== collapsed) transforms.push('strip_title_decoration');
  const lower = semanticDecorated.toLowerCase();
  if (lower !== semanticDecorated) transforms.push('lowercase');
  return finish({ ...base, value_kind: VALUE_KIND.STRING, canonical: lower, transforms });
}

/**
 * 补全 digest 与通用值判定。
 * @param {NormalizedValue} value
 * @returns {NormalizedValue}
 */
function finish(value) {
  if (value.empty) return { ...value, digest: '' };
  const generic = isGenericValue(value);
  return {
    ...value,
    generic: generic.generic,
    generic_reasons: generic.reasons,
    digest: digestOf(`${value.value_kind}|${value.canonical}`),
  };
}

/**
 * 计划书要求第 2 条的「通用值」判定：纯日期 / 纯时间 / 小整数 / 常见词。
 * 完整的「日期 + 时间」不视为通用值（见 相关实现）。
 * @param {NormalizedValue} value
 * @returns {{generic: boolean, reasons: string[]}}
 */
export function isGenericValue(value) {
  /** @type {string[]} */
  const reasons = [];
  switch (value.value_kind) {
    case VALUE_KIND.DATE:
      reasons.push(value.incomplete ? 'generic_yearless_date' : 'generic_pure_date');
      break;
    case VALUE_KIND.TIME:
      reasons.push('generic_pure_time');
      break;
    case VALUE_KIND.DATETIME:
      break;
    case VALUE_KIND.BOOLEAN:
      reasons.push('generic_boolean');
      break;
    case VALUE_KIND.NUMBER: {
      const numeric = Number(value.canonical);
      if (Number.isInteger(numeric) && Math.abs(numeric) <= SMALL_INTEGER_LIMIT) {
        reasons.push('generic_small_integer');
      } else if (Number.isInteger(numeric) && numeric >= 1900 && numeric <= 2100) {
        reasons.push('generic_year');
      }
      break;
    }
    case VALUE_KIND.STRING: {
      const canonical = value.canonical;
      if (GENERIC_WORD_SET.has(canonical)) reasons.push('generic_common_word');
      else if (/^[a-z0-9 ._+/-]{1,3}$/u.test(canonical)) reasons.push('generic_short_token');
      else if (/^[\u3400-\u9fff]{1,2}$/u.test(canonical)) reasons.push('generic_short_cjk_token');
      break;
    }
    default:
      break;
  }
  return { generic: reasons.length > 0, reasons };
}

/**
 * 两个规范化值是否相等（**逐字校验**，这是散列比较的唯一合法形式）。
 * @param {NormalizedValue} a
 * @param {NormalizedValue} b
 * @returns {boolean}
 */
export function canonicallyEqual(a, b) {
  if (!a || !b || a.empty || b.empty) return false;
  return a.value_kind === b.value_kind && a.canonical === b.canonical;
}

/**
 * 脱敏展示值（**只用于展示投影**；P3 的隐私策略见 相关实现，L1 不接管）。
 * @param {*} raw
 * @param {string} valueKind
 * @returns {string}
 */
export function maskValue(raw, valueKind) {
  const text = String(raw ?? '');
  if (valueKind === VALUE_KIND.PHONE) {
    const digits = text.replace(/[^\d]/gu, '');
    if (digits.length >= 7) return `${digits.slice(0, 3)}****${digits.slice(-4)}`;
    return '***';
  }
  if (valueKind === VALUE_KIND.EMAIL) {
    const at = text.indexOf('@');
    if (at <= 0) return '***';
    return `${text.slice(0, 1)}***${text.slice(at)}`;
  }
  if (text.length <= 2) return '**';
  return `${text.slice(0, 1)}***${text.slice(-1)}`;
}

/**
 * 值类型/规范化值的可读描述（诊断与页面用）。
 * @param {NormalizedValue} value
 * @returns {string}
 */
export function describeValue(value) {
  if (value.empty) return '(empty)';
  return `${value.value_kind}:${value.canonical}`;
}

export { SENSITIVE_SEMANTICS };
