import fs from 'node:fs';
import { createHash } from 'node:crypto';

// A small bounded cache. Counts invalidate it during collection; file stamps
// also invalidate it after maintenance that changes existing rows.
export function dataVersion(ctx) {
  const stamp = [ctx.store?.countCalls() ?? 0, ctx.store?.countEvents() ?? 0];
  for (const file of [ctx.config.dbPath, ctx.config.dbPath + '-wal']) {
    try { const s = fs.statSync(file); stamp.push(s.size, s.mtimeMs); } catch { stamp.push(null); }
  }
  return createHash('sha256').update(JSON.stringify(stamp)).digest('hex');
}
export function cachedView(ctx, key, build) {
  if (ctx.config.maskData === true) return build();
  const version = dataVersion(ctx);
  const cache = ctx.viewCache ??= new Map();
  if (ctx.viewVersion !== version) { cache.clear(); ctx.viewVersion = version; }
  if (cache.has(key)) return cache.get(key);
  const result = build();
  if (cache.size >= 6) cache.delete(cache.keys().next().value);
  cache.set(key, result);
  return result;
}

// Full values remain available through the edge and raw-data endpoints.
export function compactFlows(value) {
  const previewKeys = new Set(['source_value', 'sink_value', 'raw_value', 'canonical', 'value', 'source_value_masked', 'sink_value_masked', 'raw_value_masked', 'canonical_masked', 'value_masked']);
  function project(node, key) {
    if (key === 'competition_key' && typeof node === 'string') return 'preview-key:' + createHash('sha256').update(node).digest('hex');
    if (typeof node === 'string' && previewKeys.has(key) && node.length > 320) return node.slice(0, 320) + '…';
    if (Array.isArray(node)) return node.map(item => project(item, key));
    if (!node || typeof node !== 'object') return node;
    const result = {};
    for (const [name, item] of Object.entries(node)) result[name] = project(item, name);
    if (Object.entries(node).some(([name, item]) => previewKeys.has(name) && typeof item === 'string' && item.length > 320)) result.preview_truncated = true;
    return result;
  }
  return { ...project(value, ''), compact: true, preview_note: '长正文为预览；关联规则与字符位置按完整原文计算，查看证据可读全文。' };
}
