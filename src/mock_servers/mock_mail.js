#!/usr/bin/env node
/**
 * src/mock_servers/mock_mail.js — Mock Mail MCP Server（stdio，M1）
 *
 * 上游应用：`mock-mail`（Gateway 侧 `upstream_app=mock-mail`）。
 * 传输：stdio，stdout 只输出 MCP 协议帧，诊断一律 stderr。
 *
 * 工具（名称已冻结，供 Gateway / 演示脚本 / 文档引用）：
 *   - `read_latest_meeting_notice`（只读）：返回固定测试记录
 *       title=课程设计讨论、date=2026-10-08、time=14:00、phone=13812345678，
 *       同时给出**文本内容**与 **structuredContent** 两种表示；
 *       参数 `inconsistent: true`（或环境变量 `TRACE_MAIL_INCONSISTENT=1`）切换到
 *       「结构化内容与文本不一致」模式，用于测试不一致检测路径。
 *   - `search_notices`（只读）：在虚构通知目录中检索。
 *
 * 直接运行（独立 stdio MCP Server 进程）：
 *   node src/mock_servers/mock_mail.js
 */
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { MOCK_SERVER_VERSION, buildToolServer, defineTool, logDiag, serveOverStdio, textResult, validationErrorResult } from './common.js';
import { MEETING_NOTICE, noticeToStructured, renderNoticeText, resolveInconsistent, searchNotices } from './notices.js';

export const MAIL_SERVER_NAME = 'mock-mail';

/** 冻结的工具名（Gateway / G1 演示 / C1 文档按此引用）。 */
export const MAIL_TOOL_NAMES = Object.freeze(['read_latest_meeting_notice', 'search_notices']);

/** `tools/list` 返回的工具定义。 */
export const MAIL_TOOLS = Object.freeze([
  defineTool({
    name: 'read_latest_meeting_notice',
    readOnly: true,
    description:
      '读取最新一条会议/课程通知（只读）。返回文本内容与 structuredContent 两种表示。' +
      '参数 inconsistent=true 时故意让 structuredContent.phone 与文本中的电话不一致（测试用开关），' +
      '并在 structuredContent.mock_inconsistent 标记该模式。',
    properties: {
      inconsistent: {
        type: 'boolean',
        description: '测试开关：true 时 structuredContent 与文本内容不一致（默认 false，也可用 TRACE_MAIL_INCONSISTENT=1）',
      },
    },
  }),
  defineTool({
    name: 'search_notices',
    readOnly: true,
    description: '在虚构通知目录中按关键字检索（只读）。query 为空表示返回全部（受 limit 限制）。',
    properties: {
      query: { type: 'string', description: '关键字（匹配标题/正文/编号/发送方，大小写不敏感）' },
      limit: { type: 'integer', description: '最多返回条数，1–50，默认 10' },
    },
  }),
]);

const MAIL_SCOPE = MAIL_SERVER_NAME;

/**
 * 构造 Mock Mail 低层 Server（不连接传输，便于测试与嵌入式使用）。
 * @returns {import('@modelcontextprotocol/server').Server}
 */
export function buildMockMailServer() {
  return buildToolServer({
    name: MAIL_SERVER_NAME,
    tools: MAIL_TOOLS,
    call: async (request) => {
      const args = request?.params?.arguments && typeof request.params.arguments === 'object'
        ? request.params.arguments
        : {};
      const toolName = String(request?.params?.name);

      if (toolName === 'read_latest_meeting_notice') {
        /** @type {{inconsistent: boolean, source: string}} */
        let mode;
        try {
          mode = resolveInconsistent(args.inconsistent);
        } catch (error) {
          return validationErrorResult({
            toolName,
            problems: [{
              field: 'inconsistent',
              code: 'bad_type',
              message: error instanceof Error ? error.message : String(error),
              received: args.inconsistent,
              expected: 'boolean',
            }],
            received: { inconsistent: args.inconsistent },
          });
        }
        const structured = noticeToStructured(MEETING_NOTICE, { inconsistent: mode.inconsistent });
        return textResult(renderNoticeText(MEETING_NOTICE), structured);
      }

      // search_notices
      const problems = [];
      if (args.query !== undefined && args.query !== null && typeof args.query !== 'string') {
        problems.push({
          field: 'query',
          code: 'not_a_string',
          message: `参数 query 必须是字符串，收到 ${typeof args.query}`,
          received: args.query,
          expected: '字符串（可省略）',
        });
      }
      if (args.limit !== undefined && args.limit !== null) {
        const limit = args.limit;
        if (!Number.isInteger(limit) || limit < 1 || limit > 50) {
          problems.push({
            field: 'limit',
            code: 'out_of_range',
            message: `参数 limit 必须是 1–50 的整数，收到 ${JSON.stringify(limit)}`,
            received: limit,
            expected: '1–50 的整数',
          });
        }
      }
      if (problems.length > 0) {
        return validationErrorResult({ toolName, problems, received: { query: args.query, limit: args.limit } });
      }

      const query = typeof args.query === 'string' ? args.query : '';
      const limit = Number.isInteger(args.limit) ? args.limit : 10;
      const matches = searchNotices(query, { limit });
      const lines = matches.map(
        (notice, index) =>
          `${index + 1}. ${notice.date} ${notice.time} ${notice.title}` +
          `（${notice.notice_id}，联系电话 ${notice.phone}）`,
      );
      const text = matches.length === 0
        ? `未找到匹配的通知（query=${JSON.stringify(query)}）`
        : `命中 ${matches.length} 条通知（query=${JSON.stringify(query)}，limit=${limit}）：\n${lines.join('\n')}`;
      return textResult(text, {
        query,
        limit,
        count: matches.length,
        notices: matches.map((notice) => noticeToStructured(notice)),
      });
    },
  });
}

/**
 * 以 stdio 启动 Mock Mail（entry）。
 * @returns {Promise<void>}
 */
export async function main() {
  logDiag(MAIL_SCOPE, `启动 Mock Mail MCP Server v${MOCK_SERVER_VERSION}（工具：${MAIL_TOOL_NAMES.join(', ')}）`);
  await serveOverStdio(buildMockMailServer, { serverName: MAIL_SCOPE });
}

/** 直接运行本文件时启动 stdio server；被 import 时不启动。 */
const isEntry = process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isEntry) {
  await main();
}
