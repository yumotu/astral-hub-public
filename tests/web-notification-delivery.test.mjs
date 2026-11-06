import test from 'node:test';
import assert from 'node:assert/strict';
import {
  deliverWebNotification,
  clearWebNotificationScope,
} from '../shared/web-notification-delivery.mjs';
const n = { scope: 'owner', id: 'notice', title: 'Astral test', body: 'Synthetic' };
test('open-page notifications bind their account even without PushManager and use service-worker delivery', async () => {
  const calls = [];
  const result = await deliverWebNotification(n, {
    Notification: { permission: 'granted' },
    active: () => true,
    workerSend: async (p) => {
      calls.push(p);
      return { ok: true };
    },
  });
  assert.equal(result.mode, 'worker');
  assert.deepEqual(
    calls.map((x) => x.type),
    ['ASTRAL_BIND', 'ASTRAL_NOTIFY'],
  );
  assert.equal(calls[0].scope, n.scope);
});
test('unavailable or silently ignored worker falls back to direct page notifications and preserves click scope', async () => {
  let clicked = 0,
    closed = 0;
  class Notice {
    static permission = 'granted';
    constructor(title, options) {
      assert.equal(title, n.title);
      assert.equal(options.tag, 'owner:notice');
      assert.equal(options.icon, './icon-192.png');
      assert.equal(options.badge, './notification-badge.png');
      queueMicrotask(() => this.onshow());
    }
    close() {
      closed++;
    }
  }
  const result = await deliverWebNotification(n, {
    Notification: Notice,
    active: () => true,
    workerSend: async (p) =>
      p.type === 'ASTRAL_BIND' ? { ok: true } : { ok: true, ignored: true },
    onClick: () => clicked++,
  });
  assert.equal(result.mode, 'page');
  clearWebNotificationScope('other');
  assert.equal(closed, 0);
  clearWebNotificationScope('owner');
  assert.equal(closed, 1);
  assert.equal(clicked, 0);
});
test('denied permission and account changes never create notifications', async () => {
  await assert.rejects(
    () => deliverWebNotification(n, { Notification: { permission: 'denied' }, active: () => true }),
    /权限/,
  );
  let active = true,
    created = 0;
  class Notice {
    static permission = 'granted';
    constructor() {
      created++;
    }
  }
  const result = await deliverWebNotification(n, {
    Notification: Notice,
    active: () => active,
    workerSend: async () => {
      active = false;
      throw Error('offline');
    },
  });
  assert.equal(result.mode, 'ignored');
  assert.equal(created, 0);
});
test('a browser failing to acknowledge notification display produces a visible diagnostic', async () => {
  class Notice {
    static permission = 'granted';
    close() {}
  }
  await assert.rejects(
    () =>
      deliverWebNotification(n, {
        Notification: Notice,
        active: () => true,
        workerSend: async () => {
          throw Error('no SW');
        },
        timeout: 5,
      }),
    /macOS/,
  );
});
