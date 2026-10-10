/**
 * src/mock_servers/common.js — Mock MCP Server 共用底座（M1）
 *
 * 纪律（CONVENTIONS §4.3 / §6.8）：
 *   1. **stdout 只允许 MCP 协议帧**：本模块任何诊断都走 `process.stderr`，绝不 `console.log`；
 *   2. 参数校验失败必须是**可辨识**的工具错误（`isError: true` + 稳定前缀 + `error_kind`），
 *      不是含糊的「调用失败」；
 *   3. 未知工具走协议错误（JSON-RPC -32602），未知方法由 SDK 自动回 -32601 —— 两类错误真实可触发；
 *   4. 未捕获异常/未处理拒绝必须写 stderr 并以非 0 退出码结束，不得静默退出。
 */
import process from 'node:process';

import { INVALID_PARAMS, ProtocolError, Server } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';

import { STATUS } from '../shared/schemaversion.js';
import { nowUtcIso } from '../shared/time.js';

export const MOCK_SERVER_VERSION = '0.1.0';

/** 参数校验失败结果的稳定前缀（测试与下游按前缀识别，不靠模糊匹配）。 */
export const VALIDATION_ERROR_PREFIX = 'MOCK_VALIDATION_ERROR';

/**
 * 诊断日志 → stderr（唯一允许的日志出口）。
 * @param {string} scope 例如 'mock-mail'
 * @param {string} message
 */
export function logDiag(scope, message) {
  process.stderr.write(`[${scope}] ${nowUtcIso()} pid=${process.pid} ${message}\n`);
}

/**
 * 文本结果（可选带 structuredContent）。
 * @param {string} text
 * @param {Record<string, unknown>} [structuredContent]
 * @returns {{content: Array<{type: 'text', text: string}>, structuredContent?: Record<string, unknown>}}
 */
export function textResult(text, structuredContent) {
  /** @type {{content: Array<{type: 'text', text: string}>, structuredContent?: Record<string, unknown>}} */
  const result = { content: [{ type: 'text', text }] };
  if (structuredContent !== undefined) result.structuredContent = structuredContent;
  return result;
}

/**
 * 工具错误结果（`isError: true`）。
 * @param {string} text 以 `VALIDATION_ERROR_PREFIX` 开头时可被下游稳定识别
 * @param {Record<string, unknown>} [structuredContent]
 * @returns {{content: Array<{type: 'text', text: string}>, isError: true, structuredContent?: Record<string, unknown>}}
 */
export function errorResult(text, structuredContent) {
  /** @type {{content: Array<{type: 'text', text: string}>, isError: true, structuredContent?: Record<string, unknown>}} */
  const result = { content: [{ type: 'text', text }], isError: true };
  if (structuredContent !== undefined) result.structuredContent = structuredContent;
  return result;
}

/**
 * 参数校验失败结果：文本以稳定前缀开头，`structuredContent.error_kind` 使用规范 status 枚举。
 * @param {{toolName: string, problems: Array<Record<string, unknown>>, received: Record<string, unknown>}} input
 * @returns {ReturnType<typeof errorResult>}
 */
export function validationErrorResult(input) {
  const detail = input.problems.map((problem) => problem.message).join('；');
  const text = `${VALIDATION_ERROR_PREFIX} ${input.toolName}: ${detail}`;
  return errorResult(text, {
    error_kind: STATUS.VALIDATION_ERROR,
    tool_name: input.toolName,
    problems: input.problems,
    received: input.received,
  });
}

/**
 * 未知工具 → 协议错误（JSON-RPC -32602 Invalid Params）。
 * MCP 规范要求工具名不存在时返回错误，而不是伪装成成功的工具结果。
 * @param {string} toolName
 * @returns {never}
 */
export function throwUnknownTool(toolName) {
  throw new ProtocolError(INVALID_PARAMS, `未知工具: ${JSON.stringify(toolName)}`, {
    tool: toolName,
    hint: 'tools/list 返回的工具名之外的调用一律作为协议错误（-32602）处理',
  });
}

/**
 * 构造低层 `Server` 并注册 `tools/list` + `tools/call`（两个 Mock Server 共用的注册方式）。
 * @param {{name: string, tools: Array<Record<string, unknown>>, call: (request: any) => Promise<any>}} options
 * @returns {Server}
 */
export function buildToolServer(options) {
  const server = new Server(
    { name: options.name, version: MOCK_SERVER_VERSION },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler('tools/list', async () => ({ tools: options.tools }));
  server.setRequestHandler('tools/call', async (request) => {
    const params = request?.params ?? {};
    const name = params.name;
    const known = options.tools.some((tool) => tool.name === name);
    if (!known) throwUnknownTool(String(name));
    return options.call(request);
  });
  return server;
}

/**
 * 以 stdio 传输启动一个 Mock Server（entry 用）。
 *
 * 生命周期约定：客户端关闭 stdin（EOF）后 `StdioServerTransport` 自行关闭，
 * 本进程不再持有任何句柄，于是**自然退出且退出码为 0**（协议文档要求的行为）。
 * 只有真正的错误路径才会把退出码置为 1。
 * @param {() => Server} factory
 * @param {{serverName: string}} options
 * @returns {Promise<{server: Server, transport: StdioServerTransport}>}
 */
export async function serveOverStdio(factory, options) {
  const { serverName } = options;

  process.on('uncaughtException', (error) => {
    logDiag(serverName, `uncaughtException: ${error instanceof Error ? error.stack : String(error)}`);
    process.exitCode = 1;
  });
  process.on('unhandledRejection', (reason) => {
    logDiag(serverName, `unhandledRejection: ${reason instanceof Error ? reason.stack : String(reason)}`);
    process.exitCode = 1;
  });

  const server = factory();
  const transport = new StdioServerTransport();
  transport.onerror = (error) => logDiag(serverName, `transport error: ${error.message}`);
  await server.connect(transport);
  logDiag(
    serverName,
    `stdio 传输已连接：${serverName} v${MOCK_SERVER_VERSION}，stdout 仅用于 MCP 协议帧，诊断一律 stderr`,
  );
  return { server, transport };
}

/**
 * 生成一个工具定义。
 * @param {{name: string, description: string, properties: Record<string, unknown>, required?: string[], readOnly?: boolean}} input
 * @returns {Record<string, unknown>}
 */
export function defineTool(input) {
  /** @type {Record<string, unknown>} */
  const schema = {
    type: 'object',
    properties: input.properties,
    additionalProperties: true,
  };
  if (input.required && input.required.length > 0) schema.required = input.required;
  return {
    name: input.name,
    description: input.description,
    inputSchema: schema,
    annotations: {
      readOnlyHint: input.readOnly === true,
      destructiveHint: input.name === 'clear_events',
    },
  };
}
