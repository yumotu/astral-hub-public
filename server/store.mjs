import { DatabaseSync } from 'node:sqlite';
export function createStore(path) {
  const db = new DatabaseSync(path);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
    CREATE TABLE IF NOT EXISTS records(id TEXT PRIMARY KEY,data TEXT,deleted INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS chat_messages(id TEXT PRIMARY KEY,data TEXT,deleted INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS plugins(id TEXT PRIMARY KEY,manifest TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS migrations(name TEXT PRIMARY KEY);
    CREATE TABLE IF NOT EXISTS private_records(owner TEXT NOT NULL,id TEXT NOT NULL,data TEXT,deleted INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(owner,id));
    CREATE TABLE IF NOT EXISTS private_chat(owner TEXT NOT NULL,id TEXT NOT NULL,data TEXT,deleted INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(owner,id));
    CREATE TABLE IF NOT EXISTS private_plugins(owner TEXT NOT NULL,id TEXT NOT NULL,manifest TEXT NOT NULL,PRIMARY KEY(owner,id));`);
  // 只迁移一次。旧令牌及第一个管理员共用 legacy 空间，普通账号不会读取旧数据。
  if (!db.prepare('SELECT 1 FROM migrations WHERE name=?').get('private-v1')) {
    db.exec(`BEGIN IMMEDIATE;
      INSERT INTO private_records SELECT 'legacy',id,data,deleted FROM records;
      INSERT INTO private_chat SELECT 'legacy',id,data,deleted FROM chat_messages;
      INSERT INTO private_plugins SELECT 'legacy',id,manifest FROM plugins;
      INSERT INTO migrations VALUES('private-v1'); COMMIT;`);
  }
  function all(table, owner) {
    return db
      .prepare(`SELECT id,data,deleted FROM ${table} WHERE owner=? ORDER BY id`)
      .all(owner)
      .map((r) => ({ id: r.id, deleted: !!r.deleted, data: r.data ? JSON.parse(r.data) : null }));
  }
  function sync(table, entries, owner) {
    db.exec('BEGIN IMMEDIATE');
    try {
      for (const e of entries) {
        const old = db.prepare(`SELECT * FROM ${table} WHERE owner=? AND id=?`).get(owner, e.id);
        if (e.deleted) {
          db.prepare(
            `INSERT INTO ${table}(owner,id,data,deleted) VALUES(?,?,NULL,1) ON CONFLICT(owner,id) DO UPDATE SET data=NULL,deleted=1`,
          ).run(owner, e.id);
        } else if (!old?.deleted) {
          const data = JSON.stringify(e.data);
          if (old && old.data !== data)
            throw Object.assign(new Error('同一记录已存在不同内容，请先拉取记录'), { status: 409 });
          if (!old)
            db.prepare(`INSERT INTO ${table}(owner,id,data,deleted) VALUES(?,?,?,0)`).run(
              owner,
              e.id,
              data,
            );
        }
      }
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
    return all(table, owner);
  }
  return {
    db,
    sync: (entries, owner = 'legacy') => sync('private_records', entries, owner),
    syncChat: (entries, owner = 'legacy') => sync('private_chat', entries, owner),
    all: (owner = 'legacy') => all('private_records', owner),
    plugins(owner = 'legacy') {
      return db
        .prepare('SELECT manifest FROM private_plugins WHERE owner=? ORDER BY id')
        .all(owner)
        .map((r) => JSON.parse(r.manifest));
    },
    savePlugin(p, owner = 'legacy') {
      db.prepare(
        'INSERT INTO private_plugins(owner,id,manifest) VALUES(?,?,?) ON CONFLICT(owner,id) DO UPDATE SET manifest=excluded.manifest',
      ).run(owner, p.id, JSON.stringify(p));
    },
    deletePlugin(id, owner = 'legacy') {
      db.prepare('DELETE FROM private_plugins WHERE owner=? AND id=?').run(owner, id);
    },
    close() {
      db.close();
    },
  };
}
