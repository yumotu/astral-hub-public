import { DatabaseSync } from 'node:sqlite';
import { mkdir, chmod } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
// Readers cover the entire task, including the child Pi process. Mutations never
// replace dependency bytes while another conversation is using them.
export async function leasePackages(configPath, project, kind) {
  const dir = join(dirname(configPath), 'online-package-locks');
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(join(dir, 'leases.sqlite'));
  const nonce = randomUUID();
  try {
    await chmod(join(dir, 'leases.sqlite'), 0o600);
    db.exec(
      'PRAGMA busy_timeout=2000;CREATE TABLE IF NOT EXISTS leases(nonce TEXT PRIMARY KEY,project TEXT NOT NULL,pid INTEGER NOT NULL,kind TEXT NOT NULL);BEGIN IMMEDIATE',
    );
    for (const row of db.prepare('SELECT * FROM leases WHERE project=?').all(project)) {
      let alive = true;
      try {
        process.kill(row.pid, 0);
      } catch (e) {
        if (e.code === 'ESRCH') alive = false;
      }
      if (!alive) db.prepare('DELETE FROM leases WHERE nonce=?').run(row.nonce);
      else if (kind === 'write' || row.kind === 'write')
        throw Error('此项目有任务或插件变更正在进行，请完成后再操作；请求不会自动重放。');
    }
    db.prepare('INSERT INTO leases VALUES(?,?,?,?)').run(nonce, project, process.pid, kind);
    db.exec('COMMIT');
  } catch (e) {
    try {
      db.exec('ROLLBACK');
    } catch {}
    db.close();
    throw e;
  }
  return () => {
    try {
      db.prepare('DELETE FROM leases WHERE nonce=?').run(nonce);
    } finally {
      db.close();
    }
  };
}
