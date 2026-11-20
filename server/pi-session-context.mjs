import { z } from 'zod';

const count = z.number().finite().nonnegative().max(1e15);
const contextSchema = z.object({
  messageCount: count.optional(),
  autoCompaction: z.boolean().optional(),
  limits: z.object({
    model: z.string().max(200),
    contextWindow: count,
    requestedContextWindow: count.nullable(),
    minContextWindow: count,
    maxContextWindow: count.nullable(),
    maxOutputTokens: count.nullable(),
    source: z.enum(['api', 'cache', 'unavailable']),
    fetchedAt: z.string().max(100).nullable(),
    warning: z.string().max(2000),
    activeContextWindow: count.nullable().optional(),
  }).optional(),
  stats: z.object({
    tokens: z.object({
      input: count.optional(), output: count.optional(), cacheRead: count.optional(),
      cacheWrite: count.optional(), total: count.optional(),
    }).optional(),
    contextUsage: z.object({
      tokens: count.nullable(), contextWindow: count, percent: count.nullable(),
    }).optional(),
    userMessages: count.optional(), assistantMessages: count.optional(),
    toolCalls: count.optional(), cost: count.optional(),
  }).optional(),
});

function boundedContext(value) {
  try {
    if (!value || Buffer.byteLength(JSON.stringify(value)) > 16384) return null;
    const parsed = contextSchema.safeParse(value);
    return parsed.success && Object.keys(parsed.data).length ? parsed.data : null;
  } catch { return null; }
}

// Current observations live separately from immutable per-turn execution data.
// A reservation invalidates older in-flight observations, including on restart.
export function createPiSessionContext(db, { now = Date.now } = {}) {
  db.exec(`CREATE TABLE IF NOT EXISTS pi_session_context(
    owner TEXT NOT NULL REFERENCES users(id),conversation_id TEXT NOT NULL,
    generation INTEGER NOT NULL DEFAULT 0,revision INTEGER NOT NULL DEFAULT 0,
    baseline_task_id TEXT,source TEXT,observed_at TEXT,context TEXT,
    PRIMARY KEY(owner,conversation_id));`);
  const baseline = (owner, id) => db.prepare(
    'SELECT id FROM pi_turns WHERE owner=? AND conversation_id=? ORDER BY seq DESC LIMIT 1',
  ).get(owner, id)?.id || null;
  const closed = (owner, id) => !!db.prepare(
    'SELECT 1 FROM pi_closed_conversations WHERE owner=? AND conversation_id=?',
  ).get(owner, id);
  function get(owner, id) {
    const row = db.prepare('SELECT * FROM pi_session_context WHERE owner=? AND conversation_id=?').get(owner, id);
    if (!row?.revision || row.baseline_task_id !== baseline(owner, id) || closed(owner, id)) return null;
    return {
      conversationId: id, revision: row.revision, baselineTaskId: row.baseline_task_id,
      source: row.source, observedAt: row.observed_at,
      context: row.context ? JSON.parse(row.context) : null,
    };
  }
  function begin(owner, id) {
    if (closed(owner, id)) return null;
    const row = db.prepare(`INSERT INTO pi_session_context(owner,conversation_id,generation) VALUES(?,?,1)
      ON CONFLICT(owner,conversation_id) DO UPDATE SET generation=generation+1 RETURNING generation`).get(owner, id);
    return { revision: row.generation, baselineTaskId: baseline(owner, id) };
  }
  function commit(owner, id, ticket, value, source = 'inspect') {
    if (!ticket || closed(owner, id) || baseline(owner, id) !== ticket.baselineTaskId) return false;
    if (!['inspect', 'compact', 'task'].includes(source)) return false;
    const context = boundedContext(value);
    return !!db.prepare(`UPDATE pi_session_context SET revision=?,baseline_task_id=?,source=?,observed_at=?,context=?
      WHERE owner=? AND conversation_id=? AND generation=?`).run(
      ticket.revision, ticket.baselineTaskId, source, new Date(now()).toISOString(),
      context ? JSON.stringify(context) : null, owner, id, ticket.revision,
    ).changes;
  }
  return {
    get, begin, commit,
    task(owner, id, value) { commit(owner, id, begin(owner, id), value, 'task'); },
    remove(owner, id) { db.prepare('DELETE FROM pi_session_context WHERE owner=? AND conversation_id=?').run(owner, id); },
  };
}
