import test from 'node:test';
import assert from 'node:assert/strict';
import { confirmNativeDelivery } from '../shared/native-notification-delivery.mjs';
test('native notifications wait for actual tray delivery without rescheduling and discard switched-account results', async () => {
  let calls = 0,
    time = 0;
  const options = {
    id: 7,
    now: () => time,
    pause: async (ms) => {
      time += ms;
    },
    read: async () => ({ notifications: ++calls >= 3 ? [{ id: 7 }] : [] }),
  };
  assert.equal((await confirmNativeDelivery(options)).mode, 'shown');
  assert.equal(calls, 3);
  let current = true;
  assert.equal(
    (
      await confirmNativeDelivery({
        ...options,
        active: () => current,
        read: async () => {
          current = false;
          return { notifications: [{ id: 7 }] };
        },
      })
    ).mode,
    'ignored',
  );
});
test('native notification timeout remains a failure and does not invent a successful display', async () => {
  let time = 0,
    calls = 0;
  await assert.rejects(
    () =>
      confirmNativeDelivery({
        id: 7,
        now: () => time,
        pause: async (ms) => {
          time += ms;
        },
        timeout: 300,
        read: async () => {
          calls++;
          return { notifications: [] };
        },
      }),
    /未保留/,
  );
  assert.equal(calls, 4);
  await assert.rejects(
    () => confirmNativeDelivery({ id: 7, timeout: 10, read: () => new Promise(() => {}) }),
    /确认超时/,
  );
});
