/* View-only task organization; original evidence is never rewritten. */
(function (root) {
  'use strict';
  function groups(calls, gapMinutes) {
    var sorted = calls.slice().sort(function (a, b) { return String(a.started_at_utc).localeCompare(String(b.started_at_utc)); });
    var explicit = new Map(), suggested = [], current, previous;
    sorted.forEach(function (call) {
      var taskId = call.task_id || (call.run_id && call.run_id !== call.experiment_run_id ? call.run_id : null);
      if (taskId) {
        if (!explicit.has(taskId)) explicit.set(taskId, { id: 'explicit:' + taskId, name: '任务 ' + taskId, basis: 'explicit', calls: [] });
        explicit.get(taskId).calls.push(call.gateway_call_id);
        current = null; previous = null;
      } else {
        var at = Date.parse(call.started_at_utc);
        if (!current || (Number.isFinite(at) && Number.isFinite(previous) && at - previous > (gapMinutes || 30) * 60000)) {
          current = { id: 'suggested:' + call.gateway_call_id, name: '建议任务 ' + (suggested.length + 1), basis: 'inferred', calls: [] }; suggested.push(current);
        }
        current.calls.push(call.gateway_call_id); previous = at;
      }
    });
    return Array.from(explicit.values()).concat(suggested);
  }
  function reconcile(saved, calls) {
    var valid = new Set(calls.map(function (c) { return c.gateway_call_id; })), assigned = new Set();
    var result = (saved || []).map(function (g) {
      return { id: g.id, name: g.name, basis: g.basis, calls: (g.calls || []).filter(function (id) { if (!valid.has(id) || assigned.has(id)) return false; assigned.add(id); return true; }) };
    }).filter(function (g) { return g.calls.length; });
    var rest = calls.filter(function (c) { return !assigned.has(c.gateway_call_id); });
    if (rest.length) result.push({ id: 'unassigned-new', name: '新增 / 未分组操作', basis: 'unassigned', calls: rest.map(function (c) { return c.gateway_call_id; }) });
    return result;
  }
  function split(list, id, at) {
    var group = list.find(function (g) { return g.id === id; });
    if (!group || !Number.isInteger(at) || at < 1 || at >= group.calls.length) throw new Error('拆分位置应在 1 到 ' + ((group && group.calls.length - 1) || 0) + ' 之间');
    var next = list.filter(function (g) { return g.id !== id; });
    next.push({ id: id + ':a', name: group.name + '（前段）', basis: 'manual', calls: group.calls.slice(0, at) }, { id: id + ':b', name: group.name + '（后段）', basis: 'manual', calls: group.calls.slice(at) });
    return next;
  }
  function merge(list, a, b) {
    var first = list.find(function (g) { return g.id === a; }), second = list.find(function (g) { return g.id === b; });
    if (!first || !second || a === b) throw new Error('请选择两个不同分组');
    return list.filter(function (g) { return g.id !== a && g.id !== b; }).concat([{ id: a, name: first.name, basis: 'manual', calls: Array.from(new Set(first.calls.concat(second.calls))) }]);
  }
  function scope(timeline, flows, group) {
    if (!group) return { timeline: timeline, flows: flows };
    var ids = new Set(group.calls), calls = timeline.calls.filter(function (c) { return ids.has(c.gateway_call_id); }).map(function (c) { return c.later_success && !ids.has(c.later_success.gateway_call_id) ? Object.assign({}, c, { later_success: null }) : c; });
    var events = timeline.events.filter(function (e) { return ids.has(e.gateway_call_id); }), eventIds = new Set(events.map(function (e) { return e.event_id; }));
    var incomplete = timeline.pairing.incomplete.filter(function (c) { return ids.has(c.gateway_call_id); });
    var pairing = Object.assign({}, timeline.pairing, { calls_checked: calls.length, ok: calls.length - incomplete.length, incomplete: incomplete, orphan_events: timeline.pairing.orphan_events.filter(function (e) { return eventIds.has(e.event_id || e); }) });
    pairing.complete = !pairing.incomplete.length && !pairing.orphan_events.length;
    var nextFlows = flows && Object.assign({}, flows, { edges: { observed: flows.edges.observed.filter(edge), inferred: flows.edges.inferred.filter(edge) }, sink_assessments: (flows.sink_assessments || []).filter(function (s) { return eventIds.has(s.sink_event_id); }) });
    function edge(e) { return eventIds.has(e.source_event_id) && eventIds.has(e.sink_event_id); }
    // Scope the graph and whole-run coverage claims as well as the table.
    if (nextFlows) {
      var edgeIds = new Set(nextFlows.edges.observed.concat(nextFlows.edges.inferred).map(function (e) { return e.edge_id; }));
      var links = flows.graph.links.filter(function (l) { return edgeIds.has(l.edge_id); }), nodes = new Set();
      links.forEach(function (l) { nodes.add(l.source_node_id); nodes.add(l.sink_node_id); });
      nextFlows.graph = Object.assign({}, flows.graph, { links: links, source_nodes: flows.graph.source_nodes.filter(function (n) { return nodes.has(n.node_id); }), sink_nodes: flows.graph.sink_nodes.filter(function (n) { return nodes.has(n.node_id); }) });
      nextFlows.boundaries = flows.boundaries.map(function (b) { var items = (b.items || []).filter(function (e) { return edgeIds.has(e.edge_id) || eventIds.has(e.sink_event_id); }); return Object.assign({}, b, { items: items, count: items.length, coverage_items: [], coverage_statements: [] }); });
      nextFlows.coverage = Object.assign({}, flows.coverage, { statements: ['当前为分组查看，跨分组关联请返回完整运行查看。'], not_found_in_observed_writes: (flows.coverage.not_found_in_observed_writes || []).filter(function (s) { return eventIds.has(s.event_id); }) });
      nextFlows.counts = Object.assign({}, flows.counts, { source_fields: nextFlows.graph.source_nodes.length, sink_fields: nextFlows.sink_assessments.length });
      nextFlows.sink_assessments = nextFlows.sink_assessments.map(function (s) {
        var candidates = (s.candidates || []).filter(function (c) { return eventIds.has(c.source_event_id); });
        if (candidates.length === (s.candidates || []).length) return s;
        // A narrowed view cannot turn an ambiguous full-run decision into certainty.
        return Object.assign({}, s, { candidates: candidates, decision: 'uncertain', boundary: 'uncertain', uncertainty_reasons: ['存在分组外候选，请查看完整运行'] });
      });
      nextFlows.boundaries = nextFlows.boundaries.map(function (b) {
        if (b.key !== 'uncertain' && b.key !== 'not_covered') return b;
        var items = nextFlows.sink_assessments.filter(function (s) { return s.boundary === b.key; });
        return Object.assign({}, b, { items: items, count: items.length });
      });
    }
    return { timeline: Object.assign({}, timeline, { calls: calls, events: events, pairing: pairing, counts: { calls: calls.length, events: events.length } }), flows: nextFlows };
  }
  root.TraceTasks = { groups: groups, reconcile: reconcile, split: split, merge: merge, scope: scope };
})(typeof window === 'undefined' ? globalThis : window);
