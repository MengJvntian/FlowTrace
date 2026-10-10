#!/usr/bin/env node
/**
 * bin/reset.js — 一键重置（S2）
 *
 * 默认清空 Mock Calendar 测试数据（`demo-data/calendar-events.json`）；
 * `--events`/`--all` 追加清空事件库内容；`--delete-db-file`（需 `--yes`）删除事件库文件；
 * `--dry-run` 只预览。用法见 `node bin/reset.js --help`。
 *
 * 日历数据通过 M1 的 `CalendarStore` 清理（同一实现、同一路径安全边界：只允许仓库内路径），
 * 不重复实现存储格式、也不直接改 JSON。
 */
import process from 'node:process';

import { CliError } from '../src/cli/args.js';
import { runResetCli } from '../src/cli/commands.js';
import { err } from '../src/cli/format.js';

try {
  const code = runResetCli(process.argv.slice(2));
  process.exitCode = typeof code === 'number' ? code : 0;
} catch (error) {
  if (error instanceof CliError) {
    err(`[reset] ${error.message}`);
    process.exitCode = error.exitCode;
  } else {
    err(`[reset] 未预期错误：${error instanceof Error ? error.stack ?? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
