/**
 * src/mock_servers/notices.js — Mock Mail 的**固定**测试数据（M1）
 *
 * 纪律：
 *   1. 全部为虚构数据（手机号一律示例号段），不得引入真实个人信息（CONVENTIONS §6.5）；
 *   2. 邮件记录固定不可变：`title=课程设计讨论`、`date=2026-10-08`、`time=14:00`、
 *      `phone=13812345678`（计划书要求的固定测试记录）；
 *   3. 文本表示与 `structuredContent` 表示**分别构造**，两者默认一致；
 *      不一致模式（`inconsistent`）只替换 `structuredContent.phone`，用于测试
 *      「结构化内容与文本内容不一致」的检测路径（见 相关实现 与 L1 任务）。
 */
import process from 'node:process';

/** 计划书要求的固定邮件记录（唯一真源）。 */
export const MEETING_NOTICE = Object.freeze({
  notice_id: 'notice-2026-10-08-001',
  title: '课程设计讨论',
  date: '2026-10-08',
  time: '14:00',
  phone: '13812345678',
  sender: '教务处',
  place: '教学主楼 B-305',
  recipients: Object.freeze(['计算机学院 2026 级', '课程设计指导教师']),
  body: '请于 10 月 8 日 14:00 到教学主楼 B-305 参加课程设计讨论，携带选题说明与分组名单。如有疑问请联系 13812345678。',
});

/**
 * 不一致模式下 `structuredContent.phone` 使用的诱饵值（虚构，非任何真实号段）。
 * 文本内容仍然显示 `MEETING_NOTICE.phone`，因此下游可以观测到「同一字段两种表示不一致」。
 */
export const DECOY_PHONE = '19900001111';

/** `search_notices` 的检索目录（全部虚构；包含固定记录本身）。 */
export const NOTICE_CATALOG = Object.freeze([
  MEETING_NOTICE,
  Object.freeze({
    notice_id: 'notice-2026-10-09-002',
    title: '实验课调课通知',
    date: '2026-10-09',
    time: '10:30',
    phone: '13800000002',
    sender: '计算机学院教务办',
    place: '实验楼 A-201',
    recipients: Object.freeze(['计算机学院 2026 级']),
    body: '10 月 9 日实验课调整到 10:30 开始，地点不变。联系电话 13800000002。',
  }),
  Object.freeze({
    notice_id: 'notice-2026-10-12-003',
    title: '课程设计中期检查安排',
    date: '2026-10-12',
    time: '09:00',
    phone: '13800000003',
    sender: '课程组',
    place: '教学主楼 A-108',
    recipients: Object.freeze(['课程设计指导教师', '计算机学院 2026 级']),
    body: '中期检查定于 10 月 12 日 09:00 开始，请提前提交进展报告。联系电话 13800000003。',
  }),
]);

/**
 * 环境变量开关（`TRACE_MAIL_INCONSISTENT`）解析：'1'/'true'/'yes'（大小写不敏感）为真。
 * 工具参数 `inconsistent` 优先于环境变量（见 `resolveInconsistent`）。
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {boolean}
 */
export function inconsistentModeFromEnv(env = process.env) {
  const raw = env.TRACE_MAIL_INCONSISTENT;
  if (typeof raw !== 'string') return false;
  return ['1', 'true', 'yes', 'on'].includes(raw.trim().toLowerCase());
}

/**
 * 解析本次调用的「不一致模式」：工具参数优先，其次环境变量。
 * @param {unknown} requested 工具参数 `inconsistent`
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {{inconsistent: boolean, source: 'argument'|'env'|'default'}}
 */
export function resolveInconsistent(requested, env = process.env) {
  if (requested === true) return { inconsistent: true, source: 'argument' };
  if (requested === false) return { inconsistent: false, source: 'argument' };
  if (requested !== undefined && requested !== null) {
    throw new TypeError(`inconsistent 参数必须是布尔值，收到 ${JSON.stringify(requested)}`);
  }
  if (inconsistentModeFromEnv(env)) return { inconsistent: true, source: 'env' };
  return { inconsistent: false, source: 'default' };
}

/**
 * 文本表示（人类可读）。始终使用记录中的**原始**字段值。
 * @param {typeof MEETING_NOTICE} notice
 * @returns {string}
 */
export function renderNoticeText(notice) {
  return [
    `【课程通知】${notice.title}`,
    `通知编号：${notice.notice_id}`,
    `日期：${notice.date}`,
    `时间：${notice.time}`,
    `地点：${notice.place}`,
    `发送方：${notice.sender}`,
    `接收方：${notice.recipients.join('、')}`,
    `联系电话：${notice.phone}`,
    '',
    notice.body,
  ].join('\n');
}

/**
 * 结构化表示。默认与文本表示一致；`inconsistent=true` 时**只**替换 `phone`，
 * 并显式标记 `mock_inconsistent=true`（让测试能断言开关真的生效，而不是静默无操作）。
 * @param {typeof MEETING_NOTICE} notice
 * @param {{inconsistent?: boolean}} [options]
 * @returns {Record<string, unknown>}
 */
export function noticeToStructured(notice, options = {}) {
  const inconsistent = options.inconsistent === true;
  /** @type {Record<string, unknown>} */
  const out = {
    notice_id: notice.notice_id,
    title: notice.title,
    date: notice.date,
    time: notice.time,
    phone: inconsistent ? DECOY_PHONE : notice.phone,
    sender: notice.sender,
    place: notice.place,
    recipients: [...notice.recipients],
    body: notice.body,
  };
  if (inconsistent) out.mock_inconsistent = true;
  return out;
}

/**
 * 检索通知：按 title / body / notice_id / sender 做大小写不敏感的子串匹配。
 * @param {string} query 空字符串表示「返回全部」
 * @param {{limit?: number, catalog?: readonly typeof MEETING_NOTICE[]}} [options]
 * @returns {readonly typeof MEETING_NOTICE[]}
 */
export function searchNotices(query, options = {}) {
  const catalog = options.catalog ?? NOTICE_CATALOG;
  const limit = Number.isInteger(options.limit) && options.limit > 0 ? Math.min(options.limit, 50) : 10;
  const needle = typeof query === 'string' ? query.trim().toLowerCase() : '';
  const matched = needle === ''
    ? [...catalog]
    : catalog.filter((notice) =>
      [notice.title, notice.body, notice.notice_id, notice.sender]
        .some((field) => String(field).toLowerCase().includes(needle)),
    );
  return matched.slice(0, limit);
}
