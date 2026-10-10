#!/usr/bin/env node
/**
 * tools/install-local.js — `npm run install:local`（F1）
 *
 * 本仓库唯一的安装方式（PowerShell 的 npm.ps1 被执行策略禁止；pnpm 在此环境漏装传递依赖）：
 *
 *   cmd /c "npm install --no-audit --no-fund --cache=.npm-cache"
 *
 * 本脚本只做三件事：确保 .npm-cache 存在、在仓库根目录执行上述命令、透传退出码。
 * 它只使用 node 内置模块，因此在依赖尚未安装时也能运行。
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const cacheDir = path.join(repoRoot, '.npm-cache');
const lockFile = path.join(repoRoot, 'package-lock.json');

fs.mkdirSync(cacheDir, { recursive: true });

const inner = `npm ci --no-audit --no-fund --cache="${cacheDir}"`;
console.error('[install:local] repo      =', repoRoot);
console.error('[install:local] node      =', process.execPath, `(v${process.versions.node})`);
console.error('[install:local] command   = cmd /c "' + inner + '"');

const started = Date.now();
const result = spawnSync('cmd', ['/c', inner], { cwd: repoRoot, stdio: 'inherit', windowsHide: true });
const elapsed = ((Date.now() - started) / 1000).toFixed(1);

if (result.error) {
  console.error(`[install:local] 启动失败: ${result.error.message}`);
  process.exit(1);
}
const status = result.status === null ? 1 : result.status;
console.error(`[install:local] exit=${status} elapsed=${elapsed}s lockfile=${fs.existsSync(lockFile) ? 'present' : 'missing'}`);
if (fs.existsSync(path.join(repoRoot, 'node_modules'))) {
  console.error('[install:local] node_modules = present');
} else {
  console.error('[install:local] node_modules = MISSING (安装未生效)');
}
process.exit(status);
