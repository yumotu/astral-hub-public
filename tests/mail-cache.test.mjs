import test from 'node:test';
import assert from 'node:assert/strict';
import { MailCache, clearMailCaches, mailTTL } from '../web/src/mail-cache.ts';
import { mergeMailHistory } from '../shared/mail-history.mjs';
const storage = () => {
  const data = new Map();
  return {
    get length() {
      return data.size;
    },
    key(i) {
      return [...data.keys()][i] ?? null;
    },
    getItem(k) {
      return data.get(k) ?? null;
    },
    setItem(k, v) {
      data.set(k, v);
    },
    removeItem(k) {
      data.delete(k);
    },
  };
};
test('mail cache survives page recreation, separates users/servers and marks old data stale', () => {
  const disk = storage();
  let time = 0;
  const first = new MailCache('server-a:user-a', disk, () => time);
  first.set('body:INBOX:1', { text: 'cached email' });
  const second = new MailCache('server-a:user-a', disk, () => time);
  assert.equal(second.get('body:INBOX:1', mailTTL.body).value.text, 'cached email');
  assert.equal(new MailCache('server-a:user-b', disk).get('body:INBOX:1', mailTTL.body), null);
  assert.equal(new MailCache('server-b:user-a', disk).get('body:INBOX:1', mailTTL.body), null);
  time = mailTTL.body;
  assert.equal(second.get('body:INBOX:1', mailTTL.body).stale, true);
  clearMailCaches(disk);
  first.set('late-body', 'must not restore after logout');
  assert.equal(disk.length, 0);
  assert.equal(second.get('body:INBOX:1', mailTTL.body), null);
});
test('mailbox UID invalidation removes old bodies without evicting other folders', () => {
  const disk = storage(),
    cache = new MailCache('mailbox-validity', disk);
  cache.set(JSON.stringify(['body', 'INBOX', 1]), 'old UID data');
  cache.set(JSON.stringify(['body', 'Drafts', 1]), 'another mailbox');
  cache.invalidateMailbox('INBOX');
  assert.equal(cache.get(JSON.stringify(['body', 'INBOX', 1]), mailTTL.body), null);
  assert.equal(
    cache.get(JSON.stringify(['body', 'Drafts', 1]), mailTTL.body).value,
    'another mailbox',
  );
  cache.clear();
});
test('read flags update all cached lists while keeping message bodies and drafts', () => {
  const cache = new MailCache('seen-flags', storage());
  const list = JSON.stringify(['list', 'INBOX', '', false]),
    unread = JSON.stringify(['list', 'INBOX', '', true]),
    other = JSON.stringify(['list', 'Work', '', false]),
    body = JSON.stringify(['body', 'INBOX', 101, 'rich-v1']);
  const rows = [
    { uid: 101, seen: false },
    { uid: 102, seen: true },
  ];
  cache.set(list, rows);
  cache.set(unread, [rows[0]]);
  cache.set(other, rows);
  cache.set(body, { text: 'keep actual content' });
  cache.applySeen('INBOX', [101], true);
  assert.equal(cache.get(list, mailTTL.list).value[0].seen, true);
  assert.deepEqual(cache.get(unread, mailTTL.list).value, []);
  assert.equal(cache.get(other, mailTTL.list).value[0].seen, false);
  assert.equal(cache.get(body, mailTTL.body).value.text, 'keep actual content');
  cache.applySeen('INBOX', [102], false);
  assert.equal(cache.get(list, mailTTL.list).value[1].seen, false);
});
test('mail cache bounds storage, tolerates denied writes and clears old mailbox data', () => {
  const disk = storage();
  const cache = new MailCache('size-check', disk);
  for (let i = 0; i < 100; i++) cache.set('body:' + i, 'x'.repeat(20000));
  assert.ok(disk.getItem(disk.key(0)).length <= 1000000);
  cache.clear();
  assert.equal(disk.length, 0);
  cache.set('late-body', 'discard this mailbox revision', cache.generation - 1);
  assert.equal(disk.length, 0);
  const denied = new MailCache('private', {
    getItem() {
      throw Error();
    },
    setItem() {
      throw Error();
    },
  });
  denied.set('body', 'still works in memory');
  assert.equal(denied.get('body', mailTTL.body).value, 'still works in memory');
});

test('large mail bodies survive recreation in async archive and logout discards late hydration', async () => {
  const disk = storage(),
    rows = new Map();
  const archive = {
    async load() {
      return Object.fromEntries(rows);
    },
    async write(changed, removed) {
      for (const key of removed) rows.delete(key);
      for (const [key, value] of Object.entries(changed)) rows.set(key, structuredClone(value));
    },
    async clear() {
      rows.clear();
    },
  };
  const cache = new MailCache('large-archive', disk, Date.now, archive);
  await cache.ready();
  cache.configure({ cacheMB: 16, retentionDays: 0, pageSize: 50 });
  for (let i = 0; i < 100; i++) cache.set('body:' + i, 'x'.repeat(20000));
  await cache.flush();
  assert.equal([...rows.keys()].filter((k) => k.startsWith('body:')).length, 100);
  assert.ok(disk.getItem(disk.key(0)).length <= 1000000);
  const restored = new MailCache('large-archive', disk, Date.now, archive);
  await restored.ready();
  assert.equal(restored.get('body:0', mailTTL.body).value.length, 20000);
  restored.invalidateMailbox('Other');
  await restored.flush();
  assert.equal([...rows.keys()].filter((k) => k.startsWith('body:')).length, 100);
  let release;
  const waiting = new MailCache('late', disk, Date.now, {
    ...archive,
    load: () =>
      new Promise((r) => {
        release = r;
      }),
  });
  clearMailCaches(disk);
  release({ secret: { value: 'stale account', at: Date.now() } });
  await waiting.ready();
  assert.equal(waiting.get('secret', mailTTL.body), null);
});

test('history refresh preserves older pages, removes vanished recent UIDs and isolates mailbox versions', () => {
  const previous = {
    uidValidity: '1',
    messages: [{ uid: 9 }, { uid: 8 }, { uid: 5 }],
    total: 9,
    nextCursor: 'old',
    hasMore: true,
  };
  const incoming = {
    uidValidity: '1',
    messages: [{ uid: 10 }, { uid: 8 }],
    scannedFrom: 8,
    total: 10,
    nextCursor: 'new',
    hasMore: true,
  };
  const merged = mergeMailHistory(previous, incoming);
  assert.deepEqual(
    merged.messages.map((m) => m.uid),
    [10, 8, 5],
  );
  assert.equal(merged.nextCursor, 'old');
  assert.deepEqual(
    mergeMailHistory(previous, { ...incoming, uidValidity: '2' }).messages,
    incoming.messages,
  );
});
