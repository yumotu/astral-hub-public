import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { randomUUID } from 'node:crypto';

test('notification worker shares push/live deduplication, respects focused windows and prevents stale-account clears', async () => {
  const records = new Map(),
    listeners = {},
    shown = [];
  let windows = [{ focused: true, visibilityState: 'visible' }];
  const db = {
    createObjectStore() {},
    transaction() {
      const tx = {
        objectStore: () => ({
          get(key) {
            const request = {};
            queueMicrotask(() => request.onsuccess?.({}));
            Object.defineProperty(request, 'result', { get: () => records.get(key) });
            return request;
          },
          put(value, key) {
            records.set(key, value);
          },
          delete(key) {
            records.delete(key);
          },
        }),
      };
      setTimeout(() => tx.oncomplete?.(), 0);
      return tx;
    },
  };
  const self = {
    addEventListener(name, handler) {
      listeners[name] = handler;
    },
    clients: { matchAll: async () => windows },
    registration: { showNotification: async (title, options) => shown.push({ title, ...options }) },
  };
  const indexedDB = {
    open() {
      const request = { result: db };
      queueMicrotask(() => {
        request.onupgradeneeded?.();
        request.onsuccess?.();
      });
      return request;
    },
  };
  runInNewContext(
    await readFile(new URL('../web/public/notifications-sw.js', import.meta.url), 'utf8'),
    { self, indexedDB, URL, Date, setTimeout, clearTimeout },
  );
  async function message(data) {
    let pending, reply;
    listeners.message({
      data,
      ports: [
        {
          postMessage(value) {
            reply = value;
          },
        },
      ],
      waitUntil(p) {
        pending = p;
      },
    });
    await pending;
    return reply;
  }
  async function push(value) {
    let pending;
    listeners.push({
      data: { json: () => value },
      waitUntil(p) {
        pending = p;
      },
    });
    await pending;
  }
  const owner = randomUUID(),
    other = randomUUID();
  const notice = {
    id: randomUUID(),
    scope: owner,
    kind: 'completed',
    title: '星屿',
    body: '任务完成',
  };
  await message({ type: 'ASTRAL_BIND', scope: owner, onlyBackground: true });
  await push(notice);
  assert.equal(shown.length, 0);
  windows = [{ focused: false, visibilityState: 'hidden' }];
  await push(notice);
  assert.equal(shown.length, 1);
  assert.equal(shown[0].icon, './icon-192.png');
  assert.equal(shown[0].badge, './notification-badge.png');
  await message({ type: 'ASTRAL_NOTIFY', notification: notice });
  assert.equal(shown.length, 1);
  await message({ type: 'ASTRAL_BIND', scope: other, onlyBackground: false });
  await message({ type: 'ASTRAL_CLEAR', scope: owner });
  await push({ ...notice, id: randomUUID() });
  assert.equal(shown.length, 1);
  windows = [{ focused: true, visibilityState: 'visible' }];
  await push({ ...notice, id: randomUUID(), scope: other });
  assert.equal(shown.length, 2);
  await message({ type: 'ASTRAL_BIND', scope: other, onlyBackground: true });
  await push({ ...notice, id: randomUUID(), scope: other, kind: 'plugin' });
  assert.equal(shown.length, 3);
  await message({ type: 'ASTRAL_CLEAR', scope: other });
  await push({ ...notice, id: randomUUID(), scope: other, kind: 'test' });
  assert.equal(shown.length, 3);
});
