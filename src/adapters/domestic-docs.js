// Tencent tools include the vendor guide and the verified account catalogue.
export const TENCENT_DOCS_TOOLS = Object.freeze([
  // Additional names verified against this account's real tools/list on 2026-10-08.
  ['get_user_info', 'read', '查看腾讯文档账户'], ['query_space_list', 'read', '查看知识库空间'],
  ['create_smartcanvas_by_mdx', 'write', '创建腾讯智能文档'], ['create_space', 'write', '创建知识库空间'],
  ['smartcanvas.read', 'read', '读取腾讯智能文档'], ['smartcanvas.find', 'read', '查找智能文档正文'],
  ['smartcanvas.edit', 'write', '编辑腾讯智能文档'],
  ['doc.create_with_markdown', 'write', '创建腾讯文字文档'], ['doc.get_outline', 'read', '查看文档大纲'],
  ['doc.resolve_document_structure', 'read', '查看文档结构'], ['doc.find', 'read', '查找文档正文'],
  ['doc.get_comments', 'read', '查看文档批注'], ['doc.get_images', 'read', '查看文档图片'],
  ['doc.get_table_info', 'read', '读取文档表格'], ['doc.get_last_operable_pos', 'read', '查看正文末尾位置'],
  ['doc.insert_text', 'write', '插入文档文字'], ['doc.insert_markdown', 'write', '插入文档正文'],
  ['doc.replace_text', 'write', '替换文档文字'], ['doc.find_and_replace', 'write', '批量替换文档文字'],
  ['doc.insert_paragraph_with_text', 'write', '插入文档段落'], ['doc.insert_comment', 'write', '添加文档批注'],
  ['manage.recent_online_file', 'read', '查看最近文档'], ['manage.query_file_info', 'read', '读取文档信息'],
  ['manage.query_folder_meta', 'read', '读取文件夹信息'], ['manage.folder_list', 'read', '查看文件夹内容'],
  ['manage.search_file', 'read', '搜索腾讯文档'], ['manage.get_privilege', 'read', '查看文档共享状态'],
  ['manage.create_file', 'write', '创建腾讯文档文件'], ['manage.copy_file', 'write', '复制腾讯文档'],
  ['manage.rename_file_title', 'write', '重命名文档'], ['manage.delete_file', 'write', '移入回收站'],
  ['sheet.get_sheet_info', 'read', '查看腾讯表格工作表'], ['sheet.get_cell_data', 'read', '读取腾讯表格单元格'],
  ['sheet.set_cell_value', 'write', '写入腾讯表格单元格'], ['sheet.set_range_value', 'write', '批量写入腾讯表格'],
  ['sheet.add_sheet', 'write', '新增腾讯表格工作表'], ['sheet.rename_sheet', 'write', '重命名工作表'],
  ['sheet.delete_sheet', 'write', '删除工作表'], ['sheet.clear_range_cells', 'write', '清空单元格'],
  ['smartsheet.list_fields', 'read', '查看智能表格字段'], ['smartsheet.list_views', 'read', '查看智能表格视图'],
  ['smartsheet.delete_records', 'write', '删除智能表格记录'], ['smartsheet.add_table', 'write', '新增智能表格工作表'],
  ['smartsheet.delete_table', 'write', '删除智能表格工作表'], ['smartsheet.update_view', 'write', '修改智能表格视图'],
  ['smartsheet.delete_view', 'write', '删除智能表格视图'], ['smartsheet.delete_fields', 'write', '删除智能表格字段'],
  ['create_smartcanvas_by_markdown', 'write', '创建腾讯智能文档'], ['create_excel_by_markdown', 'write', '创建腾讯表格'],
  ['create_slide_by_markdown', 'write', '创建腾讯幻灯片'], ['create_mind_by_markdown', 'write', '创建思维导图'],
  ['create_flowchart_by_mermaid', 'write', '创建流程图'], ['create_word_by_markdown', 'write', '创建腾讯文字文档'],
  ['query_space_node', 'read', '查看腾讯文档目录'], ['create_space_node', 'write', '创建目录节点'],
  ['delete_space_node', 'write', '删除目录节点'], ['search_space_file', 'read', '搜索腾讯文档'],
  ['get_content', 'read', '读取腾讯文档正文'], ['batch_update_sheet_range', 'write', '批量写入腾讯表格'],
  ['smartcanvas.create_smartcanvas_element', 'write', '新增文档内容'], ['smartcanvas.get_element_info', 'read', '读取文档内容元素'],
  ['smartcanvas.get_page_info', 'read', '读取文档页面'], ['smartcanvas.get_top_level_pages', 'read', '查看文档页面列表'],
  ['smartcanvas.update_element', 'write', '修改文档内容'], ['smartcanvas.delete_element', 'write', '删除文档内容'],
  ['smartcanvas.append_insert_smartcanvas_by_markdown', 'write', '追加腾讯文档正文'],
  ['smartsheet.list_tables', 'read', '查看智能表格工作表'], ['smartsheet.add_fields', 'write', '新增智能表格字段'],
  ['smartsheet.add_records', 'write', '写入智能表格记录'], ['smartsheet.add_view', 'write', '新增智能表格视图'],
  ['smartsheet.list_records', 'read', '读取智能表格记录'], ['smartsheet.update_records', 'write', '更新智能表格记录'],
  ['smartsheet.update_fields', 'write', '更新智能表格字段'],
].map(([name, action, label]) => Object.freeze({ name, action, label })));

export function withDomesticDocs(manifest, enabled = ['tencent-docs']) {
  if (enabled.some(name => name !== 'tencent-docs')) throw new Error('Unsupported document application');
  const result = structuredClone(manifest);
  result.upstreams = result.upstreams.filter(item => item.serverName !== 'tencent-docs');
  if (enabled.includes('tencent-docs')) result.upstreams.push({
    serverName: 'tencent-docs', upstreamApp: 'tencent-docs', gatewayId: 'gw-tencent-docs', path: '/tencent-docs/mcp',
    transport: 'streamable-http', url: 'https://docs.qq.com/openapi/mcp',
    headers: { Authorization: '${TENCENT_DOCS_TOKEN}' },
    _说明: '腾讯文档官方远程 MCP；Authorization 按授权页的原值发送，不额外添加 Bearer。',
  });
  return result;
}
