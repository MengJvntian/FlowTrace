/**
 * src/lineage/tools.js — 工具「读 / 写」动作判定（L1）
 *
 * 计划书 §P2 的字段级血缘只关心「读应用的响应字段 → 写应用的请求字段」，
 * 因此必须先判定每个 MCP 工具是读（只读查询）还是写（产生副作用）。
 *
 * 判定顺序（**确定性优先**，见 相关实现）：
 *   1. 显式策略 `policy['<upstream_app>/<tool_name>']`（'read' / 'write' / 'ignore'）；
 *   2. 未知工具 → `unknown`：**不参与**数据流判定（只记录排除原因），绝不猜；
 *   3. 命名启发式仅用于**显式策略未覆盖**的已知 Mock 之外的工具，且只在
 *      `heuristic: true`（默认）时启用；启发式命中同样记录 `source: 'heuristic'`。
 */
import { TOOL_ACTION } from './constants.js';
import { FEISHU_TOOLS } from '../adapters/feishu.js';
import { TENCENT_DOCS_TOOLS } from '../adapters/domestic-docs.js';
import { DINGTALK_TOOLS } from '../adapters/dingtalk.js';
import { NOTION_TOOLS, GITEE_TOOLS } from '../adapters/final-batch.js';
import { QQ_MAIL_TOOLS } from '../adapters/qq_mail.js';

/** 冻结的 Mock 工具动作（与 src/mock_servers/* 的工具名逐一对应）。 */
export const DEFAULT_TOOL_POLICY = Object.freeze({
  ...Object.fromEntries(GITEE_TOOLS.map(tool => [`gitee/${tool.name}`, tool.action])),
  ...Object.fromEntries(QQ_MAIL_TOOLS.map(tool => [`qq-mail/${tool.name}`, tool.action])),
  ...Object.fromEntries(NOTION_TOOLS.map(tool => [`notion/${tool.name}`, tool.action])),
  ...Object.fromEntries(DINGTALK_TOOLS.map(tool => [`dingtalk/${tool.name}`, tool.action])),
  ...Object.fromEntries(TENCENT_DOCS_TOOLS.map(tool => [`tencent-docs/${tool.name}`, tool.action])),
  ...Object.fromEntries(FEISHU_TOOLS.map(tool => [`feishu/${tool.name}`, tool.action])),
  'mock-mail/read_latest_meeting_notice': TOOL_ACTION.READ,
  'mock-mail/search_notices': TOOL_ACTION.READ,
  'mock-calendar/create_event': TOOL_ACTION.WRITE,
  'mock-calendar/list_events': TOOL_ACTION.READ,
  'mock-calendar/clear_events': TOOL_ACTION.WRITE,

  // ── 真实 Google Workspace 上游（uvx workspace-mcp）────────────────────────────
  // 为什么必须显式列出（2026-10-07 实测的真缺陷）：
  //   命名启发式只认 `<动词>_` 前缀。而真实的**写**工具里 `manage_event` 的前缀是
  //   `manage`（不在写动词表里）、**读**工具里 `query_freebusy` 的前缀是 `query`（不在读动词表里），
  //   于是它们被判成 UNKNOWN → **不参与数据流判定**。
  //   后果：一次真实的「Gmail 读 → Calendar 写」虽然成功落库、归属也正确，
  //   但 `/flows` 里**一条跨应用边都没有**（sink 字段 = 0 个）。
  //   显式策略优先于启发式，因此这里逐个给出确定动作，不靠猜。
  'google-gmail/search_gmail_messages': TOOL_ACTION.READ,
  'google-gmail/get_gmail_message_content': TOOL_ACTION.READ,
  'google-gmail/get_gmail_messages_content_batch': TOOL_ACTION.READ,
  'google-gmail/get_gmail_thread_content': TOOL_ACTION.READ,
  'google-gmail/get_gmail_threads_content_batch': TOOL_ACTION.READ,
  'google-gmail/get_gmail_attachment_content': TOOL_ACTION.READ,
  'google-gmail/list_gmail_labels': TOOL_ACTION.READ,
  'google-gmail/list_gmail_filters': TOOL_ACTION.READ,
  'google-gmail/send_gmail_message': TOOL_ACTION.WRITE,
  'google-gmail/draft_gmail_message': TOOL_ACTION.WRITE,
  'google-gmail/modify_gmail_message_labels': TOOL_ACTION.WRITE,
  'google-gmail/batch_modify_gmail_message_labels': TOOL_ACTION.WRITE,
  'google-gmail/manage_gmail_label': TOOL_ACTION.WRITE,
  'google-gmail/manage_gmail_filter': TOOL_ACTION.WRITE,
  'google-calendar/list_calendars': TOOL_ACTION.READ,
  'google-calendar/get_events': TOOL_ACTION.READ,
  'google-calendar/query_freebusy': TOOL_ACTION.READ,
  'google-calendar/create_calendar': TOOL_ACTION.WRITE,
  'google-calendar/manage_event': TOOL_ACTION.WRITE,
  'google-calendar/manage_focus_time': TOOL_ACTION.WRITE,
  'google-calendar/manage_out_of_office': TOOL_ACTION.WRITE,
  // 授权引导工具：不读业务数据也不写业务数据 —— 明确忽略，避免它污染源/宿字段集合
  'google-gmail/start_google_auth': TOOL_ACTION.IGNORE,
  'google-calendar/start_google_auth': TOOL_ACTION.IGNORE,
  // More Google Workspace applications: explicit monitoring classification.
  'google-drive/search_drive_files': TOOL_ACTION.READ,
  'google-drive/list_drive_items': TOOL_ACTION.READ,
  'google-drive/get_drive_file_content': TOOL_ACTION.READ,
  'google-drive/get_drive_file_download_url': TOOL_ACTION.READ,
  'google-drive/create_drive_folder': TOOL_ACTION.WRITE,
  'google-drive/create_drive_file': TOOL_ACTION.WRITE,
  'google-drive/update_drive_file': TOOL_ACTION.WRITE,
  'google-drive/copy_drive_file': TOOL_ACTION.WRITE,
  'google-drive/import_to_google_doc': TOOL_ACTION.WRITE,
  'google-drive/import_to_google_sheets': TOOL_ACTION.WRITE,
  'google-drive/import_to_google_slides': TOOL_ACTION.WRITE,
  'google-drive/get_drive_file_permissions': TOOL_ACTION.READ,
  'google-drive/check_drive_file_public_access': TOOL_ACTION.READ,
  'google-drive/get_drive_shareable_link': TOOL_ACTION.READ,
  'google-drive/manage_drive_access': TOOL_ACTION.WRITE,
  'google-drive/set_drive_file_permissions': TOOL_ACTION.WRITE,
  'google-docs/search_docs': TOOL_ACTION.READ,
  'google-docs/get_doc_content': TOOL_ACTION.READ,
  'google-docs/get_doc_as_markdown': TOOL_ACTION.READ,
  'google-docs/list_docs_in_folder': TOOL_ACTION.READ,
  'google-docs/inspect_doc_structure': TOOL_ACTION.READ,
  'google-docs/create_doc': TOOL_ACTION.WRITE,
  'google-docs/modify_doc_text': TOOL_ACTION.WRITE,
  'google-docs/find_and_replace_doc': TOOL_ACTION.WRITE,
  'google-docs/insert_doc_elements': TOOL_ACTION.WRITE,
  'google-docs/batch_update_doc': TOOL_ACTION.WRITE,
  'google-sheets/list_spreadsheets': TOOL_ACTION.READ,
  'google-sheets/get_spreadsheet_info': TOOL_ACTION.READ,
  'google-sheets/read_sheet_values': TOOL_ACTION.READ,
  'google-sheets/list_sheet_tables': TOOL_ACTION.READ,
  'google-sheets/create_spreadsheet': TOOL_ACTION.WRITE,
  'google-sheets/create_sheet': TOOL_ACTION.WRITE,
  'google-sheets/modify_sheet_values': TOOL_ACTION.WRITE,
  'google-sheets/append_table_rows': TOOL_ACTION.WRITE,
  'google-sheets/format_sheet_range': TOOL_ACTION.WRITE,
  'google-sheets/manage_conditional_formatting': TOOL_ACTION.WRITE,
  'google-sheets/manage_sheet_tab': TOOL_ACTION.WRITE,
  'google-sheets/resize_sheet_dimensions': TOOL_ACTION.WRITE,
  'google-sheets/move_sheet_rows': TOOL_ACTION.WRITE,
  'google-sheets/list_spreadsheet_comments': TOOL_ACTION.READ,
  'google-drive/start_google_auth': TOOL_ACTION.IGNORE,
  'google-docs/start_google_auth': TOOL_ACTION.IGNORE,
  'google-sheets/start_google_auth': TOOL_ACTION.IGNORE,
  // Official GitHub MCP tools; no access-control decisions are made here.
  'github/get_me': TOOL_ACTION.READ,
  'github/get_file_contents': TOOL_ACTION.READ,
  'github/search_code': TOOL_ACTION.READ,
  'github/search_repositories': TOOL_ACTION.READ,
  'github/issue_read': TOOL_ACTION.READ,
  'github/list_issues': TOOL_ACTION.READ,
  'github/search_issues': TOOL_ACTION.READ,
  'github/pull_request_read': TOOL_ACTION.READ,
  'github/list_pull_requests': TOOL_ACTION.READ,
  'github/issue_write': TOOL_ACTION.WRITE,
  'github/add_issue_comment': TOOL_ACTION.WRITE,
  'github/create_or_update_file': TOOL_ACTION.WRITE,
  'github/push_files': TOOL_ACTION.WRITE,
  'github/create_pull_request': TOOL_ACTION.WRITE,
  'github/update_pull_request': TOOL_ACTION.WRITE,
});

/** 命名启发式（仅当显式策略没有该工具时启用）。 */
const READ_HEURISTIC = /^(read|get|list|search|query|fetch|find|load|lookup|describe|check)_/u;
const WRITE_HEURISTIC =
  /^(create|add|insert|write|update|set|save|put|send|post|delete|remove|clear|schedule|upsert|apply|append|record)_/u;

/**
 * @param {{upstream_app?: string | null, tool_name?: string | null}} event
 * @returns {string} `<app>/<tool>`（缺一不可，缺失时返回 ''）
 */
export function toolKey(event) {
  const app = typeof event?.upstream_app === 'string' ? event.upstream_app.trim() : '';
  const tool = typeof event?.tool_name === 'string' ? event.tool_name.trim() : '';
  if (app === '' || tool === '') return '';
  return `${app}/${tool}`;
}

/**
 * @param {{upstream_app?: string | null, tool_name?: string | null}} event
 * @param {{policy?: Record<string, string>, heuristic?: boolean}} [options]
 * @returns {{action: string, key: string, source: 'policy'|'heuristic'|'missing'|'unknown', reason: string}}
 */
export function classifyTool(event, options = {}) {
  const policy = options.policy ?? DEFAULT_TOOL_POLICY;
  const heuristic = options.heuristic !== false;
  const key = toolKey(event);
  if (key === '') {
    return { action: TOOL_ACTION.UNKNOWN, key, source: 'missing', reason: 'missing_upstream_app_or_tool_name' };
  }
  const declared = policy[key];
  if (typeof declared === 'string' && declared !== '') {
    const action = declared.toLowerCase();
    if (action === TOOL_ACTION.READ || action === TOOL_ACTION.WRITE || action === TOOL_ACTION.IGNORE) {
      return { action, key, source: 'policy', reason: `policy(${key})=${action}` };
    }
    // 显式策略值非法 → 不静默：当作 unknown 并说明
    return { action: TOOL_ACTION.UNKNOWN, key, source: 'unknown', reason: `invalid_policy_value:${declared}` };
  }
  const tool = String(event?.tool_name ?? '');
  if (heuristic) {
    if (READ_HEURISTIC.test(tool)) return { action: TOOL_ACTION.READ, key, source: 'heuristic', reason: 'name_prefix_is_read' };
    if (WRITE_HEURISTIC.test(tool)) return { action: TOOL_ACTION.WRITE, key, source: 'heuristic', reason: 'name_prefix_is_write' };
  }
  return { action: TOOL_ACTION.UNKNOWN, key, source: 'unknown', reason: `unknown_tool:${key}` };
}

/**
 * 合并策略（调用方覆盖优先）。
 * @param {Record<string, string>} [overrides]
 * @returns {Record<string, string>}
 */
export function mergeToolPolicy(overrides) {
  return { ...DEFAULT_TOOL_POLICY, ...(overrides ?? {}) };
}
