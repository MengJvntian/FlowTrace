/**
 * src/web/databases.js — 事件库发现（只读、有界、带缓存）
 *
 * 背景（用户实际困惑）：他以为历史数据丢了 —— 其实数据一直持久化在 SQLite 文件里，
 * 只是**页面读的库文件与他以为的不是同一个**。当时页面只说「当前没有任务记录」，
 * 既不说读的是哪个文件，也不说还有哪些库可用，用户无从判断。
 *
 * 本模块只做一件事：把仓库内**候选事件库**及其规模列出来，供空状态与启动提示使用。
 *
 * ⚠️ 性能纪律（2026-10-05 实测教训）：
 *   首版实现「递归扫全仓 + 逐文件用 SQLite 打开做 count」。在测试里夹具库 calls=0，
 *   于是 `api/meta` 每次请求都触发全盘扫描 + 十几次 SQLite 打开 —— 全量测试直接跑到超时。
 *   现在改为三重约束：
 *     ① **只扫固定候选目录**（不做任意深度递归）：demo-data 顶层 + 它的**直接子目录**；
 *     ② **进程内缓存**（TTL 默认 30 秒），同一次页面会话里只算一遍；
 *     ③ 单个文件 count 查询有失败兜底，坏文件直接跳过。
 */
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/** 缓存 TTL（毫秒）：自动刷新/多次请求不会反复扫盘。 */
const CACHE_TTL_MS = 30_000;
/** 最多检查多少个候选文件。 */
const MAX_FILES = 12;

/** @type {{at: number, key: string, value: Array<any>} | null} */
let cache = null;

/**
 * 读取一个事件库文件的规模（只读，失败返回 null）。
 * @param {string} filePath
 * @returns {{calls: number, events: number, runs: number} | null}
 */
function readCounts(filePath) {
  let db = null;
  try {
    db = new DatabaseSync(filePath, { readOnly: true });
    const calls = db.prepare('select count(*) as n from calls').get();
    const events = db.prepare('select count(*) as n from events').get();
    let runs = { n: 0 };
    try {
      runs = db.prepare('select count(*) as n from runs').get();
    } catch {
      /* 老库可能没有 runs 表：不算错误 */
    }
    return { calls: Number(calls?.n ?? 0), events: Number(events?.n ?? 0), runs: Number(runs?.n ?? 0) };
  } catch {
    return null;
  } finally {
    try {
      db?.close();
    } catch {
      /* 关闭失败无需上报 */
    }
  }
}

/**
 * 收集候选库文件：demo-data 顶层 + 它的直接子目录（不递归更深，避免扫盘失控）。
 * 跳过 `tmp`（那是测试与探针的临时库，列出来只会是噪音）。
 * @param {string} repoRoot
 * @returns {string[]}
 */
function collectCandidates(repoRoot) {
  /** @type {string[]} */
  const files = [];
  const demoData = path.join(repoRoot, 'demo-data');
  const dirs = [demoData];
  try {
    for (const entry of fs.readdirSync(demoData, { withFileTypes: true })) {
      if (entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'tmp') {
        dirs.push(path.join(demoData, entry.name));
      }
    }
  } catch {
    /* demo-data 不存在则只试仓库根 */
  }
  for (const dir of dirs) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      if (!/\.db$/i.test(entry.name)) continue;
      files.push(path.join(dir, entry.name));
      if (files.length >= MAX_FILES) return files;
    }
  }
  return files;
}

/**
 * 列出仓库内候选事件库及其规模（带 30 秒进程内缓存）。
 *
 * @param {string} currentDbPath 当前页面正在读的库（结果里会标 current=true）
 * @param {{repoRoot: string, limit?: number}} options
 * @returns {Array<{path: string, relative: string, calls: number, events: number, runs: number, current: boolean}>}
 */
export function listCandidateDatabases(currentDbPath, options) {
  const repoRoot = options.repoRoot;
  const limit = options.limit ?? 12;
  const currentAbsolute = path.resolve(currentDbPath);
  const key = `${repoRoot}|${currentAbsolute}|${limit}`;
  const now = Date.now();
  if (cache !== null && cache.key === key && now - cache.at < CACHE_TTL_MS) {
    return cache.value;
  }

  /** @type {Array<{path: string, relative: string, calls: number, events: number, runs: number, current: boolean}>} */
  const out = [];
  for (const file of collectCandidates(repoRoot)) {
    const absolute = path.resolve(file);
    const counts = readCounts(absolute);
    if (counts === null) continue; // 不是本平台的事件库 / 读不了 → 不算候选
    out.push({
      path: absolute,
      relative: path.relative(repoRoot, absolute).replace(/\\/g, '/'),
      calls: counts.calls,
      events: counts.events,
      runs: counts.runs,
      current: absolute === currentAbsolute,
    });
  }
  out.sort((a, b) => b.calls - a.calls);
  const value = out.slice(0, limit);
  cache = { at: now, key, value };
  return value;
}

/** 清缓存（仅供测试使用，避免用例之间互相影响）。 */
export function resetDatabaseDiscoveryCache() {
  cache = null;
}
