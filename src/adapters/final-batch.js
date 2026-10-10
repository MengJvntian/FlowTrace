// Names verified against the pinned official Notion 2.5.2 OpenAPI operations.
// HTTP POST is not sufficient to classify search/query as a write.
export const NOTION_TOOLS = Object.freeze([
  ...['get-user', 'get-users', 'get-self', 'post-search', 'get-block-children',
    'retrieve-a-block', 'retrieve-a-page', 'retrieve-a-page-property', 'retrieve-a-comment',
    'query-data-source', 'retrieve-a-data-source', 'list-data-source-templates',
    'retrieve-a-database', 'retrieve-page-markdown'].map(name => ({ name: 'API-' + name, action: 'read' })),
  ...['patch-block-children', 'update-a-block', 'delete-a-block', 'patch-page', 'post-page',
    'create-a-comment', 'update-a-data-source', 'create-a-data-source', 'move-page',
    'update-page-markdown'].map(name => ({ name: 'API-' + name, action: 'write' })),
]);
export const FINAL_BATCH_IDS = Object.freeze(['notion', 'gitee', 'qq-mail']);
// Verified against the 25 tools discovered from Gitee's official remote MCP.
// Its annotations mark get_user_info as a write, so classify by actual semantics.
export const GITEE_TOOLS = Object.freeze([
  ...['compare_branches_tags', 'get_diff_files', 'get_file_content', 'get_pull_detail', 'get_repo_issue_detail', 'get_user_info',
    'list_comments', 'list_releases', 'list_repo_issues', 'list_repo_pulls', 'list_user_notifications', 'list_user_repos',
    'search_files_by_content', 'search_open_source_repositories', 'search_users'].map(name => ({ name, action: 'read' })),
  ...['create_comment', 'create_issue', 'create_pull', 'create_release', 'create_repo', 'fork_repository', 'manage_pull_review',
    'merge_pull', 'update_issue', 'update_pull'].map(name => ({ name, action: 'write' })),
]);
export function withFinalBatch(manifest, apps, selected = [], env = process.env) {
  if (!Array.isArray(selected) || selected.some(id => !FINAL_BATCH_IDS.includes(id))) throw new Error('Invalid final batch selection');
  const result = structuredClone(manifest);
  const names = new Set(FINAL_BATCH_IDS);
  result.upstreams = result.upstreams.filter(item => !names.has(item.serverName));
  for (const id of new Set(selected)) {
    const app = apps.find(item => item.id === id);
    // Moving a module away disables it. Planned modules cannot enter a manifest.
    if (!app?.upstream || app.status === 'planned' || app.status.startsWith('excluded-')) continue;
    const required = id === 'notion' ? 'NOTION_TOKEN' : id === 'gitee' ? 'GITEE_MCP_TOKEN' : 'QQ_MAIL_AUTH_CODE';
    if (!env[required]?.trim() || /[\r\n]/u.test(env[required])) throw new Error('Selected application credential missing: ' + id);
    if (id === 'qq-mail' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(env.QQ_MAIL_EMAIL ?? '')) throw new Error('Selected application credential missing: qq-mail email');
    result.upstreams.push(structuredClone(app.upstream));
  }
  return result;
}
