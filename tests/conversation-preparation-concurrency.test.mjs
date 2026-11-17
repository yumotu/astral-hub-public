import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createConversationPreparationJournal } from '../shared/conversation-preparation.mjs';
import { preparationIDB } from './helpers/preparation-idb.mjs';
const idb = preparationIDB();
globalThis.indexedDB = idb.factory;
test.beforeEach(() => idb.reset());
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
  idb.failNext();
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
  idb.failNext(Error('quota'));
  await assert.rejects(a.draft(id, 'unsaved'), /quota/);
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
  idb.failNext(Error('quota'));
  await assert.rejects(a.draft(id, 'unsaved A'), /quota/);
  idb.failNext(Error('quota'));
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

test('stale cross-process localStorage views cannot overwrite committed IDs', async () => {
  // Each browser renderer can briefly see its own stale localStorage snapshot.
  // The IDB transaction, not either snapshot, must own the read/modify/write.
  const a = createConversationPreparationJournal(storage(), 'same-account');
  const b = createConversationPreparationJournal(storage(), 'same-account');
  const first = crypto.randomUUID(),
    second = crypto.randomUUID();
  await a.begin(first, target);
  await a.draft(first, 'retained A');
  await b.begin(second, target);
  await b.draft(second, 'retained B');
  assert.equal(b.list().length, 2, "a stale preview must not drop the other tab's committed ID");
  await a.hydrate();
  assert.equal(a.list().length, 2);
  assert.equal(a.list().find((v) => v.id === first).draft, 'retained A');
  assert.equal(a.list().find((v) => v.id === second).draft, 'retained B');
});

test('IDB restores drafts after a failed or corrupt optional preview cache', async () => {
  const s = storage();
  s.setItem = () => {
    throw Error('localStorage quota');
  };
  const a = createConversationPreparationJournal(s, 'cache-optional'),
    id = crypto.randomUUID();
  await a.begin(id, target);
  await a.queue(id, 'durable message');
  await a.draft(id, 'durable supplement');
  await a.resolve(id, { origin: 'remote', nativeId: crypto.randomUUID() });
  const corrupted = storage();
  corrupted.setItem('cache-optional:preparations', '{broken');
  const b = createConversationPreparationJournal(corrupted, 'cache-optional');
  assert.deepEqual(b.list(), []);
  await b.hydrate();
  assert.equal(b.list()[0].draft, 'durable supplement');
  assert.equal(b.list()[0].message.text, 'durable message');
  assert.equal(await b.claim(id), null, 'restoration must require explicit continuation');
  assert.equal(
    (await a.claim(id)).message.text,
    'durable message',
    'read-only hydration must not alter the original owner intent',
  );
});

test('legacy cache migrates once and cannot resurrect removed entries', async () => {
  const s = storage(),
    id = crypto.randomUUID();
  const legacy = [
    {
      id,
      target,
      draft: 'legacy draft',
      state: 'creating',
      error: '',
      createdAt: new Date().toISOString(),
    },
  ];
  s.setItem('migration:preparations', JSON.stringify(legacy));
  const a = createConversationPreparationJournal(s, 'migration');
  await a.hydrate();
  assert.equal(a.list()[0].draft, 'legacy draft');
  await a.remove(id);
  // A delayed old tab writes its pre-migration view back to the preview cache.
  s.setItem('migration:preparations', JSON.stringify(legacy));
  const b = createConversationPreparationJournal(s, 'migration');
  await b.hydrate();
  assert.deepEqual(b.list(), []);
});

test('post-write transaction abort leaves the durable journal and preview unchanged', async () => {
  const s = storage(),
    a = createConversationPreparationJournal(s, 'abort-commit'),
    id = crypto.randomUUID();
  await a.begin(id, target);
  await a.draft(id, 'committed');
  const preview = s.getItem('abort-commit:preparations');
  idb.failNext();
  await assert.rejects(a.draft(id, 'not committed'), /aborted/);
  assert.equal(a.list()[0].draft, 'not committed', 'keep failed input in memory');
  assert.equal(s.getItem('abort-commit:preparations'), preview);
  const b = createConversationPreparationJournal(s, 'abort-commit');
  await b.hydrate();
  assert.equal(b.list()[0].draft, 'committed');
});

for (const operation of ['draft', 'queue', 'edit']) {
  test(`hydrated journal cannot ${operation} from a stale visible editor`, async () => {
    const s = storage(),
      a = createConversationPreparationJournal(s, 'visible-' + operation),
      id = crypto.randomUUID();
    await a.begin(id, target);
    await a.draft(id, 'shown in A');
    const b = createConversationPreparationJournal(s, 'visible-' + operation);
    await b.draft(id, 'saved in B');
    await a.hydrate();
    assert.equal(a.list()[0].draft, 'saved in B');
    // A's DOM has not rendered the hydrated value yet.
    const attempt =
      operation === 'draft'
        ? a.draft(id, 'shown in A plus typing', 'shown in A')
        : operation === 'queue'
          ? a.queue(id, 'shown in A', undefined, 'shown in A')
          : a.edit(id, 'shown in A');
    await assert.rejects(attempt, /其他页面修改/);
    await b.hydrate();
    assert.equal(b.list()[0].draft, 'saved in B');
    assert.equal(b.list()[0].message, undefined);
    if (operation === 'draft') {
      assert.equal(a.list()[0].draft, 'shown in A plus typing');
      await a.hydrate();
      assert.equal(a.list()[0].draft, 'shown in A plus typing');
    }
  });
}

test('visible draft comparisons preserve ordered typing and queued supplements', async () => {
  const a = createConversationPreparationJournal(storage(), 'editor-chain'),
    id = crypto.randomUUID();
  await a.begin(id, target);
  await Promise.all([
    a.draft(id, 'A', ''),
    a.draft(id, 'AB', 'A'),
    a.queue(id, 'AB', undefined, 'AB'),
    a.draft(id, 'supplement', ''),
    a.draft(id, 'supplement C', 'supplement'),
  ]);
  assert.equal(a.list()[0].message.text, 'AB');
  assert.equal(a.list()[0].draft, 'supplement C');
});

test('typing while own queue waits follows only that exact committed transition', async () => {
  const s = storage(),
    a = createConversationPreparationJournal(s, 'queue-transition'),
    id = crypto.randomUUID();
  await a.begin(id, target);
  await a.draft(id, 'still visible');
  await Promise.all([
    a.queue(id, 'still visible', undefined, 'still visible'),
    a.draft(id, 'new supplement during wait', 'still visible'),
  ]);
  assert.equal(a.list()[0].draft, 'new supplement during wait');
  assert.equal(a.list()[0].message.text, 'still visible');
  await assert.rejects(
    a.draft(id, 'stale again', 'still visible'),
    /其他页面修改/,
    'the alias is consumed once',
  );
});

test('typing during edit cannot replace the queued message merged into the durable draft', async () => {
  const s = storage(),
    a = createConversationPreparationJournal(s, 'edit-transition'),
    id = crypto.randomUUID();
  await a.begin(id, target);
  await a.queue(id, 'QUEUED FIRST MESSAGE');
  await a.draft(id, 'supplement visible');
  const edit = a.edit(id, 'supplement visible');
  const typing = a.draft(id, 'supplement visible + typed', 'supplement visible');
  await edit;
  await assert.rejects(typing, /其他页面修改/);
  assert.equal(a.list()[0].draft, 'supplement visible + typed', 'retain unsaved local text');
  const reopened = createConversationPreparationJournal(s, 'edit-transition');
  await reopened.hydrate();
  assert.equal(
    reopened.list()[0].draft,
    'QUEUED FIRST MESSAGE\n\nsupplement visible',
    'retain original queued body durably',
  );
  assert.equal(reopened.list()[0].message, undefined);
});

test('another tab change cannot use an earlier local queue transition', async () => {
  const s = storage(),
    a = createConversationPreparationJournal(s, 'transition-conflict'),
    id = crypto.randomUUID();
  await a.begin(id, target);
  await a.draft(id, 'A');
  await a.queue(id, 'A', undefined, 'A');
  const b = createConversationPreparationJournal(s, 'transition-conflict');
  await b.draft(id, 'B');
  await a.hydrate();
  await assert.rejects(a.draft(id, 'A typed', 'A'), /其他页面修改/);
  await b.hydrate();
  assert.equal(b.list()[0].draft, 'B');
});
