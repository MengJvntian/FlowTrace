/**
 * src/web/static.js — P3 页面静态资源（W1）
 *
 * 只服务 `src/web/public/` 下的**白名单文件**（无构建链：原生 HTML + CSS + 经典脚本，没有打包器、
 * 没有依赖）。白名单同时消灭了路径穿越问题：URL 与磁盘文件一一对应，任何未列出的路径都 404。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PUBLIC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'public');

/**
 * URL → 文件 + 内容类型（唯一映射表）。
 *
 * 两个页面：`/`＝结论层（任务列表 / 时间线 / 流向图 / 边证据 + 一行边界摘要，四类信息各自可筛）；
 * `/ops.html`＝次级入口（系统、运维、边界原文与诊断明细）。共用 `common.js` 与 `styles.css`；
 * `filters.js` 是首页筛选的纯逻辑、`isr.js` 是首页自动刷新的纯逻辑（页面与测试共用同一份代码）。
 */
export const STATIC_FILES = Object.freeze({
  '/applications.html': { file: 'applications.html', type: 'text/html; charset=utf-8' },
  '/applications.js': { file: 'applications.js', type: 'text/javascript; charset=utf-8' },
  '/tasks.js': { file: 'tasks.js', type: 'text/javascript; charset=utf-8' },
  '/task-panel.js': { file: 'task-panel.js', type: 'text/javascript; charset=utf-8' },
  '/': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/index.html': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/app.js': { file: 'app.js', type: 'text/javascript; charset=utf-8' },
  '/data.js': { file: 'data.js', type: 'text/javascript; charset=utf-8' },
  '/insights.js': { file: 'insights.js', type: 'text/javascript; charset=utf-8' },
  '/filters.js': { file: 'filters.js', type: 'text/javascript; charset=utf-8' },
  '/isr.js': { file: 'isr.js', type: 'text/javascript; charset=utf-8' },
  '/ops.html': { file: 'ops.html', type: 'text/html; charset=utf-8' },
  '/ops.js': { file: 'ops.js', type: 'text/javascript; charset=utf-8' },
  '/common.js': { file: 'common.js', type: 'text/javascript; charset=utf-8' },
  '/styles.css': { file: 'styles.css', type: 'text/css; charset=utf-8' },
  '/favicon.ico': { file: 'favicon.svg', type: 'image/svg+xml' },
});

/**
 * @param {string} pathname
 * @returns {{type: string, body: Buffer} | null}
 */
export function readStatic(pathname) {
  const entry = STATIC_FILES[pathname];
  if (!entry) return null;
  const absolute = path.join(PUBLIC_DIR, entry.file);
  if (!fs.existsSync(absolute)) return null;
  const body = fs.readFileSync(absolute);
  const record = { type: entry.type, body };
  return record;
}

/** @returns {string} 静态资源目录（诊断用）。 */
export function staticDir() {
  return PUBLIC_DIR;
}
