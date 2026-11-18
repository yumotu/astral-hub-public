import test from 'node:test';
import assert from 'node:assert/strict';
import { createReadCache } from '../shared/read-cache.mjs';
import { api } from '../web/src/data.ts';
import {
  clearResourceCaches,
  peekAPI,
  setAPICache,
  warmResourceCache,
  flushResourceCaches,
  cacheTTL,
} from '../web/src/resource-cache.ts';
const tick = () => new Promise((r) => setImmediate(r));
test('read cache merges concurrent reads, returns independent values, refreshes stale data and survives a failed refresh', async () => {
  let now = 0,
    calls = 0;
  const cache = createReadCache({ now: () => now });
  const load = async () => {
    calls++;
    return { items: [calls] };
  };
  const [a, b] = await Promise.all([
    cache.read('a', load, { ttl: 100 }),
    cache.read('a', load, { ttl: 100 }),
  ]);
  assert.equal(calls, 1);
  a.items.push(9);
  assert.deepEqual(b, { items: [1] });
  now = 99;
  assert.deepEqual(await cache.read('a', load), { items: [1] });
  now = 100;
  await assert.rejects(
    cache.read('a', async () => {
      throw Error('offline');
    }),
  );
  assert.deepEqual(cache.peek('a'), { items: [1] });
  assert.deepEqual(await cache.read('a', load, { ttl: 100 }), { items: [2] });
  assert.equal(calls, 2);
});
test('writes and logout invalidate in-flight reads without repeating or restoring obsolete work', async () => {
  const cache = createReadCache();
  let release,
    loads = 0;
  const old = cache.read(
    'a',
    () =>
      new Promise((r) => {
        release = r;
        loads++;
      }),
  );
  await tick();
  cache.invalidate((k) => k === 'a');
  assert.equal(
    await cache.read('a', async () => {
      loads++;
      return 'new';
    }),
    'new',
  );
  release('old');
  assert.equal(await old, 'old');
  assert.equal(cache.peek('a'), 'new');
  let late;
  const pending = cache.read('b', () => new Promise((r) => (late = r)));
  await tick();
  cache.clear();
  late('signed-out');
  await pending;
  assert.equal(cache.peek('b'), undefined);
  assert.equal(loads, 2);
  const bounded = createReadCache({ maxEntries: 2, maxBytes: 40 });
  bounded.set('one', 'one');
  bounded.set('two', 'two');
  bounded.set('three', 'three');
  assert.equal(bounded.peek('one'), undefined);
  bounded.set('huge', 'x'.repeat(100));
  assert.equal(bounded.peek('huge'), undefined);
});
test('display snapshots survive a week while stale API reads still require a fresh response', async () => {
  let now = 0;
  const cache = createReadCache({ now: () => now });
  cache.set('history', { text: 'saved' }, now, 1000);
  now = 86400000;
  assert.deepEqual(cache.peek('history'), { text: 'saved' });
  let calls = 0;
  assert.deepEqual(
    await cache
      .read('history', async () => {
        calls++;
        throw Error('offline');
      })
      .catch(() => null),
    null,
  );
  assert.equal(calls, 1);
  now = 7 * 86400000;
  assert.equal(cache.peek('history'), undefined);
  assert.equal(cache.snapshot().length, 0);
  cache.set('restored', { text: 'from disk' }, now, 60000, true);
  assert.deepEqual(cache.peek('restored'), { text: 'from disk' });
  assert.deepEqual(await cache.read('restored', async () => ({ text: 'checked live' })), {
    text: 'checked live',
  });
});
test('API caches only eligible reads and scopes them by server and session; writes are sent exactly once', async (t) => {
  clearResourceCaches();
  t.after(clearResourceCaches);
  let gets = 0,
    posts = 0;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    if (options.method === 'GET') {
      gets++;
      return Response.json({ projects: [{ id: gets }] });
    }
    posts++;
    return Response.json({ ok: true });
  });
  const s = { url: 'https://one.example', token: 'test-token-a', model: 'deepseek-flash' };
  await Promise.all([api(s, '/pi/projects'), api(s, '/pi/projects')]);
  assert.equal(gets, 1);
  await api(s, '/pi/projects');
  assert.equal(gets, 1);
  await api({ ...s, sessionToken: 'test-token-b' }, '/pi/projects');
  await api({ ...s, url: 'https://two.example' }, '/pi/projects');
  assert.equal(gets, 3);
  await api(s, '/tarot/questions', {});
  await api(s, '/pi/projects');
  assert.equal(gets, 3, 'unrelated mutations keep project cache');
  await api(s, '/pi/projects', { name: 'change' });
  await api(s, '/pi/projects');
  assert.equal(gets, 4);
  assert.equal(posts, 2);
  await api(s, '/pi/projects', undefined, undefined, false, { fresh: true });
  assert.equal(gets, 5);
  await api(s, '/notifications');
  await api(s, '/notifications');
  assert.equal(gets, 7, 'live notices are never served from this cache');
  clearResourceCaches();
  assert.equal(peekAPI(s, '/pi/projects'), undefined);
});
const makeStorage = () => {
  const values = new Map();
  return {
    values,
    get length() {
      return values.size;
    },
    key: (i) => [...values.keys()][i] ?? null,
    getItem: (k) => values.get(k) ?? null,
    setItem: (k, v) => values.set(k, v),
    removeItem: (k) => values.delete(k),
  };
};
const useStorage = (t) => {
  const local = makeStorage(),
    session = makeStorage();
  const before = ['localStorage', 'sessionStorage'].map((name) => [
    name,
    Object.getOwnPropertyDescriptor(globalThis, name),
  ]);
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: local });
  Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: session });
  t.after(() => {
    for (const [name, descriptor] of before) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
  });
  return { local, session };
};
test('durable display cache survives reopening, omits sensitive endpoints and clears both stores on logout', async (t) => {
  const { local, session } = useStorage(t);
  clearResourceCaches();
  t.after(clearResourceCaches);
  const s = {
    url: 'https://one.example',
    token: 'private-session-never-persist',
    model: 'deepseek-flash',
  };
  await warmResourceCache(s);
  setAPICache(s, '/pi/projects', { projects: [{ id: 'own' }] });
  setAPICache(s, '/assistant/project-management', { projects: [], computers: [] });
  setAPICache(s, '/assistant/conversations?targets=deferred', {
    conversations: [{ id: 'own-chat' }],
  });
  setAPICache(s, '/relay/grants', { secret: 'must-not-store' });
  setAPICache(s, '/relay/terminals', { secret: 'must-not-store' });
  setAPICache(s, '/@dsh-display/chat', { id: 'chat', messages: [] });
  flushResourceCaches();
  assert.equal(local.values.size, 1);
  assert.equal(JSON.stringify([...local.values, ...session.values]).includes(s.token), false);
  assert.equal(
    JSON.stringify([...local.values, ...session.values]).includes('must-not-store'),
    false,
  );
  session.values.clear();
  const reloaded = await import('../web/src/resource-cache.ts?cache-reload-test');
  t.after(reloaded.clearResourceCaches);
  await reloaded.warmResourceCache(s);
  assert.deepEqual(reloaded.peekAPI(s, '/pi/projects'), { projects: [{ id: 'own' }] });
  assert.deepEqual(reloaded.peekAPI(s, '/assistant/conversations?targets=deferred'), {
    conversations: [{ id: 'own-chat' }],
  });
  assert.deepEqual(reloaded.peekAPI(s, '/@dsh-display/chat'), { id: 'chat', messages: [] });
  assert.equal(reloaded.peekAPI({ ...s, token: 'another-user' }, '/pi/projects'), undefined);
  assert.equal(reloaded.peekAPI({ ...s, url: 'https://other.example' }, '/pi/projects'), undefined);
  reloaded.clearResourceCaches();
  assert.equal(local.values.size, 0);
  assert.equal(session.values.size, 0);
});

test('material-based lesson bodies stay in memory and never enter durable browser caches', async (t) => {
  const { local, session } = useStorage(t);
  clearResourceCaches();
  t.after(clearResourceCaches);
  const s = { url: 'https://one.example', token: 'synthetic-material-session', model: 'fake' };
  await warmResourceCache(s);
  const path = '/learning/lessons/11111111-1111-4111-8111-111111111111';
  const value = {
    lesson: {
      sections: [{ content: 'PRIVATE_MATERIAL_ORIGINAL' }],
      explanation: 'PRIVATE_MATERIAL_ORIGINAL',
    },
  };
  setAPICache(s, path, value);
  setAPICache(s, '/learning/lessons', { lessons: [{ id: 'summary-only' }] });
  assert.deepEqual(peekAPI(s, path), value);
  flushResourceCaches();
  assert.doesNotMatch(
    JSON.stringify([...local.values, ...session.values]),
    /PRIVATE_MATERIAL_ORIGINAL/,
  );
  const key = [...local.values.keys()][0];
  const stored = JSON.parse(local.getItem(key));
  stored.records.push({ path, at: Date.now(), ttl: 60000, value });
  local.setItem(key, JSON.stringify(stored));
  const reloaded = await import('../web/src/resource-cache.ts?material-privacy-test');
  t.after(reloaded.clearResourceCaches);
  await reloaded.warmResourceCache(s);
  assert.equal(reloaded.peekAPI(s, path), undefined);
  reloaded.flushResourceCaches();
  assert.doesNotMatch(
    JSON.stringify([...local.values, ...session.values]),
    /PRIVATE_MATERIAL_ORIGINAL/,
  );
});

test('unified navigation caches invalidate after related writes and never cache authority reads', async (t) => {
  clearResourceCaches();
  t.after(clearResourceCaches);
  let gets = 0;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    if (options.method === 'GET') gets++;
    return Response.json({ count: gets });
  });
  const s = { url: 'https://one.example', token: 'one', model: 'deepseek-flash' };
  const list = '/assistant/conversations?targets=deferred';
  await api(s, list);
  await api(s, list);
  assert.equal(gets, 1);
  await api(s, '/assistant/project-management/remove', { target: {} });
  await api(s, list);
  assert.equal(gets, 2);
  await api(s, '/relay/conversations/123', { title: 'new' }, 'PATCH');
  await api(s, list);
  assert.equal(gets, 3);
  await api(s, '/pi/projects', { name: 'renamed' });
  await api(s, list);
  assert.equal(gets, 4);
  assert.equal(cacheTTL('/assistant/conversations/one/switch'), 0);
  assert.equal(cacheTTL('/assistant/authorization'), 0);
  assert.equal(cacheTTL('/agent/remote/connections'), 0);
});

test('DSH display caches invalidate around native writes, unified deletion and exact-account computer removal', async (t) => {
  clearResourceCaches();
  t.after(clearResourceCaches);
  const s = { url: 'https://display.example', token: 'account-a', model: 'deepseek-flash' };
  const other = { ...s, token: 'account-b' };
  const display = '/@dsh-display/one',
    untouched = '/@dsh-display/two';
  let during;
  t.mock.method(globalThis, 'fetch', async () => {
    during?.();
    // Simulate a poll completing while the write is in flight. Finally must
    // invalidate it again, including a write whose acceptance is unknown.
    setAPICache(s, display, { text: 'racing response' });
    return Response.json({ error: 'unknown acceptance' }, { status: 503 });
  });
  setAPICache(other, display, { text: 'another account' });
  setAPICache(s, display, { text: 'old' });
  setAPICache(s, untouched, { text: 'other conversation' });
  during = () => assert.equal(peekAPI(s, display), undefined);
  await assert.rejects(api(s, '/agent/remote/conversations/one/prompt', { text: 'new' }));
  assert.equal(peekAPI(s, display), undefined);
  assert.deepEqual(peekAPI(s, untouched), { text: 'other conversation' });
  assert.deepEqual(peekAPI(other, display), { text: 'another account' });
  setAPICache(s, '/@dsh-directory', { connections: [{ id: 'host' }] });
  during = () => assert.equal(peekAPI(s, '/@dsh-directory'), undefined);
  await assert.rejects(api(s, '/agent/remote/connections/host', undefined, 'DELETE'));
  assert.equal(peekAPI(s, '/@dsh-directory'), undefined);
  during = () => assert.equal(peekAPI(s, untouched), undefined);
  await assert.rejects(api(s, '/assistant/conversations/unified', undefined, 'DELETE'));
  assert.equal(peekAPI(s, display), undefined);
  assert.equal(peekAPI(s, untouched), undefined);
  setAPICache(s, display, { text: 'old' });
  setAPICache(s, '/@dsh-directory', { connections: [{ id: 'host' }] });
  during = () => {
    assert.equal(peekAPI(s, display), undefined);
    assert.equal(peekAPI(s, '/@dsh-directory'), undefined);
  };
  await assert.rejects(
    api(s, '/assistant/computer-management/remove', { target: { origin: 'remote' } }),
  );
  assert.equal(peekAPI(s, display), undefined);
  assert.deepEqual(peekAPI(other, display), { text: 'another account' });
});

test('restored navigation is stale even during its TTL and old, corrupt or unavailable storage is disposable', async (t) => {
  const { local, session } = useStorage(t);
  const s = { url: 'https://cache.example', token: 'owner', model: 'deepseek-flash' };
  const digest = Buffer.from(
    await crypto.subtle.digest(
      'SHA-256',
      new TextEncoder().encode(JSON.stringify([s.url, s.token])),
    ),
  ).toString('hex');
  const key = 'astral.read-cache.v2:' + digest;
  const now = Date.now();
  local.setItem(
    key,
    JSON.stringify({
      version: 2,
      records: [
        { path: '/pi/projects', value: { cached: true }, at: now, ttl: 30000 },
        { path: '/pi/preferences', value: { expired: true }, at: now - 8 * 86400000, ttl: 30000 },
        { path: '/assistant/targets', value: { future: true }, at: now + 86400000, ttl: 30000 },
      ],
    }),
  );
  const module = await import('../web/src/resource-cache.ts?stale-disk-cache');
  t.after(module.clearResourceCaches);
  await module.warmResourceCache(s);
  assert.deepEqual(module.peekAPI(s, '/pi/projects'), { cached: true });
  assert.equal(module.peekAPI(s, '/pi/preferences'), undefined);
  assert.equal(module.peekAPI(s, '/assistant/targets'), undefined);
  assert.deepEqual(
    await module.resourceCache.read(module.resourceKey(s, '/pi/projects'), async () => ({
      live: true,
    })),
    { live: true },
  );
  local.setItem(key, 'broken');
  const corrupt = await import('../web/src/resource-cache.ts?corrupt-disk-cache');
  t.after(corrupt.clearResourceCaches);
  await corrupt.warmResourceCache(s);
  assert.equal(corrupt.peekAPI(s, '/pi/projects'), undefined);
  t.mock.method(local, 'setItem', () => {
    throw Error('quota');
  });
  corrupt.setAPICache(s, '/pi/projects', { fallback: true });
  corrupt.flushResourceCaches();
  assert.deepEqual(corrupt.peekAPI(s, '/pi/projects'), { fallback: true });
  assert.equal(session.values.size, 1);
});

test('legacy session display cache migrates and durable snapshots are bounded across servers', async (t) => {
  const { local, session } = useStorage(t);
  const s = { url: 'https://legacy.example', token: 'owner', model: 'deepseek-flash' };
  const digest = Buffer.from(
    await crypto.subtle.digest(
      'SHA-256',
      new TextEncoder().encode(JSON.stringify([s.url, s.token])),
    ),
  ).toString('hex');
  const legacyKey = 'astral.read-cache.v1:' + digest;
  session.setItem(
    legacyKey,
    JSON.stringify({
      version: 1,
      records: [
        { path: '/pi/projects', value: { migrated: true }, at: Date.now(), ttl: 30000 },
        { path: '/relay/terminals', value: { no: true }, at: Date.now(), ttl: 3000 },
      ],
    }),
  );
  const module = await import('../web/src/resource-cache.ts?legacy-cache-migration');
  t.after(module.clearResourceCaches);
  await module.warmResourceCache(s);
  assert.deepEqual(module.peekAPI(s, '/pi/projects'), { migrated: true });
  assert.equal(module.peekAPI(s, '/relay/terminals'), undefined);
  module.flushResourceCaches();
  assert.equal(session.getItem(legacyKey), null);
  const other = { ...s, url: 'https://second.example' };
  await module.warmResourceCache(other);
  for (const settings of [s, other])
    for (let i = 0; i < 4; i++)
      module.setAPICache(
        settings,
        '/pi/conversations/' + `11111111-1111-4111-8111-${String(i).padStart(12, '0')}`,
        { text: 'x'.repeat(700000) },
      );
  module.flushResourceCaches();
  const size = [...local.values.values()].reduce((n, value) => n + value.length, 0);
  assert.ok(size <= 2 * 1024 * 1024, String(size));
  for (const value of local.values.values()) assert.ok(JSON.parse(value).records.length <= 240);
});

test('learning mutations refresh affected results while keeping unrelated lessons and accounts cached', async (t) => {
  clearResourceCaches();
  t.after(clearResourceCaches);
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls.push([new URL(url).pathname, options.method, options.headers.Authorization]);
    return Response.json({ value: calls.length });
  });
  const s = { url: 'https://learning.example', token: 'account-a', model: 'deepseek-flash' },
    b = { ...s, token: 'account-b' };
  const id = '11111111-1111-4111-8111-111111111111',
    other = '22222222-2222-4222-8222-222222222222';
  for (const settings of [s, b])
    for (const path of [
      '/learning/lessons',
      '/learning/lessons/' + id,
      '/learning/lessons/' + other,
      '/learning/wrong',
    ])
      await api(settings, path);
  assert.equal(calls.length, 8);
  await api(s, '/learning/attempts', { id: 'attempt', lessonId: id });
  await api(s, '/learning/lessons/' + other);
  for (const path of ['/learning/lessons', '/learning/lessons/' + id, '/learning/wrong'])
    await api(b, path);
  assert.equal(calls.length, 9, 'other lessons and accounts must keep their cache');
  for (const path of ['/learning/lessons', '/learning/lessons/' + id, '/learning/wrong'])
    await api(s, path);
  assert.equal(calls.length, 12, 'only changed account results refresh');
});
