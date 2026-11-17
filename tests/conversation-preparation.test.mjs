import test from 'node:test';
import assert from 'node:assert/strict';
import { createConversationPreparationJournal } from '../shared/conversation-preparation.mjs';

// Deterministic IDB transaction scheduling; browser tests exercise the native API.
let tail = Promise.resolve();
const db = {
  transaction() {
    let release;
    const previous = tail;
    tail = new Promise((resolve) => {
      release = resolve;
    });
    let aborted = false;
    const tx = {
      abort() {
        aborted = true;
      },
      objectStore() {
        return {
          get() {
            const request = {};
            previous.then(() => {
              request.onsuccess();
              if (aborted) tx.onabort();
              else tx.oncomplete();
              release();
            });
            return request;
          },
        };
      },
    };
    return tx;
  },
};
globalThis.indexedDB = {
  open() {
    const request = { result: db };
    queueMicrotask(() => request.onsuccess());
    return request;
  },
};
const id = '11111111-1111-4111-8111-111111111111',
  nativeId = '22222222-2222-4222-8222-222222222222';
const target = { origin: 'remote', projectId: 'work', connectionId: 'remote-a' };
const storage = () => {
  const data = new Map();
  return { getItem: (k) => data.get(k) || null, setItem: (k, v) => data.set(k, v) };
};
test('prepare accepts message before readiness and claims once', async () => {
  const j = createConversationPreparationJournal(storage(), 'a');
  await j.begin(id, target);
  await j.draft(id, 'first');
  await j.queue(id, 'first', nativeId);
  assert.equal(await j.claim(id), null);
  await j.resolve(id, { origin: 'remote', nativeId });
  assert.equal((await j.claim(id)).message.text, 'first');
  assert.equal(await j.claim(id), null);
});
test('reopen requires explicit continuation and isolates account scopes', async () => {
  const s = storage(),
    j = createConversationPreparationJournal(s, 'a');
  await j.begin(id, target);
  await j.queue(id, 'first');
  const restored = createConversationPreparationJournal(s, 'a');
  assert.equal(restored.list()[0].state, 'unknown');
  assert.deepEqual(createConversationPreparationJournal(s, 'b').list(), []);
  await restored.resolve(id, { origin: 'remote', nativeId });
  assert.equal(await restored.claim(id), null);
  await restored.resume(id);
  await restored.claim(id);
  const after = createConversationPreparationJournal(s, 'a');
  await after.resolve(id, { origin: 'remote', nativeId });
  assert.equal(await after.claim(id), null);
  assert.equal(after.list()[0].state, 'handed');
});
test('failed preparation retains queued text and supplement for editing', async () => {
  const j = createConversationPreparationJournal(storage(), 'a');
  await j.begin(id, target);
  await j.queue(id, 'first');
  await j.draft(id, 'more');
  await j.fail(id, 'network');
  await j.edit(id);
  assert.equal(j.list()[0].draft, 'first\n\nmore');
  assert.equal(j.list()[0].message, undefined);
});
test('storage failure does not claim and cached permissions are stripped', async () => {
  const s = storage(),
    j = createConversationPreparationJournal(s, 'a');
  await j.begin(id, { ...target, allowExecute: true, authorization: 'secret' });
  await j.queue(id, 'first');
  await j.resolve(id, { origin: 'remote', nativeId });
  assert.equal(j.list()[0].target.allowExecute, undefined);
  assert.equal(j.list()[0].target.authorization, undefined);
  s.setItem = () => {
    throw Error('quota');
  };
  await assert.rejects(j.claim(id), /quota/);
  assert.equal(j.list()[0].state, 'ready');
});
test('restored ready intent requires continuation after reconciliation', async () => {
  const s = storage(),
    j = createConversationPreparationJournal(s, 'a');
  await j.begin(id, target);
  await j.queue(id, 'first', nativeId);
  await j.resolve(id, { origin: 'remote', nativeId });
  const reopen = createConversationPreparationJournal(s, 'a');
  await reopen.resolve(id, { origin: 'remote', nativeId, runtime: { permissions: 'not copied' } });
  assert.equal(await reopen.claim(id), null);
  assert.equal(reopen.list()[0].native.runtime, undefined);
  await reopen.resume(id);
  assert.equal((await reopen.claim(id)).message.id, nativeId);
});
test('native-specific limits reject without consuming drafts', async () => {
  const j = createConversationPreparationJournal(storage(), 'a');
  await j.begin(id, { origin: 'server', projectId: null });
  await j.draft(id, 'x'.repeat(8001));
  await assert.rejects(j.queue(id, 'x'.repeat(8001)), /8000/);
  assert.equal(j.list()[0].draft.length, 8001);
  const remote = createConversationPreparationJournal(storage(), 'b');
  await remote.begin(id, target);
  await remote.queue(id, 'x'.repeat(64000));
  assert.equal(remote.list()[0].message.text.length, 64000);
});
test('failed draft persistence keeps newest input in memory', async () => {
  const s = storage(),
    j = createConversationPreparationJournal(s, 'a');
  await j.begin(id, target);
  s.setItem = () => {
    throw Error('quota');
  };
  await assert.rejects(j.draft(id, 'latest input'), /quota/);
  assert.equal(j.list()[0].draft, 'latest input');
});
test('failed cleanup retains handed intent without replay', async () => {
  const s = storage(),
    j = createConversationPreparationJournal(s, 'a');
  await j.begin(id, target);
  await j.queue(id, 'first');
  await j.resolve(id, { origin: 'remote', nativeId });
  await j.claim(id);
  const write = s.setItem;
  s.setItem = (k, v) => {
    if (v === '[]') throw Error('quota');
    write(k, v);
  };
  await assert.rejects(j.remove(id), /quota/);
  assert.equal(await j.claim(id), null);
  assert.equal(j.list()[0].message.text, 'first');
});
test('oversized edit preserves queue and supplement', async () => {
  const j = createConversationPreparationJournal(storage(), 'a');
  await j.begin(id, { origin: 'server', projectId: null });
  await j.queue(id, 'a'.repeat(7999));
  await j.draft(id, 'more');
  await assert.rejects(j.edit(id), /太长/);
  assert.equal(j.list()[0].message.text.length, 7999);
  assert.equal(j.list()[0].draft, 'more');
});
test('failed claim requires explicit retry after storage returns', async () => {
  const s = storage(),
    j = createConversationPreparationJournal(s, 'a');
  await j.begin(id, target);
  await j.queue(id, 'first');
  await j.resolve(id, { origin: 'remote', nativeId });
  const write = s.setItem;
  s.setItem = () => {
    throw Error('quota');
  };
  await assert.rejects(j.claim(id), /quota/);
  assert.equal(j.list()[0].resumeRequired, true);
  assert.match(j.list()[0].error, /消息尚未发送/);
  s.setItem = write;
  assert.equal(await j.claim(id), null);
  await j.resume(id);
  assert.equal((await j.claim(id)).message.text, 'first');
});
test('discard releases forty-entry cap without resurrection on reopen', async () => {
  const s = storage(),
    j = createConversationPreparationJournal(s, 'a');
  const ids = Array.from({ length: 40 }, () => crypto.randomUUID());
  for (const value of ids) {
    await j.begin(value, target);
    await j.fail(value, 'network');
  }
  await assert.rejects(j.begin(id, target), /较多/);
  await j.remove(ids[0]);
  await j.begin(id, target);
  assert.equal(j.list().length, 40);
  assert.equal(
    createConversationPreparationJournal(s, 'a')
      .list()
      .some((v) => v.id === ids[0]),
    false,
  );
});
