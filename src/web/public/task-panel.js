(function () {
  'use strict';
  var UI = window.TraceUI, T = window.TraceTasks, records = {}, storageKey, active = '', currentRun = '', currentGroups = [];
  var note = '', drafts = {};
  function initialize(key) {
    if (storageKey === key) return;
    storageKey = key;
    try {
      var saved = JSON.parse(localStorage.getItem('flowtrace:tasks:' + key) || '{}');
      records = Object.create(null);
      if (saved && typeof saved === 'object' && !Array.isArray(saved)) Object.keys(saved).forEach(function (id) {
        var entry = saved[id];
        if (!entry || typeof entry !== 'object') return;
        var groups = Array.isArray(entry.groups) ? entry.groups.filter(function (g) { return g && typeof g.id === 'string' && typeof g.name === 'string' && Array.isArray(g.calls) && g.calls.every(function (c) { return typeof c === 'string'; }); }) : null;
        records[id] = { name: typeof entry.name === 'string' ? entry.name.slice(0, 120) : '', groups: groups };
      });
    }
    catch (_) { records = {}; note = '本机任务整理记录不可读取；仍可查看原始运行。'; }
  }
  function save() {
    try { localStorage.setItem('flowtrace:tasks:' + storageKey, JSON.stringify(records)); note = '已保存到本浏览器。'; }
    catch (_) { note = '浏览器无法保存；本次整理仅在当前页面有效。'; }
  }
  function name(key, fallback) { return records[key] && records[key].name || fallback; }
  function mount(options) {
    initialize(options.viewKey);
    if (currentRun !== options.key) { currentRun = options.key; active = ''; }
    var entry = records[currentRun] || {}, groups = entry.groups ? T.reconcile(entry.groups, options.timeline.calls) : T.groups(options.timeline.calls);
    currentGroups = groups;
    if (active && !groups.some(function (g) { return g.id === active; })) active = '';
    var box = document.getElementById('task-organizer');
    var oldSplit = box.querySelector('#task-split-at'), splitValue = oldSplit ? oldSplit.value : '';
    UI.clear(box);
    var title = UI.el('input', { id: 'task-name', value: drafts[currentRun] || name(currentRun, options.defaultName), maxlength: 120, 'aria-label': '任务名称' });
    title.addEventListener('input', function () { drafts[currentRun] = title.value; });
    box.appendChild(UI.el('label', { class: 'filter-field' }, ['任务名称', title]));
    function action(label, handler, id) { return UI.el('button', { id: id, type: 'button', class: 'btn btn-small', text: label, onclick: function () { try { handler(); save(); options.changed(); } catch (e) { note = e.message; document.getElementById('task-organizer-note').textContent = note; } } }); }
    box.appendChild(action('保存名称', function () { records[currentRun] = Object.assign({}, entry, { name: title.value.trim().slice(0, 120) || options.defaultName }); delete drafts[currentRun]; }, 'task-rename'));
    var selector = UI.el('select', { id: 'task-group', 'aria-label': '任务分组' }, [UI.el('option', { value: '', text: '完整运行（含跨分组关联）' })]);
    groups.forEach(function (g) { selector.appendChild(UI.el('option', { value: g.id, text: g.name + ' · ' + g.calls.length + ' 次 · ' + ({ explicit: '明确编号', inferred: '推断建议', manual: '手动整理', unassigned: '未分组' }[g.basis] || '未确认') })); });
    selector.value = active;
    selector.addEventListener('change', function () { active = selector.value; options.changed(); });
    box.appendChild(UI.el('label', { class: 'filter-field' }, ['查看分组', selector]));
    box.appendChild(action('采用建议分组', function () { records[currentRun] = Object.assign({}, entry, { groups: groups }); }, 'task-adopt'));
    var splitAt = UI.el('input', { id: 'task-split-at', type: 'number', min: 1, value: splitValue, placeholder: '前段调用数', 'aria-label': '前段调用数' });
    box.appendChild(splitAt);
    box.appendChild(action('拆分当前组', function () { records[currentRun] = Object.assign({}, entry, { groups: T.split(groups, active, Number(splitAt.value)) }); active = ''; }, 'task-split'));
    var other = UI.el('select', { id: 'task-merge-target', 'aria-label': '合并目标' }, [UI.el('option', { value: '', text: '选择合并目标' })]);
    groups.filter(function (g) { return g.id !== active; }).forEach(function (g) { other.appendChild(UI.el('option', { value: g.id, text: g.name })); }); box.appendChild(other);
    box.appendChild(action('合并两组', function () { records[currentRun] = Object.assign({}, entry, { groups: T.merge(groups, active, other.value) }); }, 'task-merge'));
    box.appendChild(action('还原完整运行', function () { records[currentRun] = Object.assign({}, entry, { groups: null }); active = ''; }, 'task-reset'));
    box.appendChild(UI.el('p', { id: 'task-organizer-note', class: 'hint', text: note || '明确任务编号自动分组；其余按 30 分钟空闲给出推断建议。名称及手动整理保存在本浏览器，原记录不变。' }));
    return groups.find(function (g) { return g.id === active; });
  }
  function selected() { return currentGroups.find(function (g) { return g.id === active; }); }
  window.TraceTaskPanel = { initialize: initialize, mount: mount, name: name, selected: selected };
})();
