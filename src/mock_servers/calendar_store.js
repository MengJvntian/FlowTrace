/**
 * src/mock_servers/calendar_store.js — Mock Calendar 的 JSON 测试存储（M1）
 *
 * 位置与安全边界：
 *   1. 默认 `demo-data/calendar-events.json`（仓库内），可用 `--store <path>` 或
 *      `TRACE_CALENDAR_STORE` 覆盖；**解析后的绝对路径必须位于仓库内**，
 *      否则抛错并拒绝写入 —— 即「不得写用户主目录 / 仓库外任何位置」（CONVENTIONS §6.1、§7）；
 *   2. 写入采用「同目录临时文件 + rename 原子替换」，任何时刻磁盘上都是完整 JSON；
 *   3. 每次调用都重新从磁盘读取（多进程 / 多客户端共享同一份测试数据），
 *      `clear_events` 在任何进程里都能被其它进程的 `list_events` 立即观察到。
 *
 * 数据结构：`{ "schema": "mock-calendar/1", "events": [ { event_id, title, date, time, created_at_utc } ] }`
 */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { newObjectId } from '../shared/ids.js';
import { nowUtcIso } from '../shared/time.js';

export const CALENDAR_STORE_SCHEMA = 'mock-calendar/1';
export const CALENDAR_EVENT_ID_PREFIX = 'cevt';

const here = path.dirname(fileURLToPath(import.meta.url));

/** 仓库根（`<repo>/src/mock_servers/calendar_store.js` → `<repo>`）。 */
export const REPO_ROOT = path.resolve(here, '..', '..');

/** 默认存储文件（仓库相对 POSIX 形式，便于日志与证据引用）。 */
export const DEFAULT_STORE_RELATIVE = 'demo-data/calendar-events.json';

/** 默认存储文件绝对路径。 */
export const DEFAULT_STORE_PATH = path.join(REPO_ROOT, ...DEFAULT_STORE_RELATIVE.split('/'));

/** 仓库外路径被拒绝时抛出的错误（错误信息里带解析后的绝对路径）。 */
export class StorePathError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = 'StorePathError';
  }
}

/**
 * 解析存储路径并强制「只能落在仓库内」。
 * @param {string} [explicit] 命令行/环境变量给出的路径（相对或绝对）
 * @returns {string} 绝对路径
 */
export function resolveStorePath(explicit) {
  const raw = typeof explicit === 'string' && explicit.trim() !== ''
    ? explicit.trim()
    : (typeof process.env.TRACE_CALENDAR_STORE === 'string' && process.env.TRACE_CALENDAR_STORE.trim() !== ''
      ? process.env.TRACE_CALENDAR_STORE.trim()
      : DEFAULT_STORE_RELATIVE);
  const absolute = path.resolve(REPO_ROOT, raw);
  const relative = path.relative(REPO_ROOT, absolute);
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new StorePathError(
      `拒绝使用仓库外存储路径（禁止写用户主目录）：解析为 ${absolute}，仓库根为 ${REPO_ROOT}`,
    );
  }
  return absolute;
}

/**
 * 仓库相对 POSIX 路径（用于日志/结果里的可读定位）。
 * @param {string} absolute
 * @returns {string}
 */
export function repoRelative(absolute) {
  return path.relative(REPO_ROOT, absolute).split(path.sep).join('/');
}

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
const CONTROL_RE = /[\u0000-\u001f\u007f]/;

/**
 * 校验单个字段。
 * @param {unknown} value
 * @param {'title'|'date'|'time'} field
 * @returns {Array<{field: string, code: string, message: string, received: unknown, expected: string}>}
 */
function validateField(value, field) {
  const problems = [];
  const push = (code, message, expected) => {
    problems.push({ field, code, message: `参数 ${field} ${message}`, received: value, expected });
  };

  if (value === undefined) {
    push('missing', '缺失（必填）', field === 'title' ? '非空字符串' : field === 'date' ? 'YYYY-MM-DD' : 'HH:MM');
    return problems;
  }
  if (value === null) {
    push('null', '为 null（必填）', field === 'title' ? '非空字符串' : field === 'date' ? 'YYYY-MM-DD' : 'HH:MM');
    return problems;
  }
  if (typeof value !== 'string') {
    push('not_a_string', `必须是字符串，收到 ${typeof value}`, '字符串');
    return problems;
  }

  if (field === 'title') {
    const trimmed = value.trim();
    if (trimmed === '') push('empty', '为空白字符串（必填）', '非空字符串');
    else if (trimmed.length > 200) push('too_long', `长度 ${trimmed.length} 超过上限 200`, '长度 ≤ 200 的非空字符串');
    if (CONTROL_RE.test(value)) push('control_chars', '包含控制字符', '不含控制字符的字符串');
    return problems;
  }

  if (field === 'date') {
    const match = DATE_RE.exec(value);
    if (!match) {
      push('bad_format', `格式非法（期望 YYYY-MM-DD，收到 ${JSON.stringify(value)}）`, 'YYYY-MM-DD');
      return problems;
    }
    const [, y, m, d] = match;
    const year = Number(y);
    const month = Number(m);
    const day = Number(d);
    const asUtc = new Date(Date.UTC(year, month - 1, day));
    const impossible =
      asUtc.getUTCFullYear() !== year || asUtc.getUTCMonth() !== month - 1 || asUtc.getUTCDate() !== day;
    if (impossible) {
      push('impossible_date', `不是一个真实存在的日期（${value}）`, '真实存在的日历日期');
      return problems;
    }
    if (year < 1970 || year > 2100) push('out_of_range', `年份 ${year} 超出 1970–2100`, '年份 1970–2100');
    return problems;
  }

  const timeMatch = TIME_RE.exec(value);
  if (!timeMatch) {
    push('bad_format', `格式非法（期望 HH:MM 24 小时制，收到 ${JSON.stringify(value)}）`, 'HH:MM（00:00–23:59）');
  }
  return problems;
}

/**
 * 校验 `create_event` 的输入。**返回全部问题**（一次调用即可测出所有边界）。
 * 所有参数都保持「可选」的 schema，校验放在服务端，正是为了让缺参也走
 * `isError=true` 的结果路径（而不是协议层 InvalidParams）。
 * @param {{title?: unknown, date?: unknown, time?: unknown}} input
 * @returns {{ok: true, value: {title: string, date: string, time: string}} | {ok: false, problems: Array<Record<string, unknown>>}}
 */
export function validateEventInput(input) {
  const source = input && typeof input === 'object' ? input : {};
  const problems = [
    ...validateField(source.title, 'title'),
    ...validateField(source.date, 'date'),
    ...validateField(source.time, 'time'),
  ];
  if (problems.length > 0) return { ok: false, problems };
  return {
    ok: true,
    value: {
      title: /** @type {string} */ (source.title).trim(),
      date: /** @type {string} */ (source.date),
      time: /** @type {string} */ (source.time),
    },
  };
}

/** Mock Calendar 的 JSON 存储（每次操作都读盘，无内存缓存）。 */
export class CalendarStore {
  /** @param {string} [filePath] 省略则按 `TRACE_CALENDAR_STORE` / 默认值解析 */
  constructor(filePath) {
    this.filePath = filePath ? resolveStorePath(filePath) : resolveStorePath();
  }

  /** 仓库相对路径（POSIX）。 */
  get relativePath() {
    return repoRelative(this.filePath);
  }

  /**
   * 读取存储文件。
   * @returns {{schema: string, events: Array<Record<string, unknown>>}}
   */
  load() {
    if (!fs.existsSync(this.filePath)) return { schema: CALENDAR_STORE_SCHEMA, events: [] };
    const text = fs.readFileSync(this.filePath, 'utf8');
    if (text.trim() === '') return { schema: CALENDAR_STORE_SCHEMA, events: [] };
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      throw new Error(
        `日历存储文件损坏（无法解析 JSON）：${this.relativePath} — ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (parsed === null || typeof parsed !== 'object' || !Array.isArray(parsed.events)) {
      throw new Error(`日历存储文件结构非法（期望 {schema, events: []}）：${this.relativePath}`);
    }
    return { schema: typeof parsed.schema === 'string' ? parsed.schema : CALENDAR_STORE_SCHEMA, events: parsed.events };
  }

  /**
   * 原子写：同目录临时文件 + rename。
   * @param {{schema: string, events: Array<Record<string, unknown>>}} data
   */
  save(data) {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
    fs.renameSync(tmp, this.filePath);
  }

  /** @returns {Array<Record<string, unknown>>} */
  list() {
    return this.load().events;
  }

  /**
   * 追加一条日程。
   * @param {{title: string, date: string, time: string}} value 已通过 `validateEventInput` 的规范值
   * @returns {Record<string, unknown>} 写入的完整事件
   */
  create(value) {
    const data = this.load();
    const event = {
      event_id: newObjectId(CALENDAR_EVENT_ID_PREFIX),
      title: value.title,
      date: value.date,
      time: value.time,
      created_at_utc: nowUtcIso(),
    };
    data.events.push(event);
    this.save({ schema: data.schema || CALENDAR_STORE_SCHEMA, events: data.events });
    return event;
  }

  /**
   * 清空全部日程（文件保留但 events 为空数组）。
   * @returns {number} 被清掉的条数
   */
  clear() {
    const data = this.load();
    const cleared = data.events.length;
    this.save({ schema: data.schema || CALENDAR_STORE_SCHEMA, events: [] });
    return cleared;
  }
}
