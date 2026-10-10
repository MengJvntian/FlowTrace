/**
 * src/shared/ids.js — 追踪 ID 生成（F1）
 *
 * 形如 `<prefix>_<26 位 Crockford Base32 ULID>`：
 *   evt_01J9Z6...   event_id
 *   call_01J9Z6...  gateway_call_id
 *   run_01J9Z6...   runs.run_id（内部主键）
 *   exp_01J9Z6...   experiment_run_id（一次实验运行，可跨多个 Gateway）
 *
 * 特性：
 *   - 单调：同一毫秒内连续生成时随机段递增，字符串序即生成序（便于按 event_id 排序取证）；
 *   - 跨进程唯一：随机段来自 crypto.randomBytes，不依赖进程内状态；
 *   - 可解析：`idTimestampMs()` 能还原生成时刻，便于与 timestamp_utc 交叉校验。
 */
import { randomBytes } from 'node:crypto';

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const TIME_CHARS = 10;
const RANDOM_CHARS = 16;
const ULID_LENGTH = TIME_CHARS + RANDOM_CHARS;

export const ID_PREFIX = Object.freeze({
  EVENT: 'evt',
  CALL: 'call',
  RUN: 'run',
  EXPERIMENT: 'exp',
  GATEWAY: 'gw',
});

let lastTime = -1;
let lastRandom = '';

/**
 * @param {number} value 非负整数
 * @returns {string} Crockford Base32，固定宽度
 */
function encodeTime(value) {
  let remaining = value;
  let out = '';
  for (let i = 0; i < TIME_CHARS; i += 1) {
    const mod = remaining % 32;
    out = CROCKFORD[mod] + out;
    remaining = Math.floor(remaining / 32);
  }
  return out;
}

/**
 * @returns {string} 16 位随机 Crockford Base32
 */
function randomChars() {
  const bytes = randomBytes(RANDOM_CHARS);
  let out = '';
  for (let i = 0; i < RANDOM_CHARS; i += 1) out += CROCKFORD[bytes[i] % 32];
  return out;
}

/**
 * 在最后一位 +1（带进位），用于同毫秒内的单调性。
 * @param {string} value
 * @returns {string | null} 溢出（全 Z）时返回 null
 */
function incrementBase32(value) {
  const chars = value.split('');
  for (let i = chars.length - 1; i >= 0; i -= 1) {
    const idx = CROCKFORD.indexOf(chars[i]);
    if (idx < 31) {
      chars[i] = CROCKFORD[idx + 1];
      return chars.join('');
    }
    chars[i] = CROCKFORD[0];
  }
  return null;
}

/**
 * 生成一个 ULID 字符串。
 * @param {{now?: number}} [options]
 * @returns {string}
 */
export function newUlid(options = {}) {
  let time = Number.isFinite(options.now) ? Number(options.now) : Date.now();
  if (time > lastTime) {
    lastTime = time;
    lastRandom = randomChars();
  } else {
    const next = incrementBase32(lastRandom || randomChars());
    if (next === null) {
      // 随机段溢出（概率极低）：前进 1ms 重来。
      time = lastTime + 1;
      lastTime = time;
      lastRandom = randomChars();
    } else {
      lastRandom = next;
      time = lastTime;
    }
  }
  return encodeTime(time) + lastRandom;
}

/**
 * @param {string} prefix
 * @returns {string}
 */
export function newObjectId(prefix) {
  if (typeof prefix !== 'string' || prefix === '') {
    throw new TypeError('newObjectId(prefix) 需要非空前缀');
  }
  return `${prefix}_${newUlid()}`;
}

/** @returns {string} event_id */
export function newEventId() {
  return newObjectId(ID_PREFIX.EVENT);
}

/** @returns {string} gateway_call_id */
export function newGatewayCallId() {
  return newObjectId(ID_PREFIX.CALL);
}

/** @returns {string} runs.run_id */
export function newRunId() {
  return newObjectId(ID_PREFIX.RUN);
}

/** @returns {string} experiment_run_id */
export function newExperimentRunId() {
  return newObjectId(ID_PREFIX.EXPERIMENT);
}

/**
 * gateway_id 生成：包含可读名称 + 唯一后缀（同一上游可能出现多个 Gateway 实例）。
 * @param {string} name 例如 'mail' / 'calendar'
 * @returns {string}
 */
export function newGatewayId(name) {
  const slug = typeof name === 'string' && name !== '' ? name.replace(/[^A-Za-z0-9_-]/g, '_') : 'upstream';
  return `${ID_PREFIX.GATEWAY}_${slug}_${newUlid().slice(-8)}`;
}

/**
 * @param {unknown} value
 * @param {string} [prefix] 省略则接受任一已注册前缀
 * @returns {boolean}
 */
export function isValidId(value, prefix) {
  if (typeof value !== 'string') return false;
  const idx = value.indexOf('_');
  if (idx <= 0) return false;
  const foundPrefix = value.slice(0, idx);
  const body = value.slice(idx + 1);
  if (body.length !== ULID_LENGTH) return false;
  if (![...body].every((c) => CROCKFORD.includes(c))) return false;
  if (prefix !== undefined) return foundPrefix === prefix;
  return Object.values(ID_PREFIX).includes(foundPrefix);
}

/**
 * 从 ID 还原生成时刻（毫秒）。非本模块格式或超出时间位宽时返回 null。
 * @param {unknown} id
 * @returns {number | null}
 */
export function idTimestampMs(id) {
  if (!isValidId(id)) return null;
  const body = id.slice(id.indexOf('_') + 1);
  const timePart = body.slice(0, TIME_CHARS);
  let value = 0;
  for (const ch of timePart) {
    const idx = CROCKFORD.indexOf(ch);
    if (idx < 0) return null;
    value = value * 32 + idx;
  }
  return value;
}
