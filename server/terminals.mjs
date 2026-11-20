import { createApprovalPolicy } from './approval-policy.mjs';
import { z } from 'zod';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { fail } from './accounts.mjs';
const uuid = z.string().uuid(),
  target = z.enum(['pi', 'server']);
const commandSchema = z
  .object({
    callId: z.string().min(1).max(240),
    target,
    command: z.string().trim().min(1).max(8000),
    cwd: z.string().startsWith('/').max(1000).optional(),
    reason: z.string().trim().min(1).max(1000),
    timeout: z.number().int().min(1000).max(120000).default(60000),
  })
  .strict();
export function createTerminals(
  db,
  { body, pi, host, internalUrl = 'http://app:8787/api/pi/host-access', now = Date.now } = {},
) {
  const policy = createApprovalPolicy(db, now);
  const scopes = new Map(),
    rates = new Map();
  let closed = false;
  db.exec(`CREATE TABLE IF NOT EXISTS host_access_requests(id TEXT PRIMARY KEY,owner TEXT NOT NULL,task_id TEXT NOT NULL,
    conversation_id TEXT NOT NULL,call_id TEXT NOT NULL,payload TEXT NOT NULL,state TEXT NOT NULL,created_at TEXT NOT NULL,
    expires_at INTEGER NOT NULL,result TEXT,UNIQUE(owner,task_id,call_id));
    CREATE TABLE IF NOT EXISTS terminal_audit(id TEXT PRIMARY KEY,owner TEXT NOT NULL,target TEXT NOT NULL,action TEXT NOT NULL,session_id TEXT,created_at TEXT NOT NULL);`);
  db.prepare(
    "UPDATE host_access_requests SET state='interrupted' WHERE state IN ('pending','approved','running')",
  ).run();
  const digest = (value) => createHash('sha256').update(value).digest('hex');
  function limit(key, max = 120) {
    const time = now(),
      r = rates.get(key);
    if (r && r.until > time) {
      if (r.n >= max) throw fail(429, '终端请求过于频繁。');
      r.n++;
    } else rates.set(key, { n: 1, until: time + 60000 });
  }
  const selected = (t) => (t === 'pi' ? pi : host);
  async function call(t, p, timeout = 30000) {
    const config = selected(t);
    if (!config?.url || !config.token)
      throw fail(503, t === 'server' ? '服务器主机终端尚未配置。' : 'Pi 终端尚未配置。');
    let r;
    try {
      r = await (config.fetch || fetch)(config.url.replace(/\/$/, '') + '/terminal', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + config.token, 'Content-Type': 'application/json' },
        body: JSON.stringify(p),
        signal: AbortSignal.timeout(timeout),
        redirect: 'error',
      });
    } catch {
      throw fail(502, '终端连接中断，操作结果不明时不会自动重复执行。');
    }
    const data = await r.json();
    if (!r.ok)
      throw fail(
        [400, 403, 404, 409, 429, 503].includes(r.status) ? r.status : 502,
        data.error || '终端请求失败。',
      );
    return data;
  }
  function audit(owner, t, action, id) {
    db.prepare('INSERT INTO terminal_audit VALUES(?,?,?,?,?,?)').run(
      randomUUID(),
      owner,
      t,
      action,
      id || null,
      new Date(now()).toISOString(),
    );
  }
  function read(owner, id) {
    const row = db
      .prepare('SELECT * FROM host_access_requests WHERE owner=? AND id=?')
      .get(owner, id);
    if (!row) throw fail(404, '授权请求不存在。');
    return {
      ...row,
      payload: JSON.parse(row.payload),
      result: row.result ? JSON.parse(row.result) : null,
    };
  }
  function expire(row, scope) {
    if (['pending', 'approved'].includes(row.state) && row.expires_at < now()) {
      db.prepare("UPDATE host_access_requests SET state='expired' WHERE id=?").run(row.id);
      scope?.event({ type: 'extension_ui_resolved', id: 'access:' + row.id });
      return { ...row, state: 'expired' };
    }
    return row;
  }
  async function revoke(owner, taskId) {
    for (const [key, s] of scopes) if (s.owner === owner && s.taskId === taskId) scopes.delete(key);
    const rows = db
      .prepare(
        "SELECT * FROM host_access_requests WHERE owner=? AND task_id=? AND state IN ('pending','approved','running')",
      )
      .all(owner, taskId);
    for (const row of rows) {
      if (row.state === 'running')
        await call(
          JSON.parse(row.payload).target,
          { action: 'cancel_command', ownerId: owner, requestId: row.id },
          10000,
        ).catch(() => {});
      if (!closed)
        db.prepare(
          "UPDATE host_access_requests SET state='interrupted' WHERE id=? AND state IN ('pending','approved','running')",
        ).run(row.id);
    }
  }
  const service = {
    scope(owner, p, event) {
      const token = randomBytes(32).toString('hex');
      scopes.set(digest(token), {
        owner,
        taskId: p.id,
        conversationId: p.conversationId,
        event,
        expires: now() + 16 * 60000,
      });
      return { url: internalUrl, token };
    },
    revoke,
    async respond(owner, task, reply) {
      if (!reply.id.startsWith('access:')) return false;
      const row = expire(read(owner, uuid.parse(reply.id.slice(7))));
      if (row.task_id !== task.id || row.state !== 'pending')
        throw fail(409, '授权请求已过期或已经处理。');
      if (db.prepare('SELECT role FROM users WHERE id=?').get(owner)?.role !== 'owner')
        throw fail(403, '仅管理员可批准宿主访问。');
      if (reply.confirmed === true)
        policy.remember(owner, row.conversation_id, row.payload, reply.approval);
      db.prepare("UPDATE host_access_requests SET state=? WHERE id=? AND state='pending'").run(
        reply.confirmed === true ? 'approved' : 'denied',
        row.id,
      );
      return true;
    },
    async before(req, url, json) {
      if (!url.pathname.startsWith('/api/pi/host-access/')) return false;
      const token = (req.headers.authorization || '').replace(/^Bearer /, '');
      const scope = scopes.get(digest(token));
      if (
        !scope ||
        scope.expires < now() ||
        db.prepare('SELECT role FROM users WHERE id=?').get(scope.owner)?.role !== 'owner'
      )
        throw fail(401, '执行授权通道已关闭。');
      limit('agent:' + scope.taskId, 180);
      if (url.pathname === '/api/pi/host-access/request' && req.method === 'POST') {
        const p = commandSchema.parse(await body(req));
        if (!selected(p.target)?.url) throw fail(503, '所选宿主执行接口尚未配置。');
        const old = db
          .prepare(
            'SELECT id,payload FROM host_access_requests WHERE owner=? AND task_id=? AND call_id=?',
          )
          .get(scope.owner, scope.taskId, p.callId);
        if (old) {
          if (old.payload !== JSON.stringify(p)) throw fail(409, '此调用编号已存在不同的操作。');
          json(200, { id: old.id, state: read(scope.owner, old.id).state });
          return true;
        }
        if (
          db
            .prepare('SELECT count(*) n FROM host_access_requests WHERE owner=? AND task_id=?')
            .get(scope.owner, scope.taskId).n >= 10
        )
          throw fail(429, '本轮授权申请过多。');
        const id = randomUUID(),
          decision = policy.decide(scope.owner, scope.conversationId, p);
        db.prepare('INSERT INTO host_access_requests VALUES(?,?,?,?,?,?,?,?,?,NULL)').run(
          id,
          scope.owner,
          scope.taskId,
          scope.conversationId,
          p.callId,
          JSON.stringify(p),
          decision ? 'approved' : 'pending',
          new Date(now()).toISOString(),
          Math.min(now() + 5 * 60000, decision?.expiresAt ?? Infinity),
        );
        if (decision) {
          policy.save(id, decision);
          audit(scope.owner, p.target, 'auto_' + decision.kind, id);
        } else
          scope.event({
            type: 'extension_ui_request',
            id: 'access:' + id,
            method: 'confirm',
            title:
              p.target === 'server' ? '允许在服务器主机以 root 执行？' : '允许在 Pi 宿主联网执行？',
            message: `用途：${p.reason}\n环境：${p.target === 'server' ? '服务器主机 · root，整机权限' : 'Pi 宿主容器 · node，已挂载文件'}\n目录：${p.cwd || (p.target === 'server' ? '/opt/astral-hub' : 'Pi 插件目录')}\n网络：允许\n读写：继承该宿主账户权限\n命令：\n${p.command}\n\n仅批准本次命令，有效期 5 分钟。安装脚本若出现在命令中也会按展示内容执行；命令写入不经过文件工具备份。`,
            createdAt: new Date(now()).toISOString(),
          });
        json(201, {
          id,
          state: decision ? 'approved' : 'pending',
          ...(decision ? { decision: decision.reason } : {}),
        });
        return true;
      }
      const match = url.pathname.match(/^\/api\/pi\/host-access\/([^/]+)\/(status|execute)$/);
      if (match) {
        const id = uuid.parse(match[1]),
          row = expire(read(scope.owner, id), scope);
        if (row.task_id !== scope.taskId) throw fail(403, '授权请求不属于当前任务。');
        if (match[2] === 'status' && req.method === 'GET') {
          json(200, { id, state: row.state });
          return true;
        }
        if (match[2] === 'execute' && req.method === 'POST') {
          z.object({})
            .strict()
            .parse(await body(req));
          if (!policy.valid(scope.owner, scope.conversationId, id, row.payload))
            throw fail(409, '授权规则已撤销或到期，请重新申请。');
          if (row.state !== 'approved') throw fail(409, '此操作尚未获准、已过期或已经执行。');
          const claimed = db
            .prepare(
              "UPDATE host_access_requests SET state='running' WHERE id=? AND state='approved'",
            )
            .run(id);
          if (!claimed.changes) throw fail(409, '该授权已被使用。');
          try {
            const result = await call(
              row.payload.target,
              {
                action: 'command',
                ownerId: scope.owner,
                requestId: id,
                command: row.payload.command,
                ...(row.payload.cwd ? { cwd: row.payload.cwd } : {}),
                timeout: row.payload.timeout,
              },
              row.payload.timeout + 10000,
            );
            if (!closed)
              db.prepare("UPDATE host_access_requests SET state='done',result=? WHERE id=?").run(
                JSON.stringify(result),
                id,
              );
            json(200, { ...result, approvalId: id });
          } catch (e) {
            if (!closed)
              db.prepare("UPDATE host_access_requests SET state='interrupted' WHERE id=?").run(id);
            throw e;
          }
          return true;
        }
      }
      throw fail(404, '授权接口不存在。');
    },
    async handle(req, url, json, actor) {
      const path = url.pathname;
      const policyRoute = path.match(/^\/api\/pi\/approval-policies\/([^/]+)$/);
      if (!path.startsWith('/api/terminals') && !policyRoute) return false;
      if (actor?.role !== 'owner') throw fail(403, '服务器终端仅对独立管理员账号开放。');
      limit('human:' + actor.id, 1500);
      if (policyRoute) {
        const conversation = uuid.parse(policyRoute[1]);
        if (req.method === 'GET') {
          json(200, policy.get(actor.id, conversation));
          return true;
        }
        if (req.method === 'PATCH') {
          const result = policy.set(actor.id, conversation, await body(req));
          if (result.mode === 'manual')
            db.prepare(
              "UPDATE host_access_requests SET state='denied' WHERE owner=? AND conversation_id=? AND state='approved'",
            ).run(actor.id, conversation);
          audit(actor.id, 'pi', 'policy_' + result.mode, conversation);
          json(200, result);
          return true;
        }
        throw fail(405, '授权策略方法不受支持。');
      }
      if (path === '/api/terminals/status' && req.method === 'GET') {
        json(200, { pi: !!pi?.url, server: !!host?.url });
        return true;
      }
      const route = path.match(
        /^\/api\/terminals\/(pi|server)(?:\/([^/]+)(?:\/(input|resize|close))?)?$/,
      );
      if (!route) throw fail(404, '终端接口不存在。');
      const t = target.parse(route[1]),
        id = route[2] ? uuid.parse(route[2]) : null,
        action = route[3];
      if (!id && req.method === 'GET') {
        json(200, await call(t, { action: 'list', ownerId: actor.id }));
        return true;
      }
      if (!id && req.method === 'POST') {
        const p = z
          .object({
            cols: z.number().int().min(20).max(300),
            rows: z.number().int().min(5).max(100),
          })
          .strict()
          .parse(await body(req));
        const result = await call(t, { action: 'open', ownerId: actor.id, ...p });
        audit(actor.id, t, 'open', result.id);
        json(201, result);
        return true;
      }
      if (id && !action && req.method === 'GET') {
        const after = z.coerce
          .number()
          .int()
          .nonnegative()
          .max(Number.MAX_SAFE_INTEGER)
          .parse(url.searchParams.get('after') || 0);
        json(200, await call(t, { action: 'read', ownerId: actor.id, sessionId: id, after }));
        return true;
      }
      if (id && action && req.method === 'POST') {
        const p = (
          action === 'input'
            ? z.object({ data: z.string().max(16384) })
            : action === 'resize'
              ? z.object({
                  cols: z.number().int().min(20).max(300),
                  rows: z.number().int().min(5).max(100),
                })
              : z.object({})
        )
          .strict()
          .parse(await body(req));
        const result = await call(t, { action, ownerId: actor.id, sessionId: id, ...p });
        if (action === 'close') audit(actor.id, t, 'close', id);
        json(200, result);
        return true;
      }
      throw fail(405, '终端操作方法不受支持。');
    },
    close() {
      closed = true;
      scopes.clear();
    },
  };
  return service;
}
