/* src/web/public/filters.js — 首页筛选的**纯逻辑**（浏览器与自动化测试共用同一份代码）
 *
 * 为什么单独成文件：
 *   1) 首页脚本要「真的筛数据」，而不是只改样式——把判定写成纯函数，测试可以用 `node:vm`
 *      加载**同一个文件**并喂真实 API 数据，断言「无筛选 / 施加筛选」下的可见集合确实不同；
 *   2) 深链（URL query）的解析/序列化也在这里，保证「复制链接 → 刷新 → 筛选保持」是同一条代码路径。
 *
 * 约束：经典脚本、无依赖、无 DOM 访问、无内联事件处理器；不出现任何系统/运维词汇（首页禁止词表由测试盯着）。
 * 只读语义不变：本文件不发任何请求，输入全部来自页面已经拿到的只读 GET 结果。
 */
(function (root) {
  'use strict';

  /** 单表最多渲染的行数（性能降级策略：超出只渲染前 N 行并显式提示，绝不静默截断）。 */
  var RENDER_CAP = 500;

  var REGISTRATION_VALUES = ['yes', 'implicit'];
  var PAIRING_RUN_VALUES = ['complete', 'incomplete'];
  var ANOMALY_VALUES = ['has', 'none'];
  var PAIRING_CALL_VALUES = ['paired', 'incomplete'];
  var CONFIDENCE_VALUES = ['high', 'medium', 'low'];
  var REPRESENTATION_VALUES = ['observed', 'inferred'];

  var DATE_RE = /^\d{4}-\d{2}-\d{2}$/u;

  /** 界面语言：状态值 → 给人看的中文标签（URL 与接口里仍是内部值）。 */
  var STATUS_LABELS = {
    ok: '正常',
    tool_iserror: '工具错误',
    protocol_error: '协议错误',
    transport_error: '传输错误',
    timeout: '超时',
    validation_error: '参数校验错误',
  };

  /** 界面语言：匹配规则 → 中文说明（规则名本身是证据术语，保留在括号外可见）。 */
  var RULE_LABELS = {
    exact_value: '原样相等',
    literal_fragment: '原文摘录',
    normalized_equivalence: '规范化等价',
    number_string_equivalence: '数字↔字符串等价',
    datetime_split: '时间拆分（推断）',
    datetime_merge: '时间合并（推断）',
  };

  /**
   * @param {string} value
   * @returns {string} 中文界面标签；未知值原样返回（不臆造）
   */
  function statusLabel(value) {
    var key = trimmed(value);
    return STATUS_LABELS[key] || key;
  }

  /**
   * @param {string} value
   * @returns {string} `中文说明（rule_name）`；未知规则原样返回
   */
  function ruleLabel(value) {
    var key = trimmed(value);
    return RULE_LABELS[key] || key;
  }

  /**
   * 边界摘要那一行的文本：**严格**是 `coverage.statements` 的逐字拼接，
   * 不拼接任何计数、不加前缀后缀（既有契约：四种边界的限定语原文不得改写）。
   * 筛选用独立的 KPI 元素表达，绝不进这一行。
   * @param {Array<string>} statements
   * @returns {string}
   */
  function statementsText(statements) {
    return (statements || []).join('　·　');
  }

  /* ------------------------------------------------------------------ 基础工具 */

  function str(value) {
    return value === null || value === undefined ? '' : String(value);
  }

  function trimmed(value) {
    return str(value).trim();
  }

  function oneOf(value, allowed) {
    var candidate = trimmed(value);
    return allowed.indexOf(candidate) === -1 ? '' : candidate;
  }

  function dateOf(value) {
    var candidate = trimmed(value);
    return DATE_RE.test(candidate) ? candidate : '';
  }

  /** @returns {Record<string, any>} 空筛选（全部为「不限」）。 */
  function createFilters() {
    return {
      runs: { registered: '', pairing: '', anomaly: '', client: '', query: '', from: '', to: '' },
      calls: { status: '', tool: '', transport: '', gateway: '', pairing: '', from: '', to: '' },
      flows: { confidence: '', rule: '', representation: '' },
    };
  }

  /* -------------------------------------------------------------- 深链（URL） */

  /* 自带的极简 query 编解码：**不依赖 URLSearchParams**。
     理由：一旦宿主环境缺这个 API，`new URLSearchParams()` 会抛错，而「捕获后返回全默认」会变成
     一种静默失败（筛选看着在、其实全没生效）。自带实现让解析在浏览器与测试里行为一致，也没有静默分支。 */

  function decodePart(value) {
    var raw = str(value).replace(/\+/gu, ' ');
    try {
      return decodeURIComponent(raw);
    } catch (error) {
      return raw;
    }
  }

  /**
   * `?a=1&b=2` → {a:'1', b:'2'}（同名键取第一个值，与 URLSearchParams.get 一致）。
   * @param {string} search
   * @returns {Record<string, string>}
   */
  function parseQuery(search) {
    /** @type {Record<string, string>} */
    var out = {};
    var text = str(search);
    if (text.charAt(0) === '?') text = text.slice(1);
    if (text === '') return out;
    text.split('&').forEach(function (pair) {
      if (pair === '') return;
      var eq = pair.indexOf('=');
      var key = decodePart(eq === -1 ? pair : pair.slice(0, eq));
      var value = decodePart(eq === -1 ? '' : pair.slice(eq + 1));
      if (Object.prototype.hasOwnProperty.call(out, key)) return;
      out[key] = value;
    });
    return out;
  }

  /**
   * [[key, value], …] → `key=value&…`（空值丢弃）。
   * @param {Array<[string, string]>} pairs
   * @returns {string}
   */
  function buildQuery(pairs) {
    return pairs
      .filter(function (pair) { return trimmed(pair[1]) !== ''; })
      .map(function (pair) { return encodeURIComponent(pair[0]) + '=' + encodeURIComponent(trimmed(pair[1])); })
      .join('&');
  }

  /**
   * URL query → 筛选状态（未知参数/非法取值一律安全忽略，不抛错）。
   * @param {string} search 形如 `?status=tool_iserror&run=exp_1`
   * @returns {Record<string, any>}
   */
  function parse(search) {
    var params = parseQuery(search);
    var get = function (key) {
      return Object.prototype.hasOwnProperty.call(params, key) ? params[key] : null;
    };
    var filters = createFilters();
    filters.runs.registered = oneOf(get('r_reg'), REGISTRATION_VALUES);
    filters.runs.pairing = oneOf(get('r_pair'), PAIRING_RUN_VALUES);
    filters.runs.anomaly = oneOf(get('r_anom'), ANOMALY_VALUES);
    filters.runs.client = trimmed(get('r_client'));
    filters.runs.query = trimmed(get('r_query'));
    filters.runs.from = dateOf(get('r_from'));
    filters.runs.to = dateOf(get('r_to'));
    filters.calls.status = trimmed(get('status'));
    filters.calls.tool = trimmed(get('tool'));
    filters.calls.transport = trimmed(get('transport'));
    filters.calls.gateway = trimmed(get('gateway'));
    filters.calls.pairing = oneOf(get('pair'), PAIRING_CALL_VALUES);
    filters.calls.from = dateOf(get('t_from'));
    filters.calls.to = dateOf(get('t_to'));
    filters.flows.confidence = oneOf(get('conf'), CONFIDENCE_VALUES);
    filters.flows.rule = trimmed(get('rule'));
    filters.flows.representation = oneOf(get('repr'), REPRESENTATION_VALUES);
    return filters;
  }

  /** @param {string} search */
  function runKeyOf(search) {
    var value = parseQuery(search).run;
    return value === undefined ? '' : trimmed(value);
  }

  /**
   * 筛选状态 → URL query（**只写非默认值**，顺序固定，便于断言与分享）。
   * @param {Record<string, any>} filters
   * @param {string} [runKey]
   * @returns {string}
   */
  function serialize(filters, runKey) {
    var runs = (filters && filters.runs) || {};
    var calls = (filters && filters.calls) || {};
    var flows = (filters && filters.flows) || {};
    return buildQuery([
      ['run', runKey || ''],
      ['r_reg', runs.registered || ''],
      ['r_pair', runs.pairing || ''],
      ['r_anom', runs.anomaly || ''],
      ['r_client', runs.client || ''],
      ['r_query', runs.query || ''],
      ['r_from', runs.from || ''],
      ['r_to', runs.to || ''],
      ['status', calls.status || ''],
      ['tool', calls.tool || ''],
      ['transport', calls.transport || ''],
      ['gateway', calls.gateway || ''],
      ['pair', calls.pairing || ''],
      ['t_from', calls.from || ''],
      ['t_to', calls.to || ''],
      ['conf', flows.confidence || ''],
      ['rule', flows.rule || ''],
      ['repr', flows.representation || ''],
    ]);
  }

  /** @param {Record<string, any>} filters @returns {boolean} 是否有任何生效条件 */
  function isActive(filters) {
    return activeEntries(filters).length > 0;
  }

  var LABELS = {
    'runs.registered': '登记方式',
    'runs.pairing': '是否缺对',
    'runs.anomaly': '是否异常',
    'runs.client': '客户端',
    'runs.query': '搜索任务',
    'runs.from': '开始日期起',
    'runs.to': '开始日期止',
    'calls.status': '状态',
    'calls.tool': '工具',
    'calls.transport': '通道',
    'calls.gateway': 'Gateway',
    'calls.pairing': '是否成对',
    'calls.from': '调用日期起',
    'calls.to': '调用日期止',
    'flows.confidence': '置信级别',
    'flows.rule': '规则',
    'flows.representation': '表示方式',
  };

  var VALUE_LABELS = {
    yes: '已登记',
    implicit: '隐式',
    complete: '全部成对',
    incomplete: '有缺对',
    has: '有异常',
    none: '无异常',
    paired: '已配对',
  };

  var GROUP_LABELS = { runs: '任务列表', calls: '调用时间线', flows: '字段流向图' };

  /**
   * 当前生效条件（用于「筛选状态可见」与「复制链接」前的摘要）。
   * @param {Record<string, any>} filters
   * @returns {Array<{group: string, groupLabel: string, key: string, label: string, value: string, display: string}>}
   */
  function activeEntries(filters) {
    /** @type {Array<Record<string, any>>} */
    var out = [];
    ['runs', 'calls', 'flows'].forEach(function (group) {
      var bucket = (filters && filters[group]) || {};
      Object.keys(bucket).forEach(function (key) {
        var value = trimmed(bucket[key]);
        if (value === '') return;
        var path = group + '.' + key;
        out.push({
          group: group,
          groupLabel: GROUP_LABELS[group] || group,
          key: path,
          label: LABELS[path] || key,
          value: value,
          display: value + (VALUE_LABELS[value] ? '（' + VALUE_LABELS[value] + '）' : ''),
        });
      });
    });
    return out;
  }

  /* -------------------------------------------------------------- 数据侧工具 */

  function runKey(run) {
    if (!run) return '';
    // `run_key` 是服务端给出的**权威标识**（src/web/api.js:174）：
    //   run_key = experiment_run_id ?? run_id ?? UNASSIGNED
    // 必须优先用它 —— 否则「未归属运行」（calls/events 里 run id 为空，例如 Gateway 早期
    // 或人工注入的数据）会被算成空串，页面随后拼接出 `/api/runs/undefined/timeline` → 404。
    // 这正是 2026-10-05 用户报「自动刷新失败」的根因：自动刷新每轮都会重选运行，
    // 选中那个条目就必然 404。
    var key = str(run.run_key) || str(run.experiment_run_id) || str(run.run_id);
    return key;
  }

  function isAnomalousRun(run) {
    var summary = (run && run.status_summary) || {};
    return Object.keys(summary).some(function (status) {
      return status !== 'ok' && Number(summary[status]) > 0;
    });
  }

  function hasIncompletePairing(run) {
    return Boolean(run && run.pairing && (run.pairing.incomplete || []).length > 0);
  }

  /** @param {Array<Record<string, any>>} events */
  function groupEventsByCall(events) {
    /** @type {Record<string, Array<Record<string, any>>>} */
    var index = {};
    (events || []).forEach(function (event) {
      var callId = str(event && event.gateway_call_id);
      if (callId === '') return;
      if (!index[callId]) index[callId] = [];
      index[callId].push(event);
    });
    return index;
  }

  /**
   * 一次调用的通道值：来自它自己的事件（时间线里事件带 transport）。
   * @param {Record<string, any>} call
   * @param {Record<string, Array<Record<string, any>>>} index
   */
  function transportOfCall(call, index) {
    var events = index[str(call && call.gateway_call_id)] || [];
    for (var i = 0; i < events.length; i += 1) {
      var transport = trimmed(events[i].transport);
      if (transport !== '') return transport;
    }
    return '';
  }

  /**
   * UTC 日期范围判断（按 YYYY-MM-DD 比较；缺时间戳的行在设了范围时不命中）。
   * @param {string} iso
   * @param {string} from
   * @param {string} to
   */
  function inDateRange(iso, from, to) {
    var day = str(iso).slice(0, 10);
    if (from === '' && to === '') return true;
    if (!DATE_RE.test(day)) return false;
    if (from !== '' && day < from) return false;
    if (to !== '' && day > to) return false;
    return true;
  }

  /** 判断一个「候选边」（sink_assessments[].candidates[]）是否通过流向图筛选。 */
  function candidateMatches(candidate, flowsFilter) {
    var f = flowsFilter || {};
    if (trimmed(f.confidence) !== '' && trimmed(candidate.confidence) !== trimmed(f.confidence)) return false;
    if (trimmed(f.rule) !== '' && trimmed(candidate.rule) !== trimmed(f.rule)) return false;
    if (trimmed(f.representation) !== '' && trimmed(candidate.representation) !== trimmed(f.representation)) return false;
    return true;
  }

  /* -------------------------------------------------------------------- 过滤 */

  /**
   * @param {Array<Record<string, any>>} runs
   * @param {Record<string, any>} f
   */
  function filterRuns(runs, f) {
    var filter = f || {};
    var wantClient = trimmed(filter.client).toLowerCase();
    return (runs || []).filter(function (run) {
      if (filter.registered === 'yes' && run.registered !== true) return false;
      if (filter.registered === 'implicit' && run.registered === true) return false;
      if (filter.pairing === 'complete' && hasIncompletePairing(run)) return false;
      if (filter.pairing === 'incomplete' && !hasIncompletePairing(run)) return false;
      var anomalous = isAnomalousRun(run);
      if (filter.anomaly === 'has' && !anomalous) return false;
      if (filter.anomaly === 'none' && anomalous) return false;
      if (wantClient !== '' && str(run.client_label).toLowerCase().indexOf(wantClient) === -1) return false;
      if (filter.query && [run.display_name, run.notes, runKey(run), run.client_label, (run.apps || []).join(' ')].join(' ').toLowerCase().indexOf(trimmed(filter.query).toLowerCase()) === -1) return false;
      if (!inDateRange(run.started_at_utc, filter.from || '', filter.to || '')) return false;
      return true;
    });
  }

  /**
   * @param {Array<Record<string, any>>} calls
   * @param {Array<Record<string, any>>} events
   * @param {Record<string, any>} f
   */
  function filterCalls(calls, events, f) {
    var filter = f || {};
    var index = groupEventsByCall(events);
    return (calls || []).filter(function (call) {
      if (trimmed(filter.status) !== '' && trimmed(call.status) !== trimmed(filter.status)) return false;
      if (trimmed(filter.tool) !== '' && trimmed(call.tool_name) !== trimmed(filter.tool)) return false;
      if (trimmed(filter.transport) !== '' && transportOfCall(call, index) !== trimmed(filter.transport)) return false;
      if (trimmed(filter.gateway) !== '' && trimmed(call.gateway_id) !== trimmed(filter.gateway)) return false;
      if (filter.pairing === 'incomplete' && call.pairing_incomplete !== true) return false;
      if (filter.pairing === 'paired' && call.paired !== true) return false;
      if (!inDateRange(call.started_at_utc, filter.from || '', filter.to || '')) return false;
      return true;
    });
  }

  /**
   * @param {Array<Record<string, any>>} edges
   * @param {Record<string, any>} f
   */
  function filterEdges(edges, f) {
    var filter = f || {};
    return (edges || []).filter(function (edge) {
      if (trimmed(filter.confidence) !== '' && trimmed(edge.confidence) !== trimmed(filter.confidence)) return false;
      if (trimmed(filter.rule) !== '' && trimmed(edge.rule) !== trimmed(filter.rule)) return false;
      if (trimmed(filter.representation) !== '' && trimmed(edge.representation) !== trimmed(filter.representation)) return false;
      return true;
    });
  }

  /**
   * 写入字段表跟随流向图筛选联动：任一候选通过筛选即保留该字段，并记录被隐藏的候选数。
   * @param {Array<Record<string, any>>} assessments
   * @param {Record<string, any>} flowsFilter
   */
  function filterFields(assessments, flowsFilter) {
    var filter = flowsFilter || {};
    var anyActive = trimmed(filter.confidence) !== '' || trimmed(filter.rule) !== '' || trimmed(filter.representation) !== '';
    return (assessments || [])
      .map(function (assessment) {
        var candidates = assessment.candidates || [];
        var visible = candidates.filter(function (candidate) {
          return candidateMatches(candidate, filter);
        });
        return {
          assessment: assessment,
          visibleCandidates: visible,
          hiddenCandidates: candidates.length - visible.length,
        };
      })
      .filter(function (row) {
        return anyActive ? row.visibleCandidates.length > 0 : true;
      });
  }

  /** 从筛选后的边重建流向图节点（只保留被可见边连到的节点）。 */
  function visibleGraph(flows, edges) {
    var graph = (flows && flows.graph) || {};
    var allLinks = graph.links || [];
    var byEdgeId = {};
    allLinks.forEach(function (link) {
      if (link && link.edge_id) byEdgeId[link.edge_id] = link;
    });
    var keep = {};
    var links = [];
    (edges || []).forEach(function (edge) {
      var link = byEdgeId[edge.edge_id];
      if (!link) return;
      keep[link.source_node_id] = true;
      keep[link.sink_node_id] = true;
      links.push(link);
    });
    return {
      source_nodes: (graph.source_nodes || []).filter(function (node) { return keep[node.node_id]; }),
      sink_nodes: (graph.sink_nodes || []).filter(function (node) { return keep[node.node_id]; }),
      links: links,
      apps: graph.apps || [],
      direction: graph.direction || '',
    };
  }

  function countBy(items, predicate) {
    return (items || []).filter(predicate).length;
  }

  /**
   * 一次算清四类信息的可见集合与计数（页面只负责渲染，测试直接断言这里的结果）。
   *
   * @param {{runs?: Array<Record<string, any>>, timeline?: Record<string, any>, flows?: Record<string, any>}} model
   * @param {Record<string, any>} filters
   * @returns {Record<string, any>}
   */
  function apply(model, filters) {
    var f = filters || createFilters();
    var runs = (model && model.runs) || [];
    var timeline = (model && model.timeline) || null;
    var flows = (model && model.flows) || null;
    var calls = (timeline && timeline.calls) || [];
    var events = (timeline && timeline.events) || [];
    var observed = (flows && flows.edges && flows.edges.observed) || [];
    var inferred = (flows && flows.edges && flows.edges.inferred) || [];
    var allEdges = observed.concat(inferred);
    var assessments = (flows && flows.sink_assessments) || [];
    var statements = (flows && flows.coverage && flows.coverage.statements) || [];

    var visibleRuns = filterRuns(runs, f.runs);
    var visibleCalls = filterCalls(calls, events, f.calls);
    var visibleEdges = filterEdges(allEdges, f.flows);
    var fieldRows = filterFields(assessments, f.flows);
    var eventsIndex = groupEventsByCall(events);

    var notCoveredTotal = countBy(assessments, function (a) { return a.boundary === 'not_covered'; });
    var notCoveredVisible = countBy(fieldRows, function (row) { return row.assessment.boundary === 'not_covered'; });
    var candidatesVisible = fieldRows.reduce(function (sum, row) { return sum + row.visibleCandidates.length; }, 0);
    var candidatesTotal = assessments.reduce(function (sum, a) { return sum + (a.candidates || []).length; }, 0);

    var emptyIfFiltered = function (total, visible) {
      return f && isActive(f) && total > 0 && visible === 0;
    };

    return {
      filters: f,
      active: isActive(f),
      entries: activeEntries(f),
      runs: {
        items: visibleRuns,
        visible: visibleRuns.length,
        total: runs.length,
        registered: { visible: countBy(visibleRuns, function (r) { return r.registered === true; }), total: countBy(runs, function (r) { return r.registered === true; }) },
        implicit: { visible: countBy(visibleRuns, function (r) { return r.registered !== true; }), total: countBy(runs, function (r) { return r.registered !== true; }) },
      },
      calls: {
        items: visibleCalls,
        visible: visibleCalls.length,
        total: calls.length,
        eventsIndex: eventsIndex,
      },
      edges: {
        items: visibleEdges,
        visible: visibleEdges.length,
        total: allEdges.length,
        observed: countBy(visibleEdges, function (e) { return e.representation !== 'inferred'; }),
        inferred: countBy(visibleEdges, function (e) { return e.representation === 'inferred'; }),
      },
      graph: visibleGraph(flows || {}, visibleEdges),
      fields: {
        rows: fieldRows,
        visible: fieldRows.length,
        total: assessments.length,
        candidatesVisible: candidatesVisible,
        candidatesTotal: candidatesTotal,
      },
      boundary: {
        statements: statements,
        statementsTotal: statements.length,
        notCoveredVisible: notCoveredVisible,
        notCoveredTotal: notCoveredTotal,
        coverageTotal: (flows && flows.coverage && (flows.coverage.not_found_in_observed_writes || []).length) || 0,
        note: '措辞与覆盖度取接口原文，属全量事实，不随筛选变化；「未覆盖判定」按当前筛选统计。',
      },
      empty: {
        runs: emptyIfFiltered(runs.length, visibleRuns.length),
        calls: emptyIfFiltered(calls.length, visibleCalls.length),
        edges: emptyIfFiltered(allEdges.length, visibleEdges.length),
        fields: emptyIfFiltered(assessments.length, fieldRows.length),
      },
    };
  }

  /**
   * @param {Array<any>} items
   * @param {number} [cap]
   * @returns {{items: Array<any>, truncated: number, cap: number}}
   */
  function capRows(items, cap) {
    var limit = Number.isFinite(cap) && cap > 0 ? cap : RENDER_CAP;
    var list = items || [];
    if (list.length <= limit) return { items: list, truncated: 0, cap: limit };
    return { items: list.slice(0, limit), truncated: list.length - limit, cap: limit };
  }

  root.TraceFilters = {
    RENDER_CAP: RENDER_CAP,
    STATUS_LABELS: STATUS_LABELS,
    RULE_LABELS: RULE_LABELS,
    statusLabel: statusLabel,
    ruleLabel: ruleLabel,
    statementsText: statementsText,
    createFilters: createFilters,
    parse: parse,
    runKeyOf: runKeyOf,
    serialize: serialize,
    isActive: isActive,
    activeEntries: activeEntries,
    // 单类过滤（测试与页面都可直接用）
    filterRuns: filterRuns,
    filterCalls: filterCalls,
    filterEdges: filterEdges,
    filterFields: filterFields,
    // 组合
    apply: apply,
    capRows: capRows,
    // 工具（页面复用，避免重复实现）
    transportOfCall: transportOfCall,
    groupEventsByCall: groupEventsByCall,
    isAnomalousRun: isAnomalousRun,
    hasIncompletePairing: hasIncompletePairing,
    runKey: runKey,
  };
})(typeof globalThis === 'undefined' ? this : globalThis);
