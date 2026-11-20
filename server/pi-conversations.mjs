import { fail } from './accounts.mjs';
import { createAgentBindings, serverPiRuntime } from './agent-bindings.mjs';

export function createPiConversations(db, { now = Date.now } = {}) {
  db.exec(`CREATE TABLE IF NOT EXISTS pi_conversations(
    owner TEXT NOT NULL REFERENCES users(id),id TEXT NOT NULL,title TEXT,
    project_id TEXT,access TEXT NOT NULL DEFAULT 'read',pinned_at TEXT,archived_at TEXT,
    created_at TEXT NOT NULL,updated_at TEXT NOT NULL,PRIMARY KEY(owner,id));
    CREATE TABLE IF NOT EXISTS pi_preferences(
    owner TEXT PRIMARY KEY REFERENCES users(id),default_project_id TEXT);`);
  const columns = db
    .prepare('PRAGMA table_info(pi_conversations)')
    .all()
    .map((c) => c.name);
  if (!columns.includes('title_source')) {
    db.exec('ALTER TABLE pi_conversations ADD COLUMN title_source TEXT');
    db.exec("UPDATE pi_conversations SET title_source='manual' WHERE title IS NOT NULL");
  }
  if (!columns.includes('title_attempted'))
    db.exec('ALTER TABLE pi_conversations ADD COLUMN title_attempted INTEGER NOT NULL DEFAULT 0');
  const select = `SELECT id,title,title_source AS titleSource,project_id AS projectId,access,pinned_at AS pinnedAt,
    archived_at AS archivedAt,created_at AS createdAt,updated_at AS updatedAt FROM pi_conversations`;
  const bindings = createAgentBindings(db);
  for (const row of db.prepare('SELECT owner,id,project_id FROM pi_conversations').all())
    bindings.bind(row.owner, 'server', row.id, serverPiRuntime(row.owner, row.id, row.project_id));
  // Pre-metadata releases can have history without a sidebar record.
  for (const table of ['pi_turns', 'pi_jobs']) {
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table))
      continue;
    for (const row of db
      .prepare(`SELECT DISTINCT owner,conversation_id AS id,project_id FROM ${table}`)
      .all())
      bindings.bind(
        row.owner,
        'server',
        row.id,
        serverPiRuntime(row.owner, row.id, row.project_id),
      );
  }
  const view = (owner, row) =>
    row ? { ...row, runtime: serverPiRuntime(owner, row.id, row.projectId) } : null;
  const get = (owner, id) =>
    view(owner, db.prepare(`${select} WHERE owner=? AND id=?`).get(owner, id));
  return {
    get,
    list: (owner) =>
      db
        .prepare(`${select} WHERE owner=?`)
        .all(owner)
        .map((row) => view(owner, row)),
    preferences(owner) {
      const row = db
        .prepare('SELECT default_project_id AS defaultProjectId FROM pi_preferences WHERE owner=?')
        .get(owner);
      return row ? { ...row, configured: true } : { defaultProjectId: null, configured: false };
    },
    setPreferences(owner, defaultProjectId) {
      db.prepare(
        'INSERT INTO pi_preferences(owner,default_project_id) VALUES(?,?) ON CONFLICT(owner) DO UPDATE SET default_project_id=excluded.default_project_id',
      ).run(owner, defaultProjectId);
      return this.preferences(owner);
    },
    create(owner, id, { projectId = null, access = 'read' } = {}) {
      const runtime = serverPiRuntime(owner, id, projectId);
      bindings.assert(owner, 'server', id, runtime);
      const existing = get(owner, id);
      if (existing) {
        if (existing.projectId !== projectId)
          throw fail(409, '此对话已绑定其他项目，请建立新对话。');
        return existing;
      }
      if (
        db.prepare('SELECT COUNT(*) AS count FROM pi_conversations WHERE owner=?').get(owner)
          .count >= 2000
      )
        throw fail(400, '对话数量已达上限，请先删除不需要的对话。');
      const timestamp = new Date(now()).toISOString();
      bindings.bind(owner, 'server', id, runtime);
      db.prepare(
        'INSERT INTO pi_conversations(owner,id,project_id,access,created_at,updated_at) VALUES(?,?,?,?,?,?)',
      ).run(owner, id, projectId, access, timestamp, timestamp);
      return get(owner, id);
    },
    patch(owner, id, patch) {
      const existing = get(owner, id);
      if (!existing) throw fail(404, '对话不存在。');
      const timestamp = new Date(now()).toISOString();
      db.prepare(
        'UPDATE pi_conversations SET title=?,title_source=?,pinned_at=?,archived_at=?,updated_at=? WHERE owner=? AND id=?',
      ).run(
        patch.title ?? existing.title,
        patch.title === undefined ? existing.titleSource : 'manual',
        patch.pinned === undefined
          ? existing.pinnedAt
          : patch.pinned
            ? existing.pinnedAt || timestamp
            : null,
        patch.archived === undefined
          ? existing.archivedAt
          : patch.archived
            ? existing.archivedAt || timestamp
            : null,
        timestamp,
        owner,
        id,
      );
      return get(owner, id);
    },
    seedTitle(owner, id, title) {
      db.prepare(
        "UPDATE pi_conversations SET title=?,title_source='seed' WHERE owner=? AND id=? AND COALESCE(title_source,'')!='manual'",
      ).run(title, owner, id);
      return get(owner, id);
    },
    claimAITitle(owner, id) {
      return (
        db
          .prepare(
            "UPDATE pi_conversations SET title_attempted=1 WHERE owner=? AND id=? AND title_attempted=0 AND COALESCE(title_source,'') NOT IN ('manual','ai')",
          )
          .run(owner, id).changes === 1
      );
    },
    applyAITitle(owner, id, title) {
      db.prepare(
        "UPDATE pi_conversations SET title=?,title_source='ai',updated_at=? WHERE owner=? AND id=? AND title_attempted=1 AND COALESCE(title_source,'') NOT IN ('manual','ai')",
      ).run(title, new Date(now()).toISOString(), owner, id);
      return get(owner, id);
    },
    remove(owner, id) {
      db.prepare('DELETE FROM pi_conversations WHERE owner=? AND id=?').run(owner, id);
    },
  };
}
