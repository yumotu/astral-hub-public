import { z } from 'zod';
import { randomBytes, createHash } from 'node:crypto';
import { fail } from './accounts.mjs';
export const goalStepSchema = z
  .object({
    id: z.string().uuid(),
    title: z.string().trim().min(1).max(300),
    status: z.enum(['pending', 'active', 'done']).default('pending'),
  })
  .strict();
export const goalCreateSchema = z
  .object({
    id: z.string().uuid(),
    title: z.string().trim().min(1).max(200),
    description: z.string().max(10000).default(''),
    steps: z.array(goalStepSchema).max(60).default([]),
  })
  .strict();
const patchSchema = z
  .object({
    revision: z.number().int().positive(),
    title: z.string().trim().min(1).max(200).optional(),
    description: z.string().max(10000).optional(),
    status: z.enum(['active', 'paused', 'completed', 'archived']).optional(),
    steps: z.array(goalStepSchema).max(60).optional(),
  })
  .strict();
export function createGoals(
  db,
  { now = Date.now, internalUrl = 'http://app:8787/api/pi/goal-access' } = {},
) {
  db.exec(
    'CREATE TABLE IF NOT EXISTS goals(owner TEXT NOT NULL,id TEXT NOT NULL,data TEXT NOT NULL,PRIMARY KEY(owner,id))',
  );
  const grants = new Map();
  const hash = (token) => createHash('sha256').update(token).digest('hex');
  const get = (owner, id) => {
    const row = db.prepare('SELECT data FROM goals WHERE owner=? AND id=?').get(owner, id);
    return row ? JSON.parse(row.data) : null;
  };
  const list = (owner, archived = false) =>
    db
      .prepare('SELECT data FROM goals WHERE owner=?')
      .all(owner)
      .map((r) => JSON.parse(r.data))
      .filter((g) => archived || g.status !== 'archived')
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const save = (owner, g) => {
    db.prepare(
      'INSERT INTO goals VALUES(?,?,?) ON CONFLICT(owner,id) DO UPDATE SET data=excluded.data',
    ).run(owner, g.id, JSON.stringify(g));
    return g;
  };
  const execute = (owner, p) => {
    if (p.action === 'list') return { goals: list(owner, p.archived) };
    if (p.action === 'create') {
      const value = goalCreateSchema.parse(p.goal),
        existing = get(owner, value.id);
      if (existing) {
        if (existing.title !== value.title || existing.description !== value.description)
          throw fail(409, '目标编号已存在其他内容。');
        return { goal: existing };
      }
      if (list(owner, true).length >= 500) throw fail(413, '目标数量已达上限。');
      const at = new Date(now()).toISOString();
      return {
        goal: save(owner, {
          ...value,
          status: 'active',
          revision: 1,
          createdAt: at,
          updatedAt: at,
        }),
      };
    }
    const existing = get(owner, p.id);
    if (!existing) throw fail(404, '目标不存在。');
    if (p.action === 'inspect') return { goal: existing };
    const patch = patchSchema.parse(p.patch);
    if (patch.revision !== existing.revision)
      throw fail(409, '目标已被其他设备或任务修改，请重新读取后再更新。');
    if (patch.steps && new Set(patch.steps.map((s) => s.id)).size !== patch.steps.length)
      throw fail(400, '步骤编号不可重复。');
    return {
      goal: save(owner, {
        ...existing,
        ...patch,
        revision: existing.revision + 1,
        updatedAt: new Date(now()).toISOString(),
      }),
    };
  };
  const rpcSchema = z.discriminatedUnion('action', [
    z.object({ action: z.literal('list'), archived: z.boolean().optional() }).strict(),
    z.object({ action: z.literal('create'), goal: goalCreateSchema }).strict(),
    z.object({ action: z.literal('inspect'), id: z.string().uuid() }).strict(),
    z.object({ action: z.literal('update'), id: z.string().uuid(), patch: patchSchema }).strict(),
  ]);
  return {
    list,
    get,
    execute,
    grant(owner, task) {
      for (const [k, v] of grants) if (v.expires <= now()) grants.delete(k);
      const token = randomBytes(32).toString('hex'),
        digest = hash(token);
      grants.set(digest, { owner, expires: now() + 30 * 60 * 1000 });
      return { url: internalUrl, token, revoke: () => grants.delete(digest) };
    },
    async before(req, url, json, body) {
      if (url.pathname !== '/api/pi/goal-access') return false;
      const token = (req.headers.authorization || '').replace(/^Bearer /, ''),
        grant = grants.get(hash(token));
      if (req.method !== 'POST' || !grant || grant.expires <= now())
        throw fail(403, '目标工具授权已失效。');
      const p = rpcSchema.parse(await body(req));
      json(200, execute(grant.owner, p));
      return true;
    },
    async handle(req, url, json, actor, body) {
      if (!url.pathname.startsWith('/api/goals')) return false;
      if (!actor?.id) throw fail(401, '请先登录独立账号。');
      const id = url.pathname.match(/^\/api\/goals\/([^/]+)$/)?.[1];
      if (url.pathname === '/api/goals' && req.method === 'GET') {
        json(200, { goals: list(actor.id, url.searchParams.get('archived') === 'true') });
        return true;
      }
      if (url.pathname === '/api/goals' && req.method === 'POST') {
        json(
          201,
          execute(actor.id, { action: 'create', goal: goalCreateSchema.parse(await body(req)) }),
        );
        return true;
      }
      if (id && req.method === 'GET') {
        json(200, execute(actor.id, { action: 'inspect', id: z.string().uuid().parse(id) }));
        return true;
      }
      if (id && req.method === 'PATCH') {
        json(
          200,
          execute(actor.id, {
            action: 'update',
            id: z.string().uuid().parse(id),
            patch: patchSchema.parse(await body(req)),
          }),
        );
        return true;
      }
      throw fail(404, '目标接口不存在。');
    },
    close() {
      grants.clear();
    },
  };
}
