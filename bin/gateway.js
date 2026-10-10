#!/usr/bin/env node
/**
 * bin/gateway.js — stdio MCP Gateway 启动器（S1）
 *
 * 对客户端表现为 MCP Server（stdio），对上游表现为 MCP Client（stdio 子进程）。
 * 全部配置来自命令行参数或环境变量（见 src/gateway/config.js 的 --help）。
 *
 * 纪律：
 *   - **stdout 只允许 MCP 协议帧**（由 StdioServerTransport 独占写），
 *     所有日志/统计/诊断一律 stderr；
 *   - 上游启动失败或中途退出时本进程**不退出**：客户端会收到可辨识的
 *      transport_error，而不是挂死（退出码 0 表示网关按协议正常收尾）；
 *   - 退出码：0 正常（含上游不可用）、2 配置错误、1 未捕获异常。
 */
import process from 'node:process';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';

import { openStore } from '../src/collector/store.js';
import { formatConfig, parseGatewayConfig, usage } from '../src/gateway/config.js';
import { createGateway } from '../src/gateway/gateway.js';

/** @param {string} message */
function log(message) {
  process.stderr.write(`${message}\n`);
}

async function main() {
  const parsed = parseGatewayConfig();
  if (parsed.help) {
    log(usage());
    process.exit(0);
  }
  if (!parsed.ok) {
    for (const error of parsed.errors) log(`[gateway] 配置错误：${error}`);
    log(usage());
    process.exit(2);
  }
  const config = parsed.config;
  for (const warning of parsed.warnings ?? []) log(`[gateway] 警告：${warning}`);
  log(`[gateway] 启动 ${formatConfig(config)}`);

  let store;
  try {
    store = openStore(config.dbPath, { maxPayloadBytes: config.maxPayloadBytes });
  } catch (error) {
    log(`[gateway] 打开事件库失败：${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }

  let finished = false;
  /** @param {number} code */
  const finish = (code) => {
    if (finished) return;
    finished = true;
    try {
      // 注意：这里的 upstream_stderr_* 指的是**上游子进程**的 stderr（采集文件），
      // 与网关自身的 stderr 是两个来源，分开命名以免混淆统计。
      const stats = gateway?.stats ?? {};
      log(
        `[gateway] 退出 code=${code} db=${config.dbPath}` +
          ` gateway_stderr=本进程` +
          ` upstream_stderr_enabled=${stats.upstream_stderr_enabled ?? false}` +
          ` upstream_stderr_created=${stats.upstream_stderr_created ?? false}` +
          ` upstream_stderr_path=${stats.upstream_stderr_path ?? '(none)'}` +
          ` upstream_stderr_bytes=${stats.upstream_stderr_bytes ?? 0}` +
          ` upstream_stderr_lines=${stats.upstream_stderr_lines ?? 0}` +
          '（created=false 表示上游全程静默、该文件未创建）',
      );
    } catch {
      /* stderr 已关闭 */
    }
    try {
      store.close();
    } catch {
      /* 忽略 */
    }
    process.exit(code);
  };

  const gateway = await createGateway({
    config,
    store,
    serverTransport: new StdioServerTransport(),
    logger: log,
    onClientClosed: () => {
      log(`[gateway] 客户端连接已关闭，收尾完成 stats=${JSON.stringify(gateway?.stats ?? {})}`);
      finish(0);
    },
  });

  for (const signal of /** @type {const} */ (['SIGINT', 'SIGTERM'])) {
    process.on(signal, () => {
      log(`[gateway] 收到 ${signal}，开始收尾`);
      gateway
        .stop({ reason: `signal:${signal}`, signalCode: signal, exitCode: 0, status: 'ok' })
        .catch((error) => log(`[gateway] 收尾出错：${error instanceof Error ? error.message : String(error)}`))
        .finally(() => finish(0));
    });
  }

  process.on('uncaughtException', (error) => {
    log(`[gateway] 未捕获异常：${error?.stack ?? error}`);
    finish(1);
  });
  process.on('unhandledRejection', (reason) => {
    log(`[gateway] 未处理的 Promise 拒绝：${reason instanceof Error ? reason.stack : String(reason)}`);
    finish(1);
  });

  await gateway.start();
  log(
    `[gateway] 就绪 gateway_id=${config.gatewayId} upstream_ready=${gateway.state.upstream_ready} ` +
      `upstream_pid=${gateway.state.upstream_pid ?? 'n/a'}（stdout 仅供 MCP 协议使用）`,
  );
}

main().catch((error) => {
  process.stderr.write(`[gateway] 启动失败：${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exit(1);
});
