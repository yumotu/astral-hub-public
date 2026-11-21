import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { fail } from './accounts.mjs';

export const superAgentTaskStatuses = Object.freeze([
  'queued',
  'running',
  'waiting_user',
  'succeeded',
  'failed',
  'unknown',
  'cancelled',
]);

const taskId = z.string().uuid();
const runtime = z.enum(['Pi', 'DPH', 'Remote']);
const createSchema = z
  .object({
    id: taskId,
    title: z.string().trim().min(1).max(200),
    input: z.string().trim().min(1).max(8000),
    runtime: runtime.default('DPH'),
    conversationId: z.string().max(200).nullable().optional(),
    projectId: z.string().max(100).nullable().optional(),
  })
  .strict();
const reportSchema = z
  .object({
    status: z.enum(superAgentTaskStatuses),
    revision: z.number().int().positive(),
    progress: z.number().int().min(0).max(100).optional(),
    report: z.string().max(12000).optional(),
    attention: z.string().max(12000).optional(),
  })
  .strict();

const transitions = new Map([
  ['queued', new Set(['running', 'cancelled', 'unknown'])],
  ['running', new Set(['running', 'waiting_user', 'succeeded', 'failed', 'unknown', 'cancelled'])],
  ['waiting_user', new Set(['running', 'cancelled', 'unknown'])],
  ['succeeded', new Set()],
  ['failed', new Set()],
  ['unknown', new Set()],
  ['cancelled', new Set()],
]);

function ownerText(value) {
  if (typeof value !== 'string' || value.trim().length === 0) throw new TypeError('owner must be non-empty text');
  return value.trim();
}

function decode(row) {
  if (!row) return null;
  return {
    id: row.id,
    title: row.title,
    input: row.input,
    executor: 'subagent',
    runtime: row.runtime,
    conversationId: row.conversation_id,
    projectId: row.project_id,
    status: row.status,
    progress: row.progress,
    report: row.report,
    attention: row.attention,
    revision: row.revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function createSuperAgent(db, { now = Date.now } = {}) {
  db.exec(`CREATE TABLE IF NOT EXISTS superagent_tasks(
    owner TEXT NOT NULL,
    id TEXT NOT NULL,
    title TEXT NOT NULL,
    input TEXT NOT NULL,
    runtime TEXT NOT NULL,
    conversation_id TEXT,
    project_id TEXT,
    status TEXT NOT NULL,
    progress INTEGER NOT NULL DEFAULT 0,
    report TEXT NOT NULL DEFAULT '',
    attention TEXT NOT NULL DEFAULT '',
    revision INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY(owner,id)
  );
  CREATE INDEX IF NOT EXISTS superagent_tasks_owner_updated ON superagent_tasks(owner,updated_at DESC);
  CREATE TABLE IF NOT EXISTS superagent_task_events(
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    owner TEXT NOT NULL,
    task_id TEXT NOT NULL,
    event TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS superagent_task_events_owner ON superagent_task_events(owner,seq);`);

  const at = () => new Date(now()).toISOString();
  const row = (owner, id) => db.prepare('SELECT * FROM superagent_tasks WHERE owner=? AND id=?').get(ownerText(owner), id);
  const get = (owner, id) => decode(row(owner, id));
  const list = (owner) => db.prepare('SELECT * FROM superagent_tasks WHERE owner=? ORDER BY updated_at DESC LIMIT 100').all(ownerText(owner)).map(decode);
  const event = (owner, id, data) => {
    db.prepare('INSERT INTO superagent_task_events(owner,task_id,event,created_at) VALUES(?,?,?,?)').run(ownerText(owner), id, JSON.stringify(data), at());
  };

  function create(owner, input) {
    const actor = ownerText(owner);
    const value = createSchema.parse(input);
    const existing = get(actor, value.id);
    if (existing) {
      if (existing.title !== value.title || existing.input !== value.input || existing.runtime !== value.runtime)
        throw fail(409, '委派任务编号已存在其他内容。');
      return existing;
    }
    const timestamp = at();
    db.prepare('INSERT INTO superagent_tasks(owner,id,title,input,runtime,conversation_id,project_id,status,progress,report,attention,revision,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(
      actor,
      value.id,
      value.title,
      value.input,
      value.runtime,
      value.conversationId || null,
      value.projectId || null,
      'queued',
      0,
      '',
      '',
      1,
      timestamp,
      timestamp,
    );
    event(actor, value.id, { type: 'created', executor: 'subagent', runtime: value.runtime, title: value.title });
    return get(actor, value.id);
  }

  function report(owner, id, input) {
    const actor = ownerText(owner);
    const current = get(actor, id);
    if (!current) throw fail(404, '委派任务不存在。');
    const value = reportSchema.parse(input);
    if (current.revision !== value.revision) throw fail(409, '委派任务已更新，请重新读取。');
    if (['succeeded', 'failed', 'unknown', 'cancelled'].includes(current.status)) throw fail(409, '委派任务已经结束，不能再次更新。');
    if (value.status !== current.status && !transitions.get(current.status)?.has(value.status)) throw fail(409, '委派任务状态不能回退。');
    const timestamp = at();
    db.prepare('UPDATE superagent_tasks SET status=?,progress=?,report=?,attention=?,revision=?,updated_at=? WHERE owner=? AND id=?').run(
      value.status,
      value.progress ?? current.progress,
      value.report ?? current.report,
      value.attention ?? current.attention,
      current.revision + 1,
      timestamp,
      actor,
      id,
    );
    event(actor, id, { type: 'report', status: value.status, progress: value.progress ?? current.progress, ...(value.report ? { report: value.report } : {}), ...(value.attention ? { attention: value.attention } : {}) });
    return get(actor, id);
  }

  function stop(owner, id, revision) {
    return report(owner, id, { status: 'cancelled', revision });
  }

  function snapshot(owner) {
    const tasks = list(owner);
    return {
      version: 1,
      mode: 'server',
      leader: 'SuperAgent',
      executor: 'subagent',
      tasks,
      counts: {
        active: tasks.filter((task) => ['queued', 'running'].includes(task.status)).length,
        waiting: tasks.filter((task) => task.status === 'waiting_user').length,
        completed: tasks.filter((task) => ['succeeded', 'failed', 'cancelled', 'unknown'].includes(task.status)).length,
      },
    };
  }

  return Object.freeze({
    create,
    get,
    list,
    report,
    stop,
    snapshot,
    close() {},
  });
}
