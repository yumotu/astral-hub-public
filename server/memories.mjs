import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { fail } from './accounts.mjs';

const uuid = z.string().uuid();
export const memoryFields = z
  .object({
    key: z.string().trim().min(1).max(100),
    content: z.string().trim().min(1).max(2000),
    kind: z.enum(['fact', 'preference', 'goal', 'task', 'inference']),
  })
  .strict();
export const memoryWrite = memoryFields
  .extend({
    scope: z.enum(['account', 'project']).default('account'),
    quote: z.string().trim().min(1).max(4000),
  })
  .strict();
export const memoryRevision = z.number().int().positive();
const words = (text) => {
  const lower = text.toLocaleLowerCase();
  const tokens = lower.match(/[a-z0-9_]{2,}/g) || [];
  for (const run of lower.match(/[\p{Script=Han}]+/gu) || [])
    for (let i = 0; i < run.length - 1; i++) tokens.push(run.slice(i, i + 2));
  return new Set(tokens.slice(0, 2000));
};

export function createMemories(db, { now = Date.now } = {}) {
  db.exec(`CREATE TABLE IF NOT EXISTS account_memories(
    owner TEXT NOT NULL,id TEXT NOT NULL,key TEXT NOT NULL,content TEXT NOT NULL,kind TEXT NOT NULL,
    scope TEXT NOT NULL,source TEXT NOT NULL,revision INTEGER NOT NULL,deleted INTEGER NOT NULL DEFAULT 0,
    created INTEGER NOT NULL,updated INTEGER NOT NULL,PRIMARY KEY(owner,id));
    CREATE UNIQUE INDEX IF NOT EXISTS account_memory_key ON account_memories(owner,scope,key) WHERE deleted=0;
    CREATE TABLE IF NOT EXISTS memory_settings(owner TEXT PRIMARY KEY,enabled INTEGER NOT NULL DEFAULT 1);`);
  const rowFor = (owner, id) =>
    db.prepare('SELECT * FROM account_memories WHERE owner=? AND id=?').get(owner, id);
  const enabled = (owner) =>
    db.prepare('SELECT enabled FROM memory_settings WHERE owner=?').get(owner)?.enabled !== 0;
  const view = (r) => ({
    id: r.id,
    key: r.key,
    content: r.content,
    kind: r.kind,
    scope: r.scope,
    source: JSON.parse(r.source),
    revision: r.revision,
    createdAt: new Date(r.created).toISOString(),
    updatedAt: new Date(r.updated).toISOString(),
  });
  function get(owner, id) {
    const r = rowFor(owner, uuid.parse(id));
    if (!r || r.deleted) throw fail(404, '记忆不存在。');
    return view(r);
  }
  function list(owner, { query = '', before, scope, limit = 50 } = {}) {
    const cursor = before ? rowFor(owner, uuid.parse(before)) : null;
    if (before && (!cursor || cursor.deleted)) throw fail(409, '记忆列表已变化，请刷新。');
    const rows = db
      .prepare(
        `SELECT * FROM account_memories WHERE owner=? AND deleted=0
      ${scope ? 'AND scope IN (?,?)' : ''}
      ${query ? 'AND (instr(lower(key),lower(?))>0 OR instr(lower(content),lower(?))>0)' : ''}
      ${cursor ? 'AND (updated<? OR (updated=? AND id<?))' : ''}
      ORDER BY updated DESC,id DESC LIMIT ?`,
      )
      .all(
        owner,
        ...(scope ? ['account', scope] : []),
        ...(query ? [query, query] : []),
        ...(cursor ? [cursor.updated, cursor.updated, cursor.id] : []),
        limit + 1,
      );
    return {
      enabled: enabled(owner),
      items: rows.slice(0, limit).map(view),
      next: rows.length > limit ? rows[limit - 1].id : null,
    };
  }
  function save(owner, data, { id = randomUUID(), revision, scope = 'account', source } = {}) {
    const p = memoryFields.parse(data);
    uuid.parse(id);
    const old = rowFor(owner, id);
    if (revision !== undefined) {
      memoryRevision.parse(revision);
      if (!old || old.deleted) throw fail(404, '记忆不存在。');
      if (old.revision !== revision) throw fail(409, '记忆已在其他位置修改，请重新读取后再保存。');
      scope = old.scope;
    } else {
      if (old) throw fail(409, '记忆编号已使用，请读取原记录，不会恢复已删除的记忆。');
      if (
        db.prepare('SELECT count(*) n FROM account_memories WHERE owner=? AND deleted=0').get(owner)
          .n >= 2000
      )
        throw fail(429, '记忆已达2000条，请先整理。');
    }
    const conflict = db
      .prepare(
        'SELECT id FROM account_memories WHERE owner=? AND scope=? AND key=? AND deleted=0 AND id!=?',
      )
      .get(owner, scope, p.key, id);
    if (conflict) throw fail(409, '同范围已有这个记忆键，请修正已有记忆：' + conflict.id);
    if (!source || !['manual', 'pi', 'computer'].includes(source.origin))
      throw fail(400, '缺少记忆来源。');
    const at = now();
    if (old)
      db.prepare(
        'UPDATE account_memories SET key=?,content=?,kind=?,source=?,revision=revision+1,updated=? WHERE owner=? AND id=?',
      ).run(p.key, p.content, p.kind, JSON.stringify(source), at, owner, id);
    else
      db.prepare('INSERT INTO account_memories VALUES(?,?,?,?,?,?,?,1,0,?,?)').run(
        owner,
        id,
        p.key,
        p.content,
        p.kind,
        scope,
        JSON.stringify(source),
        at,
        at,
      );
    return get(owner, id);
  }
  function remove(owner, id, revision) {
    const current = get(owner, id);
    if (current.revision !== memoryRevision.parse(revision))
      throw fail(409, '记忆已变化，请刷新后删除。');
    // Retain only an identity tombstone so a retried write cannot resurrect data.
    db.prepare(
      "UPDATE account_memories SET deleted=1,key='',content='',source='{}',revision=revision+1,updated=? WHERE owner=? AND id=?",
    ).run(now(), owner, id);
    return { deleted: true, id };
  }
  function settings(owner, value) {
    if (value !== undefined)
      db.prepare(
        'INSERT INTO memory_settings VALUES(?,?) ON CONFLICT(owner) DO UPDATE SET enabled=excluded.enabled',
      ).run(owner, Number(z.boolean().parse(value)));
    return { enabled: enabled(owner) };
  }
  function recall(owner, query, scope) {
    if (!enabled(owner)) return { enabled: false, items: [] };
    const terms = words(query);
    const candidates = db
      .prepare(
        'SELECT * FROM account_memories WHERE owner=? AND deleted=0 AND scope IN (?,?) ORDER BY updated DESC,id DESC LIMIT 2000',
      )
      .all(owner, 'account', scope || 'account');
    const ranked = candidates
      .map((r) => {
        const vocabulary = words(r.key + ' ' + r.content);
        let score = 0;
        for (const token of terms) if (vocabulary.has(token)) score++;
        if (r.kind === 'preference') score += 0.5;
        return { r, score };
      })
      .filter((v) => v.score > 0)
      .sort((a, b) => b.score - a.score || b.r.updated - a.r.updated);
    const items = [];
    let chars = 0;
    for (const { r } of ranked) {
      const item = view(r),
        size = JSON.stringify(item).length;
      if (items.length >= 8) break;
      if (chars + size > 6000) continue;
      chars += size;
      items.push(item);
    }
    return { enabled: true, items };
  }
  // Resolve the actual executing task; model input never selects another account,
  // project, machine, conversation, or an invented source quotation.
  function taskContext(ctx, quote) {
    let row,
      input,
      scope,
      supplements = [];
    if (ctx.origin === 'pi') {
      row = db
        .prepare('SELECT payload FROM pi_tasks WHERE owner=? AND id=? AND conversation_id=?')
        .get(ctx.owner, ctx.task, ctx.conversation);
      const p = row ? JSON.parse(row.payload) : null;
      input = p?.input;
      scope = p?.projectId ? 'server:' + p.projectId : null;
      supplements = db
        .prepare(
          "SELECT payload FROM pi_tasks WHERE owner=? AND conversation_id=? AND json_extract(payload,'$.parentId')=? AND json_extract(state,'$.status') IN ('applied','done') ORDER BY seq DESC LIMIT 20",
        )
        .all(ctx.owner, ctx.conversation, ctx.task)
        .map((r) => JSON.parse(r.payload).input);
    } else if (ctx.origin === 'computer') {
      row = db
        .prepare('SELECT * FROM relay_jobs WHERE owner=? AND id=? AND conversation_id=?')
        .get(ctx.owner, ctx.task, ctx.conversation);
      input = row?.input;
      scope = row ? 'computer:' + row.device_id + ':' + row.project_id : null;
      supplements = db
        .prepare(
          "SELECT input FROM relay_jobs WHERE owner=? AND conversation_id=? AND parent_id=? AND status IN ('applied','done') ORDER BY rowid DESC LIMIT 20",
        )
        .all(ctx.owner, ctx.conversation, ctx.task)
        .map((r) => r.input);
    }
    if (!row) throw fail(404, '当前任务的记忆范围不存在。');
    if (quote && ![input, ...supplements].some((v) => typeof v === 'string' && v.includes(quote)))
      throw fail(400, '来源必须引用当前用户任务中的原文，不从邮件、文件或模型输出推断为用户事实。');
    return {
      scope,
      source: {
        origin: ctx.origin,
        conversationId: ctx.conversation,
        taskId: ctx.task,
        ...(quote ? { quote } : {}),
      },
    };
  }
  const rates = new Map();
  return {
    get,
    list,
    save,
    remove,
    settings,
    recall,
    taskContext,
    async handle(req, url, json, actor, body) {
      if (!url.pathname.startsWith('/api/memory')) return false;
      if (!actor?.id) throw fail(403, '请登录独立账号管理记忆。');
      const owner = actor.id,
        at = now(),
        bucket = rates.get(owner);
      if (!bucket || bucket.until <= at) rates.set(owner, { until: at + 60000, count: 1 });
      else if (++bucket.count > 120) throw fail(429, '记忆请求较多，请稍后再试。');
      if (rates.size > 2000) for (const [id, b] of rates) if (b.until <= at) rates.delete(id);
      if (url.pathname === '/api/memory/settings') {
        if (req.method === 'GET') json(200, settings(owner));
        else if (req.method === 'PATCH')
          json(
            200,
            settings(
              owner,
              z
                .object({ enabled: z.boolean() })
                .strict()
                .parse(await body(req)).enabled,
            ),
          );
        else throw fail(405, '请求方法不支持。');
        return true;
      }
      if (url.pathname === '/api/memory') {
        if (req.method === 'GET') {
          const p = z
            .object({ query: z.string().max(100).optional(), before: uuid.optional() })
            .strict()
            .parse(Object.fromEntries(url.searchParams));
          json(200, list(owner, p));
        } else if (req.method === 'POST') {
          const { id, ...p } = memoryFields
            .extend({ id: uuid })
            .strict()
            .parse(await body(req));
          json(201, {
            memory: save(owner, p, { id, source: { origin: 'manual', quote: p.content } }),
          });
        } else throw fail(405, '请求方法不支持。');
        return true;
      }
      const m = url.pathname.match(/^\/api\/memory\/([^/]+)$/);
      if (!m) throw fail(404, '记忆接口不存在。');
      const id = uuid.parse(m[1]);
      if (req.method === 'GET') json(200, { memory: get(owner, id) });
      else if (req.method === 'PATCH') {
        const { revision, ...p } = memoryFields
          .extend({ revision: memoryRevision })
          .strict()
          .parse(await body(req));
        json(200, {
          memory: save(owner, p, { id, revision, source: { origin: 'manual', quote: p.content } }),
        });
      } else if (req.method === 'DELETE') {
        const { revision } = z
          .object({ revision: memoryRevision })
          .strict()
          .parse(await body(req));
        json(200, remove(owner, id, revision));
      } else throw fail(405, '请求方法不支持。');
      return true;
    },
  };
}
