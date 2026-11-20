import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';
import { fail } from './accounts.mjs';

const uuid = z.string().uuid();
const hash = (value) => createHash('sha256').update(value).digest('hex');
const lease = 16 * 60000;
const envelope = z
  .object({
    taskId: uuid,
    sessionId: z.string().min(1).max(200),
    requestId: uuid,
    command: z.record(z.string(), z.unknown()),
  })
  .strict();
export function dshAppEndpoint(value) {
  if (!value) return '';
  const url = new URL(value);
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== '/api/agent/dsh/app-access' ||
    (url.protocol !== 'https:' &&
      !(url.protocol === 'http:' && ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname)))
  )
    throw Error('DSH_APP_TOOLS_URL须为HTTPS软件工具入口；HTTP仅限本机验收。');
  return url.href;
}

// Capabilities stay in memory. The durable journal contains scope/provenance,
// never bearer credentials. Restart cannot re-grant an external native session.
export function createDshAppTools(
  db,
  { body, endpoint = '', engine, sessionActive, targetActive, now = Date.now, fileBridge },
) {
  endpoint = dshAppEndpoint(endpoint);
  const grants = new Map();
  let closed = false;
  db.exec(`CREATE TABLE IF NOT EXISTS dsh_app_tasks(
    owner TEXT NOT NULL,id TEXT NOT NULL,conversation_id TEXT NOT NULL,connection_id TEXT NOT NULL,
    session_id TEXT NOT NULL,session_hash TEXT NOT NULL,request_id TEXT NOT NULL,input TEXT NOT NULL,
    state TEXT NOT NULL,turn INTEGER,expires INTEGER NOT NULL,created INTEGER NOT NULL,
    PRIMARY KEY(owner,id));
    CREATE INDEX IF NOT EXISTS dsh_app_conversation ON dsh_app_tasks(owner,conversation_id,state);
    UPDATE dsh_app_tasks SET state='revoked' WHERE state IN ('binding','ready','running');`);
  const row = (owner, id) =>
    db.prepare('SELECT * FROM dsh_app_tasks WHERE owner=? AND id=?').get(owner, id);
  function active(r) {
    return (
      !closed &&
      !!r &&
      ['ready', 'running'].includes(r.state) &&
      r.expires > now() &&
      sessionActive(r.owner, r.session_hash) &&
      targetActive(r.owner, r.conversation_id, r.connection_id, r.session_id)
    );
  }
  function revokeTask(owner, id, state = 'revoked') {
    const r = row(owner, id);
    if (!r) return;
    for (const [key, grant] of grants)
      if (grant.owner === owner && grant.id === id) {
        grant.controller.abort();
        grants.delete(key);
      }
    db.prepare(
      "UPDATE dsh_app_tasks SET state=? WHERE owner=? AND id=? AND state IN ('binding','ready','running')",
    ).run(state, owner, id);
    engine()?.revoke(owner, id);
  }
  function revoke(owner, conversationId) {
    for (const r of db
      .prepare(
        "SELECT id FROM dsh_app_tasks WHERE owner=? AND (? IS NULL OR conversation_id=?) AND state IN ('binding','ready','running')",
      )
      .all(owner, conversationId || null, conversationId || null))
      revokeTask(owner, r.id);
  }
  function context(r) {
    return { owner: r.owner, task: r.id, conversation: r.conversation_id, origin: 'dsh' };
  }
  return {
    enabled: !!endpoint,
    active(ctx) {
      const r = row(ctx.owner, ctx.task);
      return !!r && r.conversation_id === ctx.conversation && active(r);
    },
    task: (ctx) => row(ctx.owner, ctx.task),
    tasks(owner, conversationId) {
      const rows = db
        .prepare(
          "SELECT * FROM dsh_app_tasks WHERE owner=? AND conversation_id=? AND state IN ('binding','ready','running')",
        )
        .all(owner, conversationId);
      return rows.flatMap((r) => {
        if (r.state !== 'binding' && !active(r)) {
          revokeTask(owner, r.id);
          return [];
        }
        return [{ id: r.id, state: r.state, expiresAt: r.expires, fileBridge: [...grants.values()].some(g => g.owner === owner && g.id === r.id && g.fileBridge) }];
      });
    },
    pending(owner, conversationId) {
      return this.tasks(owner, conversationId).flatMap((t) => engine()?.pending(owner, t.id) || []);
    },
    async prepare(actor, conversation, request, chat) {
      if (!endpoint || !engine()) throw fail(503, '服务器尚未配置DSH软件工具入口。');
      if (!actor.sessionHash || !sessionActive(actor.id, actor.sessionHash))
        throw fail(403, '当前登录授权已失效。');
      for (const grant of grants.values()) {
        const r = row(grant.owner, grant.id);
        if (!r || r.expires <= now()) revokeTask(grant.owner, grant.id);
      }
      if (
        grants.size >= 256 ||
        [...grants.values()].filter((g) => g.owner === actor.id).length >= 64
      )
        throw fail(429, '正在使用的软件工具任务较多，请先结束部分任务。');
      db.prepare("DELETE FROM dsh_app_tasks WHERE created<? AND state IN ('revoked','ended')").run(
        now() - 90 * 86400000,
      );
      if (row(actor.id, request.id)) throw fail(409, '原工具授权不会重建，请核对原消息。');
      const token = randomBytes(32).toString('hex'),
        nonce = randomBytes(24).toString('hex'),
        digest = hash(token),
        expires = now() + lease;
      db.prepare('INSERT INTO dsh_app_tasks(owner,id,conversation_id,connection_id,session_id,session_hash,request_id,input,state,turn,expires,created) VALUES(?,?,?,?,?,?,?,?,?,NULL,?,?)').run(
        actor.id,
        request.id,
        conversation.id,
        conversation.connection_id,
        conversation.session_id,
        actor.sessionHash,
        request.id,
        request.text,
        'binding',
        expires,
        now(),
      );
      grants.set(digest, { owner: actor.id, id: request.id, nonce, claimed: false, controller: new AbortController() });
      try {
        const result = await chat.bindAppTools(conversation.session_id, {
          version: 1,
          taskId: request.id,
          requestId: request.id,
          token,
          nonce,
          endpoint,
          expiresAt: expires,
        });
        const grant = grants.get(digest),
          current = row(actor.id, request.id);
        if (request.attachments?.length && result?.fileBridgeVersion !== 1)
          throw fail(409, '主机尚未配置新版附件插件或授权工作区。');
        if (
          !grant?.claimed ||
          result?.version !== 1 ||
          result.taskId !== request.id ||
          result.sessionId !== conversation.session_id ||
          result.nonce !== nonce ||
          current.state !== 'binding' ||
          !sessionActive(actor.id, actor.sessionHash) ||
          !targetActive(
            actor.id,
            conversation.id,
            conversation.connection_id,
            conversation.session_id,
          )
        )
          throw fail(409, 'DSH软件工具绑定未核验，消息尚未发送。');
        grant.fileBridge = result.fileBridgeVersion === 1;
        db.prepare("UPDATE dsh_app_tasks SET state='ready' WHERE owner=? AND id=?").run(
          actor.id,
          request.id,
        );
      } catch (error) {
        revokeTask(actor.id, request.id);
        throw Object.assign(
          fail(
            409,
            error.message.includes('附件插件') ? error.message : 'DSH软件工具未就绪，消息尚未发送。请检查主机插件与入口配置，或关闭此对话的软件工具后发送。',
          ),
          { localRejected: true },
        );
      }
    },
    observe(owner, conversationId, state) {
      for (const r of db
        .prepare(
          "SELECT * FROM dsh_app_tasks WHERE owner=? AND conversation_id=? AND state IN ('ready','running')",
        )
        .all(owner, conversationId)) {
        const human = state.events.find(
          (e) => e.type === 'user/message' && e.data.source?.rpcId === r.request_id,
        );
        // Native Harness human messages need not repeat the turn number.
        const turn =
          human?.data.turn ??
          (human &&
            state.events.findLast((e) => e.type === 'turn/start' && e.seq < human.seq)?.data
              .turn) ??
          r.turn;
        if (Number.isSafeInteger(turn))
          db.prepare("UPDATE dsh_app_tasks SET turn=?,state='running' WHERE owner=? AND id=?").run(
            turn,
            owner,
            r.id,
          );
        const unrelated =
          human &&
          state.events.some(
            (e) =>
              e.type === 'user/message' &&
              e.seq > human.seq &&
              !db
                .prepare(
                  'SELECT 1 FROM dsh_app_tasks WHERE owner=? AND conversation_id=? AND request_id=?',
                )
                .get(owner, conversationId, e.data.source?.rpcId || ''),
          );
        if (state.connection !== 'connected' || unrelated) revokeTask(owner, r.id);
        else if (
          turn != null &&
          state.events.some((e) => e.type === 'turn/end' && e.data.turn === turn)
        )
          revokeTask(owner, r.id, 'ended');
      }
    },
    revoke,
    revokeTask,
    async before(req, url, json, res) {
      const binary = /^\/api\/agent\/dsh\/app-access\/files\/[^/]+$/.test(url.pathname);
      if (url.pathname !== '/api/agent/dsh/app-access' && !binary) return false;
      if (!binary && req.method !== 'POST') throw fail(405, '软件工具仅接受POST。');
      const grant = grants.get(
        hash(String(req.headers.authorization || '').replace(/^Bearer /, '')),
      );
      const r = grant && row(grant.owner, grant.id);
      if (
        !r ||
        r.expires <= now() ||
        !sessionActive(r.owner, r.session_hash) ||
        !targetActive(r.owner, r.conversation_id, r.connection_id, r.session_id)
      )
        throw fail(403, 'DSH软件工具授权已失效。');
      const p = envelope.parse(binary ? {
        taskId: req.headers['x-astral-task-id'], sessionId: req.headers['x-astral-session-id'],
        requestId: req.headers['x-astral-request-id'], command: {},
      } : await body(req));
      if (grant.controller.signal.aborted || r.expires <= now() || !sessionActive(r.owner, r.session_hash) ||
          !targetActive(r.owner, r.conversation_id, r.connection_id, r.session_id))
        throw fail(403, 'DSH软件工具授权已撤销。');
      if (p.taskId !== r.id || p.requestId !== r.request_id || p.sessionId !== r.session_id)
        throw fail(403, 'DSH软件工具的任务或会话不符。');
      if (!binary && p.command.action === 'bind') {
        const claim = z
          .object({ action: z.literal('bind'), nonce: z.string().regex(/^[a-f0-9]{48}$/) })
          .strict()
          .parse(p.command);
        if (grant.claimed || r.state !== 'binding' || claim.nonce !== grant.nonce)
          throw fail(409, '绑定凭据已使用或不符。');
        grant.claimed = true;
        json(200, { version: 1, taskId: r.id, sessionId: r.session_id, nonce: grant.nonce });
      } else {
        if (!grant.claimed || !active(row(r.owner, r.id))) throw fail(403, 'DSH软件工具任务已结束。');
        if (binary && !grant.fileBridge) throw fail(409, '当前主机未核验附件桥接能力。');
        // Only a live task can renew its idle lease; this does not revive a
        // cancelled task, logged-out session or disconnected connection.
        db.prepare('UPDATE dsh_app_tasks SET expires=? WHERE owner=? AND id=?').run(
          now() + lease,
          r.owner,
          r.id,
        );
        const ctx = { ...context(r), signal: grant.controller.signal };
        if (binary) await fileBridge().transfer(req, url, json, ctx, res);
        else json(200, await engine().execute(ctx, p.command));
      }
      return true;
    },
    close() {
      for (const g of grants.values()) revokeTask(g.owner, g.id);
      closed = true;
      grants.clear();
    },
  };
}
