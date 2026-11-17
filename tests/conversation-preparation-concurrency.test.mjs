import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createConversationPreparationJournal } from '../shared/conversation-preparation.mjs';
let tail = Promise.resolve();
let abortNext = false;
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
              if (abortNext) {
                abortNext = false;
                aborted = true;
                tx.error = Error('transaction aborted');
              } else request.onsuccess();
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
const target = { origin: 'remote', projectId: null };
const storage = () => {
  const data = new Map();
  return { getItem: (k) => data.get(k) || null, setItem: (k, v) => data.set(k, v) };
};
test('different IDs survive stale snapshots and simultaneous writes', async () => {
  const s = storage(),
    a = createConversationPreparationJournal(s, 'a');
  const id = crypto.randomUUID(),
    other = crypto.randomUUID();
  await a.begin(id, target);
  await a.draft(id, 'old');
  const b = createConversationPreparationJournal(s, 'a');
  await a.draft(id, 'new');
  await b.begin(other, target);
  await Promise.all([a.draft(id, 'latest'), b.draft(other, 'second')]);
  const list = createConversationPreparationJournal(s, 'a').list();
  assert.equal(list.find((v) => v.id === id).draft, 'latest');
  assert.equal(list.find((v) => v.id === other).draft, 'second');
});
test('same ID stale edit keeps durable winner and local losing input', async () => {
  const s = storage(),
    a = createConversationPreparationJournal(s, 'a'),
    id = crypto.randomUUID();
  await a.begin(id, target);
  const b = createConversationPreparationJournal(s, 'a');
  await a.draft(id, 'winner');
  await assert.rejects(b.draft(id, 'loser'), /其他页面修改/);
  assert.equal(b.list()[0].draft, 'loser');
  assert.equal(createConversationPreparationJournal(s, 'a').list()[0].draft, 'winner');
  await assert.rejects(b.queue(id, 'loser'), /其他页面修改/);
  assert.equal(b.list()[0].draft, 'loser');
});
test('stale draft does not resurrect deletion', async () => {
  const s = storage(),
    a = createConversationPreparationJournal(s, 'a'),
    id = crypto.randomUUID();
  await a.begin(id, target);
  const b = createConversationPreparationJournal(s, 'a');
  await a.remove(id);
  await assert.rejects(b.draft(id, 'keep'), /其他页面移除/);
  assert.equal(b.list()[0].draft, 'keep');
  assert.deepEqual(createConversationPreparationJournal(s, 'a').list(), []);
});
test('claim happens once across two ready journals', async () => {
  const s = storage(),
    a = createConversationPreparationJournal(s, 'a'),
    id = crypto.randomUUID();
  await a.begin(id, target);
  await a.queue(id, 'first');
  await a.resolve(id, { origin: 'remote', nativeId: crypto.randomUUID() });
  const b = createConversationPreparationJournal(s, 'a');
  await b.resume(id);
  const results = await Promise.all([a.claim(id), b.claim(id)]);
  assert.equal(results.filter(Boolean).length, 1);
});
test('abort and unavailable IDB preserve input without unlocked writes', async () => {
  const s = storage(),
    a = createConversationPreparationJournal(s, 'a'),
    id = crypto.randomUUID();
  await a.begin(id, target);
  abortNext = true;
  await assert.rejects(a.draft(id, 'aborted input'), /aborted/);
  assert.equal(a.list()[0].draft, 'aborted input');
  const factory = globalThis.indexedDB;
  delete globalThis.indexedDB;
  try {
    await assert.rejects(a.draft(id, 'offline input'), /存储不可用/);
    assert.equal(a.list()[0].draft, 'offline input');
    assert.equal(createConversationPreparationJournal(s, 'a').list()[0].draft, '');
  } finally {
    globalThis.indexedDB = factory;
  }
});
test('unrelated writes cannot erase a failed in-memory draft', async () => {
  const s = storage(),
    a = createConversationPreparationJournal(s, 'a');
  const id = crypto.randomUUID(),
    other = crypto.randomUUID();
  await a.begin(id, target);
  const write = s.setItem;
  s.setItem = () => {
    throw Error('quota');
  };
  await assert.rejects(a.draft(id, 'unsaved'), /quota/);
  s.setItem = write;
  await a.begin(other, target);
  assert.equal(a.list().find((v) => v.id === id).draft, 'unsaved');
  await assert.rejects(
    a.resolve(id, { origin: 'remote', nativeId: crypto.randomUUID() }),
    /尚未保存/,
  );
  assert.equal(a.list().find((v) => v.id === id).draft, 'unsaved');
});
test('corrupt JSON is never silently overwritten during mutation', async () => {
  const s = storage();
  s.setItem('a:preparations', '{bad');
  const a = createConversationPreparationJournal(s, 'a');
  assert.deepEqual(a.list(), []);
  await assert.rejects(a.begin(crypto.randomUUID(), target));
  assert.equal(s.getItem('a:preparations'), '{bad');
});
test('a second failed mutation cannot clear a different unsaved draft', async () => {
  const s = storage(),
    a = createConversationPreparationJournal(s, 'a');
  const id = crypto.randomUUID(),
    other = crypto.randomUUID();
  await a.begin(id, target);
  s.setItem = () => {
    throw Error('quota');
  };
  await assert.rejects(a.draft(id, 'unsaved A'), /quota/);
  await assert.rejects(a.begin(other, target), /quota/);
  assert.equal(a.list().find((v) => v.id === id).draft, 'unsaved A');
});
test('queued message and input typed while queue waits retain call order', async () => {
  const s = storage(),
    a = createConversationPreparationJournal(s, 'a'),
    id = crypto.randomUUID();
  await a.begin(id, target);
  const draft = a.draft(id, 'first');
  const queue = a.queue(id, 'first');
  const supplement = a.draft(id, 'new supplement');
  await Promise.all([draft, queue, supplement]);
  const reopened = createConversationPreparationJournal(s, 'a').list()[0];
  assert.equal(reopened.message.text, 'first');
  assert.equal(reopened.draft, 'new supplement');
});
test('editing a different ID cannot remove restored continuation requirement', async () => {
  const s = storage(),
    a = createConversationPreparationJournal(s, 'a');
  const id = crypto.randomUUID(),
    other = crypto.randomUUID();
  await a.begin(id, target);
  await a.queue(id, 'first');
  await a.resolve(id, { origin: 'remote', nativeId: crypto.randomUUID() });
  const b = createConversationPreparationJournal(s, 'a');
  await b.begin(other, target);
  assert.equal(await b.claim(id), null);
  assert.equal(b.list().find((v) => v.id === id).resumeRequired, true);
});
test('interrupted claimed handoff reopens with complete copyable text and no replay', async () => {
  const s = storage(),
    a = createConversationPreparationJournal(s, 'a'),
    id = crypto.randomUUID();
  await a.begin(id, target);
  await a.queue(id, 'first\ncomplete message');
  await a.draft(id, 'complete supplement');
  await a.resolve(id, { origin: 'remote', nativeId: crypto.randomUUID() });
  await a.claim(id);
  const reopened = createConversationPreparationJournal(s, 'a');
  const value = reopened.list()[0];
  assert.equal(value.message.text, 'first\ncomplete message');
  assert.equal(value.draft, 'complete supplement');
  assert.equal(value.state, 'handed');
  assert.match(value.error, /尚未确认/);
  assert.equal(await reopened.claim(id), null);
  await reopened.resume(id);
  assert.equal(await reopened.claim(id), null);
});
