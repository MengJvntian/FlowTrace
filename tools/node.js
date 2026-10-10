#!/usr/bin/env node
/**
 * tools/node.js — 工具链启动器（F1）
 *
 * 所有 npm scripts（test / gateway / demo / web / trace）都经由本文件启动子进程，
 * 目的：使用 Node 24+（`node:sqlite` 在系统 Node 22 上需要
 * `--experimental-sqlite` 且 API 较旧），而不是 PATH 里的 `node`。
 *
 * 解析顺序（可用环境变量覆盖，便于复现与移植）：
 *   1. `TRACE_NODE_BIN`（绝对路径，存在则使用）
 *   2. 当前 Node（版本 >= 24 时优先）
 *   3. 用户目录中的 DSH Node；最后回退到当前 Node 并告警
 *
 * 约定：本启动器的诊断信息只写 stderr；子进程 stdout 原样穿透，
 * 以免污染 Gateway / demo 的机器可读 stdout。
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

/** 捆绑 Node 24（本机实测 v24.21.0）。 */
export const BUNDLED_NODE = path.join(os.homedir(), '.dsh', 'dsh-runtimes', 'dsh-primary-runtime', 'dependencies', 'node', 'bin', 'node.exe');

/**
 * @returns {{bin: string, source: 'env'|'current'|'bundled'|'fallback'}}
 */
export function resolveNodeBin() {
  const fromEnv = process.env.TRACE_NODE_BIN;
  if (fromEnv && fs.existsSync(fromEnv)) return { bin: fromEnv, source: 'env' };
  if (Number(process.versions.node.split('.')[0]) >= 24) return { bin: process.execPath, source: 'current' };
  if (fs.existsSync(BUNDLED_NODE)) return { bin: BUNDLED_NODE, source: 'bundled' };
  return { bin: process.execPath, source: 'fallback' };
}

const args = process.argv.slice(2);
if (args.length === 0) {
  console.error('[tools/node.js] 用法: node tools/node.js <script.mjs|--test dir> [args...]');
  process.exit(2);
}

const { bin, source } = resolveNodeBin();
if (source === 'fallback') {
  console.error(
    `[tools/node.js] 警告: 未找到捆绑 Node 24（${BUNDLED_NODE}），回退到 ${bin}。` +
      '请设置 TRACE_NODE_BIN 指向 Node >= 24。',
  );
}
const [major] = process.versions.node.split('.');
console.error(`[tools/node.js] launch: ${bin} (source=${source}, required>=24, launcher node v${process.versions.node})`);
if (source === 'fallback' && Number(major) < 24) {
  console.error('[tools/node.js] 警告: 运行时主版本 < 24，node:sqlite 行为可能不同。');
}

const result = spawnSync(bin, args, { stdio: 'inherit', windowsHide: true });
if (result.error) {
  console.error(`[tools/node.js] 启动失败: ${result.error.message}`);
  process.exit(1);
}
if (result.signal) {
  console.error(`[tools/node.js] 子进程被信号终止: ${result.signal}`);
  process.exit(1);
}
process.exit(result.status === null ? 1 : result.status);
