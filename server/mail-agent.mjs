import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';
import { fail } from './accounts.mjs';
import { mailOperationSchema } from '../shared/mail-actions.mjs';
import { mailHistoryFields } from '../shared/mail-history.mjs';

const mailbox = z.string().trim().min(1).max(200);
// The tool schema exposes mailbox for list/read as well as prepare. Models can
// put the source beside operation; accept that explicit alias, never guess a
// folder or silently prefer one of two conflicting sources.
function normalizeCommand(input) {
  if (
    input?.action !== 'prepare' ||
    input.mailbox === undefined ||
    !input.operation ||
    typeof input.operation !== 'object' ||
    Array.isArray(input.operation)
  )
    return input;
  const source = mailbox.parse(input.mailbox);
  const { mailbox: outer, ...rest } = input;
  if (input.operation.action === 'create-folder') return rest;
  if (input.operation.mailbox !== undefined && mailbox.parse(input.operation.mailbox) !== source)
    throw fail(400, '来源文件夹不一致，请只指定一个明确的来源。');
  return { ...rest, operation: { ...input.operation, mailbox: source } };
}
const command = z.preprocess(
  normalizeCommand,
  z.discriminatedUnion('action', [
    z.object({ action: z.literal('folders') }).strict(),
    z
      .object({
        action: z.literal('list'),
        ...mailHistoryFields,
      })
      .strict(),
    z
      .object({
        action: z.literal('read'),
        mailbox,
        uid: z.number().int().positive().max(0xffffffff),
      })
      .strict(),
    z
      .object({
        action: z.literal('prepare'),
        operation: mailOperationSchema,
        callId: z.string().min(1).max(128),
      })
      .strict(),
    z.object({ action: z.literal('status'), id: z.string().uuid() }).strict(),
  ]),
);
const digest = (v) => createHash('sha256').update(v).digest('hex');
const proposalId = (owner, task, call) => {
  const h = digest(`${owner}:${task}:${call}`);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
};

// Read/unread flags execute without a second prompt. Other mutations still need
// the authenticated UI response; no sending or permanent deletion capability.
export function createMailAgent(
  db,
  { mail, body, now = Date.now, internalUrl = 'http://app:8787/api/pi/mail-access' },
) {
  db.exec(`CREATE TABLE IF NOT EXISTS mail_agent_proposals(
    owner TEXT NOT NULL,task TEXT NOT NULL,id TEXT NOT NULL,space TEXT NOT NULL,signature TEXT NOT NULL,
    PRIMARY KEY(owner,task,id));`);
  const scopes = new Map();
  let closed = false;
  const spaceFor = (owner) => db.prepare('SELECT space FROM users WHERE id=?').get(owner)?.space;
  const currentAccount = (scope) => {
    try {
      return (
        spaceFor(scope.owner) === scope.space && mail.accessRevision(scope.space) === scope.revision
      );
    } catch {
      return false;
    }
  };
  const running = (owner, task) => {
    const r = db.prepare('SELECT state FROM pi_tasks WHERE owner=? AND id=?').get(owner, task);
    return !!r && JSON.parse(r.state).status === 'running';
  };
  function binding(owner, task, id) {
    const r = db
      .prepare('SELECT * FROM mail_agent_proposals WHERE owner=? AND task=? AND id=?')
      .get(owner, task, id);
    if (!r || r.space !== spaceFor(owner)) throw fail(404, '此任务没有对应邮件操作。');
    return r;
  }
  const resolved = (scope, id) => scope.event({ type: 'extension_ui_resolved', id: 'mail:' + id });
  function revoke(owner, task) {
    for (const [key, scope] of scopes)
      if (scope.owner === owner && scope.task === task) {
        scopes.delete(key);
        for (const id of scope.pending) {
          try {
            mail.actions.deny(scope.space, id);
          } catch {}
          if (!closed) resolved(scope, id);
        }
      }
  }
  async function execute(scope, input) {
    const p = command.parse(input);
    if (p.action === 'folders') return { mailboxes: await mail.mailboxes(scope.space) };
    if (p.action === 'list') {
      const { action, ...query } = p;
      return mail.listMessages(scope.space, query);
    }
    if (p.action === 'read') {
      const message = await mail.readMessage(scope.space, { mailbox: p.mailbox }, p.uid);
      return { ...message, text: message.text.slice(0, 20000), untrusted: true };
    }
    if (p.action === 'status') {
      binding(scope.owner, scope.task, p.id);
      const result = mail.actions.inspect(scope.space, p.id);
      if (!['prepared', 'running'].includes(result.state)) scope.pending.delete(p.id);
      return result;
    }
    const id = proposalId(scope.owner, scope.task, p.callId),
      signature = digest(JSON.stringify(p.operation));
    const existing = db
      .prepare('SELECT signature FROM mail_agent_proposals WHERE owner=? AND task=? AND id=?')
      .get(scope.owner, scope.task, id);
    if (existing) {
      if (existing.signature !== signature) throw fail(409, '工具调用编号已绑定其他邮件操作。');
      return mail.actions.inspect(scope.space, id);
    }
    const preview = await mail.actions.prepare(scope.space, p.operation, { id });
    // A task cancelled while IMAP was responding must never publish a fresh approval.
    if (!scopes.has(scope.key) || !running(scope.owner, scope.task) || !currentAccount(scope)) {
      mail.actions.deny(scope.space, id);
      throw fail(409, '任务已结束，邮件操作未提交审核。');
    }
    db.prepare('INSERT INTO mail_agent_proposals VALUES(?,?,?,?,?)').run(
      scope.owner,
      scope.task,
      id,
      scope.space,
      signature,
    );
    if (['read', 'unread'].includes(p.operation.action))
      return mail.actions.confirm(scope.space, id, {
        isActive: () =>
          scopes.has(scope.key) && running(scope.owner, scope.task) && currentAccount(scope),
      });
    scope.pending.add(id);
    const lines = [
      `来源：${preview.mailbox || '无'}${preview.destination ? ` → ${preview.destination}` : ''}`,
      ...(preview.groups
        ? preview.groups.flatMap((g) => [
            `分组：${g.destination}（${g.create ? '新建文件夹' : '已有文件夹'}），${g.uids.length}封`,
            ...preview.messages
              .filter((m) => g.uids.includes(m.uid))
              .map((m) => `  UID ${m.uid} · ${m.subject} · ${m.from}`),
          ])
        : []),
      `精确选中 ${preview.messages.length} 封邮件：`,
      ...(preview.groups
        ? []
        : preview.messages.map((m) => `UID ${m.uid} · ${m.subject} · ${m.from}`)),
      `仅执行本次预览，有效至 ${new Date(preview.expiresAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}（北京时间）。不会永久删除邮件；执行中断时先核对邮箱。`,
    ];
    scope.event({
      type: 'extension_ui_request',
      id: 'mail:' + id,
      method: 'confirm',
      title: '确认邮件操作：' + preview.title,
      message: lines.join('\n'),
    });
    return preview;
  }
  return {
    scope(owner, p, event) {
      const space = spaceFor(owner);
      if (closed || !space || !mail.account(space)) return null;
      for (const [key, scope] of scopes)
        if (scope.expires <= now()) revoke(scope.owner, scope.task);
      const token = randomBytes(32).toString('hex'),
        key = digest(token);
      scopes.set(key, {
        owner,
        space,
        revision: mail.accessRevision(space),
        task: p.id,
        key,
        event,
        pending: new Set(),
        count: 0,
        window: now(),
        expires: now() + 16 * 60000,
      });
      return { url: internalUrl, token, revoke: () => revoke(owner, p.id) };
    },
    revoke,
    async respond(owner, task, response) {
      if (!response.id.startsWith('mail:')) return false;
      const id = z.string().uuid().parse(response.id.slice(5));
      const r = binding(owner, task.id, id);
      if (!running(owner, task.id)) throw fail(409, '任务已结束，邮件操作不会执行。');
      try {
        if (response.confirmed === true)
          await mail.actions.confirm(r.space, id, { isActive: () => running(owner, task.id) });
        else mail.actions.deny(r.space, id);
      } catch (error) {
        if (!['prepared', 'running'].includes(mail.actions.inspect(r.space, id).state))
          error.status = 409;
        throw error;
      } finally {
        if (!['prepared', 'running'].includes(mail.actions.inspect(r.space, id).state))
          for (const scope of scopes.values())
            if (scope.owner === owner && scope.task === task.id) {
              scope.pending.delete(id);
              resolved(scope, id);
            }
      }
      return true;
    },
    async before(req, url, json) {
      if (url.pathname !== '/api/pi/mail-access') return false;
      if (req.method !== 'POST') throw fail(405, '邮件工具仅接受 POST。');
      const scope = scopes.get(
        digest(String(req.headers.authorization || '').replace(/^Bearer /, '')),
      );
      if (
        !scope ||
        scope.expires <= now() ||
        !currentAccount(scope) ||
        !running(scope.owner, scope.task)
      )
        throw fail(403, '邮件工具的任务授权已失效。');
      if (now() - scope.window >= 60000) {
        scope.window = now();
        scope.count = 0;
      }
      if (++scope.count > 100) throw fail(429, '邮件工具调用较多，请稍候。');
      const result = await execute(scope, await body(req));
      if (!scopes.has(scope.key) || !currentAccount(scope) || !running(scope.owner, scope.task))
        throw fail(403, '邮件工具的任务授权已失效。');
      json(200, result);
      return true;
    },
    close() {
      closed = true;
      for (const scope of scopes.values()) revoke(scope.owner, scope.task);
      scopes.clear();
    },
  };
}
