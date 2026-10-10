#!/usr/bin/env node
/**
 * src/mock_servers/mock_calendar.js — Mock Calendar MCP Server（stdio，M1）
 *
 * 上游应用：`mock-calendar`（Gateway 侧 `upstream_app=mock-calendar`）。
 * 传输：stdio，stdout 只输出 MCP 协议帧，诊断一律 stderr。
 *
 * 工具（名称已冻结，供 Gateway / 演示脚本 / 文档引用）：
 *   - `create_event`（写）：接收 title/date/time。**参数缺失或格式非法时返回
 *       `isError: true`**（文本以 `MOCK_VALIDATION_ERROR` 开头，`structuredContent.error_kind`
 *       为规范枚举值 `validation_error`），而不是含糊的失败或静默成功；
 *   - `list_events`（查）：返回已写入内容；
 *   - `clear_events`（清空）：清空测试存储。
 *
 * 存储：`demo-data/calendar-events.json`（仓库内），可用 `--store <path>` 或
 * `TRACE_CALENDAR_STORE` 覆盖；**仓库外路径一律拒绝**（禁止写用户主目录）。
 *
 * 直接运行（独立 stdio MCP Server 进程）：
 *   node src/mock_servers/mock_calendar.js
 *   node src/mock_servers/mock_calendar.js --store demo-data/tmp/calendar.json
 */
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { CalendarStore, validateEventInput } from './calendar_store.js';
import { MOCK_SERVER_VERSION, buildToolServer, defineTool, logDiag, serveOverStdio, textResult, validationErrorResult } from './common.js';

export const CALENDAR_SERVER_NAME = 'mock-calendar';

/** 冻结的工具名（Gateway / G1 演示 / C1 文档按此引用）。 */
export const CALENDAR_TOOL_NAMES = Object.freeze(['create_event', 'list_events', 'clear_events']);

/** `tools/list` 返回的工具定义。 */
export const CALENDAR_TOOLS = Object.freeze([
  defineTool({
    name: 'create_event',
    description:
      '创建一个日程（写入 demo-data/ 下的测试存储）。title/date/time 三个参数在 schema 中保持可选，' +
      '由服务端逐个校验：缺失或格式非法时返回 isError=true 且文本以 MOCK_VALIDATION_ERROR 开头。' +
      'date 必须是 YYYY-MM-DD 且为真实存在的日期；time 必须是 HH:MM（00:00–23:59）。',
    properties: {
      title: { type: 'string', description: '日程标题（非空，≤200 字符）' },
      date: { type: 'string', description: '日期，YYYY-MM-DD（例：2026-10-09）' },
      time: { type: 'string', description: '时间，HH:MM 24 小时制（例：10:30）' },
    },
  }),
  defineTool({
    name: 'list_events',
    readOnly: true,
    description: '列出当前测试存储中的全部日程（只读）。',
    properties: {},
  }),
  defineTool({
    name: 'clear_events',
    description: '清空测试存储中的全部日程（文件保留，events 置为空数组）。',
    properties: {},
  }),
]);

const CALENDAR_SCOPE = CALENDAR_SERVER_NAME;

/**
 * 解析 `--store <path>`（供 entry 使用；不改变默认值语义）。
 * @param {string[]} argv
 * @returns {string | undefined}
 */
export function parseStoreArg(argv) {
  const index = argv.indexOf('--store');
  if (index === -1) return undefined;
  const value = argv[index + 1];
  if (value === undefined || value.startsWith('--')) {
    throw new Error('--store 后面的参数缺失：用法 `--store <仓库内相对或绝对路径>`');
  }
  return value;
}

/**
 * 构造 Mock Calendar 低层 Server（不连接传输，便于测试与嵌入式使用）。
 * @param {{store?: CalendarStore}} [options]
 * @returns {import('@modelcontextprotocol/server').Server}
 */
export function buildMockCalendarServer(options = {}) {
  const store = options.store ?? new CalendarStore();
  const storeFile = store.relativePath;

  return buildToolServer({
    name: CALENDAR_SERVER_NAME,
    tools: CALENDAR_TOOLS,
    call: async (request) => {
      const toolName = String(request?.params?.name);
      const args = request?.params?.arguments && typeof request.params.arguments === 'object'
        ? request.params.arguments
        : {};

      if (toolName === 'create_event') {
        const validated = validateEventInput(
          /** @type {{title?: unknown, date?: unknown, time?: unknown}} */ (args),
        );
        if (!validated.ok) {
          return validationErrorResult({
            toolName,
            problems: validated.problems,
            received: { title: args.title, date: args.date, time: args.time },
          });
        }
        const event = store.create(validated.value);
        logDiag(CALENDAR_SCOPE, `create_event 写入 ${storeFile}：event_id=${event.event_id}`);
        return textResult(
          `已创建日程：${event.date} ${event.time} 《${event.title}》` +
            `（event_id=${event.event_id}，store=${storeFile}）`,
          { ...event, store_file: storeFile },
        );
      }

      if (toolName === 'list_events') {
        const events = store.list();
        const lines = events.map(
          (event, index) =>
            `${index + 1}. ${event.date} ${event.time} ${event.title}（event_id=${event.event_id}）`,
        );
        const text = events.length === 0
          ? `日历为空（store=${storeFile}，0 条）`
          : `共 ${events.length} 条日程（store=${storeFile}）：\n${lines.join('\n')}`;
        return textResult(text, { count: events.length, events, store_file: storeFile });
      }

      // clear_events
      const cleared = store.clear();
      logDiag(CALENDAR_SCOPE, `clear_events 清空 ${storeFile}：清除 ${cleared} 条`);
      return textResult(`已清空日历（store=${storeFile}，清除 ${cleared} 条，当前 0 条）`, {
        cleared,
        count: 0,
        events: [],
        store_file: storeFile,
      });
    },
  });
}

/**
 * 以 stdio 启动 Mock Calendar（entry）。
 * @param {{store?: CalendarStore}} [options]
 * @returns {Promise<void>}
 */
export async function main(options = {}) {
  const store = options.store ?? new CalendarStore(parseStoreArg(process.argv.slice(2)));
  logDiag(
    CALENDAR_SCOPE,
    `启动 Mock Calendar MCP Server v${MOCK_SERVER_VERSION}（工具：${CALENDAR_TOOL_NAMES.join(', ')}；store=${store.relativePath}）`,
  );
  await serveOverStdio(() => buildMockCalendarServer({ store }), { serverName: CALENDAR_SCOPE });
}

/** 直接运行本文件时启动 stdio server；被 import 时不启动。 */
const isEntry = process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isEntry) {
  await main();
}
