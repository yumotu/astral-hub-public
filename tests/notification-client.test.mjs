import test from 'node:test';
import assert from 'node:assert/strict';
import { notificationDelivery, deliverNotificationBatch } from '../shared/notification-client.mjs';
test('a test response racing long polling displays once and failed deliveries can retry', async () => {
  let attempts = 0,
    stored = [];
  const once = notificationDelivery({
    deliver: async () => {
      attempts++;
      await Promise.resolve();
      if (attempts === 1) throw Error('blocked');
      return { mode: 'native' };
    },
    persist: (value) => (stored = value),
  });
  await assert.rejects(once({ id: 'one' }), /blocked/);
  assert.deepEqual(stored, []);
  await Promise.all([once({ id: 'one' }), once({ id: 'one' })]);
  assert.equal(attempts, 2);
  assert.deepEqual(stored, ['one']);
  assert.equal((await once({ id: 'one' })).mode, 'duplicate');
});
test('failed local delivery stops the cursor before that notification and preserves later notices', async () => {
  let after = 10,
    fail = true;
  const displayed = [],
    once = notificationDelivery({
      deliver: async (n) => {
        if (n.seq === 12 && fail) throw Error('permission');
        displayed.push(n.seq);
        return { mode: 'page' };
      },
    });
  const notices = [11, 12, 13].map((seq) => ({ id: String(seq), seq }));
  const options = { deliver: once, acknowledge: (seq) => (after = seq), active: () => true };
  await assert.rejects(deliverNotificationBatch(notices, options), /permission/);
  assert.equal(after, 11);
  fail = false;
  await deliverNotificationBatch(
    notices.filter((n) => n.seq > after),
    options,
  );
  assert.equal(after, 13);
  assert.deepEqual(displayed, [11, 12, 13]);
});
test('switching accounts stops delivery and never advances the old account cursor', async () => {
  let active = true,
    after = 0;
  await deliverNotificationBatch(
    [
      { id: '1', seq: 1 },
      { id: '2', seq: 2 },
    ],
    {
      deliver: async () => {
        active = false;
      },
      active: () => active,
      acknowledge: (n) => (after = n),
    },
  );
  assert.equal(after, 0);
});
