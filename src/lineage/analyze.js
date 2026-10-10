/**
 * src/lineage/analyze.js — P2 字段级数据流分析入口（L1）
 *
 * 一个 `experiment_run_id` 一份结果；**不同运行绝不串线**（`assertNoCrossRunEdges()` 可校验）。
 * `observed` 与 `inferred` 在接口层面**分开返回**（计划书要求第 3 条）：
 *   result.edges.observed / result.edges.inferred。
 *
 * 本模块只读 `TraceStore` 的查询方法（CONVENTIONS §3），不写库。
 */
import { nowUtcIso } from '../shared/time.js';
import {
  SENSITIVE_LABELS,
  SENSITIVE_SEMANTICS,
} from './constants.js';
import { collectRunFields } from './extract.js';
import { maskValue } from './normalize.js';
import { linkFields } from './rules.js';

/** 散列策略（写进每份结果，避免使用方误读）。 */
export const HASH_POLICY =
  'sha256 摘要只用于把候选来源分桶（O(1) 查找）；每条边都必须再经 canonicallyEqual() 逐字校验' +
  '规范化值，散列相同不足以建立边，也不得凭散列声明来源（计划书 §P2）。';

/** 必须显式声明的能力边界（写进每份结果，供页面与报告直接引用）。 */
export const BOUNDARIES = Object.freeze([
  '只覆盖经 Gateway 观测到的 stdio MCP 流量；客户端内部推理、绕过 Gateway 的直连调用不在范围内。',
  '字段级血缘要求 phase=request/response 事件保留原始载荷（--trace-enabled 默认开启）；载荷缺失、截断或无法解析的事件被排除，原因写在 diagnostics.excluded_events[].reason。',
  '规范化只做确定性等价：空白、大小写、日期时间格式、数字/字符串等价；不做语义相似、模糊匹配、时区换算与子串包含。',
  '纯日期 / 纯时间 / 小整数 / 常见词按计划书要求不得定唯一血缘：即使只有一个候选来源，也标记为 uncertain 并列出全部候选。',
  '只有终态为 ok 的调用参与血缘；失败调用（tool_iserror / protocol_error / transport_error / timeout / validation_error）与缺终态事件的调用只作为证据记录。',
  '“未在该已观测写入请求中发现某敏感字段”只陈述该次已观测的事实，不推断该字段在其他路径中是否传播。',
]);

/**
 * @param {Record<string, any>} field
 * @returns {string} phone / email / ''
 */
function sensitiveSemanticOf(field) {
  for (const semantic of field.semantics ?? []) {
    if (SENSITIVE_SEMANTICS.includes(semantic)) return semantic;
  }
  if (field.sensitive === true) {
    const leaf = String(field.leaf ?? '');
    if (/phone|mobile|tel/iu.test(leaf)) return 'phone';
    if (/mail/iu.test(leaf)) return 'email';
  }
  return '';
}

/**
 * 覆盖度：敏感字段是否出现在**已观测的写入请求**中（计划书 §P1 措辞与要求第 5 条）。
 * @param {{sourceFields: Array<Record<string, any>>, edges: Array<Record<string, any>>, sinkFields: Array<Record<string, any>>}} input
 * @returns {Record<string, any>}
 */
export function buildCoverage(input) {
  const writeEvents = new Set(input.sinkFields.map((field) => field.event_id));
  const edgeSources = new Set(input.edges.map((edge) => `${edge.source_event_id}|${edge.source_json_path}`));

  /** @type {Array<Record<string, any>>} */
  const notFound = [];
  /** @type {Array<Record<string, any>>} */
  const found = [];
  const seen = new Set();
  for (const field of input.sourceFields) {
    const semantic = sensitiveSemanticOf(field);
    if (semantic === '') continue;
    const key = `${field.event_id}|${field.json_path}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const label = SENSITIVE_LABELS[semantic] ?? semantic;
    if (edgeSources.has(key)) {
      const edge = input.edges.find(
        (candidate) => candidate.source_event_id === field.event_id && candidate.source_json_path === field.json_path,
      );
      found.push({
        semantic,
        label,
        source_event_id: field.event_id,
        source_json_path: field.json_path,
        sink_event_id: edge?.sink_event_id ?? null,
        sink_json_path: edge?.sink_json_path ?? null,
        rule: edge?.rule ?? null,
        representation: edge?.representation ?? null,
        confidence: edge?.confidence ?? null,
        status: 'found_in_observed_write_request',
      });
      continue;
    }
    notFound.push({
      semantic,
      label,
      source_event_id: field.event_id,
      source_json_path: field.json_path,
      value_digest: field.digest,
      sensitive: true,
      status: 'not_found_in_observed_write_requests',
      observed_write_request_count: writeEvents.size,
      statement: `未在该已观测写入请求中发现${label}`,
    });
  }

  const statements = [...new Set(notFound.map((entry) => entry.statement))];
  return {
    observed_write_request_count: writeEvents.size,
    sensitive_source_fields: seen.size,
    found_in_observed_writes: found,
    not_found_in_observed_writes: notFound,
    statements,
    inference_note:
      '上述措辞只陈述“在该次已观测的读写请求中是否出现”这一事实；不得据此推断该字段在其他路径中是否传播。',
  };
}

/**
 * 事件集合 → 分析结果（不接触数据库，便于单测与评估）。
 * @param {Array<Record<string, any>>} events
 * @param {{
 *   experiment_run_id?: string | null,
 *   client_label?: string | null,
 *   run_id?: string | null,
 *   toolPolicy?: Record<string, string>,
 *   heuristicToolPolicy?: boolean,
 *   renameHints?: Record<string, string[]>,
 *   includeTextFields?: boolean,
 *   maxDepth?: number,
 *   maskSensitive?: boolean,
 *   clock?: () => string,
 *   valueKeyFn?: (field: Record<string, any>) => string,
 * }} [options]
 * @returns {Record<string, any>}
 */
export function analyzeEvents(events, options = {}) {
  if (!Array.isArray(events)) throw new TypeError('analyzeEvents(events) 需要事件数组');
  const experimentRunId = options.experiment_run_id ?? null;
  const extracted = collectRunFields(events, {
    experiment_run_id: experimentRunId,
    toolPolicy: options.toolPolicy,
    heuristicToolPolicy: options.heuristicToolPolicy,
    includeTextFields: options.includeTextFields,
    maxDepth: options.maxDepth,
  });
  const linked = linkFields({
    sourceFields: extracted.source_fields,
    sinkFields: extracted.sink_fields,
    renameHints: options.renameHints,
    valueKeyFn: options.valueKeyFn,
  });
  const coverage = buildCoverage({
    sourceFields: extracted.source_fields,
    sinkFields: extracted.sink_fields,
    edges: linked.edges,
  });

  /** @type {Record<string, number>} */
  const decisionCounts = { unique: 0, ambiguous: 0, uncertain: 0, none: 0 };
  for (const assessment of linked.assessments) {
    decisionCounts[assessment.decision] = (decisionCounts[assessment.decision] ?? 0) + 1;
  }

  const clientLabel =
    options.client_label ??
    extracted.source_fields[0]?.client_label ??
    extracted.sink_fields[0]?.client_label ??
    null;

  /** @type {Record<string, any>} */
  const result = {
    ok: true,
    experiment_run_id: experimentRunId,
    run_id: options.run_id ?? null,
    client_label: clientLabel,
    generated_at_utc: (options.clock ?? nowUtcIso)(),
    events_total: extracted.diagnostics.counters.events_total,
    events_considered: extracted.diagnostics.counters.events_considered,
    events_excluded: extracted.diagnostics.counters.events_excluded,
    source_fields: extracted.source_fields,
    sink_fields: extracted.sink_fields,
    edges: {
      observed: linked.observed,
      inferred: linked.inferred,
      all: linked.edges,
    },
    sink_assessments: linked.assessments,
    coverage,
    diagnostics: {
      ...extracted.diagnostics,
      run_ids: extracted.run_ids,
      participating_run_ids: [
        ...new Set(
          [...extracted.source_fields, ...extracted.sink_fields].map(
            (field) => field.experiment_run_id ?? field.run_id ?? null,
          ),
        ),
      ].filter((value) => value !== null),
    },
    counts: {
      source_fields: extracted.source_fields.length,
      sink_fields: extracted.sink_fields.length,
      observed_edges: linked.observed.length,
      inferred_edges: linked.inferred.length,
      decisions: decisionCounts,
    },
    hash_policy: HASH_POLICY,
    boundaries: [...BOUNDARIES],
  };

  return options.maskSensitive === true ? maskSensitiveResult(result) : result;
}

/**
 * 从 `TraceStore` 读取一个运行的完整事件并分析。
 * @param {{listEvents: Function, getRun?: Function}} store
 * @param {string} experimentRunId
 * @param {Record<string, any>} [options]
 * @returns {Record<string, any>}
 */
export function analyzeRun(store, experimentRunId, options = {}) {
  if (!store || typeof store.listEvents !== 'function') {
    throw new TypeError('analyzeRun(store, id) 需要具备 listEvents() 的 TraceStore');
  }
  if (typeof experimentRunId !== 'string' || experimentRunId === '') {
    throw new TypeError('analyzeRun: experiment_run_id 必须是非空字符串');
  }
  const events = store.listEvents({ experiment_run_id: experimentRunId });
  /** @type {Record<string, any> | null} */
  let run = null;
  if (typeof store.getRun === 'function') {
    try {
      run = store.getRun(experimentRunId) ?? null;
    } catch {
      run = null;
    }
  }
  return analyzeEvents(events, {
    ...options,
    experiment_run_id: experimentRunId,
    run_id: run?.run_id ?? null,
    client_label: options.client_label ?? run?.client_label ?? null,
  });
}

/**
 * 断言没有跨运行串线（计划书要求第 4 条：两个任务交错不得串线）。
 * @param {Record<string, any>} result
 * @returns {Array<Record<string, any>>} 违规列表（空数组=通过）
 */
export function assertNoCrossRunEdges(result) {
  const expected = result?.experiment_run_id ?? null;
  /** @type {Array<Record<string, any>>} */
  const violations = [];
  if (typeof expected !== 'string' || expected === '') return violations;

  /** @type {Map<string, string|null>} */
  const runOfEvent = new Map();
  for (const field of [...(result.source_fields ?? []), ...(result.sink_fields ?? [])]) {
    const runKey = field.experiment_run_id ?? field.run_id ?? null;
    runOfEvent.set(field.event_id, runKey);
    if (runKey !== expected) {
      violations.push({
        kind: 'field_outside_run',
        event_id: field.event_id,
        role: field.role,
        json_path: field.json_path,
        run: runKey,
      });
    }
  }
  for (const edge of result.edges?.all ?? []) {
    const sourceRun = runOfEvent.get(edge.source_event_id);
    const sinkRun = runOfEvent.get(edge.sink_event_id);
    if (sourceRun === undefined || sinkRun === undefined) {
      violations.push({ kind: 'unknown_event_in_edge', edge });
      continue;
    }
    if (sourceRun !== expected || sinkRun !== expected) {
      violations.push({
        kind: 'cross_run_edge',
        source_event_id: edge.source_event_id,
        sink_event_id: edge.sink_event_id,
        source_run: sourceRun,
        sink_run: sinkRun,
      });
    }
  }
  return violations;
}

/**
 * 结果的紧凑摘要（CLI 与测试用）。
 * @param {Record<string, any>} result
 * @returns {Record<string, any>}
 */
export function summarizeResult(result) {
  return {
    experiment_run_id: result.experiment_run_id,
    client_label: result.client_label,
    events_total: result.events_total,
    events_considered: result.events_considered,
    events_excluded: result.events_excluded,
    source_fields: result.counts.source_fields,
    sink_fields: result.counts.sink_fields,
    observed_edges: result.counts.observed_edges,
    inferred_edges: result.counts.inferred_edges,
    decisions: result.counts.decisions,
    statements: result.coverage.statements,
    excluded_by_reason: result.diagnostics.excluded_by_reason,
  };
}

/**
 * 脱敏投影（**只用于展示**；P3 的隐私策略见 相关实现）。
 * 分析本身始终使用原始值比较，脱敏发生在结果投影阶段，不改变任何边的成立与否。
 * @param {Record<string, any>} result
 * @returns {Record<string, any>}
 */
export function maskSensitiveResult(result) {
  /**
   * @param {*} node
   * @returns {*}
   */
  function walk(node) {
    if (Array.isArray(node)) return node.map(walk);
    if (node === null || typeof node !== 'object') return node;
    /** @type {Record<string, any>} */
    const out = {};
    const sensitive = node.sensitive === true || SENSITIVE_SEMANTICS.includes(node.semantic);
    for (const [key, value] of Object.entries(node)) {
      if (sensitive && (key === 'raw_value' || key === 'value') && value !== undefined && value !== null) {
        out[key] = maskValue(value, node.value_kind ?? '');
        out.value_masked = true;
        continue;
      }
      if (
        (key === 'source_value' || key === 'sink_value') &&
        (node.value_kind === 'phone' || node.value_kind === 'email')
      ) {
        out[key] = maskValue(value, node.value_kind);
        out.value_masked = true;
        continue;
      }
      out[key] = walk(value);
    }
    if (sensitive) out.masked = true;
    return out;
  }
  return walk(result);
}
