import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPiSessionContext } from '../server/pi-session-context.mjs';

function legacy(db) {
  db.exec(`CREATE TABLE users(id TEXT PRIMARY KEY); INSERT INTO users VALUES('owner'),('member');
    CREATE TABLE pi_turns(seq INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT,owner TEXT,conversation_id TEXT,execution TEXT);
    CREATE TABLE pi_closed_conversations(owner TEXT,conversation_id TEXT);`);
}
const add = (db, id) => db.prepare('INSERT INTO pi_turns(id,owner,conversation_id,execution) VALUES(?,?,?,?)')
  .run(id, 'owner', 'chat', '{"context":{"stats":{"tokens":{"total":694807}}}}');
const observed = (total) => ({ stats: { tokens: { total } } });

test('session observations migrate an old database, persist on reopen, and preserve historical execution', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'astral-context-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'test.sqlite');
  let db = new DatabaseSync(path); legacy(db); add(db, 'old');
  let snapshots = createPiSessionContext(db);
  assert.equal(snapshots.get('owner', 'chat'), null);
  const before = db.prepare('SELECT * FROM pi_turns').all();
  const ticket = snapshots.begin('owner', 'chat');
  assert.equal(snapshots.commit('owner', 'chat', ticket, observed(703857)), true);
  const saved = snapshots.get('owner', 'chat');
  assert.equal(saved.baselineTaskId, 'old');
  assert.equal(saved.context.stats.contextUsage, undefined);
  assert.equal(snapshots.get('member', 'chat'), null);
  db.close(); db = new DatabaseSync(path); snapshots = createPiSessionContext(db);
  assert.deepEqual(snapshots.get('owner', 'chat'), saved);
  assert.deepEqual(db.prepare('SELECT * FROM pi_turns').all(), before);
  db.close();
});

test('out-of-order inspections and a new completed turn cannot roll back current statistics', () => {
  const db = new DatabaseSync(':memory:'); legacy(db); add(db, 'old');
  const snapshots = createPiSessionContext(db);
  const first = snapshots.begin('owner', 'chat'), second = snapshots.begin('owner', 'chat');
  assert.equal(snapshots.commit('owner', 'chat', second, observed(20)), true);
  assert.equal(snapshots.commit('owner', 'chat', first, observed(10)), false);
  assert.equal(snapshots.get('owner', 'chat').context.stats.tokens.total, 20);
  const oldInspection = snapshots.begin('owner', 'chat');
  add(db, 'new');
  assert.equal(snapshots.get('owner', 'chat'), null, 'new history invalidates old observations even before task snapshot saving');
  snapshots.task('owner', 'chat', observed(30));
  assert.equal(snapshots.commit('owner', 'chat', oldInspection, observed(25)), false);
  assert.equal(snapshots.get('owner', 'chat').context.stats.tokens.total, 30);
  assert.equal(snapshots.get('owner', 'chat').source, 'task');
  db.close();
});

test('unknown context stays unknown, bounded observations exclude unrelated data, and deletion blocks late responses', () => {
  const db = new DatabaseSync(':memory:'); legacy(db);
  const snapshots = createPiSessionContext(db);
  for (const value of [undefined, null, {}, { stats: { tokens: { total: -1 } } }, { extra: 'x'.repeat(16385) }]) {
    snapshots.commit('owner', 'chat', snapshots.begin('owner', 'chat'), value);
    assert.equal(snapshots.get('owner', 'chat').context, null);
  }
  snapshots.commit('owner', 'chat', snapshots.begin('owner', 'chat'), { ...observed(50), unrelatedSecret: 'must not persist' });
  assert.deepEqual(snapshots.get('owner', 'chat').context, observed(50));
  const late = snapshots.begin('owner', 'chat');
  db.prepare('INSERT INTO pi_closed_conversations VALUES(?,?)').run('owner', 'chat');
  snapshots.remove('owner', 'chat');
  assert.equal(snapshots.commit('owner', 'chat', late, observed(60)), false);
  assert.equal(snapshots.begin('owner', 'chat'), null);
  assert.equal(snapshots.get('owner', 'chat'), null);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM pi_session_context').get().count, 0);
  db.close();
});
