import test from 'node:test';
import assert from 'node:assert/strict';
import {
  temporaryChatDraftKey as key,
  readTemporaryDraft as read,
  saveTemporaryDraft as save,
  clearExpiredTemporaryDrafts as clear,
} from '../shared/temporary-chat.mjs';
function disk() {
  const m = new Map();
  return {
    get length() {
      return m.size;
    },
    key: (i) => [...m.keys()][i],
    getItem: (k) => m.get(k) || null,
    setItem: (k, v) => m.set(k, v),
    removeItem: (k) => m.delete(k),
  };
}
test('side drafts expire without loading stale input and clear only the current server/account', () => {
  const s = disk(),
    now = Date.now(),
    a = key('server', 'alice', 'a'),
    b = key('server', 'alice', 'b'),
    other = key('server', 'bob', 'a'),
    remote = key('different', 'alice', 'a');
  for (const k of [a, b, other, remote]) save(s, k, 'draft', now + 10000);
  assert.equal(read(s, a, now), 'draft');
  clear(s, 'server', 'alice', ['a'], now);
  assert.equal(read(s, a, now), '');
  assert.equal(read(s, b, now), 'draft');
  assert.equal(read(s, other, now), 'draft');
  assert.equal(read(s, remote, now), 'draft');
  clear(s, 'server', 'alice', [], now + 20000);
  assert.equal(s.getItem(b), null);
  assert.notEqual(s.getItem(other), null);
});
test('retained draft can persist, malformed legacy content is discarded, and blocked storage cannot block typing', () => {
  const s = disk(),
    k = key('s', 'a', 'id');
  save(s, k, 'kept', null);
  assert.equal(read(s, k, Number.MAX_SAFE_INTEGER), 'kept');
  s.setItem(k, 'legacy plaintext');
  assert.equal(read(s, k), '');
  assert.equal(s.getItem(k), null);
  save(s, k, 'remove', Date.now() - 1);
  assert.equal(s.getItem(k), null);
  const unavailable = {
    getItem() {
      throw Error('blocked');
    },
    setItem() {
      throw Error('blocked');
    },
    removeItem() {
      throw Error('blocked');
    },
  };
  assert.doesNotThrow(() => save(unavailable, k, 'a', null));
  assert.equal(read(unavailable, k), '');
});
test('server-confirmed live session renews a stale local draft before cleanup, but explicit expiry wins', () => {
  const s = disk(),
    now = Date.now(),
    a = key('server', 'alice', 'a'),
    expired = key('server', 'alice', 'expired'),
    other = key('server', 'bob', 'a');
  for (const k of [a, expired, other]) save(s, k, 'unsent draft', now + 1000);
  clear(s, 'server', 'alice', ['expired'], now + 2000, {
    conversationId: 'a',
    expiresAt: now + 10000,
  });
  assert.equal(read(s, a, now + 2000), 'unsent draft');
  assert.equal(JSON.parse(s.getItem(a)).expiresAt, now + 10000);
  assert.equal(s.getItem(expired), null);
  assert.equal(JSON.parse(s.getItem(other)).expiresAt, now + 1000);
  clear(s, 'server', 'alice', ['a'], now + 11000, {
    conversationId: 'a',
    expiresAt: null,
  });
  assert.equal(s.getItem(a), null);
});
test('a malformed renewed draft cannot block explicit expired-ID cleanup', () => {
  const s = disk(),
    now = Date.now(),
    a = key('s', 'a', 'live'),
    old = key('s', 'a', 'old');
  s.setItem(a, 'invalid JSON');
  save(s, old, 'expired', now + 10000);
  clear(s, 's', 'a', ['old'], now, { conversationId: 'live', expiresAt: now + 10000 });
  assert.equal(s.getItem(old), null);
  assert.equal(s.getItem(a), null);
});
