/**
 * src/lineage/constants.js — P2 字段级关联的机器可读枚举（L1）
 *
 * 与 相关实现 是同一契约的两面：文档是人类可读唯一真源，本文件是常量。
 * 任何规则名/置信级别/判定值的改动必须同时改 相关实现 与本文件。
 */

/** 值类型（规范化后的语义类型；与 JSON 原生类型分开记录，见 `json_type`）。 */
export const VALUE_KIND = Object.freeze({
  STRING: 'string',
  NUMBER: 'number',
  BOOLEAN: 'boolean',
  DATE: 'date',
  TIME: 'time',
  DATETIME: 'datetime',
  PHONE: 'phone',
  EMAIL: 'email',
});

/** 语义字段名（由 JSON 路径叶子名或文本标签推断，仅作标注与脱敏线索，不参与匹配）。 */
export const SEMANTIC = Object.freeze({
  TITLE: 'title',
  DATE: 'date',
  TIME: 'time',
  DATETIME: 'datetime',
  PHONE: 'phone',
  EMAIL: 'email',
  ID: 'id',
  COUNT: 'count',
  TEXT: 'text',
  PLACE: 'place',
  NAME: 'name',
  OTHER: 'other',
});

/** 敏感语义（P3 负责展示层脱敏；L1 只负责标注）。 */
export const SENSITIVE_SEMANTICS = Object.freeze([SEMANTIC.PHONE, SEMANTIC.EMAIL]);

/** 敏感语义 → 中文名，用于计划书要求（第 5 条）的标准措辞。 */
export const SENSITIVE_LABELS = Object.freeze({
  [SEMANTIC.PHONE]: '手机号',
  [SEMANTIC.EMAIL]: '邮箱',
});

/** 边的表示方式：**必须分开返回**（计划书要求第 3 条）。 */
export const REPRESENTATION = Object.freeze({
  /** 同一规范化值在该次已观测的读响应与写请求中都出现。 */
  OBSERVED: 'observed',
  /** 由确定性规则（格式转换）推断，值本身并不相等。 */
  INFERRED: 'inferred',
});

/** 匹配规则名（写进边的 `rule` 字段）。 */
export const RULE = Object.freeze({
  /** 原样相等（值、JSON 类型都相同）。 */
  EXACT: 'exact_value',
  /** 写入段落逐字出现在较长的读取正文中；保留真实字段及字符范围。 */
  LITERAL_FRAGMENT: 'literal_fragment',
  /** 规范化后相等（空白/大小写/日期时间格式等价）。 */
  NORMALIZED: 'normalized_equivalence',
  /** 数字 ↔ 数值字符串等价。 */
  NUMBER_STRING: 'number_string_equivalence',
  /** 上游单个日期时间字段 → 下游拆分的日期/时间字段（格式转换，inferred）。 */
  DATETIME_SPLIT: 'datetime_split',
  /** 上游日期 + 时间字段 → 下游合并的日期时间字段（格式转换，inferred）。 */
  DATETIME_MERGE: 'datetime_merge',
});

/** observed 表示方式下允许出现的规则。 */
export const OBSERVED_RULES = Object.freeze([RULE.EXACT, RULE.LITERAL_FRAGMENT, RULE.NORMALIZED, RULE.NUMBER_STRING]);
/** inferred 表示方式下允许出现的规则。 */
export const INFERRED_RULES = Object.freeze([RULE.DATETIME_SPLIT, RULE.DATETIME_MERGE]);

/** 置信级别（定义见 相关实现）。 */
export const CONFIDENCE = Object.freeze({
  HIGH: 'high',
  MEDIUM: 'medium',
  LOW: 'low',
});

export const CONFIDENCE_RANK = Object.freeze({
  [CONFIDENCE.LOW]: 0,
  [CONFIDENCE.MEDIUM]: 1,
  [CONFIDENCE.HIGH]: 2,
});

/** 单个写入字段的血缘判定（计划书要求第 2 条：不得擅自定唯一血缘）。 */
export const DECISION = Object.freeze({
  /** 唯一候选来源，且该值不通用、无表示冲突。 */
  UNIQUE: 'unique',
  /** ≥2 个候选来源（同一个值在多条上游响应出现）。 */
  AMBIGUOUS: 'ambiguous',
  /** 只有 1 个候选来源，但该值属于通用值（纯日期/纯时间/小整数/常见词）或存在表示冲突。 */
  UNCERTAIN: 'uncertain',
  /** 该写入字段的规范化值在所有已观测读响应中都没有出现。 */
  NONE: 'none',
});

/** 事件被排除出数据流判定的原因（写在 diagnostics.excluded_events[].reason）。 */
export const EXCLUSION = Object.freeze({
  OTHER_RUN: 'other_experiment_run',
  PHASE: 'phase_not_dataflow',
  METHOD: 'method_not_tools_call',
  TOOL_UNKNOWN: 'tool_unknown',
  TOOL_IGNORED: 'tool_ignored',
  READ_REQUEST: 'read_request_not_sink',
  WRITE_RESPONSE: 'write_response_not_source',
  CALL_NOT_OK: 'call_status_not_ok',
  STATUS_NOT_OK: 'status_not_ok',
  PAYLOAD_ABSENT: 'payload_absent',
  PAYLOAD_TRUNCATED: 'payload_truncated',
  PAYLOAD_UNPARSABLE: 'payload_unparsable',
  ERROR_RESPONSE: 'error_response',
  NO_FIELDS: 'no_scalar_fields',
});

/** 工具动作（由 tools.js 判定）。 */
export const TOOL_ACTION = Object.freeze({
  READ: 'read',
  WRITE: 'write',
  IGNORE: 'ignore',
  UNKNOWN: 'unknown',
});

/** 数据流判定只考虑这三种 phase（相关实现）。 */
export const DATAFLOW_PHASES = Object.freeze(['request', 'response', 'error']);
