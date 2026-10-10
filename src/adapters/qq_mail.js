import crypto from 'node:crypto';
export const QQ_MAIL_TOOLS = [
  { name: 'list_mailboxes', action: 'read' }, { name: 'search_messages', action: 'read' },
  { name: 'get_message', action: 'read' }, { name: 'create_draft', action: 'write' },
  { name: 'set_message_read', action: 'write' }, { name: 'move_message', action: 'write' },
  { name: 'send_to_self', action: 'write' },
];
const string = { type: 'string', minLength: 1 };
const identity = { mailbox: string, uid: { type: 'integer', minimum: 1 }, uid_validity: { type: 'string', pattern: '^[0-9]+$' } };
const definitions = {
  list_mailboxes: [{}, [], '列出邮箱文件夹，不读取邮件正文'],
  search_messages: [{ mailbox: string, subject: string, from: string, text: string, limit: { type: 'integer', minimum: 1, maximum: 100 } }, ['mailbox'], '检索邮件，返回最新匹配的邮件摘要和完整定位，不改变已读状态'],
  get_message: [identity, Object.keys(identity), '读取邮件正文及附件描述，不改变已读状态'],
  create_draft: [{ subject: { type: 'string' }, body: { type: 'string' }, to: string }, ['subject', 'body'], '创建纯文本草稿，不发送邮件；草稿目录通过服务器标记发现'],
  set_message_read: [{ ...identity, read: { type: 'boolean' } }, [...Object.keys(identity), 'read'], '设置指定邮件已读或未读'],
  move_message: [{ ...identity, destination: string }, [...Object.keys(identity), 'destination'], '移动指定邮件到已有文件夹，不永久删除邮件'],
  send_to_self: [{ subject: { type: 'string' }, body: { type: 'string' } }, ['subject', 'body'], '发送测试邮件到已绑定的邮箱自己，没有其他收件人、抄送或密送'],
};
export const QQ_MAIL_DEFINITIONS = QQ_MAIL_TOOLS.map(({ name, action }) => ({ name, description: definitions[name][2],
  inputSchema: { type: 'object', properties: definitions[name][0], required: definitions[name][1], additionalProperties: false },
  annotations: { readOnlyHint: action === 'read', destructiveHint: action === 'write' && name !== 'create_draft' } }));
function validate(name, args) {
  const definition = QQ_MAIL_DEFINITIONS.find(tool => tool.name === name);
  if (!definition || !args || typeof args !== 'object' || Array.isArray(args)) throw new Error('invalid_arguments');
  const schema = definition.inputSchema;
  if (schema.required.some(key => args[key] === undefined) || Object.keys(args).some(key => !schema.properties[key])) throw new Error('invalid_arguments');
  for (const [key, value] of Object.entries(args)) {
    const rule = schema.properties[key];
    if (rule.type === 'integer' ? !Number.isSafeInteger(value) : typeof value !== rule.type) throw new Error('invalid_arguments');
    if (rule.minLength && value.length < rule.minLength || rule.minimum && value < rule.minimum || rule.maximum && value > rule.maximum || rule.pattern && !new RegExp(rule.pattern).test(value)) throw new Error('invalid_arguments');
  }
}
function address(value) {
  if (!/^[^\s<>@\r\n]+@[^\s<>@\r\n]+\.[^\s<>@\r\n]+$/u.test(value)) throw new Error('invalid_email');
  return value;
}
const envelope = message => ({ uid: message.uid, subject: message.envelope?.subject ?? '', from: message.envelope?.from ?? [],
  to: message.envelope?.to ?? [], date: message.internalDate?.toISOString() ?? null, flags: [...(message.flags ?? [])], size: message.size });
export class QQMailAdapter {
  constructor({ connect, parse, email, send }) { Object.assign(this, { connect, parse, email: address(email), send }); }
  async call(name, args = {}) {
    validate(name, args);
    if (name === 'send_to_self') {
      if (!this.send) throw new Error('smtp_not_available');
      const sent = await this.send({ from: this.email, to: this.email, subject: args.subject, text: args.body });
      if (!sent.accepted?.some(value => value.toLowerCase() === this.email.toLowerCase()) || sent.rejected?.length) throw new Error('smtp_acceptance_not_confirmed');
      return { sent: true, recipient: this.email, message_id: sent.messageId, at_utc: new Date().toISOString() };
    }
    const client = await this.connect();
    let lock;
    try {
      if (name === 'list_mailboxes') return { mailboxes: (await client.list()).map(box => ({ path: box.path, name: box.name, special_use: box.specialUse ?? null })) };
      if (name === 'create_draft') {
        if (args.to !== undefined) address(args.to);
        const boxes = await client.list();
        const draft = boxes.find(box => box.specialUse === '\\Drafts');
        if (!draft) throw new Error('draft_folder_not_advertised');
        const messageId = '<' + crypto.randomUUID() + '@flowtrace.local>';
        const mime = ['From: ' + this.email, ...(args.to ? ['To: ' + args.to] : []), 'Subject: =?UTF-8?B?' + Buffer.from(args.subject).toString('base64') + '?=',
          'Date: ' + new Date().toUTCString(), 'Message-ID: ' + messageId, 'MIME-Version: 1.0', 'Content-Type: text/plain; charset=UTF-8',
          'Content-Transfer-Encoding: base64', '', Buffer.from(args.body).toString('base64').match(/.{1,76}/g)?.join('\r\n') ?? '', ''].join('\r\n');
        const result = await client.append(draft.path, Buffer.from(mime), ['\\Draft']);
        if (!result) throw new Error('append_not_confirmed');
        return { mailbox: draft.path, uid: result.uid || null, uid_validity: result.uidValidity?.toString() ?? null, message_id: messageId, sent: false };
      }
      lock = await client.getMailboxLock(args.mailbox, { readOnly: QQ_MAIL_TOOLS.find(tool => tool.name === name).action === 'read' });
      const validity = client.mailbox.uidValidity.toString();
      if (args.uid_validity !== undefined && args.uid_validity !== validity) throw new Error('uid_validity_changed');
      if (name === 'search_messages') {
        const query = Object.fromEntries(['subject', 'from', 'text'].filter(key => args[key]).map(key => [key, args[key]]));
        const uids = await client.search(Object.keys(query).length ? query : { all: true }, { uid: true });
        const selected = (uids || []).slice(-500).reverse();
        const messages = [];
        let scanned = 0;
        // No mutating operation inside a streaming FETCH iterator.
        for (const uid of selected) {
          const message = await client.fetchOne(uid, { envelope: true, flags: true, internalDate: true, size: true }, { uid: true });
          scanned++;
          if (!message) continue;
          // QQ's server may return approximate SEARCH matches. Verify header
          // predicates locally before exposing any result, never fetch bodies.
          const sender = (message.envelope?.from ?? []).map(person => `${person.name ?? ''} <${person.address ?? ''}>`).join(' ').toLowerCase();
          if (args.from && !sender.includes(args.from.toLowerCase())) continue;
          if (args.subject && !(message.envelope?.subject ?? '').toLowerCase().includes(args.subject.toLowerCase())) continue;
          messages.push({ ...envelope(message), mailbox: args.mailbox, uid_validity: validity });
          if (messages.length >= (args.limit ?? 20)) break;
        }
        return { messages, total_matches: Object.keys(query).length ? null : (uids || []).length,
          server_candidate_count: (uids || []).length, scanned_candidates: scanned, candidate_scan_complete: scanned === (uids || []).length };
      }
      const message = await client.fetchOne(args.uid, { envelope: true, flags: true, internalDate: true, size: true }, { uid: true });
      if (!message) throw new Error('message_not_found');
      if (name === 'get_message') {
        if (message.size > 25 * 1024 * 1024) throw new Error('message_over_25mb');
        const full = await client.fetchOne(args.uid, { source: true }, { uid: true });
        if (!full?.source) throw new Error('message_not_found');
        const parsed = await this.parse(full.source);
        return { ...envelope(message), mailbox: args.mailbox, uid_validity: validity, message_id: parsed.messageId ?? null,
          text: parsed.text ?? '', html: parsed.html || '', attachments: (parsed.attachments ?? []).map(file => ({ name: file.filename, content_type: file.contentType, size: file.size })) };
      }
      if (name === 'set_message_read') {
        const changed = args.read ? await client.messageFlagsAdd(args.uid, ['\\Seen'], { uid: true }) : await client.messageFlagsRemove(args.uid, ['\\Seen'], { uid: true });
        if (!changed) throw new Error('flag_change_not_confirmed');
        return { mailbox: args.mailbox, uid: args.uid, uid_validity: validity, read: args.read };
      }
      if (args.destination === args.mailbox || !(await client.list()).some(box => box.path === args.destination)) throw new Error('invalid_destination');
      // Do not let a COPY+EXPUNGE fallback purge other pre-existing deleted mail.
      if (!client.capabilities.has('MOVE') && !client.capabilities.has('UIDPLUS')) throw new Error('safe_move_not_supported');
      const moved = await client.messageMove(args.uid, args.destination, { uid: true });
      if (!moved) throw new Error('move_not_confirmed');
      // COPYUID responses can advertise stale UIDVALIDITY (observed on QQ).
      // Release the source lock before selecting the destination, and only
      // expose the mapped UID when its advertised generation is confirmed.
      lock.release(); lock = null;
      lock = await client.getMailboxLock(args.destination, { readOnly: true });
      const destinationValidity = client.mailbox.uidValidity.toString();
      const generationConfirmed = moved.uidValidity?.toString() === destinationValidity;
      return { source: { mailbox: args.mailbox, uid: args.uid, uid_validity: validity }, destination: { mailbox: args.destination,
        uid: generationConfirmed ? moved.uidMap?.get(args.uid) ?? null : null, uid_validity: destinationValidity },
        destination_uid_verified: generationConfirmed,
        ...(!generationConfirmed ? { next_step: 'Search the destination by the unique test subject before using a UID.' } : {}) };
    } finally { lock?.release(); await client.logout().catch(() => { client.close(); }); }
  }
}
