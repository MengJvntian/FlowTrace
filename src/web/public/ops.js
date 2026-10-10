/* src/web/public/ops.js — 次级页（/ops.html）：系统、运维、边界原文与诊断明细（W1）
 *
 * 首页（/）只放结论层，所有系统/运维类内容都搬到这里，并**只**从这里请求：
 *   /api/meta（采集状态、库、只读边界、保留期、脱敏策略、令牌扫描、时区）
 *   /api/ops（受控运维命令）
 *   /api/audit（受控访问记录）
 *   /api/runs?retention=all（每个任务的保留期状态与计数口径）
 *   /api/runs/:id/flows（能力边界原文、散列用途、指标限定语、覆盖度明细、诊断计数）
 * 只读语义不变：全部为 GET；改库动作只显示命令原文，不代执行。
 */
(function () {
  'use strict';

  var UI = window.TraceUI;
  var el = UI.el;
  var clear = UI.clear;
  var table = UI.table;
  var tag = UI.tag;
  var fmtTime = UI.fmtTime;
  var shortId = UI.shortId;
  var text = UI.text;

  var state = { meta: null, ops: null, runs: null, flows: null, selectedRun: null };

  /* ------------------------------------------------------------------- 状态 */

  function renderStatus() {
    var grid = document.getElementById('status-grid');
    clear(grid);
    var meta = state.meta;
    if (!meta) {
      grid.appendChild(el('p', { class: 'hint', text: '正在读取状态…' }));
      return;
    }
    var cards = [
      {
        title: '原始数据采集状态',
        items: [
          ['状态', meta.collection.label],
          ['判定依据', meta.collection.detail],
          ['保留载荷的事件', String(meta.collection.evidence.events_with_payload)],
          ['只留摘要的事件', String(meta.collection.evidence.events_without_payload)],
          ['最近事件（UTC）', fmtTime(meta.collection.evidence.last_event_utc, '')],
        ],
        legend: meta.collection.legend.map(function (item) { return item.label + '：' + item.detail; }),
      },
      {
        title: '事件库与只读连接',
        items: [
          ['库路径', meta.store.db_path],
          ['库文件存在', meta.store.db_exists ? '是' : '否'],
          ['库字节数', String(meta.store.db_bytes)],
          ['打开方式', meta.store.open_mode],
          ['打开错误', meta.store.open_error || '无'],
          ['schema_version', String(meta.store.schema_version)],
          ['ddl_version', String(meta.store.ddl_version)],
          ['journal_mode', meta.store.journal_mode === null || meta.store.journal_mode === undefined ? '（只读连接不执行 PRAGMA journal_mode，故为 null）' : String(meta.store.journal_mode)],
        ],
      },
      {
        title: '服务与只读边界',
        items: [
          ['监听地址', meta.service.host + ':' + meta.service.port],
          ['允许方法', meta.service.allowed_methods.join(' / ')],
          ['写端点', meta.service.write_endpoints.length === 0 ? '无（设计如此）' : meta.service.write_endpoints.join(',')],
          ['JSONL/导出', '只读 API，不落盘'],
        ],
        legend: meta.service.write_guard,
      },
      {
        title: '计数与采集失败',
        items: [
          ['调用 / 事件', meta.counts.calls + ' / ' + meta.counts.events],
          ['截断事件', String(meta.counts.truncated_events)],
          ['采集写入失败', JSON.stringify(meta.counts.write_failures)],
          ['调用状态分布', JSON.stringify(meta.counts.calls_by_status)],
          ['事件阶段分布', JSON.stringify(meta.counts.events_by_phase)],
        ],
      },
      {
        title: '保留期策略',
        items: [
          ['保留期天数', meta.retention.days + (meta.retention.enabled ? ' 天' : '（已关闭过滤）')],
          ['缺省列表模式', meta.retention.default_mode],
          ['截止时间（UTC）', fmtTime(meta.retention.cutoff_utc, meta.retention.cutoff_local_label)],
          ['删除边界', meta.retention.delete_boundary],
        ],
      },
      {
        title: '时间与时区',
        items: [
          ['UTC 策略', meta.time.utc_policy],
          ['本机时区', meta.time.local_timezone.name + '（' + meta.time.local_timezone.offset_label + '）'],
          ['当前时间（UTC）', meta.time.now_utc],
          ['当前时间（本机）', meta.time.now_local_label],
        ],
      },
      {
        title: '共享内存与运行计数口径',
        items: [
          ['已登记运行', meta.run_root.registered.count + ' 个（' + meta.run_root.registered.cli_semantics + '）'],
          ['隐式运行', meta.run_root.implicit.count + ' 个（' + meta.run_root.implicit.cli_semantics + '）'],
          ['合计', String(meta.run_root.total)],
          ['不得合并的原因', meta.run_root.note],
        ],
      },
      {
        title: '审计机制',
        items: [
          ['记录条数 / 上限', meta.audit.count + ' / ' + meta.audit.max],
          ['溢出丢弃', String(meta.audit.dropped)],
          ['是否落盘', meta.audit.persisted ? '是' : '否（内存环形缓冲，进程重启即清空）'],
          ['说明', meta.audit.note],
        ],
      },
    ];
    cards.forEach(function (card) {
      var list = el('dl');
      card.items.forEach(function (pair) {
        list.appendChild(el('dt', { text: pair[0] }));
        list.appendChild(el('dd', { text: pair[1] }));
      });
      var node = el('div', { class: 'card' }, [el('h3', { text: card.title }), list]);
      (card.legend || []).forEach(function (line) {
        node.appendChild(el('p', { class: 'hint', text: line }));
      });
      grid.appendChild(node);
    });
  }

  /* -------------------------------------------------------- 计数口径与保留期 */

  function renderRunsCount() {
    var prose = document.getElementById('runs-count-prose');
    var wrap = document.getElementById('runs-retention-wrap');
    clear(prose);
    clear(wrap);
    var data = state.runs;
    if (!data) {
      prose.textContent = '正在读取…';
      return;
    }
    prose.appendChild(el('p', { text: '计数口径：' + data.run_root.note }));
    prose.appendChild(el('p', {
      class: 'hint',
      text: '已登记 = ' + data.run_root.registered.cli_semantics + '；隐式 = ' + data.run_root.implicit.cli_semantics + '。',
    }));
    prose.appendChild(el('p', {
      class: 'hint',
      text: '保留期过滤：' + (data.retention.enabled ? '启用，' + data.retention.days + ' 天，缺省模式 ' + data.retention.mode : '已关闭') +
        '；本次因保留期被隐藏的运行数 = ' + data.retention.filtered_out.count +
        (data.retention.filtered_out.count > 0 ? '（' + data.retention.filtered_out.run_ids.join('、') + '）' : '') +
        '；说明：' + data.retention.filtered_out.reason,
    }));
    var rows = data.runs.map(function (run) {
      return [
        el('span', { class: 'mono muted-id', text: shortId(run.experiment_run_id || run.run_id) }),
        tag(run.registered ? '已登记' : '隐式', run.registered ? 'observed' : 'muted'),
        run.client_label || '—',
        String(run.call_count),
        fmtTime(run.started_at_utc, run.started_at_local_label),
        fmtTime(run.last_event_utc, run.last_event_local_label),
        run.retention.expired ? tag('已过期', 'uncovered') : tag('在保留期内', 'muted'),
        run.collection.label,
      ];
    });
    wrap.appendChild(table(['任务', '计数口径', '客户端', '调用数', '开始时间（UTC ⇄ 本机）', '最近事件（UTC ⇄ 本机）', '保留期', '采集状态'], rows));
  }

  function renderRunSelect() {
    var select = document.getElementById('run-select-ops');
    var previous = select.value;
    clear(select);
    if (!state.runs) return;
    state.runs.runs.forEach(function (run) {
      var key = run.experiment_run_id || run.run_id;
      select.appendChild(el('option', { value: key, text: (run.registered ? '[已登记] ' : '[隐式] ') + (run.client_label || '—') + ' · ' + shortId(key) }));
    });
    if (state.runs.runs.length === 0) select.appendChild(el('option', { value: '', text: '（没有任务）' }));
    var exists = previous && state.runs.runs.some(function (run) { return (run.experiment_run_id || run.run_id) === previous; });
    if (exists) select.value = previous;
    else if (state.runs.runs.length > 0) select.value = state.runs.runs[0].experiment_run_id || state.runs.runs[0].run_id;
  }

  /* ------------------------------------------------------------------ 运维命令 */

  function renderOpsCommands() {
    var box = document.getElementById('run-ops');
    clear(box);
    var ops = state.ops;
    if (!ops) {
      box.appendChild(el('p', { class: 'hint', text: '正在读取运维入口…' }));
      return;
    }
    var runKey = state.selectedRun || '<experiment_run_id>';
    var dbPath = state.meta ? state.meta.store.db_path : '<db>';
    box.appendChild(el('div', { class: 'card' }, [
      el('h3', { text: '只读边界' }),
      el('p', { text: ops.read_only_boundary.statement }),
      el('p', { class: 'hint', text: '实现方式：' + ops.read_only_boundary.enforced_by.join('；') }),
    ]));
    box.appendChild(el('div', { class: 'card' }, [
      el('h3', { text: '本任务（' + shortId(runKey) + '）' }),
      el('div', { class: 'ops-command', text: 'node bin/trace.js delete --run ' + runKey + ' --db "' + dbPath + '"' }),
      el('div', { class: 'ops-command', text: 'node bin/trace.js delete --run ' + runKey + ' --db "' + dbPath + '" --dry-run' }),
      el('div', { class: 'ops-command', text: '/api/runs/' + runKey + '/export?format=json' }),
      el('p', { class: 'hint', text: '删除预演不改库；导出不会在服务端落盘。' }),
    ]));
    ops.commands.forEach(function (command) {
      var card = el('div', { class: 'card' }, [el('h3', { text: command.label }), el('p', { text: command.purpose })]);
      card.appendChild(el('div', { class: 'ops-command', text: command.command }));
      if (command.dry_run_command) card.appendChild(el('div', { class: 'ops-command', text: '预演：' + command.dry_run_command }));
      if (command.page_api) card.appendChild(el('div', { class: 'ops-command', text: '只读 API：' + command.page_api }));
      if (command.cli_doc) card.appendChild(el('p', { class: 'hint', text: command.cli_doc }));
      box.appendChild(card);
    });
  }

  /* ------------------------------------------------------------- 脱敏与密钥 */

  function renderMask() {
    var box = document.getElementById('mask-prose');
    var secretsBox = document.getElementById('secrets-prose');
    clear(box);
    clear(secretsBox);
    var meta = state.meta;
    if (!meta) {
      box.textContent = '正在读取…';
      return;
    }
    box.appendChild(el('p', { text: meta.mask.label }));
    var rules = el('ul');
    meta.mask.rules.forEach(function (rule) { rules.appendChild(el('li', { text: rule })); });
    box.appendChild(rules);
    box.appendChild(el('p', { text: '查看原文：' + (meta.mask.controlled_raw.enabled ? '开启' : '关闭') + '；' + (meta.mask.controlled_raw.requires.length ? '要求 ' + meta.mask.controlled_raw.requires.join(' + ') + '；' : '') + meta.mask.controlled_raw.note }));
    var boundaries = el('ul');
    meta.mask.boundaries.forEach(function (line) { boundaries.appendChild(el('li', { text: line })); });
    box.appendChild(boundaries);

    secretsBox.appendChild(el('p', { text: '疑似敏感 / 密钥字段统计：' + JSON.stringify(meta.secrets.by_category) + '（' + meta.secrets.scan_scope + '）' }));
    if (meta.secrets.path_samples.length > 0) {
      var list = el('ul');
      meta.secrets.path_samples.forEach(function (p) { list.appendChild(el('li', { class: 'mono', text: p })); });
      secretsBox.appendChild(list);
    }
    secretsBox.appendChild(el('p', { text: meta.secrets.policy }));
  }

  /* --------------------------------------------------------------- 审计记录 */

  function loadAudit() {
    return UI.fetchJson('/api/audit').then(function (data) {
      var summary = document.getElementById('audit-summary');
      clear(summary);
      summary.appendChild(document.createTextNode('记录 ' + data.summary.count + '/' + data.summary.max + ' 条（溢出丢弃 ' + data.summary.dropped + ' 条）；' + data.summary.note));
      var wrap = document.getElementById('audit-table-wrap');
      clear(wrap);
      wrap.appendChild(
        table(
          ['audit_id', '时间（UTC）', '动作', '目标', 'event_id', '载荷 / JSON 路径', '理由', '来源', '是否保存原文'],
          data.entries.map(function (entry) {
            return [
              entry.audit_id,
              entry.at_utc,
              entry.action,
              entry.target_kind,
              shortId(entry.event_id),
              (entry.payload || '—') + ' / ' + (entry.json_path || '(整个载荷)'),
              entry.reason,
              (entry.client.remote_address || '—') + (entry.client.host ? ' via ' + entry.client.host : ''),
              entry.raw_value_stored ? '是（异常！）' : '否',
            ];
          }),
        ),
      );
      return data;
    });
  }

  /* ------------------------------------------------- 边界原文 / 覆盖度 / 诊断 */

  function renderBoundaryDetail() {
    var prose = document.getElementById('boundaries-prose');
    var coverage = document.getElementById('coverage-prose');
    var diagnostics = document.getElementById('diagnostics-prose');
    var excludedWrap = document.getElementById('excluded-table-wrap');
    clear(prose);
    clear(coverage);
    clear(diagnostics);
    clear(excludedWrap);
    var flows = state.flows;
    if (!flows) {
      prose.textContent = '正在读取本任务的边界与诊断…';
      return;
    }
    var list = el('ul');
    (flows.boundaries_text || []).forEach(function (line) { list.appendChild(el('li', { text: line })); });
    prose.appendChild(el('p', { text: '能力边界（L1 原文）：' }));
    prose.appendChild(list);
    prose.appendChild(el('p', { text: '散列用途（L1 原文）：' + flows.hash_policy }));
    prose.appendChild(el('p', { text: '指标限定语：' + flows.metric_note }));
    prose.appendChild(el('p', { class: 'hint', text: '跨运行串线自检：' + (flows.cross_run_check.ok ? '通过（0 条违规）' : '发现 ' + flows.cross_run_check.violations.length + ' 条违规') }));

    var statements = el('ul');
    (flows.coverage.statements || []).forEach(function (statement) { statements.appendChild(el('li', { text: '原文措辞：' + statement })); });
    if (statements.childNodes.length === 0) statements.appendChild(el('li', { text: '（本次没有产生「未在已观测写入请求中发现…」的措辞）' }));
    coverage.appendChild(el('p', { text: '已观测写入请求数 = ' + flows.coverage.observed_write_request_count + '；敏感来源字段 = ' + flows.coverage.sensitive_source_fields }));
    coverage.appendChild(statements);
    var notFound = el('ul');
    (flows.coverage.not_found_in_observed_writes || []).forEach(function (item) {
      notFound.appendChild(el('li', { class: 'mono', text: item.statement + '　类别：' + item.label + '　来源路径：' + item.source_json_path + '　值：' + text(item.value_masked) }));
    });
    if (notFound.childNodes.length > 0) coverage.appendChild(notFound);
    if (flows.coverage.inference_note) coverage.appendChild(el('p', { class: 'hint', text: flows.coverage.inference_note }));

    diagnostics.appendChild(el('p', { text: '排除原因计数：' + JSON.stringify(flows.diagnostics.excluded_by_reason) }));
    diagnostics.appendChild(el('p', { text: '计数器：' + JSON.stringify(flows.diagnostics.counters) }));
    diagnostics.appendChild(el('p', { class: 'hint', text: '参与本次判定的运行：' + (flows.diagnostics.participating_run_ids || []).join('、') }));

    var rows = (flows.diagnostics.excluded_events || []).map(function (entry) {
      return [shortId(entry.event_id), entry.phase || '—', entry.upstream_app || '—', entry.tool_name || '—', entry.reason || '—', entry.detail || '—'];
    });
    if (rows.length === 0) {
      excludedWrap.appendChild(el('p', { class: 'hint', text: '没有被排除的事件。' }));
    } else {
      excludedWrap.appendChild(table(['event_id', 'phase', '应用', '工具', '排除原因', '细节'], rows));
    }
  }

  /* ---------------------------------------------------------------- 字段对照 */

  function renderFieldGlossary() {
    var wrap = document.getElementById('fields-table-wrap');
    clear(wrap);
    var rows = [
      ['task / run', 'experiment_run_id、run_id', '一个任务的标识；「已登记」指 runs 表有行。'],
      ['call', 'gateway_call_id、upstream_app、tool_name', '一次经 Gateway 的调用：目标应用与工具。'],
      ['event', 'event_id、phase、timestamp_utc', '一次观测事件；phase ∈ request/response/error/…。'],
      ['pairing', 'pairing.complete、pairing.incomplete[]', '成对判定：缺 response/error 即为缺对（页面用 !!）。'],
      ['edge', 'source_event_id、source_json_path、sink_event_id、sink_json_path、rule、confidence', '字段级边的来源与去向、匹配规则与置信级别。'],
      ['registered', 'REGISTERED=yes / REGISTERED=implicit', '已登记运行与隐式运行的 CLI 口径，两者分开计数。'],
      ['mask', 'masked、mask_mode、<redacted:secret>', state.meta && state.meta.mask.mode === 'original_values' ? '个人工作台直接显示原始数据。' : '当前启用展示脱敏。'],
      ['raw access', 'ack=1、reason、audit', '受控查看原文的门禁与记录。'],
    ];
    wrap.appendChild(table(['人话', '字段名', '说明'], rows));
  }

  /* ---------------------------------------------------------------- 数据加载 */

  function loadMeta() {
    return UI.fetchJson('/api/meta').then(function (meta) {
      state.meta = meta;
      renderStatus();
      renderMask();
      renderOpsCommands();
      return meta;
    });
  }

  function loadOps() {
    return UI.fetchJson('/api/ops').then(function (ops) {
      state.ops = ops;
      renderOpsCommands();
      return ops;
    });
  }

  function loadRuns() {
    return UI.fetchJson('/api/runs?retention=all').then(function (data) {
      state.runs = data;
      renderRunsCount();
      renderRunSelect();
      return data;
    });
  }

  /** @param {string} runKey */
  function selectRun(runKey) {
    state.selectedRun = runKey;
    renderOpsCommands();
    if (!runKey) return Promise.resolve();
    return UI.fetchJson('/api/runs/' + encodeURIComponent(runKey) + '/flows')
      .then(function (flows) {
        state.flows = flows;
        renderBoundaryDetail();
      })
      .catch(function (error) {
        document.getElementById('boundaries-prose').textContent = '读取失败：' + error.message;
      });
  }

  function refresh() {
    return Promise.all([loadMeta(), loadOps(), loadRuns(), loadAudit()]).then(function () {
      var runKey = state.selectedRun || (state.runs.runs[0] && (state.runs.runs[0].experiment_run_id || state.runs.runs[0].run_id));
      return runKey ? selectRun(runKey) : null;
    });
  }

  function init() {
    document.getElementById('refresh').addEventListener('click', function () { void refresh(); });
    document.getElementById('run-select-ops').addEventListener('change', function (event) {
      selectRun(event.target.value);
    });
    renderFieldGlossary();
    refresh().catch(function (error) {
      document.getElementById('status-grid').textContent = '读取失败：' + error.message;
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
