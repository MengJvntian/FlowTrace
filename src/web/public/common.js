/* src/web/public/common.js — P3 只读页面共用的极简工具（W1）
 *
 * 约束（与 server.js 的 CSP 一致）：经典脚本、无内联事件处理器、无内联样式、无第三方依赖、无构建链。
 * 首页（/）与次级页（/ops.html）都只从同源只读 GET 接口取数，页面自己不写任何东西。
 *
 * 本文件刻意只放**展示工具**，不放任何系统/运维文案——首页与次级页的文案边界由各自页面决定，
 * 这样「首页不得出现系统信息」这条要求可以用对静态文本的断言来证明。
 *
 * 自动刷新（`isr.js`，首页加载）与筛选（`filters.js`，首页加载）都复用这里的 `fetchJson`，
 * 因此「只读 + 脱敏」边界只有一处实现：所有页面请求都是同源 GET，没有任何写路径。
 */
(function () {
  'use strict';

  /**
   * @param {string} tag
   * @param {Record<string, any>} [props]
   * @param {Array<Node|string|null|undefined>} [children]
   * @returns {HTMLElement}
   */
  /**
   * 把可能为 null / undefined 的值渲染成可读文本。
   *
   * 为什么必须有这个函数（2026-10-05 用户报「读取还是 null」）：
   *   `node.textContent = null` 在浏览器里**不会**变成空 — 它会变成**字面字符串 "null"**。
   *   于是任何 `el('span', { text: someField })` 只要该字段是 null（例如「调用正常所以没有
   *   error_message」「Mock 运行没有 notes」「未归属运行没有 client_label」，这些都是**设计上
   *   本来就为空**的字段），页面上就会直愣愣地显示一个 "null"，看起来像读取失败。
   *   这里统一兜底：null / undefined / 空串 → `—`；其它值原样 String()。
   *
   * @param {*} value
   * @param {string} [placeholder]
   * @returns {string}
   */
  function displayText(value, placeholder) {
    var dash = typeof placeholder === 'string' ? placeholder : '—';
    if (value === null || value === undefined) return dash;
    if (typeof value === 'string') return value === '' ? dash : value;
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    return String(value);
  }

  function el(tag, props, children) {
    var node = document.createElement(tag);
    if (props) {
      Object.keys(props).forEach(function (key) {
        if (key === 'class') node.className = props[key];
        // text 走 displayText 兜底：绝不把 null/undefined 渲染成字面量
        else if (key === 'text') node.textContent = displayText(props[key]);
        else if (key === 'dataset') {
          Object.keys(props[key]).forEach(function (dataKey) {
            node.dataset[dataKey] = props[key][dataKey];
          });
        } else if (key.indexOf('on') === 0 && typeof props[key] === 'function') {
          node.addEventListener(key.slice(2).toLowerCase(), props[key]);
        } else if (props[key] !== null && props[key] !== undefined && props[key] !== false) {
          node.setAttribute(key, props[key]);
        }
      });
    }
    (children || []).forEach(function (child) {
      if (child === null || child === undefined) return;
      node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
    });
    return node;
  }

  /**
   * @param {string} tag
   * @param {Record<string, any>} [attrs]
   * @param {Array<Node|null|undefined>} [children]
   * @returns {SVGElement}
   */
  function svgEl(tag, attrs, children) {
    var node = document.createElementNS('http://www.w3.org/2000/svg', tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (key) {
        if (attrs[key] === null || attrs[key] === undefined) return;
        if (key === 'text') node.textContent = String(attrs[key]);
        else node.setAttribute(key, String(attrs[key]));
      });
    }
    (children || []).forEach(function (child) {
      if (child) node.appendChild(child);
    });
    return node;
  }

  /** @param {Node} node */
  function clear(node) {
    while (node.firstChild) node.removeChild(node.firstChild);
  }

  /**
   * 只读取数：非 2xx 或 `ok:false` 一律 reject（页面不会把数据缺口当成脚本错误来隐藏）。
   *
   * @param {string} url
   * @param {{signal?: AbortSignal}} [options] 自动刷新用：把外部 AbortSignal（超时保护 / 页面卸载）传进来，
   *   让一次卡住的请求能被真正取消，而不是把后续轮询堵在「在途」状态里。
   * @returns {Promise<Record<string, any>>}
   */
  function fetchJson(url, options) {
    var init = { headers: { Accept: 'application/json' }, credentials: 'omit' };
    if (options && options.signal) init.signal = options.signal;
    return fetch(url, init).then(function (response) {
      return response.json().then(function (body) {
        if (!response.ok || body.ok === false) {
          var message = body && body.error ? body.error.message : 'HTTP ' + response.status;
          throw new Error(message);
        }
        return body;
      });
    });
  }

  /**
   * @param {Array<string|Node>} headers
   * @param {Array<Array<Node|string|null>>} rows
   * @returns {HTMLTableElement}
   */
  function table(headers, rows) {
    var thead = el('thead', null, [
      el(
        'tr',
        null,
        headers.map(function (header) {
          return typeof header === 'string' ? el('th', { text: header }) : el('th', null, [header]);
        }),
      ),
    ]);
    var tbody = el(
      'tbody',
      null,
      rows.map(function (row) {
        return el(
          'tr',
          null,
          row.map(function (cell) {
            if (cell === null || cell === undefined) return el('td', { text: '—' });
            if (typeof cell === 'object' && cell.nodeType) return el('td', null, [cell]);
            return el('td', { text: String(cell) });
          }),
        );
      }),
    );
    return el('table', null, [thead, tbody]);
  }

  /**
   * 短标签（色块）。
   * @param {string} label
   * @param {string} kind observed / inferred / uncertain / uncovered / muted
   * @returns {HTMLElement}
   */
  function tag(label, kind) {
    return el('span', { class: 'tag tag-' + kind, text: label });
  }

  /**
   * 四种边界键 → 短标签色块（键名保持原样，供 data-boundary 断言）。
   * @param {string} key
   * @param {string} label
   * @returns {HTMLElement}
   */
  function boundaryTag(key, label) {
    return tag(label, key === 'not_covered' ? 'uncovered' : key);
  }

  /**
   * 时间：本机年月日与时分秒；原始 UTC 仍保留在接口和事件记录中。
   * @param {string|null|undefined} utc
   * @param {string|null|undefined} localLabel
   * @returns {string}
   */
  function fmtTime(utc, localLabel) {
    if (!utc) return '—';
    var wall = /^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})/u.exec(localLabel || '');
    if (wall) return wall[1];
    var date = new Date(utc);
    if (!Number.isFinite(date.getTime())) return '时间未知';
    function pad(value) { return String(value).padStart(2, '0'); }
    return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate()) + ' ' +
      pad(date.getHours()) + ':' + pad(date.getMinutes()) + ':' + pad(date.getSeconds());
  }

  function clientLabel(value) {
    return ({ codex: 'Codex', deepseek_harness: 'DeepSeek Harness', dsh: 'DeepSeek Harness',
      deterministic: '旧记录 · Agent 未识别' })[value] || (value ? String(value) : 'Agent 未识别');
  }

  function appLabel(value) {
    return ({ 'google-gmail': 'Gmail', 'google-calendar': 'Google 日历',
      'google-drive': 'Google 云端硬盘', 'google-docs': 'Google 文档', 'google-sheets': 'Google 表格',
      'github': 'GitHub', 'feishu': '飞书', 'feishu-docs': '飞书文档',
      'tencent-docs': '腾讯文档', 'dingtalk': '钉钉',
      'notion': 'Notion', 'gitee': 'Gitee', 'qq-mail': 'QQ 邮箱',
      'mock-mail': '演示邮箱', 'mock-calendar': '演示日历' })[value] || (value || '未知应用');
  }

  var domesticToolLabels = {
  "get_user_info": "查看腾讯文档账户",
  "query_space_list": "查看知识库空间",
  "create_smartcanvas_by_mdx": "创建腾讯智能文档",
  "create_space": "创建知识库空间",
  "smartcanvas.read": "读取腾讯智能文档",
  "smartcanvas.find": "查找智能文档正文",
  "smartcanvas.edit": "编辑腾讯智能文档",
  "doc.create_with_markdown": "创建腾讯文字文档",
  "doc.get_outline": "查看文档大纲",
  "doc.resolve_document_structure": "查看文档结构",
  "doc.find": "查找文档正文",
  "doc.get_comments": "查看文档批注",
  "doc.get_images": "查看文档图片",
  "doc.get_table_info": "读取文档表格",
  "doc.get_last_operable_pos": "查看正文末尾位置",
  "doc.insert_text": "插入文档文字",
  "doc.insert_markdown": "插入文档正文",
  "doc.replace_text": "替换文档文字",
  "doc.find_and_replace": "批量替换文档文字",
  "doc.insert_paragraph_with_text": "插入文档段落",
  "doc.insert_comment": "添加文档批注",
  "manage.recent_online_file": "查看最近文档",
  "manage.query_file_info": "读取文档信息",
  "manage.query_folder_meta": "读取文件夹信息",
  "manage.folder_list": "查看文件夹内容",
  "manage.search_file": "搜索腾讯文档",
  "manage.get_privilege": "查看文档共享状态",
  "manage.create_file": "创建腾讯文档文件",
  "manage.copy_file": "复制腾讯文档",
  "manage.rename_file_title": "重命名文档",
  "manage.delete_file": "移入回收站",
  "sheet.get_sheet_info": "查看腾讯表格工作表",
  "sheet.get_cell_data": "读取腾讯表格单元格",
  "sheet.set_cell_value": "写入腾讯表格单元格",
  "sheet.set_range_value": "批量写入腾讯表格",
  "sheet.add_sheet": "新增腾讯表格工作表",
  "sheet.rename_sheet": "重命名工作表",
  "sheet.delete_sheet": "删除工作表",
  "sheet.clear_range_cells": "清空单元格",
  "smartsheet.list_fields": "查看智能表格字段",
  "smartsheet.list_views": "查看智能表格视图",
  "smartsheet.delete_records": "删除智能表格记录",
  "smartsheet.add_table": "新增智能表格工作表",
  "smartsheet.delete_table": "删除智能表格工作表",
  "smartsheet.update_view": "修改智能表格视图",
  "smartsheet.delete_view": "删除智能表格视图",
  "smartsheet.delete_fields": "删除智能表格字段",
  "create_smartcanvas_by_markdown": "创建腾讯智能文档",
  "create_excel_by_markdown": "创建腾讯表格",
  "create_slide_by_markdown": "创建腾讯幻灯片",
  "create_mind_by_markdown": "创建思维导图",
  "create_flowchart_by_mermaid": "创建流程图",
  "create_word_by_markdown": "创建腾讯文字文档",
  "query_space_node": "查看腾讯文档目录",
  "create_space_node": "创建目录节点",
  "delete_space_node": "删除目录节点",
  "search_space_file": "搜索腾讯文档",
  "get_content": "读取腾讯文档正文",
  "batch_update_sheet_range": "批量写入腾讯表格",
  "smartcanvas.create_smartcanvas_element": "新增文档内容",
  "smartcanvas.get_element_info": "读取文档内容元素",
  "smartcanvas.get_page_info": "读取文档页面",
  "smartcanvas.get_top_level_pages": "查看文档页面列表",
  "smartcanvas.update_element": "修改文档内容",
  "smartcanvas.delete_element": "删除文档内容",
  "smartcanvas.append_insert_smartcanvas_by_markdown": "追加腾讯文档正文",
  "smartsheet.list_tables": "查看智能表格工作表",
  "smartsheet.add_fields": "新增智能表格字段",
  "smartsheet.add_records": "写入智能表格记录",
  "smartsheet.add_view": "新增智能表格视图",
  "smartsheet.list_records": "读取智能表格记录",
  "smartsheet.update_records": "更新智能表格记录",
  "smartsheet.update_fields": "更新智能表格字段"
};

  var dingtalkToolLabels = {"currentDateTime":"查看当前时间","searchUser":"搜索钉钉成员","getUserDetailByUserId":"读取钉钉成员信息","getUserIdByMobile":"查询成员编号","getUserIdByUnionId":"查询成员编号","getDepartmentUsersByDepId":"查看部门成员","queryTasks":"读取钉钉待办","deleteTask":"删除钉钉待办","createTask":"创建钉钉待办","updateTask":"修改钉钉待办","updateExecutorsTaskStatus":"修改待办完成状态","createEvent":"创建钉钉日程","updateEvent":"修改钉钉日程","deleteEvent":"删除钉钉日程","getEvent":"读取钉钉日程","addAttendee":"添加日程参与人","removeAttendee":"移除日程参与人","getAttendees":"查看日程参与人","getCalendarView":"读取钉钉日历"};
  function toolLabel(value, app) {
      var qqMailLabels = { list_mailboxes: '查看邮箱文件夹', search_messages: '搜索邮件', get_message: '读取邮件正文',
        create_draft: '创建邮件草稿', set_message_read: '设置邮件已读状态', move_message: '移动邮件', send_to_self: '向自己的邮箱发送测试邮件' };
      if (qqMailLabels[value]) return qqMailLabels[value];
      var giteeLabels = { compare_branches_tags: '比较代码版本', create_comment: '添加评论', create_issue: '创建议题', create_pull: '创建合并请求',
        create_release: '发布代码版本', create_repo: '新建仓库', fork_repository: '复制仓库', get_diff_files: '查看代码改动', get_file_content: '读取仓库文件',
        get_pull_detail: '读取合并请求', get_repo_issue_detail: '读取议题', get_user_info: '读取账户资料', list_comments: '查看评论',
        list_releases: '查看发布版本', list_repo_issues: '查看仓库议题', list_repo_pulls: '查看合并请求', list_user_notifications: '查看账户通知',
        list_user_repos: '查看自己的仓库', manage_pull_review: '管理代码评审', merge_pull: '合并代码', search_files_by_content: '搜索仓库正文',
        search_open_source_repositories: '搜索开源仓库', search_users: '搜索用户', update_issue: '修改议题', update_pull: '修改合并请求' };
      if (giteeLabels[value] && (app === 'gitee' || (!app && value !== 'get_user_info'))) return giteeLabels[value];
    var notionLabels = {
      'API-get-user': '读取 Notion 用户资料', 'API-get-users': '查看 Notion 用户列表', 'API-get-self': '查看 Notion 连接身份',
      'API-post-search': '搜索 Notion 页面', 'API-get-block-children': '读取 Notion 页面内容',
      'API-patch-block-children': '追加 Notion 内容', 'API-retrieve-a-block': '读取 Notion 内容块',
      'API-update-a-block': '修改 Notion 内容块', 'API-delete-a-block': '归档 Notion 内容块',
      'API-retrieve-a-page': '读取 Notion 页面信息', 'API-patch-page': '更新或归档 Notion 页面',
      'API-post-page': '创建 Notion 页面', 'API-retrieve-a-page-property': '读取 Notion 页面属性',
      'API-retrieve-a-comment': '读取 Notion 评论', 'API-create-a-comment': '添加 Notion 评论',
      'API-query-data-source': '查询 Notion 数据记录', 'API-retrieve-a-data-source': '读取 Notion 数据源',
      'API-update-a-data-source': '更新 Notion 数据源', 'API-create-a-data-source': '创建 Notion 数据源',
      'API-list-data-source-templates': '查看 Notion 数据源模板', 'API-retrieve-a-database': '读取 Notion 数据库',
      'API-move-page': '移动 Notion 页面', 'API-retrieve-page-markdown': '读取 Notion 正文',
      'API-update-page-markdown': '修改 Notion 正文'
    };
    if (notionLabels[value]) return notionLabels[value];
    if (value === 'getTask') return '读取钉钉待办详情';
    if (dingtalkToolLabels[value]) return dingtalkToolLabels[value];
    if (domesticToolLabels[value]) return domesticToolLabels[value];
    var feishu = /^docx_v1_(document|documentBlock|documentBlockChildren)_(\w+)$/u.exec(value || '');
    if (feishu) {
      var group = feishu[1] === 'document' ? '飞书文档' : '文档内容块';
      if (feishu[2] === 'rawContent') return '读取飞书文档正文';
      var docVerb = ({ create: '创建', get: '读取', list: '查看', batchUpdate: '批量更新', batchDelete: '批量删除' })[feishu[2]];
      if (docVerb) return docVerb + group;
    }
    var base = /^bitable_v1_(app|appTable|appTableField|appTableRecord)_(\w+)$/u.exec(value || '');
    if (base) {
      var target = ({ app: '多维表格', appTable: '数据表', appTableField: '表格字段', appTableRecord: '表格记录' })[base[1]];
      var verb = ({ create: '创建', get: '读取', list: '查看', search: '查询', update: '更新', batchCreate: '批量写入', batchUpdate: '批量更新' })[base[2]];
      if (verb) return verb + target;
    }
    return ({ search_gmail_messages: '搜索邮件', get_gmail_message_content: '读取邮件',
      search_drive_files: '搜索文件', list_drive_items: '查看文件列表', get_drive_file_content: '读取文件',
      create_drive_file: '创建文件', update_drive_file: '更新文件', copy_drive_file: '复制文件',
      search_docs: '搜索文档', get_doc_content: '读取文档', get_doc_as_markdown: '读取文档内容',
      create_doc: '创建文档', modify_doc_text: '修改文档', find_and_replace_doc: '替换文档内容',
      list_spreadsheets: '查看表格列表', get_spreadsheet_info: '查看表格信息', read_sheet_values: '读取单元格',
      create_spreadsheet: '创建表格', modify_sheet_values: '写入单元格', append_table_rows: '追加表格行',
      format_sheet_range: '设置单元格格式', manage_conditional_formatting: '设置条件格式',
      manage_sheet_tab: '调整工作表', resize_sheet_dimensions: '调整表格行列', move_sheet_rows: '移动表格行',
      manage_named_range: '管理命名单元格范围', list_spreadsheet_comments: '读取表格批注', manage_spreadsheet_comment: '管理表格批注',
      import_to_google_slides: '导入为演示文稿', get_drive_file_permissions: '查看文件共享状态',
      check_drive_file_public_access: '查看文件是否公开', get_drive_shareable_link: '读取文件链接',
      manage_drive_access: '调整文件共享', set_drive_file_permissions: '设置文件共享',
      issue_read: '读取议题', issue_write: '创建或更新议题', add_issue_comment: '添加议题评论',
      get_file_contents: '读取仓库文件', create_or_update_file: '创建或更新仓库文件',
      search_code: '搜索代码', search_repositories: '搜索仓库', pull_request_read: '读取拉取请求',
      get_gmail_messages_content_batch: '批量读取邮件', get_gmail_thread_content: '读取邮件会话',
      send_gmail_message: '发送邮件', draft_gmail_message: '创建邮件草稿',
      list_calendars: '查看日历列表', get_events: '查看日程', manage_event: '管理日程',
      search_messages: '搜索邮件', get_message: '读取邮件', create_event: '创建日程',
      list_events: '查看日程', query_freebusy: '查看空闲时间' })[value] || (value || '未知操作');
  }

  function confidenceLabel(value) {
    return ({ high: '高', medium: '中', low: '低' })[value] || (value || '未知');
  }

  function phaseLabel(value) {
    return ({ request: '发出请求', response: '收到结果', error: '调用失败',
      initialize: '建立连接', tools_list: '获取可用操作', notification: '通知',
      gateway_lifecycle: '连接状态' })[value] || (value || '—');
  }

  function fieldLabel(value) {
    var anchor = /#([a-z_]+)\[(\d+)\]$/.exec(String(value || ''));
    if (anchor && anchor[1] === 'paragraph') return '正文引用 ' + (Number(anchor[2]) + 1);
    if (anchor && anchor[1] === 'json') return '结果字段 ' + (Number(anchor[2]) + 1);
    var leaf = anchor ? anchor[1] : String(value || '').split('.').pop();
    return ({ summary: '日程标题', subject: '邮件主题', title: '标题', date: '日期', time: '时间',
      start_time: '开始时间', end_time: '结束时间', description: '说明', location: '地点',
      text: '文本内容', content: '正文', body: '正文', phone: '电话', email: '邮箱',
      user_google_email: 'Google 账户', document_id: '文档编号', name: '名称', uri: '来源地址',
      unionId: '钉钉用户编号', userid: '组织成员编号', taskId: '待办编号', calendarId: '日历编号',
      dueTime: '截止时间', isDone: '是否完成', executorIds: '执行人', participantIds: '参与人',
      dateTime: '时间', timeZone: '时区' })[leaf] || leaf;
  }

  function duration(value) {
    if (value === null || value === undefined) return '—';
    return value < 1000 ? Math.round(value) + ' 毫秒' : (value / 1000).toFixed(1) + ' 秒';
  }

  /** @param {string|null|undefined} id */
  function shortId(id) {
    if (!id) return '—';
    return String(id).length > 26 ? String(id).slice(0, 26) + '…' : String(id);
  }

  /** @param {*} value */
  function text(value) {
    if (value === null || value === undefined) return '—';
    if (typeof value === 'object') return JSON.stringify(value);
    return String(value);
  }

  /**
   * @param {*} value
   * @param {number} max
   * @returns {string}
   */
  function truncate(value, max) {
    var string = String(value);
    return string.length > max ? string.slice(0, max - 1) + '…' : string;
  }

  /**
   * 原生「按需展开」：默认折叠，不占首屏；用原生 `<details>` 而不是 JS 状态，
   * 因此不依赖脚本执行顺序也不引入隐藏状态。
   * @param {string} summaryText
   * @param {Array<Node|string>} children
   * @returns {HTMLElement}
   */
  function details(summaryText, children) {
    var box = el('details', { class: 'disclosure' }, [el('summary', { text: summaryText })]);
    (children || []).forEach(function (child) {
      box.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
    });
    return box;
  }

  window.TraceUI = {
    el: el,
    svgEl: svgEl,
    clear: clear,
    fetchJson: fetchJson,
    table: table,
    tag: tag,
    boundaryTag: boundaryTag,
    fmtTime: fmtTime,
    clientLabel: clientLabel,
    appLabel: appLabel,
    toolLabel: toolLabel,
    confidenceLabel: confidenceLabel,
    phaseLabel: phaseLabel,
    fieldLabel: fieldLabel,
    duration: duration,
    shortId: shortId,
    text: text,
    truncate: truncate,
    details: details,
    // 供页面在**字符串拼接**场景（el 的 text 选项管不到）统一兜底 null/undefined
    displayText: displayText,
  };
})();
