export const DINGTALK_MCP_VERSION = '1.1.21';
export const DINGTALK_PROFILES = 'dingtalk-contacts,dingtalk-tasks,dingtalk-calendar';
export const DINGTALK_TOOLS = Object.freeze([
  ['currentDateTime', 'ignore', '查看当前时间'], ['searchUser', 'read', '搜索钉钉成员'],
  ['getUserDetailByUserId', 'read', '读取钉钉成员信息'], ['getUserIdByMobile', 'read', '查询成员编号'],
  ['getUserIdByUnionId', 'read', '查询成员编号'], ['getDepartmentUsersByDepId', 'read', '查看部门成员'],
  ['queryTasks', 'read', '读取钉钉待办'], ['getTask', 'read', '读取钉钉待办详情'], ['deleteTask', 'write', '删除钉钉待办'],
  ['createTask', 'write', '创建钉钉待办'], ['updateTask', 'write', '修改钉钉待办'],
  ['updateExecutorsTaskStatus', 'write', '修改待办完成状态'],
  ['createEvent', 'write', '创建钉钉日程'], ['updateEvent', 'write', '修改钉钉日程'],
  ['deleteEvent', 'write', '删除钉钉日程'], ['getEvent', 'read', '读取钉钉日程'],
  ['addAttendee', 'write', '添加日程参与人'], ['removeAttendee', 'write', '移除日程参与人'],
  ['getAttendees', 'read', '查看日程参与人'], ['getCalendarView', 'read', '读取钉钉日历'],
].map(([name, action, label]) => Object.freeze({ name, action, label })));
export const DINGTALK_UPSTREAM = Object.freeze({ serverName: 'dingtalk', upstreamApp: 'dingtalk', gatewayId: 'gw-dingtalk',
  path: '/dingtalk/mcp', command: 'node', args: ['tools/node.js', 'applications/dingtalk/server.js'],
  env: { DINGTALK_Client_ID: '${DINGTALK_CLIENT_ID}', DINGTALK_Client_Secret: '${DINGTALK_CLIENT_SECRET}' } });
export function dingtalkBusinessError(result, app) {
  if (app !== 'dingtalk') return null;
  for (const block of Array.isArray(result?.content) ? result.content : []) {
    if (block.type !== 'text') continue;
    try {
      const value = JSON.parse(block.text);
      if (Number.isInteger(value?.errcode) && value.errcode !== 0) return { code: value.errcode, message: value.errmsg ?? '' };
    } catch { /* Official HTTP errors already return isError. */ }
  }
  return null;
}
