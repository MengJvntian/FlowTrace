import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import nodemailer from 'nodemailer';
import { Server } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { QQMailAdapter, QQ_MAIL_DEFINITIONS } from '../../src/adapters/qq_mail.js';
const email = process.env.QQ_MAIL_EMAIL, secret = process.env.QQ_MAIL_AUTH_CODE;
if (!email || !secret || /[\r\n]/u.test(secret)) { process.stderr.write('Saved QQ Mail account configuration missing.\n'); process.exit(3); }
const adapter = new QQMailAdapter({ email, parse: source => simpleParser(source), send: async message => {
  const smtp = nodemailer.createTransport({ host: 'smtp.qq.com', port: 465, secure: true, auth: { user: email, pass: secret },
    logger: false, debug: false, connectionTimeout: 15000, greetingTimeout: 15000, socketTimeout: 60000,
    disableFileAccess: true, disableUrlAccess: true });
  try { return await smtp.sendMail({ ...message, envelope: { from: email, to: [email] } }); }
  finally { smtp.close(); }
}, connect: async () => {
  const client = new ImapFlow({ host: 'imap.qq.com', port: 993, secure: true, auth: { user: email, pass: secret }, logger: false,
    emitLogs: false, disableAutoIdle: true, connectionTimeout: 15000, greetingTimeout: 15000, socketTimeout: 60000,
    clientInfo: { name: 'FlowTrace', version: '0.1.0' } });
  client.on('error', () => {});
  try { await client.connect(); return client; } catch { client.close(); throw new Error('qq_mail_connection_failed'); }
} });
const server = new Server({ name: 'flowtrace-qq-mail', version: '0.1.0' }, { capabilities: { tools: {} } });
server.setRequestHandler('tools/list', async () => ({ tools: QQ_MAIL_DEFINITIONS }));
server.setRequestHandler('tools/call', async request => {
  try { const result = await adapter.call(request.params.name, request.params.arguments); return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result }; }
  catch (error) {
    const allowed = ['invalid_arguments', 'invalid_email', 'draft_folder_not_advertised', 'uid_validity_changed', 'message_not_found', 'message_over_25mb', 'invalid_destination', 'safe_move_not_supported'];
    const kind = allowed.includes(error.message) ? error.message : 'qq_mail_operation_failed';
    return { isError: true, content: [{ type: 'text', text: 'QQ 邮箱操作未成功：' + kind + '。写入结果不确定时先核对邮箱，不自动重试；检查网络、IMAP 服务和已保存授权码。' }], structuredContent: { error_kind: kind } };
  }
});
await server.connect(new StdioServerTransport());
