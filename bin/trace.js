#!/usr/bin/env node
/**
 * bin/trace.js — P1 追踪 CLI（S2）
 *
 * 用法：`node bin/trace.js <命令> [选项]`（`--help` 查看全部命令与选项）。
 *
 * 纪律：
 *   - 人类可读输出与 `--json` 输出一律写 **stdout**；用法/错误写 **stderr**；
 *   - 退出码：0 成功 / 1 运行错误 / 2 用法错误 / 3 查询对象不存在；
 *   - 只经 `TraceStore` 访问事件库（不绕过存储层直接改库）。
 */
import process from 'node:process';

import { CliError, usageError } from '../src/cli/args.js';
import { TRACE_USAGE, runTraceCli } from '../src/cli/commands.js';
import { err } from '../src/cli/format.js';

try {
  const code = runTraceCli(process.argv.slice(2));
  process.exitCode = typeof code === 'number' ? code : 0;
} catch (error) {
  if (error instanceof CliError) {
    err(`[trace] ${error.message}`);
    if (error.showUsage) err('');
    process.exitCode = error.exitCode;
  } else {
    err(`[trace] 未预期错误：${error instanceof Error ? error.stack ?? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
