import { z } from 'zod';
import { createHash } from 'node:crypto';
import { fail } from './accounts.mjs';
import { readUpload } from './files.mjs';

// The content is an immutable chat snapshot. Device credentials may publish only
// into their own running job; account credentials download through ChatFiles.
export function createRelayArtifacts(db, { chatFiles, job, allowed, ownedDevice, now, limit }) {
  db.exec(`CREATE TABLE IF NOT EXISTS relay_job_files(file_id TEXT PRIMARY KEY,job_id TEXT NOT NULL,owner TEXT NOT NULL,conversation_id TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS relay_job_files_job ON relay_job_files(job_id);`);
  const busy = new Set();
  const list = (id) =>
    db
      .prepare(
        `SELECT f.id,f.name,f.bytes,f.sha256,f.created_at AS createdAt
    FROM relay_job_files a JOIN pi_files f ON f.id=a.file_id AND f.owner=a.owner AND f.conversation_id=a.conversation_id
    WHERE a.job_id=? ORDER BY a.rowid`,
      )
      .all(id);
  function active(j) {
    const fresh = job(j.device_id, j.id);
    if (fresh.status !== 'running' || fresh.lease_until <= now())
      throw fail(409, '电脑任务已结束或失联，文件未发送。');
    try {
      const d = ownedDevice(j.device_id, j.owner);
      if (d.expires <= now()) throw Error('expired');
      allowed(fresh);
    } catch {
      throw fail(409, '电脑或项目授权已撤销，文件未发送。');
    }
  }
  return {
    list,
    async before(req, url, json, device) {
      const route = url.pathname.match(
        /^\/api\/relay\/device\/workspace\/jobs\/([^/]+)\/files\/([^/]+)$/,
      );
      if (!route || !['GET', 'PUT'].includes(req.method)) return false;
      if (!chatFiles) throw fail(503, '聊天文件存储不可用。');
      const j = job(device.id, z.string().uuid().parse(route[1]));
      const id = z.string().uuid().parse(route[2]);
      const previous = db.prepare('SELECT * FROM relay_job_files WHERE file_id=?').get(id);
      if (previous && previous.job_id !== j.id) throw fail(409, '文件标识已被其他任务使用。');
      if (req.method === 'GET') {
        if (!previous) throw fail(404, '文件尚未交付。');
        json(200, { file: chatFiles.selected(j.owner, j.conversation_id, [id])[0] });
        return true;
      }
      limit('computer-files:' + device.id, 120);
      if (busy.has(j.id)) throw fail(429, '请等待当前文件上传完成。');
      let name;
      try {
        name = decodeURIComponent(req.headers['x-astral-file-name'] || '');
      } catch {
        throw fail(400, '文件名编码不正确。');
      }
      if (!name.trim() || name !== name.trim() || name.length > 160 || /[\/\\\x00-\x1f]/.test(name))
        throw fail(400, '文件名不正确。');
      if (!previous) active(j);
      busy.add(j.id);
      let created = false;
      try {
        const bytes = await readUpload(req, 10 * 1024 * 1024);
        if (previous) {
          const file = chatFiles.selected(j.owner, j.conversation_id, [id])[0];
          if (
            file.name !== name ||
            file.bytes !== bytes.length ||
            file.sha256 !== createHash('sha256').update(bytes).digest('hex')
          )
            throw fail(409, '文件已交付，但内容不同。');
          json(200, { file });
          return true;
        }
        active(j);
        const files = list(j.id);
        if (
          files.length >= 8 ||
          files.reduce((n, f) => n + f.bytes, 0) + bytes.length > 20 * 1024 * 1024
        )
          throw fail(413, '每个电脑任务最多发送8个文件、合计20 MiB。');
        if (db.prepare('SELECT 1 FROM pi_files WHERE id=?').get(id))
          throw fail(409, '文件标识已存在。');
        const file = await chatFiles.save(j.owner, j.conversation_id, name, bytes, id);
        created = true;
        active(j); // Revocation or cancellation during a slow upload still wins.
        db.exec('BEGIN IMMEDIATE');
        try {
          db.prepare('INSERT INTO relay_job_files VALUES(?,?,?,?)').run(
            id,
            j.id,
            j.owner,
            j.conversation_id,
          );
          const at = new Date(now()).toISOString();
          db.prepare('UPDATE relay_jobs SET updated_at=? WHERE id=?').run(at, j.id);
          db.prepare('UPDATE relay_conversations SET updated_at=? WHERE id=?').run(
            at,
            j.conversation_id,
          );
          db.exec('COMMIT');
          created = false;
        } catch (e) {
          db.exec('ROLLBACK');
          throw e;
        }
        json(201, { file });
        return true;
      } finally {
        try {
          if (created) await chatFiles.remove(j.owner, j.conversation_id, id);
        } finally {
          busy.delete(j.id);
        }
      }
    },
  };
}
