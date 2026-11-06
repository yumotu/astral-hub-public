import test from 'node:test';
import assert from 'node:assert/strict';
import { createReadCache } from '../shared/read-cache.mjs';
import { api } from '../web/src/data.ts';
import {
  clearResourceCaches,
  peekAPI,
  setAPICache,
  warmResourceCache,
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
test('session cache survives reload without storing credentials and is cleared on logout', async (t) => {
  const values = new Map();
  const storage = {
    get length() {
      return values.size;
    },
    key: (i) => [...values.keys()][i] ?? null,
    getItem: (k) => values.get(k) ?? null,
    setItem: (k, v) => values.set(k, v),
    removeItem: (k) => values.delete(k),
  };
  const old = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage');
  Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: storage });
  t.after(() => {
    if (old) Object.defineProperty(globalThis, 'sessionStorage', old);
    else delete globalThis.sessionStorage;
  });
  clearResourceCaches();
  t.after(clearResourceCaches);
  const s = {
    url: 'https://one.example',
    token: 'private-session-never-persist',
    model: 'deepseek-flash',
  };
  await warmResourceCache(s);
  setAPICache(s, '/pi/projects', { projects: [{ id: 'own' }] });
  await new Promise((r) => setTimeout(r, 800));
  assert.equal(values.size, 1);
  assert.equal(JSON.stringify([...values]).includes(s.token), false);
  const reloaded = await import('../web/src/resource-cache.ts?cache-reload-test');
  t.after(reloaded.clearResourceCaches);
  await reloaded.warmResourceCache(s);
  assert.deepEqual(reloaded.peekAPI(s, '/pi/projects'), { projects: [{ id: 'own' }] });
  assert.equal(reloaded.peekAPI({ ...s, token: 'another-user' }, '/pi/projects'), undefined);
  reloaded.clearResourceCaches();
  assert.equal(values.size, 0);
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
