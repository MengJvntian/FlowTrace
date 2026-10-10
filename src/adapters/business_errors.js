import { feishuBusinessError } from './feishu.js';
import { dingtalkBusinessError } from './dingtalk.js';
export function applicationBusinessError(result, app) {
  if (app === 'notion') {
    const envelopes = [result?.structuredContent];
    for (const block of Array.isArray(result?.content) ? result.content : []) {
      if (block.type === 'text') { try { envelopes.push(JSON.parse(block.text)); } catch { /* plain text */ } }
    }
    // Official MCP returns Notion HTTP failures in text without isError.
    for (const body of envelopes) {
      if (body?.object === 'error' && typeof body.code === 'string') return { code: body.code, message: body.message ?? '' };
    }
    return null;
  }
  if (app === 'feishu') return feishuBusinessError(result, app);
  if (app === 'dingtalk') return dingtalkBusinessError(result, app);
  if (app !== 'tencent-docs') return null;
  // Actual Tencent tools explicitly declare a top-level error string in their output schema.
  if (typeof result?.structuredContent?.error === 'string' && result.structuredContent.error.trim()) {
    return { code: 'tencent_api_error', message: result.structuredContent.error };
  }
  for (const block of Array.isArray(result?.content) ? result.content : []) {
    if (block.type !== 'text') continue;
    try {
      const body = JSON.parse(block.text);
      // Vendor-documented auth/VIP errors, rather than arbitrary business fields called code.
      if ([400006, 400007].includes(body?.code)) return { code: body.code, message: body.message ?? body.msg ?? '' };
      if (typeof body?.error === 'string' && body.error.trim()) return { code: 'tencent_api_error', message: body.error };
    } catch { /* Normal document text is not an error envelope. */ }
  }
  return null;
}
