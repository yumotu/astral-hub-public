import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createPiConversations } from '../server/pi-conversations.mjs';
import { createPiTitles } from '../server/pi-titles.mjs';
function fixture(t) {
  const db = new DatabaseSync(':memory:');
  db.exec("CREATE TABLE users(id TEXT PRIMARY KEY); INSERT INTO users VALUES('a'),('b')");
  t.after(() => db.close());
  return { db, metadata: createPiConversations(db) };
}
const tick = () => new Promise((r) => setImmediate(r));
test('AI titles are generated once and a concurrent manual rename always wins', async (t) => {
  const { metadata } = fixture(t);
  metadata.create('a', 'chat');
  let release,
    calls = 0;
  const service = createPiTitles(metadata, async () => {
    calls++;
    return new Promise((r) => (release = r));
  });
  service.consider('a', { conversationId: 'chat', input: '讨论项目结构' }, '先检查配置');
  service.consider('a', { conversationId: 'chat', input: '补充' }, '更多内容');
  await tick();
  assert.equal(calls, 1);
  metadata.patch('a', 'chat', { title: '我的项目' });
  release('项目结构检查');
  await tick();
  assert.equal(metadata.get('a', 'chat').title, '我的项目');
  assert.equal(metadata.get('a', 'chat').titleSource, 'manual');
});
test('branch seed can receive its own AI name; owners, deleted chats and closed services stay isolated', async (t) => {
  const { metadata } = fixture(t);
  metadata.create('a', 'branch');
  metadata.create('b', 'branch');
  metadata.seedTitle('a', 'branch', '旧话题 · 分支');
  const service = createPiTitles(metadata, async () => '新的分支主题');
  service.consider('a', { conversationId: 'branch', input: '新主题' }, '回复');
  await tick();
  await tick();
  assert.equal(metadata.get('a', 'branch').title, '新的分支主题');
  assert.equal(metadata.get('a', 'branch').titleSource, 'ai');
  assert.equal(metadata.get('b', 'branch').title, null);
  metadata.create('a', 'deleted');
  let release;
  const delayed = createPiTitles(metadata, () => new Promise((r) => (release = r)));
  delayed.consider('a', { conversationId: 'deleted', input: '内容' }, '输出');
  await tick();
  metadata.remove('a', 'deleted');
  release('不应重建');
  await tick();
  assert.equal(metadata.get('a', 'deleted'), null);
  metadata.create('a', 'closed');
  let complete;
  const closing = createPiTitles(metadata, () => new Promise((r) => (complete = r)));
  closing.consider('a', { conversationId: 'closed', input: '内容' }, '输出');
  await tick();
  closing.close();
  complete('不应写入');
  await tick();
  assert.equal(metadata.get('a', 'closed').title, null);
});
test('AI failure keeps the fallback and does not retry or name temporary assistance', async (t) => {
  const { metadata } = fixture(t);
  metadata.create('a', 'chat');
  let calls = 0;
  const service = createPiTitles(metadata, async () => {
    calls++;
    throw Error('offline');
  });
  service.consider('a', { conversationId: 'chat', input: '输入', assistance: true }, '输出');
  await tick();
  assert.equal(calls, 0);
  service.consider('a', { conversationId: 'chat', input: '输入' }, '输出');
  await tick();
  service.consider('a', { conversationId: 'chat', input: '输入' }, '输出');
  await tick();
  assert.equal(calls, 1);
  assert.equal(metadata.get('a', 'chat').title, null);
});
