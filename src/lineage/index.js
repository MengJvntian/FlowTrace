/**
 * src/lineage/index.js — P2 字段级数据流关联（L1）统一出口
 *
 * 典型用法（只读，不写库）：
 * ```js
 * import { openStore } from '../collector/store.js';
 * import { analyzeRun, assertNoCrossRunEdges } from './lineage/index.js';
 * const store = openStore('demo-data/events.db', { createDir: false });
 * const result = analyzeRun(store, 'exp_…');
 * console.log(result.edges.observed, result.edges.inferred); // 已观测 / 推断 分开
 * console.log(result.sink_assessments);                      // 每个写入字段的候选与判定
 * console.log(result.coverage.statements);                   // 敏感字段的标准措辞
 * assertNoCrossRunEdges(result);                             // 跨运行串线检查
 * ```
 */
export {
  CONFIDENCE,
  CONFIDENCE_RANK,
  DECISION,
  EXCLUSION,
  INFERRED_RULES,
  OBSERVED_RULES,
  REPRESENTATION,
  RULE,
  SEMANTIC,
  SENSITIVE_LABELS,
  SENSITIVE_SEMANTICS,
  TOOL_ACTION,
  VALUE_KIND,
} from './constants.js';

export {
  canonicallyEqual,
  canonicalNumericString,
  collapseWhitespace,
  describeValue,
  isGenericValue,
  isValidHms,
  isValidYmd,
  maskValue,
  normalizeValue,
  pad2,
  parseTemporal,
  semanticFromLabel,
  semanticFromLeaf,
  splitDatetime,
  stripTitleDecorations,
} from './normalize.js';

export {
  DEFAULT_SKIP_KEYS,
  extractLeaves,
  formatPath,
  isTextAnchorPath,
  parsePath,
  textAnchorBlockPath,
  textAnchorPath,
} from './paths.js';

export { DEFAULT_TOOL_POLICY, classifyTool, mergeToolPolicy, toolKey } from './tools.js';

export {
  collapseEventFields,
  collectRunFields,
  extractStructuredFields,
  extractTextFields,
  findTextMatches,
  parsePayload,
  resolveCallOutcomes,
  unwrapRequest,
  unwrapResponse,
} from './extract.js';

export {
  BASE_CONFIDENCE,
  assessSinkField,
  buildEdge,
  buildSourceIndex,
  confidenceOf,
  findCandidates,
  leafNameOf,
  linkFields,
  minConfidence,
  renameEvidence,
  representationOfRule,
  selectRule,
} from './rules.js';

export {
  BOUNDARIES,
  HASH_POLICY,
  analyzeEvents,
  analyzeRun,
  assertNoCrossRunEdges,
  buildCoverage,
  maskSensitiveResult,
  summarizeResult,
} from './analyze.js';
