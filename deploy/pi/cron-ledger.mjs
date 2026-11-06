import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';

export const cronTerminal = new Set(['done', 'error', 'cancelled', 'interrupted']);
export function scheduledId(owner, job, slot) {
  const hex = createHash('sha256')
    .update(JSON.stringify([owner, job, slot]))
    .digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
export function createCronLedger(file, ownerId) {
  const db = new DatabaseSync(file);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS contexts(job_id TEXT PRIMARY KEY, context TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS runs(id TEXT PRIMARY KEY, job_id TEXT NOT NULL, slot TEXT NOT NULL,
      payload TEXT NOT NULL, state TEXT NOT NULL, reported INTEGER NOT NULL DEFAULT 0,
      UNIQUE(job_id,slot));`);
  const decode = (r) => r && { ...JSON.parse(r.payload), ...JSON.parse(r.state) };
  const get = (id) => decode(db.prepare('SELECT * FROM runs WHERE id=?').get(id));
  const all = () => db.prepare('SELECT * FROM runs ORDER BY rowid').all().map(decode);
  return {
    db,
    get,
    all,
    context: (jobId) => {
      const r = db.prepare('SELECT context FROM contexts WHERE job_id=?').get(jobId);
      return r && JSON.parse(r.context);
    },
    bind(jobId, context) {
      db.prepare(
        'INSERT INTO contexts VALUES(?,?) ON CONFLICT(job_id) DO UPDATE SET context=excluded.context',
      ).run(jobId, JSON.stringify(context));
    },
    active: (jobId) => all().some((r) => r.jobId === jobId && !cronTerminal.has(r.status)),
    enqueue(job, slot, context) {
      const id = scheduledId(ownerId, job.id, slot);
      const old = get(id);
      if (old) return old;
      const payload = {
        id,
        ownerId,
        jobId: job.id,
        jobName: job.name,
        scheduledAt: slot,
        conversationId: context.conversationId,
        projectId: context.projectId || null,
        access: context.access || 'read',
        thinkingLevel: context.thinkingLevel || 'off',
        timeZone: context.timeZone || 'Asia/Shanghai',
        model: context.model,
        toolAllowlist: job.tools ?? context.toolNames,
        skills: job.skills || [],
        input: `【定时任务：${job.name}】\n${job.prompt}`,
      };
      const state = {
        status: 'queued',
        createdAt: new Date().toISOString(),
        output: '',
        error: '',
      };
      db.prepare('INSERT OR IGNORE INTO runs(id,job_id,slot,payload,state) VALUES(?,?,?,?,?)').run(
        id,
        job.id,
        slot,
        JSON.stringify(payload),
        JSON.stringify(state),
      );
      return get(id);
    },
    pending: () =>
      all()
        .filter((r) => !cronTerminal.has(r.status))
        .slice(0, 100),
    update(id, patch) {
      const current = get(id);
      if (!current) throw new Error('定时执行不存在。');
      if (cronTerminal.has(current.status)) return current;
      const r = db.prepare('SELECT state FROM runs WHERE id=?').get(id);
      db.prepare('UPDATE runs SET state=? WHERE id=?').run(
        JSON.stringify({ ...JSON.parse(r.state), ...patch, updatedAt: new Date().toISOString() }),
        id,
      );
      return get(id);
    },
    unreported: () =>
      db
        .prepare('SELECT * FROM runs WHERE reported=0')
        .all()
        .map(decode)
        .filter((r) => cronTerminal.has(r.status)),
    reported(id) {
      db.prepare('UPDATE runs SET reported=1 WHERE id=?').run(id);
    },
    close() {
      db.close();
    },
  };
}
