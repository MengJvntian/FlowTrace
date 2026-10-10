/* src/web/public/app.js — 浅色追踪工作台：任务 / 时间线 / 字段流向 / 证据
 *
 * 信息层级（用户反馈「显示太复杂，不用把系统信息显示」后的分工）：
 *   本页 = **结论层**：发生了什么、数据从哪到哪、是否确定。
 *   系统/运维/边界原文/诊断明细一律在 /ops.html（次级页），本页**不请求也不渲染**这些内容：
 *   本文件里不出现任何系统状态、库、策略、机制类文案；`tests/web_api.test.js` 用静态文本断言守住这条边界。
 *
 * 首屏重排（t46，用户反馈「UI 有点信息密集」）：
 *   - 顶部只有「标题 + 一句话说明 + 刷新/详情」；筛选折成**一行工具条**（默认折叠，筛选生效时自动展开）；
 *   - 生命周期降级为工具条里的一行小字；长解释改成「短句 + 原生 <details> 展开」，信息不丢；
 *   - 数据区上移：任务列表紧跟工具条，成为首屏主体；表格列合并（长文本省略 + title 提示）。
 *
 * 筛选（用户要求「给各种数据添加筛选功能」）：
 *   - 四类信息各自可筛，可组合；筛选状态写在 URL query 里（深链可分享、刷新保持）；
 *   - 判定逻辑全在 `filters.js`（纯函数，测试用 node:vm 加载同一份代码断言真实数据被筛）；
 *   - 本页只做「渲染 + 把控件变化同步到 URL」，不新增任何请求与写端点。
 *
 * 约束（与 server.js 的 CSP 一致）：经典脚本、无内联事件处理器、无内联样式、无第三方依赖。
 * 只读语义不变：本页只发 GET（只读端点），受控查看原文仍需 ack + 理由，且会被记录。
 *
 * 自动刷新（功能 A，用户明确要求）：
 *   - 页面工具条里有给人看的「自动刷新」开关（默认**开启**）+ 5/10/30 秒三档间隔；
 *   - 决策全在 `isr.js`（纯逻辑，测试用 node:vm 加载同一份代码），本文件只做接线/请求/状态文案；
 *   - **只在页面可见时轮询**（`visibilitychange`）：后台暂停、回到前台立即刷一次；
 *   - 手动、自动、任务切换统一通过 data.js 读取完整快照，再一次提交并渲染；
 *     筛选状态从 URL 原样重放，因此刷新后仍是同一筛选视图；
 *   - 刷新**不打断用户**：先记录滚动位置、聚焦元素与已展开的 `<details>`，渲染后恢复；
 *   - 失败不静默也不清空页面：状态处给一行小字并退避重试，**不改写用户的开关**。
 */
(function () {
  'use strict';

  var UI = window.TraceUI;
  var F = window.TraceFilters;
  var Insights = window.TraceInsights;
  var ISR = UI.isr;
  var el = UI.el;
  var clear = UI.clear;
  var table = UI.table;
  var tag = UI.tag;
  var boundaryTag = UI.boundaryTag;
  var fmtTime = UI.fmtTime;
  var shortId = UI.shortId;
  var text = UI.text;
  var details = UI.details;

  /** 省略单元格的默认截断长度（超出用 title 提示全文）。 */
  var ELLIPSIS = 42;
  var navigationRevision = 0;
  var lastSearch = window.location.search;
  var loadingRevision = 0;
  var pages = {};
  function pageRows(key, items, wrap, size) {
    size = size || 200;
    var count = Math.max(1, Math.ceil(items.length / size));
    var page = Math.min(pages[key] || 0, count - 1); pages[key] = page;
    if (count > 1) {
      var pager = el('div', { class: 'summary', dataset: { pager: key } });
      pager.appendChild(el('span', { class: 'hint', text: '第 ' + (page + 1) + ' / ' + count + ' 页 · 共 ' + items.length + ' 条；筛选和统计仍按全部记录' }));
      [-1, 1].forEach(function (direction) { pager.appendChild(el('button', { type: 'button', class: 'btn btn-small', text: direction < 0 ? '上一页' : '下一页', disabled: direction < 0 ? page === 0 : page === count - 1,
        onclick: function () { pages[key] = page + direction; applyAndRender(); } })); });
      wrap.appendChild(pager);
    }
    return { items: items.slice(page * size, (page + 1) * size), cap: size, truncated: 0 };
  }

  function maskedView() {
    return Boolean(state.meta && state.meta.mask.mode !== 'original_values');
  }

  function navigateSection() {
    navigationRevision++;
    var hash = window.location.hash || '#block-runs';
    Array.prototype.forEach.call(document.querySelectorAll('.rail a[href^="#"]'), function (link) {
      var current = link.getAttribute('href') === hash;
      link.classList.toggle('nav-current', current);
      if (current) link.setAttribute('aria-current', 'location');
      else link.removeAttribute('aria-current');
    });
    var section = document.getElementById(hash.slice(1));
    if (section && window.location.hash) section.scrollIntoView({ block: 'start', behavior: 'instant' });
  }

  var state = {
    runs: null,
    selectedRun: null,
    timeline: null,
    flows: null,
    edgeDetail: null,
    flowGroup: null,
    filters: F.parse(window.location.search),
    applied: null,
    // 服务元信息（/api/meta）：空状态要用它说清「读的是哪个库、库里有几条」。
    // 用户报过「读以前的数据显示为空」—— 那次其实是页面读的库与他以为的不是同一个，
    // 只写一句「当前没有任务记录」根本没法判断是「真空」还是「读错文件」。
    meta: null,
  };

  /* ------------------------------------------------------------ 筛选状态与深链 */

  /** 把当前筛选 + 当前任务写进地址栏（replaceState：不刷新、不堆历史）。 */
  function syncUrl() {
    var query = F.serialize(state.filters, state.selectedRun || '');
    var next = window.location.pathname + (query === '' ? '' : '?' + query) + window.location.hash;
    if (window.location.pathname + window.location.search + window.location.hash !== next) {
      window.history.replaceState(null, '', next);
    }
    lastSearch = window.location.search;
  }

  /**
   * 筛选面板的开合（默认折叠：首屏让位于数据）。
   * 规则：筛选一旦生效（含深链带条件）就自动展开，让用户看得见「为什么数据变少了」；
   * 清除筛选后收起。用户的点击始终优先（不会被自动展开反复打断）。
   */
  function setFilterPanelOpen(open) {
    var panel = document.getElementById('filter-panel');
    var toggle = document.getElementById('toggle-filters');
    if (!panel || !toggle) return;
    panel.hidden = !open;
    toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    toggle.textContent = open ? '筛选（收起）' : '筛选';
  }

  function filterPanelOpen() {
    var panel = document.getElementById('filter-panel');
    return Boolean(panel) && panel.hidden !== true;
  }

  /** 重新计算四类信息的可见集合（纯函数），然后重渲染。 */
  function applyAndRender() {
    if (state.fullTimeline) {
      var organizerGroup = window.TraceTaskPanel.mount({ key: state.selectedRun, viewKey: state.meta && state.meta.view_key || location.origin,
        timeline: state.fullTimeline, defaultName: (state.runs.runs.find(function (r) { return F.runKey(r) === state.selectedRun; }) || {}).notes || '跨应用任务', changed: function () { renderRunSelect(); applyAndRender(); } });
      var scoped = window.TraceTasks.scope(state.fullTimeline, state.fullFlows, organizerGroup);
      state.timeline = scoped.timeline; state.flows = scoped.flows;
      state.runs.runs.forEach(function (run) { run.display_name = window.TraceTaskPanel.name(F.runKey(run), run.notes || '跨应用任务'); });
    }
    state.applied = F.apply(
      { runs: state.runs ? state.runs.runs : [], timeline: state.timeline, flows: state.flows },
      state.filters,
    );
    renderOverview();
    renderTaskOverview();
    renderFilterBanner();
    renderRuns();
    renderTimeline();
    renderFlows();
    renderBoundaryLine();
    syncUrl();
    // 有生效条件时自动展开筛选面板（否则用户会以为数据「莫名变少」）
    if (state.applied.active) setFilterPanelOpen(true);
  }

  function renderOverview() {
    var applied = state.applied;
    if (!applied) return;
    ['runs', 'calls', 'edges', 'fields'].forEach(function (key) {
      var node = document.getElementById('overview-' + key);
      if (node) node.textContent = applied[key].visible + ' / ' + applied[key].total;
    });
  }

  function preview(value, key) {
    var full = text(value);
    if (full.length <= 120) return el('span', { class: 'value-preview', text: full });
    return el('div', { class: 'value-preview' }, [el('span', { text: UI.truncate(full, 120) }),
      keyedDetails(key, state.flows && state.flows.compact && full.endsWith('…') ? '展开预览（完整原文见证据）' : '展开全文', [el('div', { class: 'raw-value', text: full })])]);
  }

  function focusCall(id) {
    state.filters.calls = F.createFilters().calls;
    pages.calls = Math.max(0, Math.floor(state.timeline.calls.findIndex(function (c) { return c.gateway_call_id === id; }) / 200));
    applyAndRender();
    var node = Array.from(document.querySelectorAll('details[data-detail-key]')).find(function (detail) { return detail.dataset.detailKey === 'call:' + id; });
    if (node) {
      node.open = true;
      window.history.replaceState(null, '', window.location.pathname + window.location.search + '#block-timeline');
      navigateSection();
      node.closest('tr').scrollIntoView({ block: 'center', behavior: 'instant' });
      node.closest('tr').classList.add('focused-call');
    }
  }

  function renderTaskOverview() {
    var box = document.getElementById('task-overview-content');
    var failures = document.getElementById('task-failures');
    clear(box); clear(failures);
    if (!state.timeline) { box.appendChild(el('p', { class: 'hint', text: '请选择一个任务查看概览。' })); return; }
    var summary = Insights.overview(state.timeline, state.flows);
    box.appendChild(el('p', { class: 'task-headline' + (summary.failed.length || summary.missing ? ' status-bad' : ' status-ok'), text: summary.headline }));
    box.appendChild(el('p', { class: 'task-description', text: summary.description }));
    var badges = el('div', { class: 'task-apps' });
    summary.apps.forEach(function (app) { badges.appendChild(tag(app.name, 'muted')); });
    box.appendChild(badges);
    box.appendChild(el('p', { class: 'hint', text: '次数包含失败的操作和读回核对；成功指应用调用返回成功，不代表整项任务已完成。' }));
    if (summary.failed.length) {
      failures.appendChild(el('h3', { text: '需要留意的步骤（' + summary.failed.length + '）' }));
      var list = el('div', { class: 'failure-list' });
      var capped = F.capRows(summary.failed);
      capped.items.forEach(function (call) {
        var card = el('article', { class: 'failure-card', dataset: { callId: call.gateway_call_id } });
        card.appendChild(el('div', { class: 'cell-line' }, [
          el('strong', { text: Insights.appName(call.upstream_app, call.tool_name) + ' · ' + UI.toolLabel(call.tool_name, call.upstream_app) }),
          tag(F.statusLabel(call.status), 'uncertain'),
          el('span', { class: 'hint', text: fmtTime(call.started_at_utc, call.started_at_local_label) })]));
        card.appendChild(el('p', { class: 'failure-outcome', text: Insights.failureText(call) }));
        if (call.error_message) card.appendChild(preview(call.error_message, 'error:' + call.gateway_call_id));
        card.appendChild(el('button', { class: 'btn btn-small', type: 'button', text: '定位失败步骤', onclick: function () { focusCall(call.gateway_call_id); } }));
        if (call.later_success) card.appendChild(el('button', { class: 'btn btn-small', type: 'button', text: '查看后续成功调用', onclick: function () { focusCall(call.later_success.gateway_call_id); } }));
        list.appendChild(card);
      });
      failures.appendChild(keyedDetails('task-failures:' + state.selectedRun, '展开异常步骤', [list]));
      if (capped.truncated) failures.appendChild(el('p', { class: 'hint', text: '仅列出前 ' + capped.cap + ' 次异常，其余请在时间线筛选查看。' }));
    }
  }

  /* ------------------------------------------- 刷新不打断用户：滚动 / 焦点 / 展开态
   *
   * 自动刷新会重渲染四类信息的容器。重渲染本身会丢掉三类**用户侧的临时界面状态**，
   * 这里逐一记录并在渲染后恢复（都不是新数据，只是把用户的视图原样接回来）：
   *   ① 滚动位置（页面纵向 + 表格横向）；
   *   ② 正在输入/选择的筛选控件的焦点与光标位置（用户的输入值本身在 `state.filters` 里，不受影响）；
   *   ③ 用户已经展开的行内 `<details>`（事件明细、候选来源列表）——按数据键恢复，不靠下标。
   */

  /** 自动刷新期间需要保住焦点的筛选控件（含正在输入的条件框）。 */
  var FOCUS_KEEP_IDS = [
    'filter-runs-client',
    'filter-runs-from',
    'filter-runs-to',
    'filter-calls-from',
    'filter-calls-to',
    'run-select',
  ];

  /** 记录「展开着的行内明细」的数据键（detail 元素自己带 data-detail-key）。 */
  function recordOpenDetails() {
    var keys = {};
    Array.prototype.forEach.call(document.querySelectorAll('details[data-detail-key]'), function (node) {
      if (node.open) keys[node.dataset.detailKey] = true;
    });
    return Object.keys(keys);
  }

  /**
   * 渲染完成后恢复展开态。
   * 用**数据键**匹配（同一行渲染出来的键相同），因此行顺序变化也不会张冠李戴。
   * @param {Array<string>} keys
   */
  function restoreOpenDetails(keys) {
    if (!keys || keys.length === 0) return;
    keys.forEach(function (key) {
      if (!key) return;
      Array.prototype.forEach.call(document.querySelectorAll('details[data-detail-key]'), function (node) {
        if (node.dataset.detailKey === key) node.open = true;
      });
    });
  }

  /** 记录当前滚动位置（页面 + 所有可横向滚动的表格容器）。 */
  function captureScroll() {
    var containers = [];
    Array.prototype.forEach.call(document.querySelectorAll('.table-wrap'), function (node, index) {
      if (node.dataset.scrollIndex === undefined) node.dataset.scrollIndex = String(index);
      if (node.scrollLeft !== 0) containers.push({ index: node.dataset.scrollIndex, left: node.scrollLeft });
    });
    return { x: window.scrollX, y: window.scrollY, containers: containers };
  }

  /**
   * 在下一帧恢复滚动位置与焦点。
   * 用 `requestAnimationFrame` 而不是同步恢复：渲染后的布局（表格行高）通常在下一帧才安定。
   * @param {Record<string, any>} snapshot
   */
  function restoreScrollAndFocus(snapshot) {
    if (!snapshot) return;
    var apply = function () {
      if (snapshot.revision !== navigationRevision) return;
      if (typeof snapshot.y === 'number') window.scrollTo(snapshot.x || 0, snapshot.y);
      (snapshot.containers || []).forEach(function (entry) {
        var node = document.querySelector('.table-wrap[data-scroll-index="' + entry.index + '"]');
        if (node) node.scrollLeft = entry.left;
      });
      var active = snapshot.active;
      if (!active || !active.id) return;
      var next = document.getElementById(active.id);
      if (!next || next === document.activeElement) return;
      next.focus();
      if (typeof next.setSelectionRange === 'function' && typeof active.selectionStart === 'number') {
        try {
          next.setSelectionRange(active.selectionStart, active.selectionEnd);
        } catch (error) {
          /* 仅部分 input 类型支持选区：不支持就只恢复焦点 */
        }
      }
    };
    if (typeof window.requestAnimationFrame === 'function') window.requestAnimationFrame(apply);
    else apply();
  }

  /** 记录聚焦中的筛选控件（不在名单里的元素不抢焦点，避免打断用户正在做的事）。 */
  function captureFocus() {
    var node = document.activeElement;
    if (!node || !node.id || FOCUS_KEEP_IDS.indexOf(node.id) === -1) return null;
    return {
      id: node.id,
      selectionStart: typeof node.selectionStart === 'number' ? node.selectionStart : null,
      selectionEnd: typeof node.selectionEnd === 'number' ? node.selectionEnd : null,
    };
  }

  /**
   * 一次「不打断用户」的刷新：把用户侧的界面状态拿在手里，渲染完再原样放回去。
   * @param {() => Promise<any>} work 真正干活的那次刷新
   */
  function preservingScroll(work) {
    var scroll = captureScroll();
    scroll.revision = navigationRevision;
    var focus = captureFocus();
    var open = recordOpenDetails();
    return Promise.resolve()
      .then(work)
      .then(
        function (value) {
          if (value && value.unchanged) return value;
          restoreOpenDetails(open);
          restoreScrollAndFocus({ x: scroll.x, y: scroll.y, containers: scroll.containers, active: focus, revision: scroll.revision });
          return value;
        },
        function (error) {
          // 失败同样要恢复：刷新失败也不能把用户展开/滚动/输入的位置弄丢
          restoreOpenDetails(open);
          restoreScrollAndFocus({ x: scroll.x, y: scroll.y, containers: scroll.containers, active: focus, revision: scroll.revision });
          throw error;
        },
      );
  }

  /**
   * t43：生命周期心跳。
   * 每 10 秒 `GET /api/alive`（只读端点）告诉服务「页面还在」；服务端在空闲超时后自行收尾退出。
   * 说明：网页**无法**检测「浏览器被关闭」——这里做的只是定期汇报存活，超时由服务端判断。
   * t46：只改呈现（工具条里的一行小字 + 悬停看解释），行为与文案口径不变。
   */
  function startHeartbeat() {
    var line = document.getElementById('lifecycle-line');
    function beat() {
      fetch('/api/alive', { headers: { accept: 'application/json' } })
        .then(function (response) { return response.ok ? response.json() : null; })
        .then(function (info) {
          if (!line || !info || !info.lifecycle) return;
          var lc = info.lifecycle;
          line.textContent =
            lc.mode === 'idle-exit'
              ? '生命周期：idle-exit(' + lc.idle_timeout_seconds + 's) — 关闭本页面后约 ' + lc.idle_timeout_seconds + ' 秒服务会退出'
              : '生命周期：keep-alive — 本页面关闭后服务仍会继续运行，直到你按 Ctrl+C 或运行 --stop';
          line.setAttribute('title', line.textContent + '（机制说明见「详情 / 运维」）');
        })
        .catch(function () {
          /* 服务已退出：页面静默即可 */
        });
    }
    beat();
    setInterval(beat, 10000);
  }

  /** 改一个筛选值：空串 = 该条件不限。 */
  function setFilter(group, key, value) {
    state.filters[group][key] = value;
    applyAndRender();
  }

  function clearAllFilters() {
    state.filters = F.createFilters();
    applyAndRender();
    setFilterPanelOpen(false);
  }

  function clearGroup(group) {
    state.filters[group] = F.createFilters()[group];
    applyAndRender();
  }

  /* ---------------------------------------------------------------- 控件构件 */

  /**
   * 一个下拉筛选：`options` 为 [{value, label}]，第一项必须是「不限」。
   * 若当前值不在候选里（例如跨任务残留的值），补一个显式选项，避免选择框静默显示成「不限」。
   */
  function selectFilter(label, group, key, options) {
    var current = state.filters[group][key];
    var select = el('select', { class: 'filter-select', id: 'filter-' + group + '-' + key });
    options.forEach(function (option) {
      select.appendChild(el('option', { value: option.value, text: option.label }));
    });
    var values = options.map(function (option) { return option.value; });
    if (current !== '' && values.indexOf(current) === -1) {
      select.appendChild(el('option', { value: current, text: current + '（当前值）' }));
    }
    select.value = current;
    select.addEventListener('change', function (event) {
      setFilter(group, key, event.target.value);
    });
    return el('label', { class: 'filter-field' }, [el('span', { text: label }), select]);
  }

  /** 文本筛选（客户端标签等）。 */
  function textFilter(label, group, key, placeholder) {
    var input = el('input', {
      type: 'search',
      class: 'filter-input',
      id: 'filter-' + group + '-' + key,
      placeholder: placeholder || '',
      value: state.filters[group][key],
    });
    input.addEventListener('change', function (event) {
      setFilter(group, key, event.target.value.trim());
    });
    return el('label', { class: 'filter-field' }, [el('span', { text: label }), input]);
  }

  /** 日期范围（按 UTC 日期比较）。 */
  function dateFilter(label, group, key) {
    var input = el('input', {
      type: 'date',
      class: 'filter-input',
      id: 'filter-' + group + '-' + key,
      value: state.filters[group][key],
    });
    input.addEventListener('change', function (event) {
      setFilter(group, key, event.target.value);
    });
    return el('label', { class: 'filter-field' }, [el('span', { text: label }), input]);
  }

  function uniqueValues(items, pick) {
    var seen = {};
    var out = [];
    (items || []).forEach(function (item) {
      var value = pick(item);
      if (value === '' || value === null || value === undefined) return;
      var key = String(value);
      if (seen[key]) return;
      seen[key] = true;
      out.push(key);
    });
    return out.sort();
  }

  function optionsFrom(values) {
    return [{ value: '', label: '不限' }].concat(values.map(function (value) {
      return { value: value, label: value };
    }));
  }

  /** 「命中数 / 全量数」——要求两者可辨，所以始终两个数都显示。 */
  function hitTotal(visible, total, unit) {
    return '显示 ' + visible + ' / ' + total + ' ' + unit;
  }

  /** 长文本：截断显示 + `title` 提示全文（信息不丢，只是不铺在首屏）。 */
  function ellipsis(value, max, className) {
    var full = value === null || value === undefined ? '' : String(value);
    var limit = max || ELLIPSIS;
    return el('span', {
      class: 'ellipsis' + (className ? ' ' + className : ''),
      title: full,
      text: full.length > limit ? UI.truncate(full, limit - 1) : full,
    });
  }

  /**
   * 带**数据键**的按需展开块。
   *
   * 为什么需要键：自动刷新会重渲染这些容器，新元素默认是折叠的。如果只按 DOM 下标去恢复，
   * 一旦行顺序变化就会把「A 行展开着」错接到 B 行。键由这一行的数据算出（`call:<id>` /
   * `field:<event_id>:<path>`），因此恢复的是**同一行**的展开态。
   * @param {string} key
   * @param {string} summaryText
   * @param {Array<Node|string>} children
   * @returns {HTMLElement}
   */
  function keyedDetails(key, summaryText, children) {
    var node = details(summaryText, children);
    if (key) node.dataset.detailKey = key;
    return node;
  }

  /** 等宽 + 数字右对齐（时间与计数用 tabular-nums 对齐）。 */
  function num(value) {
    return el('span', { class: 'num', text: value === null || value === undefined ? '—' : String(value) });
  }

  /** 空状态：不是空白页，给出「为什么空」与「怎么恢复」。 */
  function emptyState(group, visible, total, unit) {
    return el('div', { class: 'empty-state' }, [
      el('p', { text: '当前筛选没有匹配的' + unit + '（全量 ' + total + ' ' + unit + '）。' }),
      el('button', {
        type: 'button',
        class: 'btn btn-small',
        text: '清除本区筛选',
        onclick: function () { clearGroup(group); },
      }),
    ]);
  }

  function renderFilterBanner() {
    var status = document.getElementById('filter-status');
    var banner = document.getElementById('filter-banner');
    clear(status);
    var applied = state.applied;
    var entries = applied ? applied.entries : [];
    if (entries.length === 0) {
      status.textContent = '无（显示全部）';
      if (banner) banner.dataset.active = 'no';
      return;
    }
    if (banner) banner.dataset.active = 'yes';
    status.appendChild(document.createTextNode('筛选生效中：'));
    entries.forEach(function (entry, index) {
      if (index > 0) status.appendChild(document.createTextNode('　·　'));
      status.appendChild(el('span', { class: 'filter-chip', text: entry.groupLabel + '·' + entry.label + '=' + entry.display }));
    });
    // 全局「命中 / 全量」摘要：四类各自的 KPI 在各自区块里，这里给一眼可见的总览。
    status.appendChild(el('span', {
      class: 'filter-total',
      text: '　｜　命中 任务 ' + applied.runs.visible + '/' + applied.runs.total +
        '、调用 ' + applied.calls.visible + '/' + applied.calls.total +
        '、边 ' + applied.edges.visible + '/' + applied.edges.total +
        '、字段 ' + applied.fields.visible + '/' + applied.fields.total +
        '　｜　边界摘要仍为全量（不随筛选变化）',
    }));
  }

  function copyViewLink() {
    var status = document.getElementById('copy-status');
    var url = window.location.href;
    var done = function (ok) {
      clear(status);
      status.appendChild(el('span', { class: ok ? 'status-ok' : 'warn', text: ok ? '已复制当前视图链接' : '复制失败：请手动复制地址栏（含筛选条件）' }));
    };
    if (window.navigator && window.navigator.clipboard && window.navigator.clipboard.writeText) {
      window.navigator.clipboard.writeText(url).then(function () { done(true); }, function () { done(false); });
      return;
    }
    done(false);
  }

  /* ------------------------------------------------------------------ ① 任务列表 */

  function renderRuns() {
    var summary = document.getElementById('runs-summary');
    var wrap = document.getElementById('runs-table-wrap');
    clear(summary);
    clear(wrap);
    var filtersBox = document.getElementById('runs-filters');
    clear(filtersBox);

    if (!state.runs) {
      summary.textContent = '正在读取任务…';
      return;
    }
    var applied = state.applied;

    filtersBox.appendChild(selectFilter('登记方式', 'runs', 'registered', [
      { value: '', label: '不限' },
      { value: 'yes', label: '已登记' },
      { value: 'implicit', label: '隐式' },
    ]));
    filtersBox.appendChild(selectFilter('是否缺对', 'runs', 'pairing', [
      { value: '', label: '不限' },
      { value: 'complete', label: '全部成对' },
      { value: 'incomplete', label: '有缺对 !!' },
    ]));
    filtersBox.appendChild(selectFilter('是否异常', 'runs', 'anomaly', [
      { value: '', label: '不限' },
      { value: 'has', label: '有异常' },
      { value: 'none', label: '无异常' },
    ]));
    filtersBox.appendChild(textFilter('客户端', 'runs', 'client', '例如 codex'));
    filtersBox.appendChild(textFilter('搜索任务', 'runs', 'query', '名称、编号、应用或 Agent'));
    filtersBox.appendChild(dateFilter('开始日期起', 'runs', 'from'));
    filtersBox.appendChild(dateFilter('开始日期止', 'runs', 'to'));

    summary.appendChild(el('span', { class: 'kpi', id: 'runs-hit-count', text: hitTotal(applied.runs.visible, applied.runs.total, '个任务') }));
    summary.appendChild(el('span', { class: 'kpi-split', id: 'runs-count-split' }, [
      tag('已登记', 'observed'),
      document.createTextNode(' 全量 ' + applied.runs.registered.total + ' / 命中 ' + applied.runs.registered.visible + '　'),
      tag('隐式', 'muted'),
      document.createTextNode(' 全量 ' + applied.runs.implicit.total + ' / 命中 ' + applied.runs.implicit.visible),
    ]));

    if (applied.runs.total === 0) {
      wrap.appendChild(el('p', { class: 'prose', text: '当前没有任务记录。' }));
      // 说清「为什么空」：读的是哪个库文件、库里有多少条、以及最常见的原因。
      //
      // ⚠️ 文案纪律：首页有一条硬约束 —— **不得出现任何系统/运维标记**
      // （具体词表由 tests/web_api.test.js 逐词断言，且是**纯子串匹配**：连注释里写出来都会红，
      //  所以这里刻意不复述那些词）。因此只能用中文界面语 + 服务端给的纯文件名标签。
      // （2026-10-05：我第一版直接读了服务端那个带下划线的字段名，当场把契约弄红。）
      var meta = state.meta || {};
      var store = meta.store || {};
      var counts = meta.counts || {};
      var detail = '本页读取的事件库文件：' + (store.file_label || '（未知文件）');
      if (store.db_exists === false) {
        detail += '（文件不存在）';
      } else if (typeof counts.calls === 'number' || typeof counts.events === 'number') {
        detail += '（库内：调用 ' + (counts.calls || 0) + ' 条、事件 ' + (counts.events || 0) + ' 条）';
      }
      wrap.appendChild(el('p', { class: 'prose', text: detail }));
      // 候选库列表：把「你的数据可能在哪个文件」直接摆出来，而不是让用户自己去翻目录。
      var candidates = Array.isArray(meta.available_databases) ? meta.available_databases : [];
      var others = candidates.filter(function (item) { return !item.current; });
      if (others.length > 0) {
        wrap.appendChild(el('p', { class: 'prose', text: '本机还有这些事件库可用（按调用数排序）：' }));
        var list = el('ul', { class: 'prose' });
        others.forEach(function (item) {
          list.appendChild(
            el('li', {
              text:
                item.relative +
                '（调用 ' + item.calls + '、事件 ' + item.events + '、已登记运行 ' + item.runs + '）',
            }),
          );
        });
        wrap.appendChild(list);
        wrap.appendChild(
          el('p', {
            class: 'prose',
            text: '要看其中一个：npm run web -- --db ' + others[0].relative + '（或启动时 npm run serve -- --db <路径>）',
          }),
        );
      }
      wrap.appendChild(
        el('p', {
          class: 'prose',
          text:
            '库文件是持久化存储：只要文件还在，历史记录随时可以再用不同 --db 打开查看。' +
            '若你希望所有数据都进同一个库，跑演示时也显式带上同一个 --db 即可。',
        }),
      );
      return;
    }
    if (applied.empty.runs) {
      wrap.appendChild(emptyState('runs', applied.runs.visible, applied.runs.total, '个任务'));
      return;
    }

    var capped = pageRows('runs', applied.runs.items, wrap, 100);
    var rows = capped.items.map(function (run) {
      var key = F.runKey(run) || '(未归属)';
      var anomalies = Object.keys(run.status_summary || {})
        .filter(function (status) { return status !== 'ok'; })
        .map(function (status) { return F.statusLabel(status) + '×' + run.status_summary[status]; });
      var pairingCell = F.hasIncompletePairing(run)
        ? el('span', { class: 'status-bad', title: run.pairing.incomplete.map(function (item) { return UI.shortId(item.gateway_call_id); }).join('、') }, [
          el('span', { class: 'marker-bang', text: '!!' }),
          document.createTextNode(' 缺 ' + run.pairing.incomplete.length + ' 次应答'),
        ])
        : el('span', { class: 'status-ok', text: '全部成对' });
      var anomalyCell = anomalies.length > 0
        ? el('span', { class: 'status-bad', text: '异常 ' + anomalies.join(' ') })
        : el('span', { class: 'status-ok', text: '无异常' });
      return [
        el('span', { class: 'cell-stack' }, [
          el('span', { class: 'cell-line' }, [
            el('button', {
              type: 'button',
              class: 'btn btn-small',
              text: '查看',
              onclick: function () { void selectRun(key).catch(function () { /* 已显示读取原因 */ }); },
            }),
            tag(run.registered ? '已登记' : '隐式', run.registered ? 'observed' : 'muted'),
            el('span', { class: 'muted-id', text: UI.clientLabel(run.client_label), title: '原始标签：' + (run.client_label || '无') }),
            el('span', { class: 'muted-id', text: run.display_name || '跨应用任务', title: '任务编号：' + key }),
          ]),
        ]),
        fmtTime(run.started_at_utc, run.started_at_local_label),
        el('span', { class: 'num-wrap' }, [num(run.call_count), el('span', { class: 'unit', text: '次' })]),
        el('span', { class: 'cell-stack' }, [
          el('span', { class: 'cell-line' }, [pairingCell, anomalyCell]),
        ]),
      ];
    });
    wrap.appendChild(table(['任务 · Agent', '开始时间', '操作次数', '执行结果'], rows));
    if (capped.truncated > 0) {
      wrap.appendChild(el('p', { class: 'hint', text: '仅渲染前 ' + capped.cap + ' 行，另有 ' + capped.truncated + ' 行未显示（用筛选收窄即可看全）。' }));
    }
  }

  function renderRunSelect() {
    var select = document.getElementById('run-select');
    // 数据快照成功提交后，选择框必须与该快照一致，不能沿用旧 DOM 值。
    var previous = state.selectedRun || '';
    clear(select);
    if (!state.runs) return;
    state.runs.runs.forEach(function (run) {
      var key = F.runKey(run);
      select.appendChild(
        el('option', {
          value: key,
          text: (run.registered ? '[已登记] ' : '[隐式] ') + window.TraceTaskPanel.name(key, run.notes || '跨应用任务') + ' · ' + UI.clientLabel(run.client_label) + ' · ' + fmtTime(run.started_at_utc, run.started_at_local_label) + ' · ' + run.call_count + ' 次操作',
        }),
      );
    });
    if (state.runs.runs.length === 0) select.appendChild(el('option', { value: '', text: '（没有任务）' }));
    var exists = previous !== '' && state.runs.runs.some(function (run) { return F.runKey(run) === previous; });
    if (exists) select.value = previous;
    else if (state.runs.runs.length > 0) select.value = F.runKey(state.runs.runs[0]);
  }

  /* ---------------------------------------------------------------- ② 调用时间线 */

  function renderTimeline() {
    var summary = document.getElementById('timeline-summary');
    var wrap = document.getElementById('timeline-table-wrap');
    var filtersBox = document.getElementById('timeline-filters');
    clear(summary);
    clear(wrap);
    clear(filtersBox);

    var data = state.timeline;
    if (!data) {
      summary.textContent = '请选择一个任务';
      return;
    }
    var applied = state.applied;

    filtersBox.appendChild(selectFilter('状态', 'calls', 'status', [
      { value: '', label: '不限' },
    ].concat(Object.keys(F.STATUS_LABELS).map(function (value) {
      return { value: value, label: F.statusLabel(value) };
    }))));
    filtersBox.appendChild(selectFilter('操作', 'calls', 'tool', uniqueValues(data.calls, function (call) { return call.tool_name; }).map(function (value) { return { value: value, label: UI.toolLabel(value) }; }).concat([{ value: '', label: '不限' }])));
    filtersBox.appendChild(selectFilter('通道', 'calls', 'transport', optionsFrom(uniqueValues(data.calls, function (call) {
      return F.transportOfCall(call, applied.calls.eventsIndex);
    }))));
    filtersBox.appendChild(selectFilter('Gateway', 'calls', 'gateway', optionsFrom(uniqueValues(data.calls, function (call) { return call.gateway_id; }))));
    filtersBox.appendChild(selectFilter('是否成对', 'calls', 'pairing', [
      { value: '', label: '不限' },
      { value: 'paired', label: '已配对' },
      { value: 'incomplete', label: '缺对 !!' },
    ]));
    filtersBox.appendChild(dateFilter('调用日期起', 'calls', 'from'));
    filtersBox.appendChild(dateFilter('调用日期止', 'calls', 'to'));

    // 任务级配对事实（全量口径）与筛选命中数分开展示，避免把筛选后的数量误读成全量。
    var pairing = data.pairing;
    summary.appendChild(el('span', { class: 'tag tag-muted', text: '全量配对：' + (pairing.complete ? '全部成对' : '!! ' + pairing.incomplete.length + ' 次缺对') }));
    summary.appendChild(el('span', { class: 'kpi', id: 'timeline-hit-count', text: hitTotal(applied.calls.visible, applied.calls.total, '条调用') }));
    summary.appendChild(el('span', { class: 'summary-note', text: '共 ' + pairing.calls_checked + ' 次调用' }));

    if (applied.calls.total === 0) {
      wrap.appendChild(el('p', { class: 'hint', text: '这次任务没有调用记录。' }));
      return;
    }
    if (applied.empty.calls) {
      wrap.appendChild(emptyState('calls', applied.calls.visible, applied.calls.total, '条调用'));
      return;
    }

    var eventsIndex = applied.calls.eventsIndex;
    var capped = pageRows('calls', applied.calls.items, wrap);
    var rows = capped.items.map(function (call) {
      var events = eventsIndex[call.gateway_call_id] || [];
      var eventList = el('div');
      if (events.length === 0) {
        eventList.appendChild(el('p', { class: 'hint', text: '这次调用没有记录到事件。' }));
      }
      events.forEach(function (event) {
        var line = el('div', { class: 'event-line' }, [
          el('span', { class: 'mono', text: shortId(event.event_id) }),
          document.createTextNode('　' + UI.phaseLabel(event.phase) + '　' + F.statusLabel(event.status) + '　'),
          el('span', { class: 'muted-id', text: fmtTime(event.timestamp_utc, event.timestamp_local_label) }),
        ]);
        if (event.pairing_marker) line.appendChild(el('span', { class: 'marker-bang', text: ' !!' }));
        if (event.payload && event.payload.request_present) {
          line.appendChild(el('button', {
            type: 'button',
            class: 'btn btn-small',
            text: maskedView() ? '查看请求原文（受控）' : '查看请求数据',
            onclick: function () { openReveal('request', event.event_id, ''); },
          }));
        }
        if (event.payload && event.payload.response_present) {
          line.appendChild(el('button', {
            type: 'button',
            class: 'btn btn-small',
            text: maskedView() ? '查看结果原文（受控）' : '查看结果数据',
            onclick: function () { openReveal('response', event.event_id, ''); },
          }));
        }
        eventList.appendChild(line);
      });
      var transport = F.transportOfCall(call, eventsIndex) || '—';
      var resultCell = el('span', { class: 'cell-line' }, [
        el('span', { class: call.status === 'ok' ? 'status-ok' : 'status-bad', text: F.statusLabel(call.status) + (call.error_category ? '（' + call.error_category + '）' : '') }),
        call.pairing_incomplete
          ? el('span', { class: 'status-bad', title: '缺 ' + call.missing.join('+') }, [el('span', { class: 'marker-bang', text: '!! ' }), document.createTextNode('缺 ' + call.missing.join('+'))])
          : el('span', { class: 'status-ok', text: call.paired ? '成对' : '缺 ' + call.missing.join('+') }),
      ]);
      if (call.status !== 'ok') resultCell.appendChild(el('span', { class: 'failure-outcome', text: Insights.failureText(call) }));
      if (call.error_message) eventList.appendChild(preview(call.error_message, 'timeline-error:' + call.gateway_call_id));
      return [
        fmtTime(call.started_at_utc, call.started_at_local_label),
        el('span', { class: 'cell-stack' }, [
          el('span', { class: 'cell-line' }, [
            el('span', { class: 'app-name', text: Insights.appName(call.upstream_app, call.tool_name), title: call.upstream_app || '' }),
          ]),
          el('span', { text: UI.toolLabel(call.tool_name, call.upstream_app), title: call.tool_name || '' }),
        ]),
        resultCell,
        el('span', { class: 'num-wrap', text: UI.duration(call.duration_ms) }),
        keyedDetails('call:' + call.gateway_call_id, '事件（' + events.length + '）', [eventList]),
      ];
    });
    wrap.appendChild(table(['时间', '应用 · 操作', '执行结果', '耗时', '过程详情'], rows));
    if (capped.truncated > 0) {
      wrap.appendChild(el('p', { class: 'hint', text: '仅渲染前 ' + capped.cap + ' 行，另有 ' + capped.truncated + ' 行未显示（用筛选收窄即可看全）。' }));
    }
  }

  /* ------------------------------------------------------- ③ 流向图 + ④ 边证据 */

  function renderFlows() {
    var legendBox = document.getElementById('flows-legend');
    var svgWrap = document.getElementById('flows-svg-wrap');
    var fieldsWrap = document.getElementById('flows-table-wrap');
    var filtersBox = document.getElementById('flows-filters');
    clear(legendBox);
    clear(svgWrap);
    clear(fieldsWrap);
    clear(filtersBox);
    renderAppFlows();

    var data = state.flows;
    if (!data) {
      svgWrap.appendChild(el('p', { class: 'hint', text: '请选择一个任务' }));
      return;
    }
    var applied = state.applied;
    var allEdges = (data.edges.observed || []).concat(data.edges.inferred || []);

    filtersBox.appendChild(selectFilter('置信级别', 'flows', 'confidence', [
      { value: '', label: '不限' },
      { value: 'high', label: '高' },
      { value: 'medium', label: '中' },
      { value: 'low', label: '低' },
    ]));
    filtersBox.appendChild(selectFilter('规则', 'flows', 'rule', [
      { value: '', label: '不限' },
    ].concat(uniqueValues(allEdges, function (edge) { return edge.rule; }).map(function (rule) {
      return { value: rule, label: F.ruleLabel(rule) };
    }))));
    filtersBox.appendChild(selectFilter('表示方式', 'flows', 'representation', [
      { value: '', label: '不限' },
      { value: 'observed', label: '已观测' },
      { value: 'inferred', label: '推断' },
    ]));

    legendBox.appendChild(el('span', { class: 'kpi', id: 'flows-hit-count', text: hitTotal(applied.edges.visible, applied.edges.total, '条边') }));
    data.boundaries.forEach(function (boundary) {
      var visibleCount = boundary.key === 'observed'
        ? applied.edges.observed
        : boundary.key === 'inferred'
          ? applied.edges.inferred
          : boundary.key === 'uncertain'
            ? applied.fields.rows.filter(function (row) { return row.assessment.boundary === 'uncertain'; }).length
            : applied.boundary.notCoveredVisible;
      legendBox.appendChild(
        el('span', { class: 'legend-chip', dataset: { boundary: boundary.key }, title: boundary.label + '；点击图例不改变数据，只用于辨识' }, [
          boundaryTag(boundary.key, boundary.label),
          el('span', { class: 'legend-count', text: visibleCount + ' / 全量 ' + boundary.count }),
        ]),
      );
    });
    legendBox.appendChild(el('span', { class: 'legend-note', text: '实线＝已观测　虚线＝推断　紫框＝不确定　红框＝未覆盖（说明见「详情 / 运维」）' }));
    if (data.compact) legendBox.appendChild(el('span', { class: 'hint', text: data.preview_note }));

    var graph = applied.graph;
    if (graph.links.length > 200) {
      var links = graph.links.slice(0, 200), graphNodes = new Set();
      links.forEach(function (link) { graphNodes.add(link.source_node_id); graphNodes.add(link.sink_node_id); });
      graph = Object.assign({}, graph, { links: links, source_nodes: graph.source_nodes.filter(function (node) { return graphNodes.has(node.node_id); }), sink_nodes: graph.sink_nodes.filter(function (node) { return graphNodes.has(node.node_id); }) });
      svgWrap.appendChild(el('p', { class: 'hint', text: '图中先显示 200 / ' + applied.graph.links.length + ' 条关联；下方表格可翻页查看全部，或按应用与字段筛选。' }));
    }
    svgWrap.appendChild(buildFlowSvg(data, graph));

    if (applied.empty.edges) {
      fieldsWrap.appendChild(emptyState('flows', applied.edges.visible, applied.edges.total, '条边'));
      renderEdgeDetail();
      return;
    }

    var capped = pageRows('fields', applied.fields.rows, fieldsWrap);
    var rows = capped.items.map(function (row) {
      var assessment = row.assessment;
      var boundaryKey = assessment.boundary === 'not_covered' ? 'not_covered' : assessment.boundary;
      var candidateChildren = [
        el('p', {
          class: 'hint',
          text: row.visibleCandidates.length === 0
            ? '没有候选来源。'
            : '候选来源（当前筛选可见 ' + row.visibleCandidates.length + ' 个' + (row.hiddenCandidates > 0 ? '，被筛选隐藏 ' + row.hiddenCandidates + ' 个' : '') + '；全部列出，不替用户择一）：',
        }),
      ];
      if (row.visibleCandidates.length > 0) {
        var list = el('ul', { class: 'candidate-list' });
        row.visibleCandidates.forEach(function (candidate) {
          list.appendChild(el('li', null, [
            boundaryTag(candidate.representation === 'inferred' ? 'inferred' : 'observed', candidate.representation === 'inferred' ? '推断' : '已观测'),
            document.createTextNode(
              ' ' + F.ruleLabel(candidate.rule) + '　可信程度：' + UI.confidenceLabel(candidate.confidence) + '　来源 ' + candidate.source_json_path +
              '　@' + shortId(candidate.source_event_id) + '　值 ' + text(candidate.source_value_masked),
            ),
          ]));
        });
        candidateChildren.push(list);
      }
      if (assessment.uncertainty_reasons && assessment.uncertainty_reasons.length > 0) {
        candidateChildren.push(el('p', { class: 'hint', text: '不确定原因：' + assessment.uncertainty_reasons.join('、') }));
      }
      return [
        el('span', { text: UI.fieldLabel(assessment.sink_json_path), title: assessment.sink_json_path }),
        boundaryTag(boundaryKey, Insights.explanation(assessment).label),
        ellipsis(text(assessment.raw_value_masked), 22),
        keyedDetails(
          'field:' + assessment.sink_event_id + ':' + assessment.sink_json_path,
          row.visibleCandidates.length + ' / ' + (assessment.candidates || []).length + ' 个候选',
          candidateChildren,
        ),
      ];
    });

    if (applied.fields.total === 0) {
      fieldsWrap.appendChild(el('p', { class: 'hint', text: '这次任务没有可判定的写入字段（可能没有写侧调用，或记录里没有载荷）。' }));
    } else if (applied.empty.fields) {
      fieldsWrap.appendChild(emptyState('flows', applied.fields.visible, applied.fields.total, '个写入字段'));
    } else {
      var head = el('div', { class: 'summary', id: 'flows-fields-count', text: hitTotal(applied.fields.visible, applied.fields.total, '个写入字段（跟随流向图筛选）') });
      fieldsWrap.appendChild(head);
      var writeValueLabel = maskedView() ? '写入值（脱敏）' : '写入值';
      fieldsWrap.appendChild(table(['写入字段（记录路径）', '判定', writeValueLabel, '候选'], rows));
      if (capped.truncated > 0) {
        fieldsWrap.appendChild(el('p', { class: 'hint', text: '仅渲染前 ' + capped.cap + ' 行，另有 ' + capped.truncated + ' 行未显示（用筛选收窄即可看全）。' }));
      }
    }
    // 「未覆盖」判定的两个计数口径都显示（当前筛选 / 全量）；措辞原文仍只在 `#boundary-line` 里逐字呈现。
    fieldsWrap.appendChild(el('div', {
      class: 'summary',
      id: 'flows-boundary-counts',
      text: '未覆盖判定：当前筛选 ' + applied.boundary.notCoveredVisible + ' / 全量 ' + applied.boundary.notCoveredTotal + ' 条　（覆盖度措辞属全量事实，见下方「边界摘要」）',
    }));

    renderEdgeDetail();
  }

  function renderAppFlows() {
    var box = document.getElementById('app-flow-groups');
    var detail = document.getElementById('app-flow-detail');
    clear(box); clear(detail);
    if (!state.flows || !state.applied) return;
    var groups = Insights.groupEdges(state.applied.edges.items);
    if (!groups.length) {
      box.appendChild(el('p', { class: 'hint', text: '当前没有可展示的应用间关联。读取或写入成功，并不一定能找到对应的字段来源。' }));
      return;
    }
    if (state.flowGroup && !groups.some(function (group) { return group.key === state.flowGroup; })) state.flowGroup = null;
    groups.forEach(function (group) {
      var selected = state.flowGroup === group.key;
      box.appendChild(el('button', { type: 'button', class: 'app-flow-card' + (selected ? ' is-selected' : ''),
        'aria-pressed': selected ? 'true' : 'false', 'aria-controls': 'app-flow-detail',
        onclick: function () { void preservingScroll(function () { state.flowGroup = selected ? null : group.key; renderFlows(); return Promise.resolve(); }); } }, [
        el('span', { class: 'app-flow-route' }, [el('strong', { text: group.source }), el('span', { class: 'flow-arrow', text: '→' }), el('strong', { text: group.sink })]),
        el('span', { class: 'hint', text: group.fieldCount + ' 个写入字段 · ' + group.edges.length + ' 条候选关联' }),
        el('span', { class: 'hint', text: '已观测 ' + group.observed + ' · 推断 ' + group.inferred }),
        el('span', { class: 'flow-card-action', text: selected ? '收起字段与证据' : '查看字段与证据' })]));
    });
    var selected = groups.find(function (group) { return group.key === state.flowGroup; });
    if (!selected) { detail.appendChild(el('p', { class: 'hint', text: '选择上方流向，查看涉及的字段、原文和匹配依据。同一应用内的读回及写入也会单独展示。' })); return; }
    detail.appendChild(el('h3', { text: selected.source + ' → ' + selected.sink }));
    detail.appendChild(el('p', { class: 'hint', text: '以下为当前流向筛选可见的候选；判断说明仍依据该字段的全部候选，不会因筛选变成唯一来源。' }));
    var fields = new Map();
    selected.edges.forEach(function (edge) {
      var key = JSON.stringify([edge.sink_event_id, edge.sink_json_path]);
      if (!fields.has(key)) fields.set(key, []);
      fields.get(key).push(edge);
    });
    var entries = F.capRows(Array.from(fields.values()));
    entries.items.forEach(function (edges) {
      var first = edges[0];
      var assessment = (state.flows.sink_assessments || []).find(function (a) { return a.sink_event_id === first.sink_event_id && a.sink_json_path === first.sink_json_path; });
      var explanation = Insights.explanation(assessment || { decision: 'uncertain', candidates: edges });
      var card = el('article', { class: 'flow-field-card' });
      card.appendChild(el('div', { class: 'cell-line' }, [el('strong', { text: UI.fieldLabel(first.sink_json_path), title: first.sink_json_path }), tag(explanation.label, explanation.tone)]));
      card.appendChild(preview(first.sink_value_masked, 'flow-value:' + first.sink_event_id + ':' + first.sink_json_path));
      card.appendChild(el('p', { class: 'hint', text: explanation.text }));
      var candidates = el('div', { class: 'flow-candidates' });
      edges.forEach(function (edge) {
        var item = el('div', { class: 'flow-candidate' });
        item.appendChild(el('p', { text: UI.toolLabel(edge.source_tool_name, edge.source_upstream_app) + ' → ' + UI.toolLabel(edge.sink_tool_name, edge.sink_upstream_app) }));
        item.appendChild(el('p', { class: 'hint', text: F.ruleLabel(edge.rule) + ' · 可信程度：' + UI.confidenceLabel(edge.confidence) + (edge.representation === 'inferred' ? ' · 推断' : ' · 已观测匹配') }));
        item.appendChild(el('button', { type: 'button', class: 'btn btn-small', text: '查看这条关联的证据', onclick: function () { loadEdgeDetail(edge.edge_id); } }));
        candidates.appendChild(item);
      });
      card.appendChild(keyedDetails('flow-candidates:' + first.sink_event_id + ':' + first.sink_json_path, '查看 ' + edges.length + ' 条可见候选', [candidates]));
      detail.appendChild(card);
    });
    if (entries.truncated) detail.appendChild(el('p', { class: 'hint', text: '仅展示前 ' + entries.cap + ' 个字段，请使用筛选收窄。' }));
  }

  /** @param {Record<string, any>} data @param {Record<string, any>} graph */
  function buildFlowSvg(data, graph) {
    var sources = (graph.source_nodes || []).slice();
    var sinks = (graph.sink_nodes || []).slice();
    var links = graph.links || [];
    var nodeWidth = 250;
    var nodeHeight = 34;
    var gap = 12;
    var leftX = 16;
    var rightX = 16 + nodeWidth + 150;
    var width = rightX + nodeWidth + 24;
    var rows = Math.max(sources.length, sinks.length, 1);
    var height = 60 + rows * (nodeHeight + gap) + 20;
    var svg = UI.svgEl('svg', { class: 'flow', viewBox: '0 0 ' + width + ' ' + height, width: width, height: height });

    svg.appendChild(UI.svgEl('text', { x: leftX, y: 20, class: 'app-label', text: '数据来源：读取结果' }));
    svg.appendChild(UI.svgEl('text', { x: rightX, y: 20, class: 'app-label', text: '数据去向：写入参数' }));
    svg.appendChild(UI.svgEl('text', {
      x: leftX,
      y: 36,
      class: 'app-label',
      text: '显示 ' + links.length + ' 条关联 / 共 ' + (((data.edges && data.edges.observed) || []).length + (((data.edges && data.edges.inferred) || []).length)) + ' 条',
    }));

    var sourcePos = {};
    var measurement = document.createElement('canvas').getContext('2d');
    if (measurement) measurement.font = '12px Consolas, "Cascadia Mono", monospace';
    var definitions = UI.svgEl('defs');
    svg.appendChild(definitions);
    function nodeLabel(value, x, y, id) {
      var full = String(value), chars = Array.from(full);
      var visible = full;
      if (measurement) {
        if (measurement.measureText(full).width > nodeWidth - 16) {
          var low = 0, high = chars.length;
          while (low < high) {
            var middle = Math.ceil((low + high) / 2);
            if (measurement.measureText(chars.slice(0, middle).join('') + '…').width <= nodeWidth - 16) low = middle;
            else high = middle - 1;
          }
          visible = chars.slice(0, low).join('') + '…';
        }
      } else visible = UI.truncate(full, 18);
      definitions.appendChild(UI.svgEl('clipPath', { id: id }, [UI.svgEl('rect', { x: x, y: y - 12, width: nodeWidth - 16, height: 15 })]));
      return UI.svgEl('text', { x: x, y: y, 'clip-path': 'url(#' + id + ')', text: visible }, [UI.svgEl('title', { text: full })]);
    }
    sources.forEach(function (node, index) {
      var y = 52 + index * (nodeHeight + gap);
      sourcePos[node.node_id] = { x: leftX, y: y };
      svg.appendChild(UI.svgEl('rect', { x: leftX, y: y, width: nodeWidth, height: nodeHeight, rx: 6, class: 'node' }, [UI.svgEl('title', { text: node.json_path })]));
      svg.appendChild(nodeLabel(UI.fieldLabel(node.leaf) + '：' + text(node.value_masked), leftX + 8, y + 15, 'source-value-' + index));
      svg.appendChild(nodeLabel(Insights.appName(node.app, node.tool_name) + ' · ' + UI.toolLabel(node.tool_name, node.app), leftX + 8, y + 28, 'source-tool-' + index));
    });

    var sinkPos = {};
    sinks.forEach(function (node, index) {
      var y = 52 + index * (nodeHeight + gap);
      sinkPos[node.node_id] = { x: rightX, y: y };
      var klass = 'node' + (node.boundary === 'uncertain' ? ' is-uncertain' : node.boundary === 'not_covered' ? ' is-uncovered' : '');
      svg.appendChild(UI.svgEl('rect', { x: rightX, y: y, width: nodeWidth, height: nodeHeight, rx: 6, class: klass }, [UI.svgEl('title', { text: node.json_path })]));
      svg.appendChild(nodeLabel(UI.fieldLabel(node.leaf) + '：' + text(node.value_masked), rightX + 8, y + 15, 'sink-value-' + index));
      svg.appendChild(nodeLabel(Insights.appName(node.app, node.tool_name) + ' · ' + UI.toolLabel(node.tool_name, node.app), rightX + 8, y + 28, 'sink-tool-' + index));
    });

    links.forEach(function (link) {
      var from = sourcePos[link.source_node_id];
      var to = sinkPos[link.sink_node_id];
      if (!from || !to) return;
      var x1 = from.x + nodeWidth;
      var y1 = from.y + nodeHeight / 2;
      var x2 = to.x;
      var y2 = to.y + nodeHeight / 2;
      var mid = (x1 + x2) / 2;
      var path = UI.svgEl('path', {
        d: 'M ' + x1 + ' ' + y1 + ' C ' + mid + ' ' + y1 + ', ' + mid + ' ' + y2 + ', ' + x2 + ' ' + y2,
        class: 'link is-' + (link.boundary === 'inferred' ? 'inferred' : 'observed'),
        'data-boundary': link.boundary,
        'data-edge-id': link.edge_id,
      });
      path.appendChild(UI.svgEl('title', { text: F.ruleLabel(link.rule) + ' / 可信程度：' + UI.confidenceLabel(link.confidence) }));
      path.addEventListener('click', function () {
        loadEdgeDetail(link.edge_id);
      });
      svg.appendChild(path);
      svg.appendChild(UI.svgEl('circle', { cx: x2, cy: y2, r: 3.5, class: 'node-dot' }));
    });

    if (sources.length === 0 && sinks.length === 0) {
      svg.appendChild(UI.svgEl('text', { x: leftX, y: 70, text: '当前筛选下没有可见的字段级边（可清除筛选，或换个任务）。' }));
    }
    return svg;
  }

  function renderEdgeDetail() {
    var box = document.getElementById('edge-detail');
    clear(box);
    if (!state.edgeDetail) {
      box.appendChild(el('h3', { text: '单条边的证据详情' }));
      box.appendChild(el('p', { class: 'hint', text: '点击流向图上的连线，查看数据来源、去向和关联依据。' }));
      return;
    }
    var detail = state.edgeDetail;
    var edge = detail.edge;
    var trace = detail.traceability;
    box.dataset.edgeId = edge.edge_id;
    box.appendChild(el('h3', { text: '单条边的证据详情' }));
    var assessment = (state.flows.sink_assessments || []).find(function (item) { return item.sink_event_id === edge.sink_event_id && item.sink_json_path === edge.sink_json_path; });
    var explanation = Insights.explanation(assessment || { decision: 'uncertain', candidates: [edge] });
    box.appendChild(el('p', { class: 'hint', text: explanation.label + '：' + explanation.text }));
    var fragment = edge.evidence && edge.evidence.literal_fragment;
    if (fragment) {
      box.appendChild(el('p', { class: 'hint', text: '原文位置：' + fragment.source_spans.map(function (span) {
        return '第 ' + (span.start + 1) + '～' + span.end + ' 位';
      }).join('、') + '；共出现 ' + fragment.occurrences + ' 次（按解码文本的 UTF-16 字符位置计数）。' }));
    }
    var list = el('dl');
    [
      ['关联判断', edge.boundary_label],
      ['判断依据', F.ruleLabel(edge.rule)],
      ['可信程度', UI.confidenceLabel(edge.confidence)],
      ['数据来源', UI.appLabel(edge.source_upstream_app) + ' · ' + UI.toolLabel(edge.source_tool_name, edge.source_upstream_app)],
      ['来源记录编号', edge.source_event_id],
      ['来源字段位置', edge.source_json_path],
      [maskedView() ? '来源值（脱敏）' : '来源值', text(edge.source_value_masked)],
      ['数据去向', UI.appLabel(edge.sink_upstream_app) + ' · ' + UI.toolLabel(edge.sink_tool_name, edge.sink_upstream_app)],
      ['去向记录编号', edge.sink_event_id],
      ['去向字段位置', edge.sink_json_path],
      [maskedView() ? '去向值（脱敏）' : '去向值', text(edge.sink_value_masked)],
      ['跨 APP', edge.evidence && edge.evidence.cross_app ? '是' : '否'],
      ['字段改名', edge.evidence && edge.evidence.rename ? (edge.evidence.rename.renamed ? '是：' + edge.evidence.rename.source_leaf + ' → ' + edge.evidence.rename.sink_leaf : '否') : '—'],
    ].forEach(function (pair) {
      list.appendChild(el('dt', { text: pair[0] }));
      list.appendChild(el('dd', { text: String(pair[1]) }));
    });
    box.appendChild(list);

    ['source', 'sink'].forEach(function (side) {
      var endpoint = trace[side];
      if (!endpoint) return;
      var endpointList = el('dl');
      [
        ['event_id', endpoint.event_id],
        ['gateway_call_id', endpoint.gateway_call_id],
        ['方法 / 工具', (endpoint.method || '—') + ' / ' + (endpoint.tool_name || '—')],
        ['phase / status', endpoint.phase + ' / ' + endpoint.status],
        ['时间', fmtTime(endpoint.timestamp_utc, endpoint.timestamp_local_label)],
        ['记录路径', endpoint.json_path],
      ].forEach(function (pair) {
        endpointList.appendChild(el('dt', { text: pair[0] }));
        endpointList.appendChild(el('dd', { text: String(pair[1]) }));
      });
      box.appendChild(el('h4', { text: (side === 'source' ? '来源' : '去向') + ' MCP 请求 / 响应（可回溯）' }));
      box.appendChild(endpointList);
      box.appendChild(details(maskedView() ? '脱敏预览' : '操作数据', [el('div', { class: 'raw-value', text: JSON.stringify(endpoint.payload_preview, null, 2) })]));
      box.appendChild(el('button', {
        type: 'button',
        class: 'btn btn-small',
        text: (side === 'source' ? '查看来源数据' : '查看去向数据'),
        onclick: function () { openReveal(endpoint.payload_hint, endpoint.event_id, endpoint.json_path); },
      }));
    });

    box.appendChild(el('p', { class: 'hint', text: '跨运行串线自检：' + (trace.cross_run_check.ok ? '通过（0 条违规）' : '发现 ' + trace.cross_run_check.violations.length + ' 条违规') }));
  }

  /* ------------------------------------------------- ⑤ 一行边界摘要（不展开） */

  /**
   * `#boundary-line` **严格**只放 `coverage.statements` 的逐字拼接（团队契约：四种边界的限定语原文
   * 不得改写、不得混入其它信息）。筛选的命中/全量计数一律走各自区块的 KPI 元素与工具条状态，
   * 绝不进这一行——`tests/web_api.test.js` 对此有专门断言（值级严格相等 + 结构上不出现计数节点）。
   */
  function renderBoundaryLine() {
    var box = document.getElementById('boundary-line');
    clear(box);
    if (!state.flows) {
      box.textContent = '正在读取边界摘要…';
      return;
    }
    var statements = state.flows.coverage.statements || [];
    if (statements.length === 0) {
      box.textContent = '这次任务没有产生「未覆盖」类措辞（措辞一律来自接口原文，页面不自行生成）。';
      return;
    }
    box.textContent = F.statementsText(statements);
  }

  /* ----------------------------------------------------------------- 自动刷新 */

  /**
   * 自动刷新：把一次刷新包成「同一时刻只有一个在途请求」+「超时可取消」的形式。
   *
   * · 用 `AbortController` 做单次请求超时保护（`ISR.REQUEST_TIMEOUT_MS`）：卡住的请求会被真正
   *   abort 并按失败处理，而不是把后续轮询永久堵在「在途」状态里。
   * · 请求与「刷新」按钮、深链走**同一条** `refresh()` 路径，因此筛选状态与地址栏条件原样重放。
   * @returns {Promise<Record<string, any>>}
   */
  function loadCurrentViewOnce(manual) {
    var controller = new AbortController();
    var timedOut = false;
    var timer = window.setTimeout(function () {
      timedOut = true;
      controller.abort();
    }, ISR.REQUEST_TIMEOUT_MS);
    return preservingScroll(function () {
      return refresh({ signal: controller.signal, layout: true, force: manual === true });
    }).catch(function (error) {
      if (timedOut) throw new Error('自动刷新超时（已取消本次请求，将重试）');
      throw error;
    }).then(
      function (value) {
        window.clearTimeout(timer);
        return value;
      },
      function (error) {
        window.clearTimeout(timer);
        throw error;
      },
    );
  }

  var autoRefresh = ISR.createScheduler({
    intervalSeconds: ISR.DEFAULT_INTERVAL_SECONDS,
    enabled: true,
    visible: true,
    refresh: loadCurrentViewOnce,
  });

  /** 把调度器的决策渲染成工具条上的一行小字（失败必须可辨识，但不吵）。 */
  function renderAutoRefreshStatus() {
    var box = document.getElementById('auto-refresh-status');
    if (!box) return;
    var view = ISR.presentation(autoRefresh.snapshot());
    box.textContent = view.text;
    box.dataset.state = view.state;
    box.classList.toggle('is-failed', view.failed);
    var banner = document.getElementById('filter-banner');
    if (banner) banner.dataset.refresh = view.state;
  }

  var autoRefreshTimer = null;
  var selectionReads = 0;

  /** 按当前间隔重排下一拍（开关关闭/页面在后台时不排：宁可不请求，也不做无意义轮询）。 */
  function rescheduleAutoRefresh() {
    if (autoRefreshTimer !== null) {
      window.clearTimeout(autoRefreshTimer);
      autoRefreshTimer = null;
    }
    if (!autoRefresh.isRunning() || selectionReads > 0) return;
    autoRefreshTimer = window.setTimeout(function () {
      autoRefreshTimer = null;
      return pollOnce();
    }, autoRefresh.nextDelay() * 1000);
  }

  /** 执行一拍（失败只体现在状态文案与退避上：**不清空页面、不改写用户的开关**）。 */
  function pollOnce(manual) {
    if (selectionReads > 0) return Promise.resolve();
    return autoRefresh.tick(manual === true).then(function () {
      renderAutoRefreshStatus();
      rescheduleAutoRefresh();
      return undefined;
    });
  }

  /**
   * 页面可见性：标签页在后台时暂停轮询；回到前台**立即刷一次**再按间隔继续。
   * 这样既不做「后台偷偷刷」，也不让用户回到前台时看到过期数据。
   */
  function handleVisibilityChange() {
    var visible = document.visibilityState !== 'hidden';
    autoRefresh.setVisible(visible);
    renderAutoRefreshStatus();
    if (visible) pollOnce();
    else rescheduleAutoRefresh();
  }

  function initAutoRefresh() {
    var toggle = document.getElementById('auto-refresh-enabled');
    var interval = document.getElementById('auto-refresh-interval');
    autoRefresh.setVisible(document.visibilityState !== 'hidden');
    autoRefresh.setIntervalSeconds(interval ? interval.value : ISR.DEFAULT_INTERVAL_SECONDS);
    if (toggle) {
      // 开关默认开启（HTML 里就是 checked，脚本再显式对齐一次状态）
      toggle.checked = true;
      autoRefresh.setEnabled(true);
      toggle.addEventListener('change', function (event) {
        autoRefresh.setEnabled(event.target.checked === true);
        renderAutoRefreshStatus();
        rescheduleAutoRefresh();
        if (autoRefresh.isEnabled()) void pollOnce();
      });
    }
    if (interval) {
      interval.addEventListener('change', function (event) {
        autoRefresh.setIntervalSeconds(event.target.value);
        renderAutoRefreshStatus();
        rescheduleAutoRefresh();
      });
    }
    document.addEventListener('visibilitychange', handleVisibilityChange);
    window.addEventListener('beforeunload', function () {
      if (autoRefreshTimer !== null) window.clearTimeout(autoRefreshTimer);
      autoRefreshTimer = null;
      reader.cancel();
    });
    renderAutoRefreshStatus();
    rescheduleAutoRefresh();
  }

  /* ------------------------------------------------------------------- loads */

  var reader = window.TraceData.createReader(function (url, options) {
    return UI.fetchJson(url, options);
  });
  var requestedRun = F.runKeyOf(window.location.search);

  /**
   * 选中一个任务并拉取它的时间线与流向图。
   * @param {string} runKey
   * @param {{signal?: AbortSignal, keepEdgeDetail?: boolean}} [options]
   */
  function selectRun(runKey, options) {
    requestedRun = runKey;
    selectionReads++;
    rescheduleAutoRefresh();
    return loadCurrentViewOnce().catch(function (error) {
      document.getElementById('timeline-summary').textContent = '读取失败：' + error.message;
      throw error;
    }).finally(function () {
      selectionReads--;
      rescheduleAutoRefresh();
    });
  }

  /** @param {string} edgeId */
  function loadEdgeDetail(edgeId) {
    if (!state.selectedRun) return;
    var runKey = state.selectedRun;
    UI.fetchJson('/api/runs/' + encodeURIComponent(runKey) + '/edges/' + encodeURIComponent(edgeId))
      .then(function (detail) {
        if (state.selectedRun !== runKey) return;
        state.edgeDetail = detail;
        renderEdgeDetail();
        document.getElementById('edge-detail').scrollIntoView({ block: 'start', behavior: 'instant' });
      })
      .catch(function (error) {
        var box = document.getElementById('edge-detail');
        clear(box);
        box.appendChild(el('p', { class: 'warn', text: '读取这条边的证据失败：' + error.message }));
      });
  }

  /* ---------------------------------------------------------- 受控原文对话框 */

  var revealState = { payload: 'auto', eventId: '', jsonPath: '' };

  /**
   * @param {string} payload
   * @param {string} eventId
   * @param {string} jsonPath
   */
  function openReveal(payload, eventId, jsonPath) {
    var dialog = document.getElementById('reveal-dialog');
    revealState = { payload: payload || 'auto', eventId: eventId, jsonPath: jsonPath || '' };
    var target = document.getElementById('reveal-target');
    clear(target);
    target.appendChild(document.createTextNode('目标事件：' + eventId + '；载荷：' + (payload || 'auto') + '；记录路径：' + (jsonPath || '（整个载荷）')));
    document.getElementById('reveal-reason').value = '';
    document.getElementById('reveal-ack').checked = false;
    dialog.querySelector('h3').textContent = maskedView() ? '受控查看原文' : '操作数据';
    dialog.querySelector('.warn').hidden = !maskedView();
    document.getElementById('reveal-reason').closest('label').hidden = !maskedView();
    document.getElementById('reveal-ack').closest('label').hidden = !maskedView();
    document.getElementById('reveal-submit').hidden = !maskedView();
    if (typeof dialog.showModal === 'function') dialog.showModal();
    else dialog.setAttribute('open', 'open');
    if (!maskedView()) submitReveal();
  }

  function submitReveal() {
    var reason = document.getElementById('reveal-reason').value.trim();
    var ack = document.getElementById('reveal-ack').checked;
    var output = document.getElementById('reveal-target');
    if (maskedView() && reason.length < 3) {
      clear(output);
      output.appendChild(el('span', { class: 'warn', text: '请填写至少 3 个字符的查看理由。' }));
      return;
    }
    if (maskedView() && !ack) {
      clear(output);
      output.appendChild(el('span', { class: 'warn', text: '请先勾选确认框。' }));
      return;
    }
    var params = new URLSearchParams();
    params.set('payload', revealState.payload || 'auto');
    params.set('event_id', revealState.eventId);
    params.set('path', (revealState.jsonPath || '').includes('#') ? '' : revealState.jsonPath || '');
    if (maskedView()) {
      params.set('ack', '1');
      params.set('reason', reason);
    }
    clear(output);
    output.appendChild(document.createTextNode('正在读取数据…'));
    UI.fetchJson('/api/raw?' + params.toString())
      .then(function (result) {
        clear(output);
        if (maskedView()) output.appendChild(el('p', { text: '本次查看已记录：' + result.audit.audit_id + ' @ ' + fmtTime(result.audit.at_utc) + '（理由：' + result.audit.reason + '）' }));
        output.appendChild(el('div', { class: 'raw-value', text: JSON.stringify(result.reveal.value, null, 2) }));
        var warnings = el('ul');
        if (maskedView()) {
          result.warnings.forEach(function (warning) { warnings.appendChild(el('li', { text: warning })); });
          output.appendChild(warnings);
        }
      })
      .catch(function (error) {
        clear(output);
        output.appendChild(el('span', { class: 'warn', text: '读取失败：' + error.message }));
      });
  }

  /* --------------------------------------------------------------------- init */

  /**
   * 一次刷新：重取任务列表 → 决定当前任务（用户选择优先、最后回落第一个）→ 重取该任务的
   * 时间线与流向图 → 重算并重渲染。
   *
   * **筛选与深链保持**就发生在这里：筛选状态一直是 `state.filters`（由 URL 解析而来，
   * 与地址栏双向同步），刷新只重取数据、重放同一份筛选，所以刷新后仍是同一个筛选视图；
   * 「命中数 / 全量数」也由 `F.apply` 在重放后重新算出，不会退化成只看全量。
   *
   * @param {{signal?: AbortSignal, layout?: boolean}} [options]
   *   `signal`：自动刷新的超时/取消控制器；`layout`：本次刷新是自动刷新（同一个任务，
   *   保留用户正在看的单条边证据详情，不打断）。
   */
  /**
   * 单独刷新服务元信息（`/api/meta`）。
   *
   * 为什么单独一个函数、而不是塞进 refresh()：`/api/meta` 在「当前库为空」时要去扫
   * 仓库里的候选事件库文件（见 src/web/databases.js），属于**不该周期性做**的开销。
   * 所以只在首屏取一次；自动刷新只走 refresh()，不再拉 meta。
   * 空状态文案依赖它，而首屏那次已经足够。
   */
  function refreshMeta() {
    return UI.fetchJson('/api/meta').then(
      function (meta) { state.meta = meta; },
      function () { state.meta = null; },
    );
  }

  function refresh(options) {
    var opts = options || {};
    var loadVersion = ++loadingRevision;
    var marker = document.body ? document.body.dataset : {};
    marker.loading = 'true';
    return reader.read({
      checkRevision: true,
      force: opts.force,
      signal: opts.signal,
      selectedRun: requestedRun || state.selectedRun,
      fromUrl: F.runKeyOf(window.location.search),
      runKey: F.runKey,
    }).then(function (snapshot) {
      if (!snapshot) return;
      if (snapshot.unchanged) return snapshot;
      if (state.selectedRun !== snapshot.selectedRun) { state.edgeDetail = null; state.flowGroup = null; pages = {}; }
      state.runs = snapshot.runs;
      state.selectedRun = snapshot.selectedRun;
      state.timeline = snapshot.timeline;
      state.flows = snapshot.flows;
      state.fullTimeline = snapshot.timeline;
      state.fullFlows = snapshot.flows;
      requestedRun = snapshot.selectedRun;
      if (window.TraceTaskPanel) window.TraceTaskPanel.initialize(state.meta && state.meta.view_key || location.origin);
      renderRunSelect();
      applyAndRender();
      marker.committedRun = state.selectedRun;
      marker.viewRevision = String(Number(marker.viewRevision || 0) + 1);
    }).finally(function () { if (loadVersion === loadingRevision) marker.loading = 'false'; });
  }

  function init() {
    startHeartbeat();
    Array.prototype.forEach.call(document.querySelectorAll('.rail a[href^="#"]'), function (link) {
      link.addEventListener('click', function (event) {
        event.preventDefault();
        window.history.pushState(null, '', window.location.pathname + window.location.search + link.getAttribute('href'));
        navigateSection();
      });
    });
    window.addEventListener('hashchange', navigateSection);
    document.getElementById('refresh').addEventListener('click', function () { void pollOnce(true); });
    document.getElementById('clear-filters').addEventListener('click', clearAllFilters);
    document.getElementById('copy-link').addEventListener('click', copyViewLink);
    document.getElementById('toggle-filters').addEventListener('click', function () {
      setFilterPanelOpen(!filterPanelOpen());
    });
    document.getElementById('reveal-cancel').addEventListener('click', function () {
      document.getElementById('reveal-dialog').close();
    });
    document.getElementById('reveal-submit').addEventListener('click', submitReveal);
    document.getElementById('run-select').addEventListener('change', function (event) {
      void selectRun(event.target.value).catch(function () { /* selectRun 已显示原因 */ });
    });
    // 复制链接按钮需要最新 URL：地址栏变化（前进/后退）时同步回筛选状态。
    window.addEventListener('popstate', function () {
      navigateSection();
      if (lastSearch === window.location.search) return;
      lastSearch = window.location.search;
      state.filters = F.parse(window.location.search);
      requestedRun = F.runKeyOf(window.location.search);
      void selectRun(requestedRun).catch(function () {});
    });
    // 首屏默认折叠；深链里带条件时自动展开（让用户看得见条件）
    setFilterPanelOpen(F.isActive(state.filters));
    // 自动刷新接线（开关默认开启；只在页面可见时轮询）
    initAutoRefresh();
    // 先取一次服务元信息：空状态要靠它说清「读的是哪个库、库里有哪些候选库」。
    // 只在此处取一次（不在自动刷新里重复取）——见 refreshMeta() 的说明。
    var metaPromise = refreshMeta();
    Promise.all([metaPromise, pollOnce(true)]).then(navigateSection).catch(function (error) {
      document.getElementById('runs-summary').textContent = '读取失败：' + error.message;
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
