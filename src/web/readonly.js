/**
 * src/web/readonly.js — P3 只读边界的两道保险（W1）
 *
 * 「只读」不能只靠约定，必须是**结构上不可能写**：
 *
 * 1. **SQLite 层**：`openReadOnlyStore()` 用 `new DatabaseSync(path, { readOnly: true })`
 *    打开连接（实测：`INSERT`/`CREATE TABLE` 均报
 *    `attempt to write a readonly database`，即 SQLITE_READONLY）。
 *    同时传 `autoInit: false`，避免 `TraceStore.init()` 的 PRAGMA/DDL 在只读连接上执行。
 * 2. **API 层**：`asReadOnlyStore()` 返回一个**白名单门面**——只转发查询方法
 *    （`list*` / `get*` / `count*` / `stats` / `getMeta`），任何写方法
 *    （`insertCall` / `insertEvent` / `upsertRun` / `deleteRun` / `vacuum` / `setMeta` /
 *    `init` / `withTransaction` …）在门面上直接抛错。
 *
 * 这样即使后来有人在 API 代码里误调用 `store.deleteRun()`，也会立刻失败而不是静默改库。
 */
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { TraceStore } from '../collector/store.js';
import { DEFAULT_BUSY_TIMEOUT_MS } from '../shared/schemaversion.js';

/** 门面允许的**查询**方法（唯一的读入口白名单）。 */
export const READONLY_METHODS = Object.freeze([
  'listRuns',
  'listCalls',
  'listEvents',
  'getRun',
  'getCall',
  'getCallDetail',
  'countCalls',
  'countEvents',
  'stats',
  'getMeta',
  'listMeta',
  'getPersistedWriteFailures',
  'dbFileSize',
]);

/** 明确禁止的方法（用于错误信息与测试断言）。 */
export const WRITE_METHODS = Object.freeze([
  'init',
  'insertCall',
  'insertEvent',
  'upsertRun',
  'deleteRun',
  'vacuum',
  'setMeta',
  'withTransaction',
  '_safeWrite',
  '_handleWriteFailure',
]);

/**
 * 打开只读事件库连接。
 * @param {string} dbPath
 * @param {{busyTimeoutMs?: number}} [options]
 * @returns {TraceStore}
 */
export function openReadOnlyStore(dbPath, options = {}) {
  if (typeof dbPath !== 'string' || dbPath === '') throw new TypeError('openReadOnlyStore(dbPath) 需要非空字符串');
  const busyTimeoutMs = Number.isFinite(options.busyTimeoutMs) ? Number(options.busyTimeoutMs) : DEFAULT_BUSY_TIMEOUT_MS;
  const db = new DatabaseSync(dbPath, { readOnly: true, timeout: busyTimeoutMs });
  return new TraceStore(dbPath, db, { autoInit: false, busyTimeoutMs });
}

/**
 * 只读 store 门面：只暴露查询方法 + `dbPath`。
 * @param {TraceStore} store
 * @returns {Record<string, any>}
 */
export function asReadOnlyStore(store) {
  /** @type {Record<string, any>} */
  const facade = {
    dbPath: store.dbPath,
    readonly: true,
  };
  for (const method of READONLY_METHODS) {
    if (typeof store[method] !== 'function') continue;
    facade[method] = (...args) => store[method](...args);
  }
  return new Proxy(facade, {
    get(target, property) {
      if (property in target) return target[property];
      if (typeof property === 'symbol') return undefined;
      throw new TypeError(
        `只读边界：web 层不允许访问 store.${String(property)}；` +
          `查询方法白名单=${READONLY_METHODS.join(',')}。改库请用 CLI 受控入口（bin/trace.js / bin/reset.js）。`,
      );
    },
    set() {
      throw new TypeError('只读边界：web 层的 store 门面不可赋值。');
    },
    has(target, property) {
      return property in target;
    },
  });
}

/**
 * 打开 web 服务使用的库：文件不存在时**不建库**（避免误建空库，也不写任何文件）。
 *
 * 返回 `store`（只读门面，供 API 使用）与 `raw`（底层 `TraceStore`，仅供服务关闭连接时使用）。
 *
 * @param {string} dbPath
 * @returns {{store: Record<string, any> | null, raw: TraceStore | null, db_exists: boolean, db_bytes: number, open_error: string | null, mode: string}}
 */
export function openWebStore(dbPath) {
  if (dbPath === ':memory:') {
    return {
      store: null,
      raw: null,
      db_exists: false,
      db_bytes: 0,
      open_error: ':memory: 不适用于页面服务（没有可读的持久数据）',
      mode: 'memory_unsupported',
    };
  }
  if (!fs.existsSync(dbPath)) {
    return { store: null, raw: null, db_exists: false, db_bytes: 0, open_error: null, mode: 'missing' };
  }
  const bytes = (() => {
    try {
      return fs.statSync(dbPath).size;
    } catch {
      return 0;
    }
  })();
  try {
    const raw = openReadOnlyStore(dbPath);
    return { store: asReadOnlyStore(raw), raw, db_exists: true, db_bytes: bytes, open_error: null, mode: 'readonly' };
  } catch (error) {
    return {
      store: null,
      raw: null,
      db_exists: true,
      db_bytes: bytes,
      open_error: error instanceof Error ? error.message : String(error),
      mode: 'unreadable',
    };
  }
}
