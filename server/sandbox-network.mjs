import { z } from 'zod';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { fail } from './accounts.mjs';
const uuid = z.string().uuid();
const minutes = z.union([z.literal(5), z.literal(15), z.literal(60)]).default(15);
const choice = z
  .object({ enabled: z.boolean(), minutes, acknowledged: z.boolean().default(false) })
  .strict();

export function createSandboxNetwork(
  db,
  { now = Date.now, notifications, internalUrl = 'http://app:8787/api/pi/sandbox-access' } = {},
) {
  db.exec(`CREATE TABLE IF NOT EXISTS sandbox_network(owner TEXT NOT NULL,conversation_id TEXT NOT NULL,enabled INTEGER NOT NULL,version INTEGER NOT NULL,expires_at INTEGER,approved_by TEXT,updated_at TEXT NOT NULL,PRIMARY KEY(owner,conversation_id));
    CREATE TABLE IF NOT EXISTS sandbox_network_requests(id TEXT PRIMARY KEY,owner TEXT NOT NULL,conversation_id TEXT NOT NULL,minutes INTEGER NOT NULL,state TEXT NOT NULL,created_at TEXT NOT NULL,expires_at INTEGER NOT NULL,reviewed_by TEXT);
    CREATE INDEX IF NOT EXISTS sandbox_network_pending ON sandbox_network_requests(state,owner,conversation_id);`);
  const scopes = new Map(),
    rates = new Map();
  const hash = (token) => createHash('sha256').update(token).digest('hex');
  const expire = () =>
    db
      .prepare(
        "UPDATE sandbox_network_requests SET state='expired' WHERE state='pending' AND expires_at<=?",
      )
      .run(now());
  const status = (owner, conversation) => {
    const row = db
      .prepare('SELECT * FROM sandbox_network WHERE owner=? AND conversation_id=?')
      .get(owner, conversation);
    const request = db
      .prepare(
        "SELECT id,minutes,expires_at AS expiresAt FROM sandbox_network_requests WHERE owner=? AND conversation_id=? AND state='pending' AND expires_at>? ORDER BY created_at DESC LIMIT 1",
      )
      .get(owner, conversation, now());
    return {
      enabled: !!row?.enabled && row.expires_at > now(),
      version: row?.version || 0,
      expiresAt: row?.expires_at || null,
      ...(request ? { request } : {}),
      network: 'Pi 容器可达网络',
      scope: '当前对话',
    };
  };
  function set(owner, conversation, enabled, duration, approver) {
    const previous = status(owner, conversation),
      expiresAt = enabled ? now() + duration * 60000 : null;
    db.prepare(
      'INSERT INTO sandbox_network VALUES(?,?,?,?,?,?,?) ON CONFLICT(owner,conversation_id) DO UPDATE SET enabled=excluded.enabled,version=excluded.version,expires_at=excluded.expires_at,approved_by=excluded.approved_by,updated_at=excluded.updated_at',
    ).run(
      owner,
      conversation,
      Number(enabled),
      previous.version + 1,
      expiresAt,
      approver,
      new Date(now()).toISOString(),
    );
    return status(owner, conversation);
  }
  const service = {
    status,
    scope(owner, task) {
      for (const [key, scope] of scopes) if (scope.expiresAt <= now()) scopes.delete(key);
      const token = randomBytes(32).toString('hex'),
        key = hash(token);
      scopes.set(key, {
        owner,
        taskId: task.id,
        conversation: task.conversationId,
        expiresAt: now() + 16 * 60000,
      });
      return { url: internalUrl, token, revoke: () => scopes.delete(key) };
    },
    revokeTask(owner, taskId) {
      for (const [key, scope] of scopes)
        if (scope.owner === owner && scope.taskId === taskId) scopes.delete(key);
    },
    revokeConversation(owner, conversation) {
      set(owner, conversation, false, 0, null);
      db.prepare(
        "UPDATE sandbox_network_requests SET state='cancelled' WHERE owner=? AND conversation_id=? AND state='pending'",
      ).run(owner, conversation);
    },
    async before(req, url, json) {
      if (!url.pathname.startsWith('/api/pi/sandbox-access')) return false;
      const scope = scopes.get(hash((req.headers.authorization || '').replace(/^Bearer /, '')));
      if (
        req.method !== 'GET' ||
        url.pathname !== '/api/pi/sandbox-access/network' ||
        !scope ||
        scope.expiresAt <= now() ||
        !db.prepare('SELECT id FROM users WHERE id=?').get(scope.owner)
      )
        throw fail(403, '沙箱联网查询授权已失效。');
      json(200, status(scope.owner, scope.conversation));
      return true;
    },
    async handle(req, url, json, actor, body) {
      const route = url.pathname.match(/^\/api\/pi\/conversations\/([^/]+)\/network$/),
        review = url.pathname.match(/^\/api\/pi\/network-requests\/([^/]+)$/);
      if (!route && !review && url.pathname !== '/api/pi/network-requests') return false;
      if (!actor?.id) throw fail(401, '请先登录独立账号。');
      expire();
      if (route) {
        const conversation = uuid.parse(route[1]);
        if (req.method === 'GET') {
          json(200, status(actor.id, conversation));
          return true;
        }
        if (req.method === 'PATCH') {
          const p = choice.parse(await body(req));
          if (p.enabled && !p.acknowledged) throw fail(400, '请确认当前对话的联网范围。');
          if (!p.enabled) {
            service.revokeConversation(actor.id, conversation);
            json(200, status(actor.id, conversation));
            return true;
          }
          if (actor.role === 'owner') {
            json(200, set(actor.id, conversation, true, p.minutes, actor.id));
            return true;
          }
          const old = status(actor.id, conversation);
          if (old.request) {
            json(200, old);
            return true;
          }
          const rate = rates.get(actor.id);
          if (rate && rate.until > now() && rate.count >= 6)
            throw fail(429, '联网申请过于频繁，请等待管理员审核。');
          rates.set(actor.id, {
            count: rate && rate.until > now() ? rate.count + 1 : 1,
            until: now() + 60000,
          });
          const id = randomUUID();
          db.prepare('INSERT INTO sandbox_network_requests VALUES(?,?,?,?,?,?,?,NULL)').run(
            id,
            actor.id,
            conversation,
            p.minutes,
            'pending',
            new Date(now()).toISOString(),
            now() + 30 * 60000,
          );
          for (const owner of db.prepare("SELECT id FROM users WHERE role='owner'").all())
            notifications?.publish(
              owner.id,
              {
                kind: 'input',
                title: 'Bash 联网申请',
                body: `@${actor.username} 申请为一个对话开启联网。请在对话的「Bash 联网」面板审核。`,
              },
              'network-request:' + id,
            );
          json(202, status(actor.id, conversation));
          return true;
        }
      }
      if (actor.role !== 'owner') throw fail(403, '仅管理员可审核其他账号的联网申请。');
      if (url.pathname === '/api/pi/network-requests' && req.method === 'GET') {
        const requests = db
          .prepare(
            "SELECT r.id,r.owner,r.conversation_id AS conversationId,r.minutes,r.created_at AS createdAt,r.expires_at AS expiresAt,u.username FROM sandbox_network_requests r JOIN users u ON u.id=r.owner WHERE r.state='pending' ORDER BY r.created_at LIMIT 100",
          )
          .all();
        json(200, { requests });
        return true;
      }
      if (review && req.method === 'POST') {
        const id = uuid.parse(review[1]),
          p = z
            .object({ approved: z.boolean(), acknowledged: z.boolean().default(false) })
            .strict()
            .parse(await body(req));
        const request = db.prepare('SELECT * FROM sandbox_network_requests WHERE id=?').get(id);
        if (!request || request.state !== 'pending') throw fail(409, '此联网申请已结束，请刷新。');
        if (p.approved && !p.acknowledged) throw fail(400, '请确认将授予的实际联网范围。');
        db.exec('SAVEPOINT sandbox_network_review');
        try {
          if (p.approved)
            set(request.owner, request.conversation_id, true, request.minutes, actor.id);
          db.prepare('UPDATE sandbox_network_requests SET state=?,reviewed_by=? WHERE id=?').run(
            p.approved ? 'approved' : 'denied',
            actor.id,
            id,
          );
          db.exec('RELEASE sandbox_network_review');
        } catch (e) {
          db.exec('ROLLBACK TO sandbox_network_review; RELEASE sandbox_network_review');
          throw e;
        }
        notifications?.publish(
          request.owner,
          {
            kind: 'plugin',
            title: 'Bash 联网申请已处理',
            body: p.approved
              ? `此对话已获准联网 ${request.minutes} 分钟；下一条 Bash 命令生效。`
              : '管理员未批准本次联网申请。',
            conversationId: request.conversation_id,
          },
          'network-review:' + id,
        );
        json(200, { ok: true });
        return true;
      }
      throw fail(404, '联网授权接口不存在。');
    },
    close() {
      scopes.clear();
      rates.clear();
    },
  };
  return service;
}
