/**
 * src/web/edges.js — P3 流向图与单条边证据（W1）
 *
 * 数据来源**完全是 L1 的 `analyzeRun()` 结果**（不自己重算血缘、不另立判据）：
 *   - `edges.observed` / `edges.inferred` **分开返回、分开渲染**（团队硬约束：不得合并成一个枚举）；
 *   - `sink_assessments[].decision` 的 multi-candidate 情况**全部列出候选**，页面不替用户择一；
 *   - `coverage.statements` **原文展示**（例如「未在该已观测写入请求中发现手机号」），
 *     绝不改写成「未泄露 / 未传播」这类强断言；
 *   - 能力边界（`boundaries`）、散列用途（`hash_policy`）原文进响应。
 *
 * 四种边界（要求 5）在接口层就是**四个独立字段**，视觉上四种色/线型 + 四种文案：
 *   observed（已观测）/ inferred（推断）/ uncertain（不确定）/ not_covered（未覆盖）。
 *
 * 展示层脱敏：所有值（边的 source_value/sink_value/canonical、字段 raw_value）都经
 * `maskFn(value, leafKey)` 投影；脱敏只影响展示，不影响任何边的成立与否。
 */
import { createHash } from 'node:crypto';
import { analyzeRun, assertNoCrossRunEdges, parsePath, isTextAnchorPath, textAnchorBlockPath } from '../lineage/index.js';
import { formatUtcLocal, runKeyMatcher, UNASSIGNED } from './aggregate.js';

/** 四种边界的键（页面必须分别渲染）。 */
export const BOUNDARY_KEYS = Object.freeze(['observed', 'inferred', 'uncertain', 'not_covered']);

export const BOUNDARY_DEFINITIONS = Object.freeze({
  observed: {
    key: 'observed',
    label: '已观测',
    tone: 'observed',
    definition: '内容在已观测的读响应与写请求中都出现，包括完整值匹配和保留字符位置的原文摘录（rule: exact_value / literal_fragment / normalized_equivalence / number_string_equivalence）。',
  },
  inferred: {
    key: 'inferred',
    label: '推断',
    tone: 'inferred',
    definition: '由确定性格式转换规则推出，两侧值本身不相等（rule: datetime_split / datetime_merge）。',
  },
  uncertain: {
    key: 'uncertain',
    label: '不确定',
    tone: 'uncertain',
    definition: '存在候选来源但不得定唯一血缘：多个候选来源（ambiguous）或通用值/表示冲突（uncertain）；候选全部列出，页面不替用户择一。',
  },
  not_covered: {
    key: 'not_covered',
    label: '未覆盖',
    tone: 'uncovered',
    definition: '只陈述「在已观测的读写请求中是否出现」这一事实；不推断该字段在其他路径中是否传播。',
  },
});

/** 指标限定语（团队要求：不得把同期标注集的一致性讲成泛化准确率）。 */
export const METRIC_DISCLAIMER =
  '本页面不展示准确率指标。L1 参考实现与评估工具报告过的 precision/recall/F1 = 1.0000 ' +
  '只表示与其**同期人工编写的标注样例集（13 个运行 / 32 条标注边）**一致，' +
  '并不意味着真实场景准确率；该标注集与实现同期编写，存在过拟合风险，且其中 14 条预测边来自显式白名单。' +
  '页面只展示本运行内可逐条回溯的事实计数。';

/**
 * 稳定边 ID：同一运行内 `representation|rule|source_event|source_path|sink_event|sink_path` 的 sha256 前 16 位。
 * @param {Record<string, any>} edge
 * @returns {string}
 */
export function edgeIdOf(edge) {
  const key = [
    edge?.representation ?? '',
    edge?.rule ?? '',
    edge?.source_event_id ?? '',
    edge?.source_json_path ?? '',
    edge?.sink_event_id ?? '',
    edge?.sink_json_path ?? '',
  ].join('|');
  return `edge_${createHash('sha256').update(key).digest('hex').slice(0, 16)}`;
}

/**
 * JSON 路径 → 叶子键（用于键名级脱敏；文本锚点路径取锚点类型）。
 * @param {string} jsonPath
 * @returns {string}
 */
export function leafKeyOf(jsonPath) {
  if (typeof jsonPath !== 'string' || jsonPath === '') return '';
  const anchor = jsonPath.indexOf('#');
  if (anchor !== -1) return jsonPath.slice(anchor + 1).replace(/\[\d+\]$/u, '');
  try {
    const segments = parsePath(jsonPath);
    const last = segments[segments.length - 1];
    return typeof last === 'string' ? last : '';
  } catch {
    const parts = jsonPath.split('.');
    return parts[parts.length - 1].replace(/\[\d+\]$/u, '');
  }
}

/**
 * @param {*} value
 * @param {string} jsonPath
 * @param {Function | null} maskFn
 * @returns {*}
 */
function maskAt(value, jsonPath, maskFn) {
  if (typeof maskFn !== 'function') return value === undefined ? null : value;
  return maskFn(value === undefined ? null : value, leafKeyOf(jsonPath)).value;
}

/**
 * 运行的事件列表（与 L1 `analyzeRun` 使用同一过滤：只按 experiment_run_id）。
 * @param {Record<string, any>} store
 * @param {string} runKey
 * @returns {Array<Record<string, any>>}
 */
function eventsOf(store, runKey) {
  // 与 aggregate.js 的 buildRunTimeline 同一套语义：`(unassigned)` 不是一个真实的运行 id，
  // 而是「两个字段都为空」那批记录的显示值。
  // 同样**不能**把 '(unassigned)' 交给 store 当过滤条件（按 SQL 精确匹配只会得到 0 行），
  // 未归属时取全量再在内存里过滤。
  const match = runKeyMatcher(runKey);
  const query = runKey === UNASSIGNED ? { order: 'asc' } : { experiment_run_id: runKey, order: 'asc' };
  return store.listEvents(query).filter(match);
}

/**
 * 构建流向图数据（含四种边界、边、候选判定、覆盖度原文与证据索引）。
 *
 * @param {Record<string, any>} store 只读 store 门面
 * @param {string} runKey experiment_run_id
 * @param {{maskFn?: Function | null, maskStats?: Record<string, any>, previewChars?: number, events?: Array<Record<string, any>>, runSummary?: Record<string, any>}} [options]
 * @returns {Record<string, any>}
 */
export function buildRunFlows(store, runKey, options = {}) {
  const maskFn = typeof options.maskFn === 'function' ? options.maskFn : null;
  const events = options.events ?? eventsOf(store, runKey);
  const result = analyzeRun(store, runKey, {});
  const crossRun = assertNoCrossRunEdges(result);

  /** @type {Map<string, Record<string, any>>} */
  const eventById = new Map(events.map((event) => [event.event_id, event]));
  /** @type {Map<string, Record<string, any>>} */
  const fieldByEvent = new Map();
  for (const field of [...(result.source_fields ?? []), ...(result.sink_fields ?? [])]) {
    if (!fieldByEvent.has(field.event_id)) fieldByEvent.set(field.event_id, field);
  }

  /**
   * 边 → 响应对象（脱敏 + 边 ID + 证据回溯指针）。
   * @param {Record<string, any>} edge
   * @returns {Record<string, any>}
   */
  function projectEdge(edge) {
    const sourceLeaf = leafKeyOf(edge.source_json_path);
    const sinkLeaf = leafKeyOf(edge.sink_json_path);
    return {
      edge_id: edgeIdOf(edge),
      representation: edge.representation,
      boundary: edge.representation === 'inferred' ? 'inferred' : 'observed',
      boundary_label: edge.representation === 'inferred' ? '推断' : '已观测',
      rule: edge.rule,
      confidence: edge.confidence,
      confidence_reasons: edge.confidence_reasons ?? [],
      source_event_id: edge.source_event_id,
      source_json_path: edge.source_json_path,
      source_json_paths: edge.source_json_paths ?? [],
      source_upstream_app: edge.source_upstream_app,
      source_tool_name: edge.source_tool_name,
      source_phase: edge.source_phase,
      source_leaf: sourceLeaf,
      source_value_masked: maskAt(edge.source_value, edge.source_json_path, maskFn),
      sink_event_id: edge.sink_event_id,
      sink_json_path: edge.sink_json_path,
      sink_json_paths: edge.sink_json_paths ?? [],
      sink_upstream_app: edge.sink_upstream_app,
      sink_tool_name: edge.sink_tool_name,
      sink_phase: edge.sink_phase,
      sink_leaf: sinkLeaf,
      sink_value_masked: maskAt(edge.sink_value, edge.sink_json_path, maskFn),
      value_kind: edge.value_kind,
      canonical_masked: maskAt(edge.canonical, edge.sink_json_path, maskFn),
      shared_canonical: edge.shared_canonical === true,
      competing_source_count: edge.competing_source_count ?? 1,
      competition_key: edge.competition_key ?? null,
      evidence: {
        hash: edge.evidence?.hash ?? null,
        normalization: {
          source_transforms: edge.evidence?.normalization?.source_transforms ?? [],
          sink_transforms: edge.evidence?.normalization?.sink_transforms ?? [],
          comparable: edge.evidence?.normalization?.comparable ?? false,
        },
        representation: edge.evidence?.representation ?? null,
        rename: edge.evidence?.rename ?? null,
        cross_app: edge.evidence?.cross_app === true,
        generic: edge.evidence?.generic ?? null,
        component: edge.evidence?.component ?? null,
        literal_fragment: edge.evidence?.literal_fragment ? {
          ...edge.evidence.literal_fragment,
          matched_text: maskAt(edge.evidence.literal_fragment.matched_text, edge.sink_json_path, maskFn),
        } : null,
        format_conversion: edge.evidence?.format_conversion ?? null,
        contradiction: edge.evidence?.contradiction ?? null,
        times: edge.evidence?.times ?? null,
      },
      raw_access: {
        note: '原文不在此响应中：仅给出受控访问入口（需要 ack=1 与理由，且会写入审计记录）。',
        source_url: rawAccessUrl('auto', edge.source_event_id, edge.source_json_path),
        sink_url: rawAccessUrl('auto', edge.sink_event_id, edge.sink_json_path),
      },
    };
  }

  const observed = (result.edges?.observed ?? []).map(projectEdge);
  const inferred = (result.edges?.inferred ?? []).map(projectEdge);

  const assessments = (result.sink_assessments ?? []).map((assessment) => ({
    sink_event_id: assessment.sink_event_id,
    sink_json_path: assessment.sink_json_path,
    sink_json_paths: assessment.sink_json_paths ?? [],
    sink_upstream_app: assessment.sink_upstream_app,
    sink_tool_name: assessment.sink_tool_name,
    sink_timestamp_utc: assessment.sink_timestamp_utc,
    sink_timestamp_local: formatUtcLocal(assessment.sink_timestamp_utc).local_label,
    value_kind: assessment.value_kind,
    sensitive: assessment.sensitive === true,
    raw_value_masked: maskAt(assessment.raw_value, assessment.sink_json_path, maskFn),
    decision: assessment.decision,
    boundary:
      assessment.decision === 'none'
        ? 'not_covered'
        : assessment.decision === 'unique'
          ? 'observed'
          : 'uncertain',
    uncertainty_reasons: assessment.uncertainty_reasons ?? [],
    generic_reasons: assessment.generic_reasons ?? [],
    conflict: assessment.conflict === true,
    candidate_count: assessment.candidate_count ?? 0,
    candidate_source_events: assessment.candidate_source_events ?? [],
    competition: assessment.competition ?? [],
    candidates: (assessment.candidates ?? []).map((candidate) => ({
      representation: candidate.representation,
      rule: candidate.rule,
      confidence: candidate.confidence,
      source_event_id: candidate.source_event_id,
      source_json_path: candidate.source_json_path,
      source_value_masked: maskAt(
        findSourceValue(events, result, candidate.source_event_id, candidate.source_json_path),
        candidate.source_json_path,
        maskFn,
      ),
      edge_id: edgeIdOf({
        representation: candidate.representation,
        rule: candidate.rule,
        source_event_id: candidate.source_event_id,
        source_json_path: candidate.source_json_path,
        sink_event_id: assessment.sink_event_id,
        sink_json_path: assessment.sink_json_path,
      }),
      raw_access_url: rawAccessUrl('auto', candidate.source_event_id, candidate.source_json_path),
    })),
  }));

  const coverage = {
    observed_write_request_count: result.coverage?.observed_write_request_count ?? 0,
    sensitive_source_fields: result.coverage?.sensitive_source_fields ?? 0,
    statements: result.coverage?.statements ?? [],
    found_in_observed_writes: (result.coverage?.found_in_observed_writes ?? []).map((entry) => ({
      ...entry,
      value_masked: maskAt(findSourceValue(events, result, entry.source_event_id, entry.source_json_path), entry.source_json_path, maskFn),
    })),
    not_found_in_observed_writes: (result.coverage?.not_found_in_observed_writes ?? []).map((entry) => ({
      semantic: entry.semantic,
      label: entry.label,
      source_event_id: entry.source_event_id,
      source_json_path: entry.source_json_path,
      value_digest: entry.value_digest ?? null,
      sensitive: true,
      status: entry.status,
      observed_write_request_count: entry.observed_write_request_count ?? null,
      statement: entry.statement,
      value_masked: maskAt(findSourceValue(events, result, entry.source_event_id, entry.source_json_path), entry.source_json_path, maskFn),
      raw_access_url: rawAccessUrl('auto', entry.source_event_id, entry.source_json_path),
    })),
    inference_note: result.coverage?.inference_note ?? null,
  };

  const uncertainAssessments = assessments.filter((entry) => entry.boundary === 'uncertain');
  const notCoveredAssessments = assessments.filter((entry) => entry.boundary === 'not_covered');

  /** @type {Array<Record<string, any>>} */
  const boundaries = [
    {
      ...BOUNDARY_DEFINITIONS.observed,
      count: observed.length,
      items: observed,
      empty_note: '本运行没有「已观测」边。',
    },
    {
      ...BOUNDARY_DEFINITIONS.inferred,
      count: inferred.length,
      items: inferred,
      empty_note: '本运行没有「推断」边（推断只来自 datetime_split / datetime_merge 两条确定性格式转换规则）。',
    },
    {
      ...BOUNDARY_DEFINITIONS.uncertain,
      count: uncertainAssessments.length,
      items: uncertainAssessments,
      empty_note: '本运行没有「不确定」的写入字段。',
    },
    {
      ...BOUNDARY_DEFINITIONS.not_covered,
      count: notCoveredAssessments.length + coverage.not_found_in_observed_writes.length,
      items: notCoveredAssessments,
      coverage_statements: coverage.statements,
      coverage_items: coverage.not_found_in_observed_writes,
      empty_note: '本运行没有「未覆盖」的判定。',
    },
  ];

  const sourceNodes = buildSourceNodes(observed, inferred, fieldByEvent);
  const sinkNodes = buildSinkNodes(assessments);
  const links = [...observed, ...inferred].map((edge) => ({
    link_id: `${edge.edge_id}:link`,
    edge_id: edge.edge_id,
    source_node_id: `${edge.source_event_id}|${edge.source_json_path}`,
    sink_node_id: `${edge.sink_event_id}|${edge.sink_json_path}`,
    representation: edge.representation,
    boundary: edge.boundary,
    rule: edge.rule,
    confidence: edge.confidence,
  }));

  const excludedEvents = (result.diagnostics?.excluded_events ?? []).slice(0, 200).map((entry) => ({
    event_id: entry.event_id ?? null,
    gateway_call_id: entry.gateway_call_id ?? null,
    upstream_app: entry.upstream_app ?? null,
    tool_name: entry.tool_name ?? null,
    phase: entry.phase ?? null,
    reason: entry.reason ?? null,
    detail: entry.detail ?? null,
  }));

  return {
    ok: true,
    experiment_run_id: result.experiment_run_id ?? runKey,
    run_id: result.run_id ?? null,
    client_label: result.client_label ?? null,
    generated_at_utc: result.generated_at_utc ?? null,
    counts: {
      ...(result.counts ?? {}),
      sink_fields: assessments.length,
    },
    boundaries,
    edges: { observed, inferred },
    sink_assessments: assessments,
    coverage,
    graph: {
      source_nodes: sourceNodes,
      sink_nodes: sinkNodes,
      links,
      apps: [...new Set([...sourceNodes.map((node) => node.app), ...sinkNodes.map((node) => node.app)])].filter(Boolean),
      direction: '读侧（Mail 等只读工具的 response） → 写侧（Calendar 等写入工具的 request）',
    },
    diagnostics: {
      excluded_by_reason: result.diagnostics?.excluded_by_reason ?? {},
      excluded_events: excludedEvents,
      counters: result.diagnostics?.counters ?? {},
      participating_run_ids: result.diagnostics?.participating_run_ids ?? [],
    },
    cross_run_check: { checked: true, violations: crossRun, ok: crossRun.length === 0 },
    boundaries_text: result.boundaries ?? [],
    hash_policy: result.hash_policy ?? null,
    metric_note: METRIC_DISCLAIMER,
    boundary_legend: BOUNDARY_KEYS.map((key) => BOUNDARY_DEFINITIONS[key]),
  };
}

/**
 * @param {Array<Record<string, any>>} observed
 * @param {Array<Record<string, any>>} inferred
 * @param {Map<string, Record<string, any>>} fieldByEvent
 * @returns {Array<Record<string, any>>}
 */
function buildSourceNodes(observed, inferred, fieldByEvent) {
  /** @type {Map<string, Record<string, any>>} */
  const nodes = new Map();
  for (const edge of [...observed, ...inferred]) {
    const id = `${edge.source_event_id}|${edge.source_json_path}`;
    if (nodes.has(id)) continue;
    const field = fieldByEvent.get(edge.source_event_id) ?? {};
    nodes.set(id, {
      node_id: id,
      side: 'source',
      app: edge.source_upstream_app,
      tool_name: edge.source_tool_name,
      phase: edge.source_phase,
      event_id: edge.source_event_id,
      gateway_call_id: field.gateway_call_id ?? null,
      json_path: edge.source_json_path,
      json_paths: edge.source_json_paths,
      leaf: edge.source_leaf,
      value_masked: edge.source_value_masked,
      value_kind: edge.value_kind,
      cross_app: edge.evidence?.cross_app === true,
    });
  }
  return [...nodes.values()];
}

/**
 * @param {Array<Record<string, any>>} assessments
 * @returns {Array<Record<string, any>>}
 */
function buildSinkNodes(assessments) {
  return assessments.map((assessment) => ({
    node_id: `${assessment.sink_event_id}|${assessment.sink_json_path}`,
    side: 'sink',
    app: assessment.sink_upstream_app,
    tool_name: assessment.sink_tool_name,
    event_id: assessment.sink_event_id,
    json_path: assessment.sink_json_path,
    leaf: leafKeyOf(assessment.sink_json_path),
    value_masked: assessment.raw_value_masked,
    value_kind: assessment.value_kind,
    decision: assessment.decision,
    boundary: assessment.boundary,
    candidate_count: assessment.candidate_count,
    candidates: assessment.candidates,
    uncertainty_reasons: assessment.uncertainty_reasons,
    sensitive: assessment.sensitive,
  }));
}

/**
 * 在分析结果里找某个来源字段的原始值（只读，不推断）。
 * @param {Array<Record<string, any>>} events
 * @param {Record<string, any>} result
 * @param {string} eventId
 * @param {string} jsonPath
 * @returns {*}
 */
function findSourceValue(events, result, eventId, jsonPath) {
  const field = [...(result.source_fields ?? []), ...(result.sink_fields ?? [])].find(
    (candidate) => candidate.event_id === eventId && (candidate.json_path === jsonPath || (candidate.json_paths ?? []).includes(jsonPath)),
  );
  if (field && field.raw_value !== undefined) return field.raw_value;
  const event = events.find((candidate) => candidate.event_id === eventId);
  if (!event) return null;
  return null;
}

/**
 * 受控查看原文的 URL（页面按钮直接用；调用方必须自己附 ack/reason）。
 * @param {string} payload auto / request / response
 * @param {string} eventId
 * @param {string} jsonPath
 * @returns {string}
 */
export function rawAccessUrl(payload, eventId, jsonPath) {
  const params = new URLSearchParams();
  params.set('payload', payload);
  params.set('event_id', eventId);
  // 血缘对「纯文本里的值」用**文本锚点路径**（`result.content[0].text#date[0]`），
  // 而 /api/raw 的路径解析是严格 JSON 路径解析、不认识 `#kind[n]` 后缀 —— 直接把锚点路径
  // 传过去会 404（2026-10-05 实测：--self-check 的 raw_requires_gate 因此失败，
  // 页面上的「查看原文」按钮同样会 404）。
  //
  // 处理：锚点路径在**发起受控查看前**降级为它所属的内容块路径（`result.content[0].text`），
  // 语义仍然正确 —— 受控查看本来就是「看这块原文」，锚点的 span 由血缘证据卡单独展示。
  // 锚点后缀另外放进 `anchor` 查询参数（页面据此高亮）：
  //   ⚠️ **不要**放 URL fragment —— 调用方会把 `&ack=1&reason=…` 拼到本 URL 后面，
  //   而 fragment 之后的内容会被当成 fragment 的一部分丢掉，结果「合规请求」变成缺少理由 → 400
  //   （2026-10-05 实测：`--self-check` 的 raw_requires_gate 正是这样从 200 变成 400）。
  // 用血缘模块自己的 isTextAnchorPath/textAnchorBlockPath，避免两处各写一套正则。
  const isAnchor = isTextAnchorPath(jsonPath);
  const blockPath = isAnchor ? textAnchorBlockPath(jsonPath) : jsonPath;
  params.set('path', blockPath ?? '');
  if (isAnchor) {
    const suffix = String(jsonPath).slice(String(jsonPath).indexOf('#') + 1);
    if (suffix !== '') params.set('anchor', suffix);
  }
  return `/api/raw?${params.toString()}`;
}

/** 页面上可显示的四边界键（供测试直接断言）。 */
export function boundaryKeys() {
  return [...BOUNDARY_KEYS];
}
