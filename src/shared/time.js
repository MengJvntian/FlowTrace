/**
 * src/shared/time.js — 时间与单调耗时（F1）
 *
 * 契约（相关实现）：
 *   - 墙上时间一律 UTC ISO-8601、毫秒精度、`Z` 结尾（例：2026-10-08T06:00:00.123Z）；
 *   - 耗时一律用 performance.now() 差值（单调时钟），单位毫秒，保留 3 位小数，
 *     绝不用 Date 差值计算耗时（会被系统时钟跳变污染）。
 */
import { performance } from 'node:perf_hooks';

const UTC_ISO_MS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/**
 * @param {Date} [date]
 * @returns {string} UTC ISO-8601 毫秒精度
 */
export function nowUtcIso(date = new Date()) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
    throw new TypeError('nowUtcIso() 需要合法 Date');
  }
  return date.toISOString();
}

/**
 * 宽松归一化：Date / 毫秒数 / ISO 字符串 → UTC ISO-8601 毫秒精度。
 * @param {unknown} value
 * @returns {string}
 */
export function toUtcIso(value) {
  if (value instanceof Date) return nowUtcIso(value);
  if (typeof value === 'number' && Number.isFinite(value)) return new Date(value).toISOString();
  if (typeof value === 'string') {
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) throw new TypeError(`无法解析为时间: ${JSON.stringify(value)}`);
    return parsed.toISOString();
  }
  throw new TypeError(`无法解析为时间: ${JSON.stringify(value)}`);
}

/**
 * @param {unknown} value
 * @returns {boolean} 是否为规范形式（毫秒精度 + Z）
 */
export function isUtcIso8601Ms(value) {
  if (typeof value !== 'string' || !UTC_ISO_MS.test(value)) return false;
  const parsed = new Date(value);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value;
}

/**
 * 单调时钟读数（毫秒，进程内单调）。
 * @returns {number}
 */
export function monotonicNow() {
  return performance.now();
}

/**
 * @param {number} startMs monotonicNow() 的返回值
 * @param {number} [endMs] 默认取当前单调时刻
 * @returns {number} 毫秒，保留 3 位小数，永不为负
 */
export function elapsedMs(startMs, endMs = monotonicNow()) {
  const value = endMs - startMs;
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.round(value * 1000) / 1000);
}

/**
 * 建立一个成对计时器：同时给出墙上时间与单调起点。
 * @returns {{start_utc: string, started_monotonic_ms: number, utc: () => string, ms: () => number}}
 */
export function createTimer() {
  const started_monotonic_ms = monotonicNow();
  const start_utc = nowUtcIso();
  return {
    start_utc,
    started_monotonic_ms,
    utc: () => nowUtcIso(),
    ms: () => elapsedMs(started_monotonic_ms),
  };
}

/**
 * 便于做文件名/ID 片段的紧凑 UTC 时间戳：20261008T060000123Z
 * @param {string | Date} [value]
 * @returns {string}
 */
export function utcStampCompact(value = new Date()) {
  const iso = value instanceof Date ? nowUtcIso(value) : toUtcIso(value);
  return `${iso.slice(0, 4)}${iso.slice(5, 7)}${iso.slice(8, 10)}T${iso.slice(11, 13)}${iso.slice(14, 16)}${iso.slice(17, 19)}${iso.slice(20, 23)}Z`;
}

/**
 * 相对毫秒的 ISO 字符串（用于打印「+123ms」这类时间线偏移）。
 * @param {number} ms
 * @returns {string}
 */
export function formatOffsetMs(ms) {
  if (!Number.isFinite(ms)) return '+0ms';
  const sign = ms < 0 ? '-' : '+';
  const abs = Math.abs(ms);
  if (abs < 1000) return `${sign}${abs.toFixed(abs % 1 === 0 ? 0 : 1)}ms`;
  return `${sign}${(abs / 1000).toFixed(3)}s`;
}
