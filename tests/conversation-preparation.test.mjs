import test from 'node:test';
import assert from 'node:assert/strict';
import { createConversationPreparationJournal } from '../shared/conversation-preparation.mjs';
const id = '11111111-1111-4111-8111-111111111111',
  nativeId = '22222222-2222-4222-8222-222222222222';
const target = {
  origin: 'remote',
  projectId: 'work',
  connectionId: 'remote-a',
  projectName: '合成项目',
};
const storage = () => {
  const values = new Map();
  return { getItem: (k) => values.get(k) || null, setItem: (k, v) => values.set(k, v) };
};
test('prepare accepts a first message before create resolves and claims exactly once after readiness', () => {
  const j = createConversationPreparationJournal(storage(), 'scope');
  j.begin(id, target);
  j.draft(id, '首条消息');
  j.queue(id, '首条消息', nativeId);
  assert.equal(j.claim(id), null);
  j.resolve(id, { origin: 'remote', nativeId });
  const handoff = j.claim(id);
  assert.equal(handoff.message.id, nativeId);
  assert.equal(handoff.message.text, '首条消息');
  assert.equal(j.claim(id), null);
});
test('reopen never retries unknown creates or repeats a handed message, account scopes are isolated', () => {
  const s = storage(),
    j = createConversationPreparationJournal(s, 'a');
  j.begin(id, target);
  j.queue(id, '待发送');
  const restored = createConversationPreparationJournal(s, 'a');
  assert.equal(restored.list()[0].state, 'unknown');
  assert.equal(restored.claim(id), null);
  assert.deepEqual(createConversationPreparationJournal(s, 'b').list(), []);
  restored.resolve(id, { origin: 'remote', nativeId });
  assert.equal(restored.claim(id), null);
  restored.resume(id);
  restored.claim(id);
  const after = createConversationPreparationJournal(s, 'a');
  after.resolve(id, { origin: 'remote', nativeId });
  assert.equal(after.claim(id), null);
  assert.equal(after.list()[0].state, 'handed');
});
test('failed preparation retains full queued text and subsequent draft for explicit recovery', () => {
  const j = createConversationPreparationJournal(storage(), 'a');
  j.begin(id, target);
  j.queue(id, '首条\n正文');
  j.draft(id, '补充');
  j.fail(id, '网络中断');
  assert.equal(j.list()[0].message.text, '首条\n正文');
  j.edit(id);
  assert.equal(j.list()[0].draft, '首条\n正文\n\n补充');
  assert.equal(j.list()[0].message, undefined);
});
test('storage failure does not claim intent and cached target permissions are never accepted', () => {
  const s = storage(),
    j = createConversationPreparationJournal(s, 'a');
  j.begin(id, { ...target, allowExecute: true, authorization: 'secret' });
  j.queue(id, '内容');
  j.resolve(id, { origin: 'remote', nativeId });
  assert.equal(j.list()[0].target.allowExecute, undefined);
  assert.equal(j.list()[0].target.authorization, undefined);
  s.setItem = () => {
    throw Error('quota');
  };
  assert.throws(() => j.claim(id), /quota/);
  assert.equal(j.list()[0].state, 'ready');
});
test('restored ready intent needs explicit continuation even after fresh catalogue reconciliation', () => {
  const s = storage(),
    j = createConversationPreparationJournal(s, 'a');
  j.begin(id, target);
  j.queue(id, '明确发送', nativeId);
  j.resolve(id, { origin: 'remote', nativeId });
  const reopen = createConversationPreparationJournal(s, 'a');
  reopen.resolve(id, { origin: 'remote', nativeId, runtime: { permissions: 'not copied' } });
  assert.equal(reopen.claim(id), null);
  assert.equal(reopen.list()[0].native.runtime, undefined);
  reopen.resume(id);
  assert.equal(reopen.claim(id).message.id, nativeId);
  assert.equal(reopen.claim(id), null);
});
test('native-specific message limits reject before consuming drafts', () => {
  const j = createConversationPreparationJournal(storage(), 'a');
  j.begin(id, { origin: 'server', projectId: 'work' });
  j.draft(id, 'x'.repeat(8001));
  assert.throws(() => j.queue(id, 'x'.repeat(8001)), /8000/);
  assert.equal(j.list()[0].draft.length, 8001);
  assert.equal(j.list()[0].message, undefined);
  const remote = createConversationPreparationJournal(storage(), 'b');
  remote.begin(id, target);
  remote.queue(id, '长'.repeat(64000));
  assert.equal(remote.list()[0].message.text.length, 64000);
});
test('a failed draft persistence keeps the newest typed text in memory', () => {
  const s = storage(),
    j = createConversationPreparationJournal(s, 'a');
  j.begin(id, target);
  s.setItem = () => {
    throw Error('quota');
  };
  assert.throws(() => j.draft(id, '不能丢失的新输入'), /quota/);
  assert.equal(j.list()[0].draft, '不能丢失的新输入');
});
test('failed cleanup retains handed intent and cannot create a second submission', () => {
  const s = storage(),
    j = createConversationPreparationJournal(s, 'a');
  j.begin(id, target);
  j.queue(id, '已交接');
  j.resolve(id, { origin: 'remote', nativeId });
  j.claim(id);
  const write = s.setItem;
  s.setItem = (key, value) => {
    if (value === '[]') throw Error('quota');
    write(key, value);
  };
  assert.throws(() => j.remove(id), /quota/);
  assert.equal(j.claim(id), null);
  assert.equal(j.list()[0].message.text, '已交接');
});

test('editing an oversized combined draft preserves both messages instead of truncating', () => {
  const j = createConversationPreparationJournal(storage(), 'a');
  j.begin(id, { origin: 'server', projectId: 'work' });
  j.queue(id, 'a'.repeat(7999));
  j.draft(id, '补充内容');
  assert.throws(() => j.edit(id), /太长/);
  assert.equal(j.list()[0].message.text.length, 7999);
  assert.equal(j.list()[0].draft, '补充内容');
});

test('failed claim exposes recoverable intent and requires explicit retry after storage returns', () => {
  const s = storage(),
    j = createConversationPreparationJournal(s, 'a');
  j.begin(id, target);
  j.queue(id, '尚未发出的消息', nativeId);
  j.resolve(id, { origin: 'remote', nativeId });
  const write = s.setItem;
  s.setItem = () => {
    throw Error('quota');
  };
  assert.throws(() => j.claim(id), /quota/);
  assert.equal(j.list()[0].resumeRequired, true);
  assert.match(j.list()[0].error, /消息尚未发送/);
  s.setItem = write;
  assert.equal(j.claim(id), null);
  j.resume(id);
  assert.equal(j.claim(id).message.id, nativeId);
  assert.equal(j.claim(id), null);
});
test('discarding local drafts releases the forty-entry cap without recreating them on reopen', () => {
  const s = storage(),
    j = createConversationPreparationJournal(s, 'a');
  const ids = Array.from({ length: 40 }, () => crypto.randomUUID());
  for (const value of ids) {
    j.begin(value, target);
    j.fail(value, '暂未连接');
  }
  assert.throws(() => j.begin(id, target), /较多/);
  j.remove(ids[0]);
  j.begin(id, target);
  assert.equal(j.list().length, 40);
  const restored = createConversationPreparationJournal(s, 'a');
  assert.equal(
    restored.list().some((v) => v.id === ids[0]),
    false,
  );
  assert.equal(restored.list().filter((v) => v.id === id).length, 1);
});
