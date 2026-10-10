/**
 * src/lineage/extract.js — P2 读写字段提取（L1）
 *
 * 输入：同一 `experiment_run_id` 的事件行（`TraceStore.listEvents()` 的返回，字段名 snake_case）。
 * 输出：`source_fields`（读应用响应的字段）与 `sink_fields`（写应用请求的字段），
 * 每个字段保留 **JSON 路径 + 值类型 + 规范化值 + 证据**，以及完整的排除诊断。
 *
 * 角色判定（与 相关实现 逐字一致）：
 *   - source（读侧）：`phase=response` 且该事件 `status=ok` 且工具动作=read；
 *   - sink（写侧）：`phase=request` 且工具动作=write 且该次调用的**终态为 ok**；
 *   - 其余事件一律排除，并写明原因（不静默丢弃任何事件）。
 *
 * 载荷形态：`request_json` / `response_json` 是原始 JSON-RPC 帧（S1 实测），
 * 因此路径根为 `params.arguments.*`（请求）与 `result.*`（响应）；同时兼容
 * 「裸载荷」写法（测试与手工构造的历史数据），并把识别结果记进 `payload_shape`。
 */
import { parseJsonSafe } from '../shared/json.js';
import {
  DATAFLOW_PHASES,
  EXCLUSION,
  SEMANTIC,
  TOOL_ACTION,
  VALUE_KIND,
} from './constants.js';
import { normalizeValue, semanticFromLabel, semanticFromLeaf } from './normalize.js';
import { DEFAULT_SKIP_KEYS, extractLeaves, formatPath, textAnchorPath } from './paths.js';
import { classifyTool, mergeToolPolicy } from './tools.js';
import { applicationBusinessError } from '../adapters/business_errors.js';

/** 参与「表示冲突」检测的语义字段（结构化表示 vs 文本表示）。 */
const CONTRADICTION_SEMANTICS = Object.freeze([
  SEMANTIC.TITLE,
  SEMANTIC.DATE,
  SEMANTIC.TIME,
  SEMANTIC.DATETIME,
  SEMANTIC.PHONE,
  SEMANTIC.EMAIL,
]);

/** 文本里可识别的值（模式与优先级见 相关实现）。 */
const TEXT_PATTERNS = Object.freeze([
  {
    name: 'datetime',
    kind: 'datetime',
    semantic: SEMANTIC.DATETIME,
    re: /\d{4}[-/.]\d{1,2}[-/.]\d{1,2}[T ]\d{1,2}:\d{2}(?::\d{2})?/gu,
    boundary: true,
  },
  {
    name: 'date_ymd',
    kind: 'date',
    semantic: SEMANTIC.DATE,
    re: /\d{4}[-/.]\d{1,2}[-/.]\d{1,2}/gu,
    boundary: true,
  },
  {
    name: 'date_mdy',
    kind: 'date',
    semantic: SEMANTIC.DATE,
    re: /\d{1,2}[-/.]\d{1,2}[-/.]\d{4}/gu,
    boundary: true,
  },
  {
    name: 'date_compact',
    kind: 'date',
    semantic: SEMANTIC.DATE,
    re: /\b\d{8}\b/gu,
    boundary: true,
  },
  {
    name: 'date_cjk',
    kind: 'date',
    semantic: SEMANTIC.DATE,
    re: /\d{4}年\d{1,2}月\d{1,2}日/gu,
    boundary: true,
  },
  {
    name: 'date_cjk_md',
    kind: 'date',
    semantic: SEMANTIC.DATE,
    re: /\d{1,2}月\d{1,2}日/gu,
    boundary: true,
  },
  {
    name: 'time',
    kind: 'time',
    semantic: SEMANTIC.TIME,
    re: /\d{1,2}:\d{2}(?::\d{2})?/gu,
    boundary: true,
  },
  {
    name: 'time_cjk',
    kind: 'time',
    semantic: SEMANTIC.TIME,
    re: /\d{1,2}[时點点]\d{1,2}分?/gu,
    boundary: true,
  },
  {
    name: 'phone',
    kind: 'phone',
    semantic: SEMANTIC.PHONE,
    re: /1[3-9]\d{9}/gu,
    boundary: true,
  },
  {
    name: 'email',
    kind: 'email',
    semantic: SEMANTIC.EMAIL,
    re: /[\w.+-]+@[\w-]+\.[A-Za-z]{2,}/gu,
    boundary: true,
  },
  {
    name: 'quoted_title',
    kind: 'title',
    semantic: SEMANTIC.TITLE,
    re: /《([^》\n]{1,200})》/gu,
    group: 1,
    boundary: false,
  },
  {
    name: 'labeled',
    kind: 'labeled',
    semantic: SEMANTIC.OTHER,
    re: /^[ \t]*([\u3400-\u9fffA-Za-z][\u3400-\u9fffA-Za-z0-9 _-]{0,11})[：:][ \t]*(\S[^\n]*?)[ \t]*$/gmu,
    labelGroup: 1,
    valueGroup: 2,
    boundary: false,
  },
]);

/** 值锚点里用的类型名（`path#kind[i]`）。 */
const PATH_KIND_BY_SEMANTIC = Object.freeze({
  [SEMANTIC.TITLE]: 'title',
  [SEMANTIC.DATE]: 'date',
  [SEMANTIC.TIME]: 'time',
  [SEMANTIC.DATETIME]: 'datetime',
  [SEMANTIC.PHONE]: 'phone',
  [SEMANTIC.EMAIL]: 'email',
});

/**
 * @param {*} value
 * @returns {string} string / number / boolean
 */
function jsonTypeOf(value) {
  return typeof value === 'string' ? 'string' : typeof value === 'number' ? 'number' : 'boolean';
}

/**
 * 解析事件载荷文本；显式识别截断信封（相关实现）。
 * @param {string | null | undefined} text
 * @returns {{ok: true, value: *} | {ok: false, reason: string, detail?: string}}
 */
export function parsePayload(text) {
  if (text === null || text === undefined || text === '') {
    return { ok: false, reason: EXCLUSION.PAYLOAD_ABSENT };
  }
  if (typeof text !== 'string') {
    return { ok: true, value: text };
  }
  const parsed = parseJsonSafe(text);
  if (!parsed.ok) return { ok: false, reason: EXCLUSION.PAYLOAD_UNPARSABLE, detail: parsed.error };
  const value = parsed.value;
  if (value !== null && typeof value === 'object' && /** @type {any} */ (value).__truncated__ === true) {
    return { ok: false, reason: EXCLUSION.PAYLOAD_TRUNCATED, detail: 'truncation_envelope' };
  }
  return { ok: true, value };
}

/**
 * 请求帧 → 工具名 + 参数根。
 * @param {*} value
 * @returns {{shape: string, prefix: string, tool_name: string | null, method: string | null, arguments_value: *}}
 */
export function unwrapRequest(value) {
  if (value !== null && typeof value === 'object' && typeof /** @type {any} */ (value).method === 'string') {
    const frame = /** @type {any} */ (value);
    const params = frame.params && typeof frame.params === 'object' ? frame.params : {};
    return {
      shape: 'jsonrpc',
      prefix: formatPath(['params', 'arguments']),
      tool_name: typeof params.name === 'string' ? params.name : null,
      method: frame.method,
      arguments_value: params.arguments,
    };
  }
  if (value !== null && typeof value === 'object' && /** @type {any} */ (value).arguments !== undefined) {
    return {
      shape: 'bare-with-arguments',
      prefix: formatPath(['arguments']),
      tool_name: null,
      method: null,
      arguments_value: /** @type {any} */ (value).arguments,
    };
  }
  return { shape: 'bare', prefix: '', tool_name: null, method: null, arguments_value: value };
}

/**
 * 响应帧 → 结果根。
 * @param {*} value
 * @returns {{shape: string, prefix: string, result: *, error: *}}
 */
export function unwrapResponse(value) {
  if (value !== null && typeof value === 'object') {
    const frame = /** @type {any} */ (value);
    if (frame.result !== undefined) {
      return { shape: 'jsonrpc', prefix: formatPath(['result']), result: frame.result, error: frame.error ?? null };
    }
    if (frame.error !== undefined) {
      return { shape: 'jsonrpc-error', prefix: '', result: null, error: frame.error };
    }
  }
  return { shape: 'bare', prefix: '', result: value, error: null };
}

/**
 * @param {string} char
 * @returns {boolean} 是否属于「令牌内部」字符（用于判定匹配是否独立成词）
 */
function isTokenChar(char) {
  return char !== undefined && /[\w\u3400-\u9fff-]/u.test(char);
}

/**
 * 从文本里找出可识别的值（重叠时保留更长/更早的匹配）。
 * @param {string} text
 * @returns {Array<{pattern: string, kind: string, semantic: string, label: string | null, value: string, span: {start: number, end: number}}>}
 */
export function findTextMatches(text) {
  if (typeof text !== 'string' || text === '') return [];
  /** @type {Array<{pattern: string, kind: string, semantic: string, label: string | null, value: string, span: {start: number, end: number}, priority: number}>} */
  const raw = [];
  TEXT_PATTERNS.forEach((pattern, priority) => {
    const re = new RegExp(pattern.re.source, pattern.re.flags);
    let match;
    while ((match = re.exec(text)) !== null) {
      if (match[0] === '') {
        re.lastIndex += 1;
        continue;
      }
      const value = pattern.valueGroup ? match[pattern.valueGroup] : match[pattern.group ?? 0];
      if (value === undefined || value === null || String(value).trim() === '') continue;
      const label = pattern.labelGroup ? match[pattern.labelGroup] : null;
      const start = pattern.valueGroup ? match.index + match[0].indexOf(String(value)) : match.index;
      const end = start + String(value).length;
      if (pattern.boundary && !pattern.labelGroup) {
        const before = text[start - 1];
        const after = text[end];
        if (isTokenChar(before) || isTokenChar(after)) continue;
      }
      raw.push({
        pattern: pattern.name,
        kind: pattern.kind,
        semantic: pattern.semantic,
        label: label === null ? null : String(label).trim(),
        value: String(value),
        span: { start, end },
        priority,
      });
    }
  });

  // 带标签行与同跨度的类型化匹配合并：标签作为**证据**附在类型化匹配上，
  // 避免同一个值既产生「日期」字段又产生「日期标签」字段（证据里保留 label 即可）。
  const labeledCandidates = raw.filter((candidate) => candidate.pattern === 'labeled');
  const typedCandidates = raw.filter((candidate) => candidate.pattern !== 'labeled');
  for (const labeled of labeledCandidates) {
    const sameSpan = typedCandidates.find(
      (candidate) => candidate.span.start === labeled.span.start && candidate.span.end === labeled.span.end,
    );
    if (!sameSpan) continue;
    sameSpan.label = labeled.label;
    const labelSemantic = semanticFromLabel(labeled.label ?? '');
    if (labelSemantic !== SEMANTIC.OTHER) sameSpan.semantic = labelSemantic;
    labeled.merged_into_labeled_value = true;
  }
  const candidates = raw.filter((candidate) => candidate.merged_into_labeled_value !== true);

  // 重叠消解：起点更早优先；同起点更长的优先；再同长度按模式优先级（先日期时间类）
  candidates.sort((a, b) => {
    if (a.span.start !== b.span.start) return a.span.start - b.span.start;
    const lengthA = a.span.end - a.span.start;
    const lengthB = b.span.end - b.span.start;
    if (lengthA !== lengthB) return lengthB - lengthA;
    return a.priority - b.priority;
  });
  /** @type {typeof raw} */
  const selected = [];
  for (const candidate of candidates) {
    const overlaps = selected.some(
      (chosen) => candidate.span.start < chosen.span.end && chosen.span.start < candidate.span.end,
    );
    if (overlaps) continue;
    selected.push(candidate);
  }
  selected.sort((a, b) => a.span.start - b.span.start);
  return selected.map(({ priority, ...rest }) => ({
    ...rest,
    semantic: rest.pattern === 'labeled' ? semanticFromLabel(rest.label ?? '') : rest.semantic,
  }));
}

/**
 * 文本内容块 → 字段（路径用文本锚点形式）。
 * @param {string} text
 * @param {{blockPath: string, counters?: Map<string, number>}} options
 * @returns {Array<Record<string, any>>}
 */
export function extractTextFields(text, options) {
  const counters = options.counters ?? new Map();
  /** @type {Array<Record<string, any>>} */
  const fields = [];
  for (const match of findTextMatches(text)) {
    const semantic = match.semantic;
    const normalized = normalizeValue(match.value, { semantic });
    if (normalized.empty) continue;
    const kind =
      match.pattern === 'labeled'
        ? PATH_KIND_BY_SEMANTIC[semantic] ?? 'text'
        : match.kind;
    const index = counters.get(kind) ?? 0;
    counters.set(kind, index + 1);
    fields.push({
      json_path: textAnchorPath(options.blockPath, kind, index),
      raw_value: normalized.raw,
      json_type: normalized.json_type,
      value_kind: normalized.value_kind,
      canonical: normalized.canonical,
      transforms: normalized.transforms,
      incomplete: normalized.incomplete,
      generic: normalized.generic,
      generic_reasons: normalized.generic_reasons,
      sensitive: normalized.sensitive,
      digest: normalized.digest,
      semantics: [semantic],
      representation: 'text',
      leaf: kind,
      text_match: {
        pattern: match.pattern,
        label: match.label,
        span: match.span,
        matched_text: match.value,
      },
      payload_shape: 'text-block',
      depth: 0,
    });
  }
  return fields;
}

/**
 * 结构化载荷 → 字段。
 * @param {*} root
 * @param {{prefix: string, skipKeys?: string[], maxDepth?: number, payload_shape: string}} options
 * @returns {{fields: Array<Record<string, any>>, depth_truncated: boolean}}
 */
export function extractStructuredFields(root, options) {
  const skipKeys = [...DEFAULT_SKIP_KEYS, ...(options.skipKeys ?? [])];
  const { fields, depth_truncated } = extractLeaves(root, {
    prefix: options.prefix,
    skipKeys,
    maxDepth: options.maxDepth ?? 8,
  });
  /** @type {Array<Record<string, any>>} */
  const out = [];
  for (const leaf of fields) {
    const semantic = semanticFromLeaf(leaf.leaf_key);
    const normalized = normalizeValue(leaf.value, { semantic });
    if (normalized.empty) continue;
    out.push({
      json_path: leaf.path,
      raw_value: normalized.raw,
      json_type: normalized.json_type,
      value_kind: normalized.value_kind,
      canonical: normalized.canonical,
      transforms: normalized.transforms,
      incomplete: normalized.incomplete,
      generic: normalized.generic,
      generic_reasons: normalized.generic_reasons,
      sensitive: normalized.sensitive,
      digest: normalized.digest,
      semantics: [semantic],
      representation: 'structured',
      leaf: leaf.leaf_key,
      text_match: null,
      payload_shape: options.payload_shape,
      depth: leaf.depth,
    });
  }
  return { fields: out, depth_truncated };
}

/** Literal prose lines only: quote evidence, never semantic matching of summaries. */
export function extractParagraphFields(text, blockPath) {
  const fields = [];
  let fenced = false;
  for (const match of text.matchAll(/[^\r\n]+/gu)) {
    const value = match[0].trim();
    if (/^(?:```|~~~)/u.test(value)) { fenced = !fenced; continue; }
    if (fenced || value.length < 24 || value.length > 2000 || /^(?:#|\||[-*+]\s|\d+[.)]\s|https?:\/\/)/u.test(value)) continue;
    const normalized = normalizeValue(value, { semantic: SEMANTIC.TEXT });
    const start = match.index + match[0].indexOf(value);
    fields.push({
      json_path: textAnchorPath(blockPath, 'paragraph', fields.length),
      raw_value: normalized.raw, json_type: normalized.json_type,
      value_kind: normalized.value_kind, canonical: normalized.canonical,
      transforms: normalized.transforms, incomplete: normalized.incomplete,
      generic: normalized.generic, generic_reasons: normalized.generic_reasons,
      sensitive: normalized.sensitive, digest: normalized.digest,
      semantics: [SEMANTIC.TEXT], representation: 'text', leaf: 'paragraph',
      text_match: { pattern: 'paragraph', span: { start, end: start + value.length }, matched_text: value },
      payload_shape: 'text-block', depth: 0,
    });
  }
  return fields;
}

/** JSON-in-text document responses: paths refer to the real block, decoded paths are evidence. */
export function extractJsonTextFields(text, blockPath, maxDepth = 8) {
  let value;
  try { value = JSON.parse(text); } catch { return []; }
  if (value === null || typeof value !== 'object') return [];
  const { fields } = extractStructuredFields(value, { prefix: '', maxDepth, payload_shape: 'json-text' });
  const out = [];
  let paragraphIndex = 0;
  fields.forEach((field, index) => {
    out.push({ ...field, json_path: textAnchorPath(blockPath, 'json', index), representation: 'text',
      text_match: { pattern: 'json', parsed_json_path: field.json_path, matched_text: field.raw_value } });
    if (typeof field.raw_value === 'string' && ['content', 'markdown', 'body', 'mdx', 'description'].includes(field.leaf)) {
      for (const paragraph of extractParagraphFields(field.raw_value, blockPath)) {
        out.push({ ...paragraph, json_path: textAnchorPath(blockPath, 'paragraph', paragraphIndex++),
          text_match: { ...paragraph.text_match, parsed_json_path: field.json_path, span_basis: 'decoded-json-string' } });
      }
    }
  });
  return out;
}

/** 表示方式的合并优先级：结构化优先（作为主路径）。 */
const REPRESENTATION_PRIORITY = Object.freeze({ structured: 0, text: 1 });

/**
 * 同一事件内合并字段。
 *
 * 两种分组方式（相关实现）：
 *   - 读侧（source）按**规范化值**合并：同一个值在该响应里可能同时有结构化表示与文本表示
 *     （甚至两个同值不同名的叶子），它们属于同一个来源，不能算成多个候选来源；
 *   - 写侧（sink）按**JSON 路径**分组：每个写入参数各自是一条边，必须保留路径级粒度。
 * @param {Array<Record<string, any>>} fields
 * @param {{groupBy?: 'value'|'path'}} [options]
 * @returns {Array<Record<string, any>>}
 */
export function collapseEventFields(fields, options = {}) {
  const groupBy = options.groupBy ?? 'value';
  const keyOf =
    groupBy === 'path'
      ? (field) => field.json_path
      : (field) => `${field.value_kind}|${field.canonical}`;
  /** @type {Map<string, Record<string, any>>} */
  const groups = new Map();
  for (const field of fields) {
    const key = keyOf(field);
    const existing = groups.get(key);
    if (!existing) {
      groups.set(key, {
        ...field,
        json_paths: [field.json_path],
        representations: [field.representation],
        structured_path: field.representation === 'structured' ? field.json_path : null,
        text_path: field.representation === 'text' ? field.json_path : null,
      });
      continue;
    }
    existing.json_paths.push(field.json_path);
    if (!existing.representations.includes(field.representation)) existing.representations.push(field.representation);
    if (field.representation === 'structured' && existing.structured_path === null) existing.structured_path = field.json_path;
    if (field.representation === 'text' && existing.text_path === null) existing.text_path = field.json_path;
    for (const semantic of field.semantics) {
      if (!existing.semantics.includes(semantic)) existing.semantics.push(semantic);
    }
    for (const transform of field.transforms) {
      if (!existing.transforms.includes(transform)) existing.transforms.push(transform);
    }
    if (!existing.text_match && field.text_match) existing.text_match = field.text_match;
  }

  /** @type {Array<Record<string, any>>} */
  const out = [];
  for (const field of groups.values()) {
    // 主路径：结构化表示优先，其次文本锚点
    const sortedPaths = [...field.json_paths].sort((a, b) => {
      const aStructured = a === field.structured_path ? 0 : 1;
      const bStructured = b === field.structured_path ? 0 : 1;
      if (aStructured !== bStructured) return aStructured - bStructured;
      return 0;
    });
    const primaryPath = field.structured_path ?? sortedPaths[0];
    const representations = [...field.representations].sort(
      (a, b) => REPRESENTATION_PRIORITY[a] - REPRESENTATION_PRIORITY[b],
    );
    out.push({
      ...field,
      json_path: primaryPath,
      json_paths: sortedPaths,
      representations,
      representation_primary: representations[0],
    });
  }
  return out;
}

/**
 * 每条调用的终态（来自 response / error 事件；缺失则记 unknown）。
 * @param {Array<Record<string, any>>} events
 * @returns {Map<string, {final_status: string | null, terminal_event_id: string | null, terminal_phase: string | null}>}
 */
export function resolveCallOutcomes(events) {
  /** @type {Map<string, {final_status: string | null, terminal_event_id: string | null, terminal_phase: string | null}>} */
  const outcomes = new Map();
  for (const event of events) {
    const callId = event.gateway_call_id;
    if (typeof callId !== 'string' || callId === '') continue;
    if (event.phase !== 'response' && event.phase !== 'error') continue;
    outcomes.set(callId, {
      final_status: typeof event.status === 'string' ? event.status : null,
      terminal_event_id: event.event_id ?? null,
      terminal_phase: event.phase,
    });
  }
  return outcomes;
}

/**
 * @param {Record<string, any>} event
 * @param {string} reason
 * @param {Record<string, any>} [detail]
 * @returns {Record<string, any>}
 */
function exclusion(event, reason, detail = {}) {
  return {
    event_id: event.event_id ?? null,
    gateway_call_id: event.gateway_call_id ?? null,
    phase: event.phase ?? null,
    status: event.status ?? null,
    method: event.method ?? null,
    upstream_app: event.upstream_app ?? null,
    tool_name: event.tool_name ?? null,
    timestamp_utc: event.timestamp_utc ?? null,
    reason,
    ...detail,
  };
}

/**
 * 提取一个 experiment_run 的读写字段与诊断。
 *
 * @param {Array<Record<string, any>>} events 事件行（可含其他运行；`options.experiment_run_id` 命中过滤）
 * @param {{
 *   experiment_run_id?: string | null,
 *   toolPolicy?: Record<string, string>,
 *   heuristicToolPolicy?: boolean,
 *   includeTextFields?: boolean,
 *   maxDepth?: number,
 *   includeEventIds?: Set<string> | null,
 * }} [options]
 * @returns {{
 *   source_fields: Array<Record<string, any>>,
 *   sink_fields: Array<Record<string, any>>,
 *   ordered_events: Array<Record<string, any>>,
 *   diagnostics: Record<string, any>,
 *   run_ids: string[],
 *   tool_decisions: Map<string, Record<string, any>>,
 * }}
 */
export function collectRunFields(events, options = {}) {
  const experimentRunId = options.experiment_run_id ?? null;
  const toolPolicy = mergeToolPolicy(options.toolPolicy);
  const includeTextFields = options.includeTextFields !== false;
  const includeEventIds = options.includeEventIds ?? null;

  const sorted = [...events].sort((a, b) => {
    const aTime = String(a.timestamp_utc ?? '');
    const bTime = String(b.timestamp_utc ?? '');
    if (aTime !== bTime) return aTime < bTime ? -1 : 1;
    return String(a.event_id ?? '') < String(b.event_id ?? '') ? -1 : 1;
  });

  const outcomes = resolveCallOutcomes(sorted);
  /** @type {Array<Record<string, any>>} */
  const excludedEvents = [];
  /** @type {Array<Record<string, any>>} */
  const contradictions = [];
  /** @type {Array<Record<string, any>>} */
  const toolDecisions = [];
  /** @type {Set<string>} */
  const runIds = new Set();
  /** @type {Array<Record<string, any>>} */
  const sourceFields = [];
  /** @type {Array<Record<string, any>>} */
  const sinkFields = [];
  /** @type {Map<string, Record<string, any>>} */
  const toolDecisionByKey = new Map();
  /** @type {Record<string, number>} */
  const counters = { events_total: sorted.length, events_considered: 0, events_excluded: 0 };

  sorted.forEach((event, order) => {
    if (typeof event.experiment_run_id === 'string' && event.experiment_run_id !== '') {
      runIds.add(event.experiment_run_id);
    }
    if (includeEventIds && !includeEventIds.has(event.event_id)) {
      excludedEvents.push(exclusion(event, EXCLUSION.OTHER_RUN, { detail: 'not_in_requested_event_set' }));
      counters.events_excluded += 1;
      return;
    }
    if (experimentRunId !== null) {
      const runId = event.run_id ?? null;
      const experimentId = event.experiment_run_id ?? null;
      if (runId !== experimentRunId && experimentId !== experimentRunId) {
        excludedEvents.push(exclusion(event, EXCLUSION.OTHER_RUN, { detail: `run=${experimentId ?? runId ?? 'null'}` }));
        counters.events_excluded += 1;
        return;
      }
    }
    const phase = typeof event.phase === 'string' ? event.phase : '';
    if (!DATAFLOW_PHASES.includes(phase)) {
      excludedEvents.push(exclusion(event, EXCLUSION.PHASE, { detail: `phase=${phase || 'null'}` }));
      counters.events_excluded += 1;
      return;
    }
    const method = typeof event.method === 'string' && event.method !== '' ? event.method : 'tools/call';
    if (method !== 'tools/call') {
      excludedEvents.push(exclusion(event, EXCLUSION.METHOD, { detail: `method=${method}` }));
      counters.events_excluded += 1;
      return;
    }

    const classification = classifyTool(event, {
      policy: toolPolicy,
      heuristic: options.heuristicToolPolicy !== false,
    });
    if (!toolDecisionByKey.has(classification.key)) {
      toolDecisionByKey.set(classification.key, classification);
      toolDecisions.push({ ...classification });
    }
    if (classification.action === TOOL_ACTION.UNKNOWN) {
      excludedEvents.push(exclusion(event, EXCLUSION.TOOL_UNKNOWN, { detail: classification.reason }));
      counters.events_excluded += 1;
      return;
    }
    if (classification.action === TOOL_ACTION.IGNORE) {
      excludedEvents.push(exclusion(event, EXCLUSION.TOOL_IGNORED, { detail: classification.reason }));
      counters.events_excluded += 1;
      return;
    }

    const outcome = typeof event.gateway_call_id === 'string' ? outcomes.get(event.gateway_call_id) : undefined;
    const isSink = phase === 'request' && classification.action === TOOL_ACTION.WRITE;
    const isSource = phase === 'response' && classification.action === TOOL_ACTION.READ;

    if (phase === 'request' && classification.action === TOOL_ACTION.READ) {
      excludedEvents.push(exclusion(event, EXCLUSION.READ_REQUEST, { tool_key: classification.key }));
      counters.events_excluded += 1;
      return;
    }
    if (phase === 'error') {
      excludedEvents.push(exclusion(event, EXCLUSION.STATUS_NOT_OK, { detail: 'failed_call_does_not_participate' }));
      counters.events_excluded += 1;
      return;
    }
    if (phase === 'response' && typeof event.status === 'string' && event.status !== 'ok') {
      excludedEvents.push(exclusion(event, EXCLUSION.STATUS_NOT_OK, { detail: `status=${event.status}` }));
      counters.events_excluded += 1;
      return;
    }
    if (phase === 'response' && classification.action === TOOL_ACTION.WRITE) {
      excludedEvents.push(exclusion(event, EXCLUSION.WRITE_RESPONSE, { tool_key: classification.key }));
      counters.events_excluded += 1;
      return;
    }
    if (isSink) {
      if (!outcome) {
        excludedEvents.push(exclusion(event, EXCLUSION.CALL_NOT_OK, { detail: 'no_terminal_event' }));
        counters.events_excluded += 1;
        return;
      }
      if (outcome.final_status !== 'ok') {
        excludedEvents.push(exclusion(event, EXCLUSION.CALL_NOT_OK, {
          detail: `final_status=${outcome.final_status ?? 'null'}`,
          terminal_event_id: outcome.terminal_event_id,
        }));
        counters.events_excluded += 1;
        return;
      }
    }
    if (!isSink && !isSource) {
      excludedEvents.push(exclusion(event, EXCLUSION.PHASE, { detail: 'phase_action_mismatch' }));
      counters.events_excluded += 1;
      return;
    }

    // 载荷 → 字段
    const isRequest = isSink;
    const payloadText = isRequest ? event.request_json : event.response_json;
    const payload = parsePayload(payloadText);
    if (!payload.ok) {
      excludedEvents.push(exclusion(event, payload.reason, { detail: payload.detail ?? null }));
      counters.events_excluded += 1;
      return;
    }
    if (event.truncated === 1 || event.truncated === true) {
      excludedEvents.push(exclusion(event, EXCLUSION.PAYLOAD_TRUNCATED, { detail: 'truncated=1' }));
      counters.events_excluded += 1;
      return;
    }

    /** @type {Array<Record<string, any>>} */
    let fields = [];
    let payloadShape = 'bare';
    if (isRequest) {
      const request = unwrapRequest(payload.value);
      payloadShape = request.shape;
      if (request.arguments_value === undefined || request.arguments_value === null) {
        excludedEvents.push(exclusion(event, EXCLUSION.NO_FIELDS, { detail: 'no_arguments' }));
        counters.events_excluded += 1;
        return;
      }
      fields = extractStructuredFields(request.arguments_value, {
        prefix: request.prefix,
        maxDepth: options.maxDepth,
        payload_shape: request.shape,
      }).fields;
      if (includeTextFields && event.tool_name === 'create_doc' && typeof request.arguments_value.content === 'string') {
        fields.push(...extractParagraphFields(request.arguments_value.content, `${request.prefix}.content`));
      }
      if (includeTextFields && ['tencent-docs', 'dingtalk', 'wps365', 'google-drive', 'notion', 'gitee', 'qq-mail'].includes(event.upstream_app)) {
        for (const field of [...fields]) {
          if (typeof field.raw_value === 'string' && /[\r\n]/u.test(field.raw_value)
            && ['body', 'content', 'markdown', 'text', 'mdx', 'description'].includes(field.leaf)) {
            fields.push(...extractParagraphFields(field.raw_value, field.json_path));
          }
        }
      }
    } else {
      const response = unwrapResponse(payload.value);
      payloadShape = response.shape;
      if (response.error || response.result === null || response.result === undefined) {
        excludedEvents.push(exclusion(event, EXCLUSION.ERROR_RESPONSE, { detail: 'no_result' }));
        counters.events_excluded += 1;
        return;
      }
      if (response.result !== null && typeof response.result === 'object' && response.result.isError === true) {
        excludedEvents.push(exclusion(event, EXCLUSION.STATUS_NOT_OK, { detail: 'isError_in_payload' }));
        counters.events_excluded += 1;
        return;
      }
      const businessError = applicationBusinessError(response.result, event.upstream_app);
      if (businessError) {
        excludedEvents.push(exclusion(event, EXCLUSION.STATUS_NOT_OK, { detail: `${event.upstream_app}_api_code=${businessError.code}` }));
        counters.events_excluded += 1;
        return;
      }
      // MCP content is parsed separately; nested business keys named content remain valid.
      const structuredRoot = Array.isArray(response.result?.content)
        ? Object.fromEntries(Object.entries(response.result).filter(([key]) => key !== 'content'))
        : response.result;
      const structured = extractStructuredFields(structuredRoot, {
        prefix: response.prefix,
        maxDepth: options.maxDepth,
        payload_shape: response.shape,
      });
      fields = structured.fields;
      if (structured.depth_truncated) counters.depth_truncated = (counters.depth_truncated ?? 0) + 1;
      if (includeTextFields) {
        const blocks = Array.isArray(response.result?.content) ? response.result.content : [];
        const countersByKind = new Map();
        blocks.forEach((block, index) => {
          if (!block || typeof block !== 'object') return;
          const resource = block.type === 'resource' && typeof block.resource?.text === 'string';
          const text = resource ? block.resource.text : block.type === 'text' ? block.text : null;
          if (typeof text !== 'string') return;
          const blockPath = formatPath([
            ...(response.prefix === '' ? [] : response.prefix.split('.')),
            'content',
            index,
            ...(resource ? ['resource', 'text'] : ['text']),
          ]);
          fields.push(...extractTextFields(text, { blockPath, counters: countersByKind }));
          // workspace-mcp Drive returns an actual text block with a metadata header.
          // Keep paragraph anchors relative to the original block, excluding the header.
          if (event.upstream_app === 'google-drive' && event.tool_name === 'get_drive_file_content' && !resource) {
            const marker = '\n--- CONTENT ---\n';
            const boundary = text.indexOf(marker);
            if (boundary >= 0) {
              const offset = boundary + marker.length;
              fields.push(...extractParagraphFields(text.slice(offset), blockPath).map(field => ({
                ...field, text_match: { ...field.text_match,
                  span: { start: field.text_match.span.start + offset, end: field.text_match.span.end + offset } },
              })));
            }
          }
          if (resource) fields.push(...extractParagraphFields(text, blockPath));
          if (['feishu', 'tencent-docs', 'dingtalk', 'wps365', 'notion', 'gitee', 'qq-mail'].includes(event.upstream_app) && !resource) {
            fields.push(...extractJsonTextFields(text, blockPath, options.maxDepth));
            if (event.upstream_app === 'tencent-docs') {
              try { JSON.parse(text); } catch { fields.push(...extractParagraphFields(text, blockPath)); }
            }
          }
        });
      }
    }

    if (fields.length === 0) {
      excludedEvents.push(exclusion(event, EXCLUSION.NO_FIELDS, { payload_shape: payloadShape }));
      counters.events_excluded += 1;
      return;
    }

    const collapsed = collapseEventFields(fields, { groupBy: isSink ? 'path' : 'value' });
    // 表示冲突检测（同一事件、同一语义，结构化表示与文本表示没有公共值）
    for (const semantic of CONTRADICTION_SEMANTICS) {
      const structured = collapsed.filter(
        (field) => field.structured_path !== null && field.semantics.includes(semantic),
      );
      const text = collapsed.filter((field) => field.text_path !== null && field.semantics.includes(semantic));
      if (structured.length === 0 || text.length === 0) continue;
      const structuredValues = new Set(structured.map((field) => field.canonical));
      const textValues = new Set(text.map((field) => field.canonical));
      const shared = [...structuredValues].some((value) => textValues.has(value));
      if (shared) continue;
      const structuredField = structured[0];
      const textField = text[0];
      contradictions.push({
        event_id: event.event_id ?? null,
        upstream_app: event.upstream_app ?? null,
        tool_name: event.tool_name ?? null,
        semantic,
        structured: {
          json_path: structuredField.structured_path,
          value: structuredField.raw_value,
          canonical: structuredField.canonical,
        },
        text: {
          json_path: textField.text_path,
          value: textField.raw_value,
          canonical: textField.canonical,
          text_match: textField.text_match,
        },
      });
      for (const field of [...structured, ...text]) {
        field.contradicted = true;
        field.contradiction_semantic = semantic;
      }
    }

    counters.events_considered += 1;
    const common = {
      event_id: event.event_id ?? null,
      gateway_call_id: event.gateway_call_id ?? null,
      experiment_run_id: event.experiment_run_id ?? null,
      run_id: event.run_id ?? null,
      client_label: event.client_label ?? null,
      gateway_id: event.gateway_id ?? null,
      upstream_app: event.upstream_app ?? null,
      tool_name: event.tool_name ?? null,
      method,
      phase,
      timestamp_utc: event.timestamp_utc ?? null,
      order,
      tool_action: classification.action,
      tool_decision: classification.source,
      payload_shape: payloadShape,
      role: isSink ? 'sink' : 'source',
    };
    for (const field of collapsed) {
      const record = {
        ...common,
        ...field,
        representation: field.representation_primary,
        contradicted: field.contradicted === true,
        contradiction_semantic: field.contradiction_semantic ?? null,
        source_json_path: field.json_path,
      };
      if (isSink) sinkFields.push(record);
      else sourceFields.push(record);
    }
  });

  const countersByReason = {};
  for (const entry of excludedEvents) {
    countersByReason[entry.reason] = (countersByReason[entry.reason] ?? 0) + 1;
  }

  return {
    source_fields: sourceFields,
    sink_fields: sinkFields,
    ordered_events: sorted,
    run_ids: [...runIds],
    tool_decisions: toolDecisionByKey,
    diagnostics: {
      excluded_events: excludedEvents,
      excluded_by_reason: countersByReason,
      contradictions,
      tool_decisions: toolDecisions,
      counters,
    },
  };
}
