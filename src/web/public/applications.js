(function () {
  'use strict';
  var UI = window.TraceUI, data, query = '', loading = false;
  var mode, modeToken, modeRead = 0, saving = false, modeUnknown = true;
  function renderSummary() {
    if (!data) return;
    document.getElementById('applications-summary').textContent = (data.demo ? '虚构数据演示 · 未探测实时 Gateway · 正式监控模式未读取' : 'Gateway ' + (data.gateway_online ? '在线' : '离线') + ' · ' + (modeUnknown ? '监控模式待确认' : '强制监控' + (mode.enforce ? '开启' : '关闭'))) + ' · ' + data.applications.length + ' 款应用 · 检查时间 ' + UI.fmtTime(data.checked_at);
  }
  function renderMode() {
    if (mode.demo) {
      document.getElementById('monitoring-toggle').textContent = '演示模式（只读）';
      document.getElementById('monitoring-toggle').disabled = true;
      document.getElementById('monitoring-state').textContent = '演示不读取或修改正式监控模式。需要恢复真实服务时，请打开独立工作台。';
      return;
    }
    document.getElementById('monitoring-toggle').textContent = mode.enforce ? '关闭强制监控' : '开启强制监控';
    document.getElementById('monitoring-state').textContent = mode.enforce ? '已开启 · 监控任务遇到网关故障将停止，普通聊天不受影响。' : '已关闭 · 允许故障回退，部分应用操作可能没有监控记录。';
  }
  async function loadMode() {
    if (saving) return;
    var read = ++modeRead;
    document.getElementById('monitoring-toggle').disabled = true;
    try {
      var result = await UI.fetchJson('/api/settings/monitoring');
      if (read !== modeRead) return;
      mode = result; modeUnknown = false; modeToken = mode.token; renderMode(); renderSummary();
      document.getElementById('monitoring-toggle').disabled = Boolean(mode.demo);
    } catch (e) {
      if (read !== modeRead) return;
      modeUnknown = true; renderSummary();
      document.getElementById('monitoring-toggle').disabled = true;
      document.getElementById('monitoring-state').textContent = '开关读取失败：' + e.message + '；请点击检查连接和工具重试。';
    }
  }
  document.getElementById('monitoring-toggle').addEventListener('click', async function () {
    if (saving || modeUnknown || !mode || mode.demo || this.disabled) return;
    saving = true; ++modeRead;
    this.disabled = true;
    try {
      var response = await fetch('/api/settings/monitoring', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Trace-Control-Token': modeToken }, body: JSON.stringify({ enforce: !mode.enforce }) });
      var result = await response.json(); if (!response.ok) throw new Error(result.error.message);
      mode = result; renderMode(); if (data) data.mode = result; renderSummary();
    } catch (e) { modeUnknown = true; renderSummary(); document.getElementById('monitoring-state').textContent = '保存结果待确认：' + e.message + '；请检查当前模式后再操作。'; }
    finally { saving = false; this.disabled = modeUnknown || Boolean(mode.demo); }
  });
  var connectionNames = { connected: '已连接', gateway_offline: '网关未运行', not_loaded: '当前未加载', unavailable: '连接异常' };
  var actionNames = { read: '读取', write: '写入', ignore: '辅助操作', unknown: '待分类' };
  function render() {
    var wrap = document.getElementById('application-cards'); UI.clear(wrap);
    var visible = data.applications.filter(function (app) { return (app.name + ' ' + app.tools.map(function (t) { return t.name; }).join(' ')).toLowerCase().includes(query); });
    visible.forEach(function (app) {
      var card = UI.el('section', { class: 'block application-card', dataset: { app: app.id } });
      card.appendChild(UI.el('div', { class: 'block-head' }, [UI.el('h2', { text: app.name }), UI.tag(data.demo ? '目录模块' : app.enabled ? '已启用' : '已停用', !data.demo && app.enabled ? 'observed' : 'muted')]));
      card.appendChild(UI.el('p', { text: '绑定账户 / 应用：' + app.account.label }));
      card.appendChild(UI.el('div', { class: 'cell-line' }, [UI.tag(data.demo ? '演示未检查连接' : connectionNames[app.connection], app.connection === 'connected' ? 'observed' : 'muted'), UI.tag(app.tools_state === 'available' ? app.tools.length + ' 个工具可用' : app.tools_state === 'unavailable' ? '工具发现失败' : '工具尚未核验', app.tools_state === 'available' ? 'observed' : 'muted')]));
      var next = data.demo ? '当前仅查看演示；真实应用连接尚未检查。默认 Mock 无需绑定账户。' :
        !app.enabled ? '此模块已停用；如需使用，请在应用管理入口启用后重载服务。' :
        app.connection === 'gateway_offline' ? '尚未连接到 Gateway。请先启动实时服务，再点击“检查连接和工具”；无需因此重新授权。' :
        app.connection === 'not_loaded' ? '当前 Gateway 清单未装载此应用。请按教程配置所选应用并重载服务。' :
        app.connection === 'unavailable' ? '上游尚未就绪。请检查本地启动日志、依赖与网络；账户是否失效仍待确认。' :
        app.tools_state === 'unavailable' ? '工具发现失败，原因待确认。请检查启动日志和网络，再按教程核对权限；不要直接反复授权。' :
        app.tools_state !== 'available' ? '上游已连接，但工具尚未核验。点击“检查连接和工具”；此操作不读取业务正文。' :
        '工具发现成功；账户权限和业务结果仍需通过具体操作验证。';
      card.appendChild(UI.el('p', { text: next }));
      if (!data.demo && !app.account.configured) card.appendChild(UI.el('p', { class: 'hint', text: '未找到本机保存的账户配置；真实应用请展开绑定教程，Mock 无需账户。' }));
      var schema = app.schema, changed = schema.state === 'changed';
      card.appendChild(UI.el('p', { class: changed ? 'status-bad' : 'hint', text: changed ? '上游工具定义已变化：新增 ' + schema.added.length + '，删除 ' + schema.removed.length + '，定义变化 ' + schema.changed.length + '。需要维护确认并重新准备工具缓存。' : schema.state === 'unchanged' ? '工具定义与已保存基线一致。' : schema.state === 'no_baseline' ? '尚无基线，请绑定客户端并准备工具缓存。' : '尚未检查工具定义变化。' }));
      if (changed) card.appendChild(UI.el('p', { class: 'hint', text: '新增：' + (schema.added.join('、') || '无') + '；删除：' + (schema.removed.join('、') || '无') + '；变化：' + (schema.changed.join('、') || '无') }));
      if (app.error) card.appendChild(UI.el('p', { class: 'status-bad', text: app.error }));
      card.appendChild(UI.el('p', { class: 'hint', text: app.recent_failure ? '最近历史故障：' + UI.fmtTime(app.recent_failure.at) + ' · ' + app.recent_failure.tool + ' · ' + app.recent_failure.kind : '监控历史未发现该应用故障。' }));
      var body = UI.el('div', { class: 'tool-list' }), disclosure = UI.el('details', {}, [UI.el('summary', { text: '工具读写分类与字段提取（' + app.tools.length + '）' }), body]);
      disclosure.addEventListener('toggle', function () {
        if (!disclosure.open || body.children.length) return;
        app.tools.filter(function (t) { return !query || app.name.toLowerCase().includes(query) || t.name.toLowerCase().includes(query); }).forEach(function (tool) {
          var line = UI.el('details', { class: 'tool-card' }, [UI.el('summary', { text: tool.name + ' · ' + (actionNames[tool.action] || '待分类') + (tool.classification_source === 'heuristic' ? '（命名推断）' : '') + ' · 历史调用 ' + tool.calls + ' 次' })]);
          line.appendChild(UI.el('p', { class: 'hint', text: '参数：' + (tool.input_fields.join('、') || '无') + '；必填：' + (tool.required.join('、') || '无') }));
          line.appendChild(UI.el('p', { class: 'hint', text: tool.calls ? '历史实际提取 ' + tool.extracted_fields + ' 个字段；路径：' + (tool.observed_paths.join('、') || '尚未提取，不能声称覆盖') : '尚无该工具业务记录，字段关联待实测。' }));
          if (tool.schema_changed) line.appendChild(UI.el('p', { class: 'status-bad', text: '定义变化，请复核读写分类和提取路径。' }));
          body.appendChild(line);
        });
      }); card.appendChild(disclosure);
      var guideBody = UI.el('pre', { class: 'raw-value', text: '展开后读取教程…' });
      var guide = UI.el('details', {}, [UI.el('summary', { text: '查看账户绑定与停用教程' }), guideBody]);
      guide.addEventListener('toggle', function () { if (!guide.open || guide.dataset.loaded) return; guide.dataset.loaded = 'true'; UI.fetchJson('/api/applications/' + encodeURIComponent(app.id) + '/guide').then(function (value) { guideBody.textContent = value.text; }, function () { guide.dataset.loaded = ''; guideBody.textContent = '教程读取失败，收起后重试。'; }); });
      card.appendChild(guide);
      card.appendChild(UI.el('p', { class: 'hint', text: '账户绑定 / 停用教程：applications/' + app.id + '/README.md；绑定入口 connect.bat，连接检查 check.bat。网页检查不会替你安装或授权。' }));
      wrap.appendChild(card);
    });
    if (!visible.length) wrap.appendChild(UI.el('p', { class: 'hint', text: '没有匹配的应用或工具。' }));
  }
  async function load(live) {
    if (loading) return; loading = true;
    var button = document.getElementById('applications-refresh'); button.disabled = true;
    document.getElementById('applications-summary').textContent = live ? '正在逐项检查，请稍候…' : '正在读取…';
    try {
      data = await UI.fetchJson('/api/applications' + (live ? '?live=1' : ''));
      await loadMode(); renderSummary();
      document.getElementById('applications-note').textContent = data.note; render();
    } catch (error) { document.getElementById('applications-summary').textContent = '读取失败：' + error.message + '；保留上一次状态，可重试。'; }
    finally { loading = false; button.disabled = false; }
  }
  document.getElementById('applications-refresh').addEventListener('click', function () { load(true); });
  document.getElementById('applications-search').addEventListener('input', function (event) { query = event.target.value.trim().toLowerCase(); if (data) render(); });
  load(false);
  loadMode();
})();
