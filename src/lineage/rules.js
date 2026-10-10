/**
 * src/lineage/rules.js — P2 匹配规则、置信级别与「不确定」判定（L1）
 *
 * 规则（详见 相关实现 与 §3）：
 *   observed（该次已观测的读响应与写请求都出现同一规范化值）
 *     - `exact_value`：原样相等；
 *     - `normalized_equivalence`：空白/大小写/日期时间格式规范化后相等；
 *     - `number_string_equivalence`：数字 ↔ 数值字符串等价；
 *   inferred（规则推断，值本身不相等）
 *     - `datetime_split`：上游单个日期时间 → 下游日期 / 时间两个字段；
 *     - `datetime_merge`：上游日期 + 时间 → 下游单个日期时间字段。
 *
 * **散列的合法用法**：`digest` 只用于把候选来源分桶（`byDigest`），
 * 命中后一律由 `canonicallyEqual()` 逐字校验；本文件不存在任何「凭散列建立边」的分支。
 */
import {
  CONFIDENCE,
  CONFIDENCE_RANK,
  DECISION,
  REPRESENTATION,
  RULE,
  VALUE_KIND,
} from './constants.js';
import { canonicallyEqual, splitDatetime } from './normalize.js';

/** 各规则的基准置信级别（封顶前）。 */
export const BASE_CONFIDENCE = Object.freeze({
  [RULE.EXACT]: CONFIDENCE.HIGH,
  [RULE.LITERAL_FRAGMENT]: CONFIDENCE.MEDIUM,
  [RULE.NORMALIZED]: CONFIDENCE.HIGH,
  [RULE.NUMBER_STRING]: CONFIDENCE.HIGH,
  [RULE.DATETIME_SPLIT]: CONFIDENCE.MEDIUM,
  [RULE.DATETIME_MERGE]: CONFIDENCE.MEDIUM,
});

/**
 * @param {string} rule
 * @returns {string} observed / inferred
 */
export function representationOfRule(rule) {
  return rule === RULE.DATETIME_SPLIT || rule === RULE.DATETIME_MERGE
    ? REPRESENTATION.INFERRED
    : REPRESENTATION.OBSERVED;
}

/**
 * @param {string} level
 * @param {string} cap
 * @returns {string}
 */
export function minConfidence(level, cap) {
  return CONFIDENCE_RANK[level] <= CONFIDENCE_RANK[cap] ? level : cap;
}

/**
 * 建立来源索引（散列分桶 + 日期/时间分量索引）。
 * @param {Array<Record<string, any>>} sourceFields
 * @returns {{
 *   byDigest: Map<string, Array<Record<string, any>>>,
 *   byDate: Map<string, Array<Record<string, any>>>,
 *   byTime: Map<string, Array<Record<string, any>>>,
 *   datetimes: Array<Record<string, any>>,
 *   all: Array<Record<string, any>>,
 *   keyOf: (field: Record<string, any>) => string,
 * }}
 */
export function buildSourceIndex(sourceFields, options = {}) {
  // valueKeyFn 默认用字段自带的 sha256；可注入（测试用：注入常量以证明「散列相同 ≠ 值相同」）。
  const keyOf = typeof options.valueKeyFn === 'function' ? options.valueKeyFn : (field) => field.digest;
  /** @type {Map<string, Array<Record<string, any>>>} */
  const byDigest = new Map();
  /** @type {Map<string, Array<Record<string, any>>>} */
  const byDate = new Map();
  /** @type {Map<string, Array<Record<string, any>>>} */
  const byTime = new Map();
  /** @type {Array<Record<string, any>>} */
  const datetimes = [];
  for (const field of sourceFields) {
    const key = keyOf(field);
    if (!byDigest.has(key)) byDigest.set(key, []);
    /** @type {Array<Record<string, any>>} */ (byDigest.get(key)).push(field);
    if (field.value_kind === VALUE_KIND.DATE) {
      if (!byDate.has(field.canonical)) byDate.set(field.canonical, []);
      /** @type {Array<Record<string, any>>} */ (byDate.get(field.canonical)).push(field);
    } else if (field.value_kind === VALUE_KIND.TIME) {
      if (!byTime.has(field.canonical)) byTime.set(field.canonical, []);
      /** @type {Array<Record<string, any>>} */ (byTime.get(field.canonical)).push(field);
    } else if (field.value_kind === VALUE_KIND.DATETIME) {
      datetimes.push(field);
      const parts = splitDatetime(field.canonical);
      if (!byDate.has(parts.date)) byDate.set(parts.date, []);
      /** @type {Array<Record<string, any>>} */ (byDate.get(parts.date)).push(field);
      if (!byTime.has(parts.time)) byTime.set(parts.time, []);
      /** @type {Array<Record<string, any>>} */ (byTime.get(parts.time)).push(field);
    }
  }
  return { byDigest, byDate, byTime, datetimes, all: sourceFields, keyOf };
}

/**
 * 规则选择（仅在 `canonicallyEqual` 成立时调用）。
 * @param {Record<string, any>} source
 * @param {Record<string, any>} sink
 * @returns {string}
 */
export function selectRule(source, sink) {
  if (source.raw_value === sink.raw_value && source.json_type === sink.json_type) return RULE.EXACT;
  if (source.value_kind === VALUE_KIND.NUMBER && sink.value_kind === VALUE_KIND.NUMBER) {
    return RULE.NUMBER_STRING;
  }
  return RULE.NORMALIZED;
}

/**
 * 字段叶子名（文本锚点取其类型，便于重命名比较）。
 * @param {Record<string, any>} field
 * @returns {string}
 */
export function leafNameOf(field) {
  if (Array.isArray(field.json_paths)) {
    for (const path of field.json_paths) {
      const hash = path.indexOf('#');
      if (hash !== -1) continue;
      const segments = path.split('.');
      return segments[segments.length - 1].replace(/\[\d+\]$/u, '');
    }
  }
  if (typeof field.json_path === 'string' && field.json_path.includes('#')) return field.leaf;
  const segments = String(field.json_path ?? '').split('.');
  return segments[segments.length - 1].replace(/\[\d+\]$/u, '');
}

/**
 * 重命名证据：叶子名不同即视为重命名；`renameHints` 只用于**解释**，绝不用于凭空建边。
 * @param {Record<string, any>} source
 * @param {Record<string, any>} sink
 * @param {Record<string, string[]>} [renameHints]
 * @returns {{renamed: boolean, hint: string | null, source_leaf: string, sink_leaf: string}}
 */
export function renameEvidence(source, sink, renameHints) {
  const sourceLeaf = leafNameOf(source);
  const sinkLeaf = leafNameOf(sink);
  /** @type {string | null} */
  let hint = null;
  const aliases = renameHints?.[sinkLeaf];
  if (Array.isArray(aliases) && aliases.includes(sourceLeaf)) hint = `${sinkLeaf}←${sourceLeaf}`;
  return { renamed: sourceLeaf !== sinkLeaf, hint, source_leaf: sourceLeaf, sink_leaf: sinkLeaf };
}

/**
 * 生成候选边（不含置信级别）。
 * @param {Record<string, any>} sink
 * @param {ReturnType<typeof buildSourceIndex>} index
 * @param {{renameHints?: Record<string, string[]>}} [options]
 * @returns {Array<Record<string, any>>}
 */
export function findCandidates(sink, index, options = {}) {
  /** @type {Array<Record<string, any>>} */
  const candidates = [];

  // 1) observed：按散列分桶取候选，逐字校验后成立
  for (const source of index.byDigest.get(index.keyOf(sink)) ?? []) {
    if (source.order >= sink.order) continue;
    if (!canonicallyEqual(source, sink)) continue;
    push({
      representation: REPRESENTATION.OBSERVED,
      rule: selectRule(source, sink),
      source,
      component: null,
    });
  }

  // 2) inferred：日期时间格式转换
  // A long write paragraph can quote a fragment of a flattened read body.
  // Compare original strings, retain the original source field, and record decoded
  // UTF-16 offsets. Short/common values and arbitrary identifiers are excluded.
  if (typeof sink.raw_value === 'string' && ['paragraph', 'content', 'body', 'description', 'markdown', 'mdx', 'text'].includes(sink.leaf)
    && [...sink.raw_value.trim()].length >= 20 && !(sink.generic_reasons ?? []).length) {
    for (const source of index.all) {
      if (source.order >= sink.order || typeof source.raw_value !== 'string'
        || !['content', 'body', 'description', 'markdown', 'mdx', 'text', 'paragraph'].includes(source.leaf)
        || source.raw_value.length <= sink.raw_value.length
        || candidates.some(candidate => candidate.source.event_id === source.event_id && candidate.rule !== RULE.LITERAL_FRAGMENT)) continue;
      const spans = [];
      let start = source.raw_value.indexOf(sink.raw_value), occurrences = 0;
      while (start !== -1) {
        occurrences++;
        if (spans.length < 32) spans.push({ start, end: start + sink.raw_value.length });
        start = source.raw_value.indexOf(sink.raw_value, start + 1);
      }
      if (!occurrences) continue;
      push({ representation: REPRESENTATION.OBSERVED, rule: RULE.LITERAL_FRAGMENT, source, component: null,
        literal_fragment: { matched_text: sink.raw_value, source_spans: spans, occurrences,
          spans_truncated: occurrences > spans.length, span_basis: 'decoded-source-string', offset_unit: 'UTF-16 code units' } });
    }
  }

  // inferred：日期时间格式转换
  if (sink.value_kind === VALUE_KIND.DATETIME) {
    const parts = splitDatetime(sink.canonical);
    for (const source of index.byDate.get(parts.date) ?? []) {
      if (source.order >= sink.order || source.value_kind !== VALUE_KIND.DATE) continue;
      push({
        representation: REPRESENTATION.INFERRED,
        rule: RULE.DATETIME_MERGE,
        source,
        component: 'date',
      });
    }
    for (const source of index.byTime.get(parts.time) ?? []) {
      if (source.order >= sink.order || source.value_kind !== VALUE_KIND.TIME) continue;
      push({
        representation: REPRESENTATION.INFERRED,
        rule: RULE.DATETIME_MERGE,
        source,
        component: 'time',
      });
    }
  } else if (sink.value_kind === VALUE_KIND.DATE || sink.value_kind === VALUE_KIND.TIME) {
    for (const source of index.datetimes) {
      if (source.order >= sink.order) continue;
      const parts = splitDatetime(source.canonical);
      const component = sink.value_kind === VALUE_KIND.DATE ? parts.date : parts.time;
      if (component !== sink.canonical) continue;
      push({
        representation: REPRESENTATION.INFERRED,
        rule: RULE.DATETIME_SPLIT,
        source,
        component: sink.value_kind === VALUE_KIND.DATE ? 'date' : 'time',
      });
    }
  }

  // 去重：(来源事件 + 主路径 + 规则)
  /** @type {Map<string, Record<string, any>>} */
  const seen = new Map();
  for (const candidate of candidates) {
    const key = `${candidate.source.event_id}|${candidate.source.json_path}|${candidate.rule}`;
    if (!seen.has(key)) seen.set(key, candidate);
  }
  return [...seen.values()];

  /**
   * @param {{representation: string, rule: string, source: Record<string, any>, component: string | null}} partial
   */
  function push(partial) {
    const rename = renameEvidence(partial.source, sink, options.renameHints);
    candidates.push({ ...partial, sink, rename });
  }
}

/**
 * 单个写入字段的判定（多候选 / 通用值 / 表示冲突 → 不得定唯一血缘）。
 * @param {Array<Record<string, any>>} candidates
 * @returns {{
 *   decision: string,
 *   uncertainty_reasons: string[],
 *   competition: Array<{key: string, source_events: string[]}>,
 *   generic_reasons: string[],
 *   conflict: boolean,
 *   source_event_ids: string[],
 * }}
 */
export function assessSinkField(candidates) {
  /** @type {Map<string, Set<string>>} */
  const groups = new Map();
  /** @type {Set<string>} */
  const genericReasons = new Set();
  let conflict = false;

  for (const candidate of candidates) {
    const { source, sink, rule } = candidate;
    let groupKey;
    if (rule === RULE.DATETIME_MERGE) groupKey = `merge:${candidate.component}`;
    else if (rule === RULE.DATETIME_SPLIT) groupKey = `split:${candidate.component}`;
    else groupKey = `value:${sink.value_kind}|${sink.canonical}`;
    if (!groups.has(groupKey)) groups.set(groupKey, new Set());
    /** @type {Set<string>} */ (groups.get(groupKey)).add(source.event_id);

    if (rule === RULE.DATETIME_MERGE) {
      for (const reason of sink.generic_reasons ?? []) genericReasons.add(reason);
    } else {
      for (const reason of sink.generic_reasons ?? []) genericReasons.add(reason);
      for (const reason of source.generic_reasons ?? []) genericReasons.add(reason);
    }
    if (source.contradicted === true || sink.contradicted === true) conflict = true;
    if (source.contradiction_semantic && sink.semantics?.includes(source.contradiction_semantic)) conflict = true;
  }

  const competition = [...groups.entries()]
    .filter(([, events]) => events.size >= 2)
    .map(([key, events]) => ({ key, source_events: [...events].sort() }));
  const sourceEventIds = [...new Set(candidates.map((candidate) => candidate.source.event_id))].sort();

  /** @type {string[]} */
  const uncertaintyReasons = [];
  if (competition.length > 0) uncertaintyReasons.push('multiple_candidate_sources');
  for (const reason of [...genericReasons].sort()) uncertaintyReasons.push(`generic_value:${reason}`);
  if (conflict) uncertaintyReasons.push('text_structured_conflict');

  let decision;
  if (candidates.length === 0) decision = DECISION.NONE;
  else if (competition.length > 0) decision = DECISION.AMBIGUOUS;
  else if (genericReasons.size > 0 || conflict) decision = DECISION.UNCERTAIN;
  else decision = DECISION.UNIQUE;

  return {
    decision,
    uncertainty_reasons: uncertaintyReasons,
    competition,
    generic_reasons: [...genericReasons].sort(),
    conflict,
    source_event_ids: sourceEventIds,
  };
}

/**
 * 置信级别 = 规则基准 × 收窄项（见 相关实现）。
 * @param {Record<string, any>} candidate
 * @param {{competing: boolean, textOnly: boolean}} flags
 * @returns {{confidence: string, reasons: string[]}}
 */
export function confidenceOf(candidate, flags) {
  const base = BASE_CONFIDENCE[candidate.rule] ?? CONFIDENCE.LOW;
  const { source, sink, rule } = candidate;
  /** @type {string[]} */
  const reasons = [`rule:${rule}`, `base:${base}`];
  let confidence = base;

  const genericApplies =
    rule === RULE.DATETIME_MERGE
      ? (sink.generic_reasons ?? []).length > 0
      : (sink.generic_reasons ?? []).length > 0 || (source.generic_reasons ?? []).length > 0;
  if (genericApplies) {
    confidence = minConfidence(confidence, CONFIDENCE.LOW);
    const reasonsList = rule === RULE.DATETIME_MERGE ? sink.generic_reasons : [...(sink.generic_reasons ?? []), ...(source.generic_reasons ?? [])];
    reasons.push(`generic_value:${[...new Set(reasonsList)].sort().join('+')}`);
  }
  if (flags.competing) {
    confidence = minConfidence(confidence, CONFIDENCE.MEDIUM);
    reasons.push('multiple_candidate_sources');
  }
  if (source.contradicted === true || sink.contradicted === true) {
    confidence = minConfidence(confidence, CONFIDENCE.LOW);
    reasons.push('text_structured_conflict');
  }
  if (flags.textOnly) {
    confidence = minConfidence(confidence, CONFIDENCE.MEDIUM);
    reasons.push('source_representation:text_only');
  } else if (Array.isArray(source.representations) && source.representations.includes('structured')) {
    reasons.push('source_representation:structured');
  }
  if (candidate.rename?.hint) reasons.push(`rename_hint:${candidate.rename.hint}`);
  if (source.upstream_app !== sink.upstream_app) reasons.push('cross_app');
  return { confidence, reasons };
}

/**
 * 组装一条边（字段级血缘记录）。
 * @param {Record<string, any>} candidate
 * @param {{competing: boolean, competingSourceCount: number}} flags
 * @returns {Record<string, any>}
 */
export function buildEdge(candidate, flags) {
  const { source, sink, rule, representation } = candidate;
  const textOnly = Array.isArray(source.representations) && source.representations.length === 1 && source.representations[0] === 'text';
  const { confidence, reasons } = confidenceOf(candidate, { competing: flags.competing, textOnly });
  const sharedCanonical = rule === RULE.EXACT || rule === RULE.NORMALIZED || rule === RULE.NUMBER_STRING;
  return {
    representation,
    rule,
    confidence,
    source_event_id: source.event_id,
    source_json_path: source.json_path,
    source_json_paths: source.json_paths ?? [source.json_path],
    source_value: source.raw_value,
    source_upstream_app: source.upstream_app,
    source_tool_name: source.tool_name,
    source_phase: source.phase,
    sink_event_id: sink.event_id,
    sink_json_path: sink.json_path,
    sink_json_paths: sink.json_paths ?? [sink.json_path],
    sink_value: sink.raw_value,
    sink_upstream_app: sink.upstream_app,
    sink_tool_name: sink.tool_name,
    sink_phase: sink.phase,
    value_kind: sink.value_kind,
    canonical: sink.canonical,
    shared_canonical: sharedCanonical,
    competing_source_count: flags.competingSourceCount,
    evidence: {
      hash: {
        source: source.digest,
        sink: sink.digest,
        usage: 'bucketing_only',
        verified_by: rule === RULE.LITERAL_FRAGMENT ? 'original-string-indexOf' : 'canonicallyEqual',
      },
      normalization: {
        source_transforms: source.transforms,
        sink_transforms: sink.transforms,
        source_canonical: source.canonical,
        sink_canonical: sink.canonical,
        comparable: sharedCanonical,
      },
      representation: {
        source: source.representations ?? [source.representation],
        sink: sink.representations ?? [sink.representation],
        source_primary: source.representation,
        text_match: source.text_match ?? null,
      },
      rename: candidate.rename,
      cross_app: source.upstream_app !== sink.upstream_app,
      generic: {
        source: { value: source.generic === true, reasons: source.generic_reasons ?? [] },
        sink: { value: sink.generic === true, reasons: sink.generic_reasons ?? [] },
      },
      component: candidate.component,
      literal_fragment: candidate.literal_fragment ?? null,
      format_conversion:
        rule === RULE.DATETIME_MERGE || rule === RULE.DATETIME_SPLIT
          ? {
              direction: rule === RULE.DATETIME_MERGE ? 'merge' : 'split',
              component: candidate.component,
              sink_canonical: sink.canonical,
            }
          : null,
      contradiction: source.contradicted === true || sink.contradicted === true
        ? { semantic: source.contradiction_semantic ?? sink.contradiction_semantic ?? null }
        : null,
      values: { source_raw: source.raw_value, sink_raw: sink.raw_value },
      times: { source_event_utc: source.timestamp_utc, sink_event_utc: sink.timestamp_utc },
    },
    confidence_reasons: reasons,
  };
}

/**
 * 主流程：读侧字段 + 写侧字段 → observed / inferred 两组边 + 每个写字段的判定。
 *
 * @param {{
 *   sourceFields: Array<Record<string, any>>,
 *   sinkFields: Array<Record<string, any>>,
 *   renameHints?: Record<string, string[]>,
 *   valueKeyFn?: (field: Record<string, any>) => string,
 * }} input
 * @returns {{
 *   observed: Array<Record<string, any>>,
 *   inferred: Array<Record<string, any>>,
 *   assessments: Array<Record<string, any>>,
 *   edges: Array<Record<string, any>>,
 * }}
 */
export function linkFields(input) {
  const index = buildSourceIndex(input.sourceFields, { valueKeyFn: input.valueKeyFn });
  /** @type {Array<Record<string, any>>} */
  const observed = [];
  /** @type {Array<Record<string, any>>} */
  const inferred = [];
  /** @type {Array<Record<string, any>>} */
  const assessments = [];

  const sinks = [...input.sinkFields].sort((a, b) =>
    a.order === b.order ? String(a.json_path).localeCompare(String(b.json_path)) : a.order - b.order,
  );

  for (const sink of sinks) {
    const candidates = findCandidates(sink, index, { renameHints: input.renameHints });
    const assessment = assessSinkField(candidates);
    /** @type {Array<Record<string, any>>} */
    const edges = [];
    for (const candidate of candidates) {
      const competingKey = candidate.rule === RULE.DATETIME_MERGE
        ? `merge:${candidate.component}`
        : candidate.rule === RULE.DATETIME_SPLIT
          ? `split:${candidate.component}`
          : `value:${sink.value_kind}|${sink.canonical}`;
      const group = assessment.competition.find((entry) => entry.key === competingKey);
      const edge = buildEdge(candidate, {
        competing: Boolean(group),
        competingSourceCount: group ? group.source_events.length : 1,
      });
      edge.competition_key = competingKey;
      edges.push(edge);
      if (edge.representation === REPRESENTATION.INFERRED) inferred.push(edge);
      else observed.push(edge);
    }
    assessments.push({
      sink_event_id: sink.event_id,
      sink_json_path: sink.json_path,
      sink_json_paths: sink.json_paths ?? [sink.json_path],
      sink_upstream_app: sink.upstream_app,
      sink_tool_name: sink.tool_name,
      sink_timestamp_utc: sink.timestamp_utc,
      sink_order: sink.order,
      value_kind: sink.value_kind,
      canonical: sink.canonical,
      raw_value: sink.raw_value,
      sensitive: sink.sensitive === true,
      decision: assessment.decision,
      uncertainty_reasons: assessment.uncertainty_reasons,
      generic_reasons: assessment.generic_reasons,
      conflict: assessment.conflict,
      candidate_count: candidates.length,
      candidate_source_events: assessment.source_event_ids,
      competition: assessment.competition,
      candidates: edges.map((edge) => ({
        representation: edge.representation,
        rule: edge.rule,
        confidence: edge.confidence,
        source_event_id: edge.source_event_id,
        source_json_path: edge.source_json_path,
      })),
    });
  }

  return { observed, inferred, assessments, edges: [...observed, ...inferred] };
}
