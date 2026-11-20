import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createAccounts } from '../server/accounts.mjs';
import { createPiConversations } from '../server/pi-conversations.mjs';
import { conversationList, visibleConversations } from '../shared/pi-conversation-list.mjs';

test('server and computer categories share pin/archive ordering without mutating cached metadata', () => {
  const items = [
    { id: 'z', updatedAt: '2026-11-06', pinnedAt: '2026-11-03', active: 2 },
    { id: 'b', updatedAt: '2026-11-05' },
    { id: 'a', updatedAt: '2026-11-05' },
    { id: 'recent-pin', updatedAt: '2026-11-01', pinnedAt: '2026-11-04', active: 1 },
    { id: 'archived', updatedAt: '2026-11-07', archivedAt: '2026-11-07' },
  ];
  const original = structuredClone(items);
  assert.deepEqual(
    visibleConversations(items).map((c) => c.id),
    ['recent-pin', 'z', 'a', 'b'],
  );
  assert.deepEqual(
    visibleConversations(items, true).map((c) => c.id),
    ['archived'],
  );
  assert.equal(visibleConversations(items)[0].active, 1);
  assert.deepEqual(
    visibleConversations(conversationList({ metadata: items })).map((c) => c.id),
    visibleConversations(items).map((c) => c.id),
  );
  assert.deepEqual(items, original);
});

test('conversation metadata and default directory are account scoped and survive reopening the store', () => {
  const db = new DatabaseSync(':memory:');
  createAccounts(db);
  for (const id of ['alice', 'bob'])
    db.prepare(
      'INSERT INTO users(id,username,display_name,password,role,space,created_at) VALUES(?,?,?,?,?,?,?)',
    ).run(id, id, id, 'test-only', 'owner', id, new Date().toISOString());
  const store = createPiConversations(db, { now: () => 20000 });
  store.create('alice', 'a', { projectId: 'workspace' });
  store.patch('alice', 'a', { title: '保留的名称', pinned: true, archived: true });
  store.create('bob', 'a');
  store.setPreferences('alice', 'workspace');
  const reopened = createPiConversations(db);
  assert.equal(reopened.get('alice', 'a').title, '保留的名称');
  assert.ok(reopened.get('alice', 'a').pinnedAt);
  assert.ok(reopened.get('alice', 'a').archivedAt);
  assert.equal(reopened.get('bob', 'a').title, null);
  assert.equal(reopened.get('bob', 'a').pinnedAt, null);
  assert.equal(reopened.preferences('bob').configured, false);
  assert.equal(reopened.preferences('alice').defaultProjectId, 'workspace');
  assert.throws(() => reopened.create('alice', 'a', { projectId: 'other' }), { status: 409 });
  reopened.patch('alice', 'a', { pinned: false, archived: false });
  assert.equal(reopened.get('alice', 'a').archivedAt, null);
  reopened.remove('alice', 'a');
  assert.equal(reopened.get('alice', 'a'), null);
  assert.ok(reopened.get('bob', 'a'));
  db.close();
});

test('runtime migration preserves old Pi history and sidebar metadata without changing native routing or replaying tasks', () => {
  const db = new DatabaseSync(':memory:');
  try {
    const accounts = createAccounts(db);
    db.prepare(
      'INSERT INTO users(id,username,display_name,password,role,space,created_at) VALUES(?,?,?,?,?,?,?)',
    ).run('alice', 'alice', 'Alice', 'synthetic', 'owner', 'alice', new Date().toISOString());
    accounts.savePiTurn(
      'alice',
      {
        id: 'old-turn',
        conversationId: 'old-chat',
        projectId: 'workspace',
        access: 'read',
        input: 'synthetic old input',
      },
      'stored reply',
      [],
    );
    const before = db.prepare('SELECT * FROM pi_turns').all();
    const store = createPiConversations(db);
    const row = db
      .prepare(
        "SELECT runtime FROM agent_conversation_bindings WHERE owner='alice' AND origin='server' AND conversation_id='old-chat'",
      )
      .get();
    assert.equal(JSON.parse(row.runtime).backend, 'pi');
    assert.equal(JSON.parse(row.runtime).projectId, 'workspace');
    assert.deepEqual(db.prepare('SELECT * FROM pi_turns').all(), before);
    assert.equal(store.get('alice', 'old-chat'), null, 'migration does not invent sidebar titles');
    assert.throws(() => store.create('alice', 'old-chat', { projectId: 'other' }), {
      status: 409,
    });
    const reopened = createPiConversations(db);
    assert.equal(reopened.get('alice', 'old-chat'), null);
    assert.deepEqual(db.prepare('SELECT * FROM pi_turns').all(), before);
  } finally {
    db.close();
  }
});

test('history and task refreshes preserve rename, pin and archive, including task-only conversations', () => {
  const stamp = (n) => new Date(n * 1000).toISOString();
  const tasks = [
    {
      conversationId: 'old',
      input: '首条消息',
      createdAt: stamp(1),
      projectId: 'workspace',
      access: 'read',
    },
    {
      conversationId: 'new',
      input: '新任务',
      createdAt: stamp(9),
      projectId: 'workspace',
      access: 'edit',
    },
    {
      conversationId: 'new',
      input: '补充要求',
      createdAt: stamp(10),
      projectId: 'workspace',
      parentId: 'parent',
    },
  ];
  const metadata = [
    {
      id: 'old',
      title: '自定义名称',
      projectId: 'workspace',
      pinnedAt: stamp(3),
      archivedAt: stamp(4),
      updatedAt: stamp(4),
    },
  ];
  const result = conversationList({ tasks, metadata });
  assert.equal(result[0].id, 'old');
  assert.equal(result[0].title, '自定义名称');
  assert.equal(result[0].archivedAt, stamp(4));
  assert.equal(result[1].title, '新任务');
  assert.equal(result[1].updatedAt, stamp(9));
  assert.equal(result[1].access, 'edit');
  assert.deepEqual(
    tasks.map((task) => task.createdAt),
    [stamp(1), stamp(9), stamp(10)],
  );
});
