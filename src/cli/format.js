/**
 * src/cli/format.js — CLI 输出渲染（S2）
 *
 * 规则：
 *   - 表格只用 ASCII（`+`/`-`/`|`），列宽自适应，可直接复制进报告；
 *   - 时间一律打印存储里的 UTC ISO-8601 毫秒字符串（不做本地化，避免歧义）；
 *   - 空值统一显示 `-`；超长文本按列截断并加 `…`；
 *   - `--json` 时只输出一个 JSON 文档，便于脚本消费。
 */
import process from 'node:process';

/**
 * @param {string} text
 * @param {number} width
 * @returns {string}
 */
export function truncate(text, width) {
  const value = text === null || text === undefined ? '-' : String(text);
  if (value.length <= width) return value;
  return `${value.slice(0, Math.max(1, width - 1))}…`;
}

/**
 * @param {string} text
 * @param {number} width
 * @param {'left'|'right'} [align]
 * @returns {string}
 */
export function pad(text, width, align = 'left') {
  const value = text === null || text === undefined ? '-' : String(text);
  return align === 'right' ? value.padStart(width, ' ') : value.padEnd(width, ' ');
}

/**
 * 渲染 ASCII 表格。
 * @param {Array<{title: string, key: string, width?: number, align?: 'left'|'right'}>} columns
 * @param {Array<Record<string, any>>} rows
 * @returns {string}
 */
export function renderTable(columns, rows) {
  const widths = columns.map((column) => {
    const values = rows.map((row) => String(row[column.key] ?? '-'));
    const natural = Math.max(column.title.length, ...values.map((value) => value.length), 0);
    return Math.min(column.width ?? natural, Math.max(column.title.length, natural));
  });

  const line = (cells) => `| ${cells.map((cell, index) => pad(cell, widths[index], columns[index].align ?? 'left')).join(' | ')} |`;
  const separator = `+-${widths.map((width) => '-'.repeat(width)).join('-+-')}-+`;

  const output = [separator, line(columns.map((column) => column.title)), separator];
  for (const row of rows) {
    output.push(
      line(
        columns.map((column, index) => {
          const value = row[column.key];
          const text = value === null || value === undefined ? '-' : String(value);
          return truncate(text, widths[index]);
        }),
      ),
    );
  }
  output.push(separator);
  return output.join('\n');
}

/**
 * @param {number | null | undefined} bytes
 * @returns {string}
 */
export function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return '-';
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)}MiB`;
}

/**
 * @param {number | null | undefined} ms
 * @returns {string}
 */
export function formatDuration(ms) {
  if (!Number.isFinite(ms)) return '-';
  return `${Number(ms).toFixed(3)}ms`;
}

/**
 * @param {string | null | undefined} text
 * @param {number} [max]
 * @returns {string}
 */
export function oneLine(text, max = 120) {
  if (text === null || text === undefined) return '-';
  return truncate(String(text).replace(/\s+/g, ' ').trim(), max);
}

/**
 * @param {unknown} value
 * @returns {string}
 */
export function toJson(value) {
  return JSON.stringify(value, null, 2);
}

/** @param {string} message */
export function out(message = '') {
  process.stdout.write(`${message}\n`);
}

/** @param {string} message */
export function err(message = '') {
  process.stderr.write(`${message}\n`);
}
