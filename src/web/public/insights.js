/* Facts and explanations derived from the current task snapshot, without new requests. */
(function (root) {
  'use strict';
  var UI = root.TraceUI;
  function appName(app, tool) {
    if (app === 'feishu' && /^docx_/u.test(tool || '')) return '飞书文档';
    if (app === 'feishu' && /^bitable_/u.test(tool || '')) return '飞书多维表格';
    if (app === 'dingtalk' && ['queryTasks', 'getTask', 'createTask', 'updateTask', 'deleteTask', 'updateExecutorsTaskStatus'].includes(tool)) return '钉钉待办';
    if (app === 'dingtalk' && ['createEvent', 'updateEvent', 'deleteEvent', 'getEvent', 'addAttendee', 'removeAttendee', 'getAttendees', 'getCalendarView'].includes(tool)) return '钉钉日程';
    return UI.appLabel(app);
  }
  function edgeKey(edge) {
    return JSON.stringify([appName(edge.source_upstream_app, edge.source_tool_name), appName(edge.sink_upstream_app, edge.sink_tool_name)]);
  }
  function groupEdges(edges) {
    var groups = new Map();
    (edges || []).forEach(function (edge) {
      var key = edgeKey(edge);
      if (!groups.has(key)) groups.set(key, { key: key, source: appName(edge.source_upstream_app, edge.source_tool_name),
        sink: appName(edge.sink_upstream_app, edge.sink_tool_name), edges: [], fields: new Set(), observed: 0, inferred: 0 });
      var group = groups.get(key);
      group.edges.push(edge);
      group.fields.add(JSON.stringify([edge.sink_event_id, edge.sink_json_path]));
      group[edge.representation === 'inferred' || edge.boundary === 'inferred' ? 'inferred' : 'observed']++;
    });
    return Array.from(groups.values()).map(function (group) { group.fieldCount = group.fields.size; return group; });
  }
  function overview(timeline, flows) {
    var calls = timeline && timeline.calls || [];
    var apps = new Map();
    calls.forEach(function (call) {
      var name = appName(call.upstream_app, call.tool_name);
      if (!apps.has(name)) apps.set(name, { name: name, reads: 0, writes: 0, other: 0, failed: 0 });
      var app = apps.get(name);
      app[call.action === 'read' ? 'reads' : call.action === 'write' ? 'writes' : 'other']++;
      if (call.status !== 'ok') app.failed++;
    });
    var failed = calls.filter(function (call) { return call.status !== 'ok'; });
    var missing = timeline && timeline.pairing && !timeline.pairing.complete;
    var successful = calls.filter(function (call) { return call.status === 'ok'; }).length;
    var headline = calls.length === 0 ? '这次任务还没有操作记录' :
      failed.length ? '记录到 ' + failed.length + ' 次异常，' + successful + ' 次成功操作' : '记录到的 ' + calls.length + ' 次操作全部成功';
    if (missing) headline += '；部分请求或返回记录缺失';
    var descriptions = Array.from(apps.values()).map(function (app) {
      var counts = [];
      if (app.reads) counts.push('读取 ' + app.reads + ' 次');
      if (app.writes) counts.push('写入 ' + app.writes + ' 次');
      if (app.other) counts.push('其他操作 ' + app.other + ' 次');
      return app.name + '：' + counts.join('、');
    });
    return { headline: headline, description: descriptions.join('；'), apps: Array.from(apps.values()), failed: failed,
      successful: successful, missing: Boolean(missing), groups: groupEdges([].concat(flows && flows.edges && flows.edges.observed || [], flows && flows.edges && flows.edges.inferred || [])) };
  }
  function explanation(assessment) {
    var candidates = assessment.candidates || [];
    var rules = new Set(candidates.map(function (c) { return c.rule; }));
    if (assessment.decision === 'none' || !candidates.length) return { label: '未找到来源', tone: 'muted',
      text: '现有读取记录里没有找到可关联的来源；不代表数据一定来自任务之外。' };
    if (assessment.decision === 'ambiguous' || candidates.length > 1) return { label: '多个可能来源', tone: 'uncertain',
      text: '有 ' + candidates.length + ' 个候选匹配。重复读取或相同内容都可能造成多个候选，无法据此确定实际使用了哪一个。' };
    if (assessment.decision === 'uncertain' || candidates[0].representation === 'inferred') return { label: '来源尚不确定', tone: 'uncertain',
      text: '存在候选匹配，但证据不足或只属于推断，需要结合调用原文核对。' };
    if (rules.has('literal_fragment')) return { label: '原文摘录', tone: 'observed', text: '写入段落逐字出现在此前读取的正文中，证据保留原文字符位置。只说明内容出现，不证明 Agent 的实际使用意图。' };
    if (rules.has('exact_value')) return { label: '原文一致', tone: 'observed', text: '读取值与写入值逐字一致。只说明内容匹配，不证明 Agent 的实际使用意图。' };
    return { label: '格式转换后匹配', tone: 'inferred', text: '按已支持的格式转换规则匹配，例如空白、日期或时间转换；可以展开查看具体规则。' };
  }
  function failureText(call) {
    if (!call.later_success) return '未记录到该操作后续成功；请查看错误详情。';
    if (call.later_success.match === 'same_arguments') return '相同参数的后续调用成功，原失败记录仍保留。';
    return '同类操作后续成功，但参数一致性未确认，不能确定是本次重试。';
  }
  root.TraceInsights = { appName: appName, edgeKey: edgeKey, groupEdges: groupEdges, overview: overview, explanation: explanation, failureText: failureText };
})(typeof window !== 'undefined' ? window : globalThis);
