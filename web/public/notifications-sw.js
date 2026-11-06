// Notification delivery only: no API credentials or offline application cache.
const dbPromise = new Promise((resolve, reject) => {
  const request = indexedDB.open('astral-notifications', 1);
  request.onupgradeneeded = () => request.result.createObjectStore('state');
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
});
async function state(action) {
  const db = await dbPromise;
  return new Promise((resolve, reject) => {
    const tx = db.transaction('state', 'readwrite'),
      store = tx.objectStore('state');
    let result;
    action(store, (v) => {
      result = v;
    });
    tx.oncomplete = () => resolve(result);
    tx.onerror = () => reject(tx.error);
  });
}
const bindingScope = (value) => (typeof value === 'string' ? value : value?.scope);
async function deliver(n) {
  if (!n || !/^[a-f0-9-]{36}$/.test(n.id || '') || !/^[a-f0-9-]{36}$/.test(n.scope || ''))
    return { ok: false };
  const binding = await state((store, done) => {
    const r = store.get('scope');
    r.onsuccess = () => done(r.result);
  });
  if (bindingScope(binding) !== n.scope) return { ok: true, ignored: true };
  if (binding?.onlyBackground !== false && !['test', 'plugin'].includes(n.kind)) {
    const tabs = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    if (tabs.some((tab) => tab.focused && tab.visibilityState === 'visible'))
      return { ok: true, foreground: true };
  }
  const key = n.scope + ':' + n.id;
  const claimed = await state((store, done) => {
    const r = store.get('scope');
    r.onsuccess = () => {
      if (bindingScope(r.result) !== n.scope) {
        done(false);
        return;
      }
      const old = store.get(key);
      old.onsuccess = () => {
        if (old.result) {
          done(false);
          return;
        }
        store.put(Date.now(), key);
        done(true);
      };
    };
  });
  if (!claimed) return { ok: true, duplicate: true };
  try {
    await self.registration.showNotification(String(n.title || '星屿').slice(0, 120), {
      body: String(n.body || '你有一条新通知').slice(0, 1200),
      tag: key,
      icon: './icon-192.png',
      badge: './notification-badge.png',
      data: { id: n.id, scope: n.scope, conversationId: n.conversationId, taskId: n.taskId },
    });
    return { ok: true };
  } catch {
    await state((store, done) => {
      store.delete(key);
      done(true);
    });
    return { ok: false, error: '系统未允许展示通知。' };
  }
}
self.addEventListener('install', (event) => event.waitUntil(self.skipWaiting()));
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));
self.addEventListener('push', (event) => {
  let value;
  try {
    value = event.data?.json();
  } catch {
    return;
  }
  event.waitUntil(deliver(value));
});
self.addEventListener('message', (event) => {
  const data = event.data || {};
  event.waitUntil(
    (async () => {
      let result = { ok: true };
      if (data.type === 'ASTRAL_BIND' && /^[a-f0-9-]{36}$/.test(data.scope || ''))
        await state((store, done) => {
          store.put({ scope: data.scope, onlyBackground: data.onlyBackground !== false }, 'scope');
          done(true);
        });
      else if (data.type === 'ASTRAL_CLEAR')
        await state((store, done) => {
          const r = store.get('scope');
          r.onsuccess = () => {
            if (bindingScope(r.result) === data.scope) store.delete('scope');
            done(true);
          };
        });
      else if (data.type === 'ASTRAL_NOTIFY') result = await deliver(data.notification);
      event.ports[0]?.postMessage(result);
    })(),
  );
});
self.addEventListener('notificationclick', (event) => {
  const n = event.notification.data || {};
  event.notification.close();
  event.waitUntil(
    (async () => {
      const active = await state((store, done) => {
        const r = store.get('scope');
        r.onsuccess = () => done(r.result);
      });
      if (bindingScope(active) !== n.scope) return;
      const tabs = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      const target = tabs.find((tab) => new URL(tab.url).origin === self.location.origin);
      if (target) {
        target.postMessage({ type: 'ASTRAL_OPEN_NOTIFICATION', ...n });
        await target.focus();
      } else {
        const url = new URL('./', self.registration.scope);
        if (/^[a-f0-9-]{36}$/.test(n.id || '')) url.searchParams.set('notification', n.id);
        if (/^[a-f0-9-]{36}$/.test(n.conversationId || ''))
          url.searchParams.set('piConversation', n.conversationId);
        if (/^[a-f0-9-]{36}$/.test(n.taskId || '')) url.searchParams.set('piTask', n.taskId);
        await self.clients.openWindow(url.href);
      }
    })(),
  );
});
