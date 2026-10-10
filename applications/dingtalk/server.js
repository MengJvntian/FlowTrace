import { PlatformDingTalkServer } from './server-class.js';
import { DINGTALK_PROFILES } from '../../src/adapters/dingtalk.js';
for (const name of ['DINGTALK_Client_ID', 'DINGTALK_Client_Secret']) {
  if (!process.env[name]?.trim() || /[\r\n]/u.test(process.env[name])) throw new Error('DingTalk application credentials missing or invalid');
}
process.env.ACTIVE_PROFILES = DINGTALK_PROFILES;
delete process.env.DINGTALK_ACCESS_TOKEN;
delete process.env.STAGING;
delete process.env.DEBUG;
// The official release logs token-bearing URL/headers unconditionally. Gateway retains business payloads.
console.error = () => {};
try { await new PlatformDingTalkServer().run(); }
catch { process.stderr.write('DingTalk MCP startup failed; check local application settings.\n'); process.exitCode = 1; }
