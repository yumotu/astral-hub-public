import { DatabaseSync } from 'node:sqlite';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

// SQLite serializes lease claims across separate Pi workers; the transaction
// ends before file IO. A dead worker's lease can be reclaimed atomically.
export async function lockProjectFile(backupDir, path) {
  await mkdir(backupDir, { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(join(backupDir, '.file-locks.sqlite'));
  const nonce = randomUUID();
  try {
    db.exec(
      'PRAGMA busy_timeout=2000; CREATE TABLE IF NOT EXISTS file_locks(path TEXT PRIMARY KEY,pid INTEGER NOT NULL,nonce TEXT NOT NULL)',
    );
    db.exec('BEGIN IMMEDIATE');
    const old = db.prepare('SELECT pid FROM file_locks WHERE path=?').get(path);
    if (old) {
      let alive = true;
      try {
        process.kill(old.pid, 0);
      } catch (e) {
        if (e.code === 'ESRCH') alive = false;
      }
      if (alive)
        throw Object.assign(new Error('另一对话正在修改此文件，请读取最新版本后再试。'), {
          status: 409,
        });
      db.prepare('DELETE FROM file_locks WHERE path=?').run(path);
    }
    db.prepare('INSERT INTO file_locks VALUES(?,?,?)').run(path, process.pid, nonce);
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
      db.prepare('DELETE FROM file_locks WHERE path=? AND nonce=?').run(path, nonce);
    } finally {
      db.close();
    }
  };
}
