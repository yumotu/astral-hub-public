import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createAccounts } from '../server/accounts.mjs';
import { createPiConversations } from '../server/pi-conversations.mjs';
import { conversationList } from '../shared/pi-conversation-list.mjs';

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
