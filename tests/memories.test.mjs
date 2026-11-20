import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { createMemories } from '../server/memories.mjs';
const source = { origin: 'manual', quote: '我喜欢中文讲解' };
const data = { key: '讲解偏好', content: '我喜欢中文讲解', kind: 'preference' };
test('memory corrections are account isolated, revision checked and deletion cannot be replayed', (t) => {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  const m = createMemories(db);
  const a = m.save('alice', data, { source }),
    b = m.save('bob', { ...data, content: 'English' }, { source });
  assert.equal(m.list('alice').items.length, 1);
  assert.throws(() => m.get('bob', a.id), /不存在/);
  assert.throws(() => m.save('alice', data, { source }), /已有/);
  const corrected = m.save(
    'alice',
    { ...data, content: '我现在喜欢英文讲解' },
    { id: a.id, revision: 1, source: { ...source, quote: '我现在喜欢英文讲解' } },
  );
  assert.equal(corrected.revision, 2);
  assert.throws(() => m.save('alice', data, { id: a.id, revision: 1, source }), /其他位置/);
  assert.equal(m.recall('alice', '讲解').items[0].content, corrected.content);
  assert.equal(m.get('bob', b.id).content, 'English');
  assert.throws(() => m.remove('alice', a.id, 1), /变化/);
  m.remove('alice', a.id, 2);
  assert.deepEqual(m.recall('alice', '讲解').items, []);
  assert.throws(() => m.save('alice', data, { id: a.id, source }), /不会恢复/);
  assert.ok(
    !JSON.stringify(
      db.prepare('SELECT * FROM account_memories WHERE owner=?').all('alice'),
    ).includes('我现在喜欢'),
  );
});
test('recall is relevant, bounded, scoped and freshly obeys disabling or edits', (t) => {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  const m = createMemories(db);
  m.save('a', { key: '检索经验', kind: 'fact', content: '实现过BM25检索和RAG' }, { source });
  m.save(
    'a',
    { key: '专属项目', kind: 'fact', content: 'BM25专属参数' },
    { source, scope: 'server:p1' },
  );
  m.save(
    'a',
    { key: '另一个项目', kind: 'fact', content: 'BM25绝密' },
    { source, scope: 'computer:d:p2' },
  );
  m.save('a', { key: '无关事实', kind: 'fact', content: '喜欢去海边' }, { source });
  assert.equal(m.recall('a', 'BM25', 'server:p1').items.length, 2);
  assert.equal(m.recall('a', 'BM25').items.length, 1);
  for (let i = 0; i < 20; i++)
    m.save(
      'a',
      { key: 'RAG' + i, kind: 'fact', content: 'RAG' + '上下文'.repeat(600) },
      { source },
    );
  const r = m.recall('a', 'RAG');
  assert.ok(r.items.length <= 8 && JSON.stringify(r.items).length <= 6002);
  m.settings('a', false);
  assert.deepEqual(m.recall('a', 'RAG'), { enabled: false, items: [] });
  const reopened = createMemories(db);
  assert.equal(reopened.settings('a').enabled, false);
  reopened.settings('a', true);
  assert.ok(reopened.recall('a', 'BM25').items.length);
  assert.throws(() => m.save('a', { ...data, content: '' }, { source }), /./);
});
