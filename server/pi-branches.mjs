import { randomUUID, createHash } from 'node:crypto';
import { fail } from './accounts.mjs';

function inheritedTurnId(conversation, turn) {
  const h = createHash('sha256').update(`${conversation}:${turn}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

export function createPiBranches(db, { accounts, metadata, chatFiles, forkNative }) {
  db.exec(`CREATE TABLE IF NOT EXISTS pi_branches(owner TEXT NOT NULL,id TEXT NOT NULL,
    source_conversation TEXT NOT NULL,source_turn TEXT NOT NULL,position TEXT NOT NULL,
    state TEXT NOT NULL,PRIMARY KEY(owner,id));`);
  const locks = new Set();
  const get = (owner, id) =>
    db.prepare('SELECT * FROM pi_branches WHERE owner=? AND id=?').get(owner, id);
  const info = (owner, id) => {
    const row = get(owner, id);
    return row?.state === 'ready'
      ? { conversationId: row.source_conversation, turnId: row.source_turn, position: row.position }
      : null;
  };
  return {
    info,
    pending: (owner, id) => {
      const row = get(owner, id);
      return row && row.state !== 'ready';
    },
    async create(owner, source, p, running) {
      const lock = `${owner}:${p.id}`;
      if (locks.has(lock)) throw fail(409, '此分支正在建立，请稍候。');
      const prior = get(owner, p.id);
      if (
        prior &&
        (prior.source_conversation !== source ||
          prior.source_turn !== p.turnId ||
          prior.position !== p.position)
      )
        throw fail(409, '分支编号已存在不同来源。');
      if (prior?.state === 'ready') return this.result(owner, p.id);
      if (
        !prior &&
        (metadata.get(owner, p.id) ||
          accounts.piScope(owner, p.id) ||
          chatFiles.list(owner, p.id).length)
      )
        throw fail(409, '目标对话已存在。');
      const original = accounts.piTurn(owner, p.turnId);
      const task = running;
      if (
        (original && original.conversation_id !== source) ||
        (!original && (!task || task.conversationId !== source || task.parentId))
      )
        throw fail(404, '原消息不存在。');
      if (p.position === 'after' && !original)
        throw fail(409, '请等待这条回复完成，或从问题处编辑并分支。');
      const scope = original
        ? { projectId: original.project_id, access: original.access }
        : { projectId: task.projectId, access: task.access };
      const input = original?.input || task.input;
      const rows = db
        .prepare(
          `SELECT * FROM pi_turns WHERE owner=? AND conversation_id=? AND ${original ? 'seq ' + (p.position === 'after' ? '<=' : '<') + ' ?' : 'created_at < ?'} ORDER BY seq`,
        )
        .all(owner, source, original?.seq ?? task.createdAt);
      const fields = ['tools', 'timeline', 'attachments', 'artifacts', 'supplements', 'execution'];
      const history = rows.map((row) => ({
        ...row,
        ...Object.fromEntries(
          fields.map((key) => [key, JSON.parse(row[key] || (key === 'execution' ? 'null' : '[]'))]),
        ),
      }));
      if (history.length > 10000) throw fail(413, '这段历史过长，暂时无法建立分支。');
      const inherited = new Map(history.map((t) => [t.id, inheritedTurnId(p.id, t.id)]));
      const draft =
        p.position === 'before'
          ? original
            ? JSON.parse(original.attachments || '[]')
            : task.attachmentFiles || []
          : [];
      const references = history
        .flatMap((t) => [
          ...t.attachments,
          ...t.artifacts,
          ...t.supplements.flatMap((s) => s.attachments || []),
        ])
        .concat(draft);
      locks.add(lock);
      db.prepare("INSERT OR IGNORE INTO pi_branches VALUES(?,?,?,?,?,'preparing')").run(
        owner,
        p.id,
        source,
        p.turnId,
        p.position,
      );
      try {
        const native = await forkNative({
          owner,
          source,
          target: p.id,
          turnId: p.turnId,
          position: p.position,
          input,
          checkpoints: [...inherited].map(([from, to]) => ({ from, to })),
        });
        await chatFiles.removeConversation(owner, p.id);
        const files = new Map();
        for (const f of references)
          if (!files.has(f.id)) files.set(f.id, await chatFiles.clone(owner, source, p.id, f.id));
        const map = (list) => list.map((f) => files.get(f.id));
        db.exec('BEGIN IMMEDIATE');
        try {
          metadata.create(owner, p.id, scope);
          metadata.seedTitle(
            owner,
            p.id,
            (metadata.get(owner, source)?.title || input.slice(0, 40)) + ' · 分支',
          );
          for (const t of history) {
            const supplements = t.supplements.map((s) => ({
              ...s,
              id: randomUUID(),
              attachments: map(s.attachments || []),
            }));
            db.prepare(
              'INSERT INTO pi_turns(id,owner,conversation_id,input,output,created_at,project_id,access,tools,thinking,timeline,attachments,artifacts,supplements,execution) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
            ).run(
              inherited.get(t.id),
              owner,
              p.id,
              t.input,
              t.output,
              t.created_at,
              t.project_id,
              t.access,
              JSON.stringify(t.tools),
              t.thinking,
              JSON.stringify(t.timeline),
              JSON.stringify(map(t.attachments)),
              JSON.stringify(map(t.artifacts)),
              JSON.stringify(supplements),
              JSON.stringify(t.execution),
            );
          }
          db.prepare("UPDATE pi_branches SET state='ready' WHERE owner=? AND id=?").run(
            owner,
            p.id,
          );
          // Draft attachment IDs and the edited prompt persist across response loss.
          db.exec(
            'CREATE TABLE IF NOT EXISTS pi_branch_drafts(owner TEXT NOT NULL,id TEXT NOT NULL,input TEXT NOT NULL,files TEXT NOT NULL,PRIMARY KEY(owner,id))',
          );
          db.prepare('INSERT OR REPLACE INTO pi_branch_drafts VALUES(?,?,?,?)').run(
            owner,
            p.id,
            p.position === 'before' ? input : '',
            JSON.stringify(map(draft)),
          );
          db.exec('COMMIT');
        } catch (e) {
          db.exec('ROLLBACK');
          throw e;
        }
        return { ...this.result(owner, p.id), native: !!native?.native };
      } catch (e) {
        await chatFiles.removeConversation(owner, p.id);
        throw e;
      } finally {
        locks.delete(lock);
      }
    },
    result(owner, id) {
      const exists = db.prepare("SELECT 1 FROM sqlite_master WHERE name='pi_branch_drafts'").get();
      const draft =
        exists &&
        db
          .prepare('SELECT input,files FROM pi_branch_drafts WHERE owner=? AND id=?')
          .get(owner, id);
      return {
        conversation: metadata.get(owner, id),
        branch: info(owner, id),
        draft: draft
          ? { input: draft.input, attachments: JSON.parse(draft.files) }
          : { input: '', attachments: [] },
      };
    },
  };
}
