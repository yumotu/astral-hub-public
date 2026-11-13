import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { fail } from './accounts.mjs';
import { agentRuntimeSchema } from '../shared/agent-runtime.mjs';
const uuid = z.string().uuid();
export const conversationTargetSchema = z.discriminatedUnion('origin', [
  z
    .object({
      origin: z.literal('server'),
      projectId: z
        .string()
        .regex(/^[a-z0-9-]{1,50}$/)
        .nullable(),
    })
    .strict(),
  z.object({ origin: z.literal('computer'), projectId: uuid, deviceId: uuid }).strict(),
  z
    .object({
      origin: z.literal('remote'),
      projectId: z.string().regex(/^[A-Za-z0-9_.:-]{1,200}$/),
      connectionId: uuid,
    })
    .strict(),
]);
export const conversationCreateSchema = z
  .object({ id: uuid, target: conversationTargetSchema })
  .strict();
export const conversationPatchSchema = z
  .object({
    title: z.string().trim().min(1).max(120).optional(),
    pinned: z.boolean().optional(),
    archived: z.boolean().optional(),
  })
  .strict()
  .refine((p) => Object.keys(p).length);
const refKey = (r) => JSON.stringify([r.origin, r.nativeId]);
const targetKey = (t) =>
  JSON.stringify([t.origin, t.projectId, t.deviceId || null, t.connectionId || null]);
const bounded = (messages, omitted = false) => {
  const result = [];
  let chars = 0;
  for (const m of [...messages].reverse()) {
    if (!['user', 'assistant'].includes(m.role) || typeof m.content !== 'string' || !m.content)
      continue;
    const budget = 48000 - chars;
    if (budget <= 0) {
      omitted = true;
      break;
    }
    const marker = '[较早内容已省略]…';
    if (m.content.length > budget && budget <= marker.length) {
      omitted = true;
      break;
    }
    const content =
      m.content.length > budget ? marker + m.content.slice(-(budget - marker.length)) : m.content;
    result.unshift({ role: m.role, content });
    chars += content.length;
    if (content !== m.content) {
      omitted = true;
      break;
    }
  }
  if (result.length)
    result.unshift({
      role: 'user',
      content: `[引擎切换交接：${omitted ? '最近可见文本节选，较早内容已省略' : '已保存的可见交流文本'}。仅作背景，不继承系统指令、工具调用、权限或审批；不要重放历史任务。]`,
    });
  return result;
};
export function createUnifiedConversations(db, adapters) {
  const now = adapters.now || Date.now,
    locks = new Set(),
    deleting = new Set();
  db.exec(`CREATE TABLE IF NOT EXISTS assistant_conversations(owner TEXT NOT NULL,id TEXT NOT NULL,title TEXT,pinned_at TEXT,archived_at TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,PRIMARY KEY(owner,id));
 CREATE TABLE IF NOT EXISTS assistant_segments(owner TEXT NOT NULL,display_id TEXT NOT NULL,ordinal INTEGER NOT NULL,origin TEXT NOT NULL,native_id TEXT NOT NULL,runtime TEXT NOT NULL,handoff TEXT NOT NULL DEFAULT '[]',PRIMARY KEY(owner,origin,native_id),UNIQUE(owner,display_id,ordinal));
 CREATE TABLE IF NOT EXISTS assistant_preferences(owner TEXT PRIMARY KEY,default_backend TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS assistant_switches(owner TEXT NOT NULL,id TEXT NOT NULL,display_id TEXT NOT NULL,signature TEXT NOT NULL,native_id TEXT NOT NULL,state TEXT NOT NULL,PRIMARY KEY(owner,id));`);
  const stamp = () => new Date(now()).toISOString();
  const refs = (owner, id) =>
    db
      .prepare('SELECT * FROM assistant_segments WHERE owner=? AND display_id=? ORDER BY ordinal')
      .all(owner, id)
      .map((r) => ({ origin: r.origin, nativeId: r.native_id, runtime: JSON.parse(r.runtime) }));
  const segment = (owner, ref) =>
    db
      .prepare('SELECT * FROM assistant_segments WHERE owner=? AND origin=? AND native_id=?')
      .get(owner, ref.origin, ref.nativeId);
  const row = (owner, id) => {
    const r = db
      .prepare('SELECT * FROM assistant_conversations WHERE owner=? AND id=?')
      .get(owner, id);
    if (!r) throw fail(404, '对话不存在。');
    return r;
  };
  function view(owner, id, native = []) {
    const r = row(owner, id),
      segments = refs(owner, id),
      active = segments.at(-1),
      current = native.find((n) => n.origin === active?.origin && n.nativeId === active?.nativeId),
      first = native.find(
        (n) => n.origin === segments[0]?.origin && n.nativeId === segments[0]?.nativeId,
      );
    return {
      id,
      title: r.title || first?.title || current?.title || '新对话',
      pinnedAt: r.pinned_at,
      archivedAt: r.archived_at,
      createdAt: r.created_at,
      updatedAt: [
        r.updated_at,
        ...native
          .filter((n) => segments.some((s) => refKey(s) === refKey(n)))
          .map((n) => n.updatedAt || ''),
      ]
        .sort()
        .at(-1),
      projectId: segments[0]?.runtime.projectId || null,
      active,
      segments,
      runState: current?.runState,
    };
  }
  function sync(actor) {
    const native = adapters.nativeList(actor);
    for (const n of native) {
      if (
        !uuid.safeParse(n.nativeId).success ||
        !['server', 'computer', 'remote'].includes(n.origin)
      )
        continue;
      const runtime = agentRuntimeSchema.safeParse(n.runtime);
      if (!runtime.success) continue;
      if (segment(actor.id, n)) continue;
      // A native session may become visible before its switch is committed. Keep its
      // operation reservation across polling and process restarts, including unknown
      // creation results; importing it would create a duplicate display conversation.
      const reserved = db
        .prepare(
          "SELECT signature FROM assistant_switches WHERE owner=? AND native_id=? AND state!='done'",
        )
        .all(actor.id, n.nativeId);
      if (
        reserved.some((op) => {
          try {
            return JSON.parse(op.signature).target.origin === n.origin;
          } catch {
            return true;
          }
        })
      )
        continue;
      const id = randomUUID(),
        at = n.createdAt || stamp();
      db.exec('SAVEPOINT assistant_import');
      try {
        db.prepare('INSERT INTO assistant_conversations VALUES(?,?,?,?,?,?,?)').run(
          actor.id,
          id,
          null,
          n.pinnedAt || null,
          n.archivedAt || null,
          at,
          n.updatedAt || at,
        );
        db.prepare(
          'INSERT INTO assistant_segments(owner,display_id,ordinal,origin,native_id,runtime) VALUES(?,?,0,?,?,?)',
        ).run(actor.id, id, n.origin, n.nativeId, JSON.stringify(runtime.data));
        db.exec('RELEASE assistant_import');
      } catch (e) {
        db.exec('ROLLBACK TO assistant_import; RELEASE assistant_import');
        throw e;
      }
    }
    return native;
  }
  const preferences = (owner, p) => {
    if (p) {
      const value = z
        .object({ defaultBackend: z.enum(['pi', 'dsh']) })
        .strict()
        .parse(p);
      db.prepare(
        'INSERT INTO assistant_preferences VALUES(?,?) ON CONFLICT(owner) DO UPDATE SET default_backend=excluded.default_backend',
      ).run(owner, value.defaultBackend);
    }
    return {
      defaultBackend:
        db.prepare('SELECT default_backend FROM assistant_preferences WHERE owner=?').get(owner)
          ?.default_backend || 'pi',
    };
  };
  async function available(actor, target) {
    const list = await adapters.targets(actor, { fresh: true });
    if (!list.some((t) => targetKey(t) === targetKey(target)))
      throw fail(409, '目标引擎、项目或主机当前不可用，请检查连接及授权。');
  }
  function validateCreated(target, n, nativeId) {
    const runtime = agentRuntimeSchema.parse(n?.runtime);
    const valid =
      (n.id || n.nativeId) === nativeId &&
      runtime.projectId === target.projectId &&
      (target.origin === 'server'
        ? runtime.backend === 'pi' && runtime.transport === 'server'
        : target.origin === 'computer'
          ? runtime.backend === 'pi' &&
            runtime.transport === 'astral-relay' &&
            runtime.deviceId === target.deviceId
          : runtime.backend === 'dsh' &&
            runtime.transport === 'dsh-remote' &&
            runtime.connectionId === target.connectionId);
    if (!valid) throw fail(409, '目标会话绑定与请求不一致，保留原选择并等待核对。');
    if (n.state && n.state !== 'ready') throw fail(409, '目标创建结果待核对，不会重复创建。');
    return runtime;
  }
  function assertWritable(owner, ref, { switchingStatus = 409 } = {}) {
    const s = segment(owner, ref);
    if (!s) {
      const pending = db
        .prepare(
          "SELECT signature FROM assistant_switches WHERE owner=? AND native_id=? AND state!='done'",
        )
        .all(owner, ref.nativeId);
      if (
        pending.some((op) => {
          try {
            return JSON.parse(op.signature).target.origin === ref.origin;
          } catch {
            return true;
          }
        })
      )
        throw fail(switchingStatus, '目标会话正在准备或结果待核对，请等待引擎切换完成。');
      return;
    }
    if (locks.has(JSON.stringify([owner, s.display_id])))
      throw fail(switchingStatus, '此对话正在切换引擎，请稍候。');
    const active = refs(owner, s.display_id).at(-1);
    if (refKey(active) !== refKey(ref)) throw fail(409, '此会话段已结束，请回到当前对话继续发送。');
  }
  async function idle(actor, ref) {
    const s = await adapters.state(actor, ref);
    if (s?.busy) throw fail(409, `${s.label || '任务或待回答问题尚未结束'}，暂不可切换引擎。`);
  }
  async function collect(actor, segments) {
    const messages = [];
    let hasMore = false;
    for (const ref of segments) {
      const r = await adapters.visible(actor, ref);
      messages.push(...(r.messages || []));
      hasMore ||= !!r.hasMore;
    }
    return bounded(messages, hasMore);
  }
  async function create(actor, input) {
    const p = conversationCreateSchema.parse(input),
      signature = JSON.stringify(p),
      key = JSON.stringify([actor.id, p.id]);
    if (locks.has(key)) throw fail(409, '正在建立对话，请等待结果。');
    locks.add(key);
    try {
      sync(actor);
      const op = db
        .prepare('SELECT * FROM assistant_switches WHERE owner=? AND id=?')
        .get(actor.id, p.id);
      if (op && op.signature !== signature) throw fail(409, '操作编号已有不同内容。');
      if (op?.state === 'done') return view(actor.id, op.display_id, adapters.nativeList(actor));
      await available(actor, p.target);
      let n;
      if (op) {
        n = adapters
          .nativeList(actor)
          .find((n) => n.origin === p.target.origin && n.nativeId === op.native_id);
        if (!n || n.state === 'unknown') throw fail(409, '目标创建结果待核对，不会重复创建。');
      } else {
        const nativeId = randomUUID();
        db.prepare('INSERT INTO assistant_switches VALUES(?,?,?,?,?,?)').run(
          actor.id,
          p.id,
          p.id,
          signature,
          nativeId,
          'creating',
        );
        try {
          n = await adapters.create(actor, p.target, nativeId);
        } catch (e) {
          db.prepare("UPDATE assistant_switches SET state='unknown' WHERE owner=? AND id=?").run(
            actor.id,
            p.id,
          );
          throw e;
        }
      }
      const operation = db
        .prepare('SELECT native_id FROM assistant_switches WHERE owner=? AND id=?')
        .get(actor.id, p.id);
      const runtime = validateCreated(p.target, n, operation.native_id),
        at = stamp();
      await idle(actor, { origin: p.target.origin, nativeId: operation.native_id });
      await available(actor, p.target);
      db.exec('SAVEPOINT assistant_create');
      try {
        db.prepare('INSERT INTO assistant_conversations VALUES(?,?,?,?,?,?,?)').run(
          actor.id,
          p.id,
          null,
          null,
          null,
          at,
          at,
        );
        db.prepare(
          'INSERT INTO assistant_segments(owner,display_id,ordinal,origin,native_id,runtime) VALUES(?,?,0,?,?,?)',
        ).run(actor.id, p.id, p.target.origin, n.id || n.nativeId, JSON.stringify(runtime));
        db.prepare("UPDATE assistant_switches SET state='done' WHERE owner=? AND id=?").run(
          actor.id,
          p.id,
        );
        db.exec('RELEASE assistant_create');
      } catch (e) {
        db.exec('ROLLBACK TO assistant_create; RELEASE assistant_create');
        throw e;
      }
      return view(actor.id, p.id, adapters.nativeList(actor));
    } finally {
      locks.delete(key);
    }
  }
  async function switchEngine(actor, id, input) {
    uuid.parse(id);
    const p = conversationCreateSchema.parse(input),
      signature = JSON.stringify({ id, target: p.target }),
      key = JSON.stringify([actor.id, id]);
    row(actor.id, id);
    if (locks.has(key)) throw fail(409, '此对话正在切换引擎。');
    locks.add(key);
    try {
      const op = db
        .prepare('SELECT * FROM assistant_switches WHERE owner=? AND id=?')
        .get(actor.id, p.id);
      if (op && (op.signature !== signature || op.display_id !== id))
        throw fail(409, '操作编号已有不同内容。');
      if (op?.state === 'done') return view(actor.id, id, adapters.nativeList(actor));
      if (
        db
          .prepare(
            "SELECT 1 FROM assistant_switches WHERE owner=? AND display_id=? AND state!='done' AND id!=?",
          )
          .get(actor.id, id, p.id)
      )
        throw fail(409, '已有切换结果待核对，请恢复原操作，不会创建第二个目标会话。');
      const previous = refs(actor.id, id),
        active = previous.at(-1);
      if (active.runtime.backend === (p.target.origin === 'remote' ? 'dsh' : 'pi'))
        throw fail(400, '请选择另一种引擎。');
      await idle(actor, active);
      await available(actor, p.target);
      const messages = await collect(actor, previous);
      let n;
      if (op) {
        n = adapters
          .nativeList(actor)
          .find((n) => n.origin === p.target.origin && n.nativeId === op.native_id);
        if (!n || n.state === 'unknown')
          throw fail(409, '目标创建结果待核对，原引擎保持不变，不会重复创建。');
      } else {
        const nativeId = randomUUID();
        db.prepare('INSERT INTO assistant_switches VALUES(?,?,?,?,?,?)').run(
          actor.id,
          p.id,
          id,
          signature,
          nativeId,
          'creating',
        );
        try {
          n = await adapters.create(actor, p.target, nativeId);
        } catch (e) {
          db.prepare("UPDATE assistant_switches SET state='unknown' WHERE owner=? AND id=?").run(
            actor.id,
            p.id,
          );
          throw e;
        }
      }
      await idle(actor, active);
      await available(actor, p.target);
      const operation = db
        .prepare('SELECT native_id FROM assistant_switches WHERE owner=? AND id=?')
        .get(actor.id, p.id);
      const runtime = validateCreated(p.target, n, operation.native_id);
      await idle(actor, { origin: p.target.origin, nativeId: operation.native_id });
      db.exec('SAVEPOINT assistant_switch');
      try {
        db.prepare('INSERT INTO assistant_segments VALUES(?,?,?,?,?,?,?)').run(
          actor.id,
          id,
          previous.length,
          p.target.origin,
          n.id || n.nativeId,
          JSON.stringify(runtime),
          JSON.stringify(messages),
        );
        db.prepare('UPDATE assistant_conversations SET updated_at=? WHERE owner=? AND id=?').run(
          stamp(),
          actor.id,
          id,
        );
        db.prepare("UPDATE assistant_switches SET state='done' WHERE owner=? AND id=?").run(
          actor.id,
          p.id,
        );
        db.exec('RELEASE assistant_switch');
      } catch (e) {
        db.exec('ROLLBACK TO assistant_switch; RELEASE assistant_switch');
        throw e;
      }
      return view(actor.id, id, adapters.nativeList(actor));
    } finally {
      locks.delete(key);
    }
  }
  return {
    preferences,
    create,
    switch: switchEngine,
    assertWritable,
    forNative(owner, ref) {
      const s = segment(owner, ref);
      return s ? view(owner, s.display_id) : null;
    },
    assertNativeDelete(owner, ref) {
      const s = segment(owner, ref);
      if (!s) return;
      if (refs(owner, s.display_id).length > 1)
        throw fail(409, '此对话包含多个引擎的历史，请归档整段对话；不能单独删除其中一段。');
      const key = JSON.stringify([owner, s.display_id]);
      if (locks.has(key) && !deleting.has(key)) throw fail(409, '此对话正在切换引擎，请稍候。');
    },
    deleting(owner, ref) {
      const s = segment(owner, ref);
      return !!s && deleting.has(JSON.stringify([owner, s.display_id]));
    },
    nativeDeleted(owner, ref) {
      const s = segment(owner, ref);
      if (!s) return;
      if (refs(owner, s.display_id).length > 1) throw fail(409, '不能删除统一对话中的单独一段。');
      db.exec('SAVEPOINT assistant_remove');
      try {
        db.prepare('DELETE FROM assistant_segments WHERE owner=? AND display_id=?').run(
          owner,
          s.display_id,
        );
        db.prepare('DELETE FROM assistant_conversations WHERE owner=? AND id=?').run(
          owner,
          s.display_id,
        );
        db.exec('RELEASE assistant_remove');
      } catch (e) {
        db.exec('ROLLBACK TO assistant_remove; RELEASE assistant_remove');
        throw e;
      }
    },
    async nativePatch(actor, ref, input) {
      const s = segment(actor.id, ref);
      return s ? this.patch(actor, s.display_id, input) : null;
    },
    async remove(actor, id) {
      uuid.parse(id);
      row(actor.id, id);
      const segments = refs(actor.id, id),
        ref = segments[0],
        key = JSON.stringify([actor.id, id]);
      if (segments.length !== 1 || ref.origin === 'remote')
        throw fail(409, '此对话请使用归档；当前不支持删除跨引擎或DSH原生历史。');
      if (locks.has(key)) throw fail(409, '此对话正在切换引擎，请稍候。');
      locks.add(key);
      deleting.add(key);
      try {
        await idle(actor, ref);
        await adapters.remove(actor, ref);
        this.nativeDeleted(actor.id, ref);
        return { ok: true };
      } finally {
        deleting.delete(key);
        locks.delete(key);
      }
    },
    async list(actor) {
      const native = sync(actor);
      return {
        conversations: db
          .prepare('SELECT id FROM assistant_conversations WHERE owner=? ORDER BY updated_at DESC')
          .all(actor.id)
          .map((r) => view(actor.id, r.id, native)),
        targets: await adapters.targets(actor),
        preferences: preferences(actor.id),
      };
    },
    cached(actor) {
      const native = sync(actor);
      return {
        conversations: db
          .prepare('SELECT id FROM assistant_conversations WHERE owner=? ORDER BY updated_at DESC')
          .all(actor.id)
          .map((r) => view(actor.id, r.id, native)),
        preferences: preferences(actor.id),
      };
    },
    async patch(actor, id, input) {
      const p = conversationPatchSchema.parse(input),
        r = row(actor.id, uuid.parse(id)),
        at = stamp();
      db.prepare(
        'UPDATE assistant_conversations SET title=?,pinned_at=?,archived_at=?,updated_at=? WHERE owner=? AND id=?',
      ).run(
        p.title ?? r.title,
        p.pinned === undefined ? r.pinned_at : p.pinned ? at : null,
        p.archived === undefined ? r.archived_at : p.archived ? at : null,
        at,
        actor.id,
        id,
      );
      return view(actor.id, id, adapters.nativeList(actor));
    },
    async handoff(owner, ref) {
      const s = segment(owner, ref);
      if (!s) return [];
      const previous = refs(owner, s.display_id).slice(0, s.ordinal);
      // Revalidate each source before handing any saved text to a new model task.
      const actor = adapters.actor(owner);
      for (const r of previous) await adapters.visible(actor, r);
      return JSON.parse(s.handoff);
    },
  };
}
