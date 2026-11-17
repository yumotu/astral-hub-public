import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

const source = readFileSync(new URL('../web/src/PiPage.tsx', import.meta.url), 'utf8').replace(
  /\r\n/g,
  '\n',
);
const start = source.indexOf('  const refreshGeneration =');
const end = source.indexOf(
  '  useEffect(() => {\n    if (!session) return;\n    let live = true;\n    const sync',
  start,
);
const code = ts.transpileModule(source.slice(start, end), {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText;
const tick = () => new Promise((resolve) => setImmediate(resolve));
function setup() {
  const requests = [],
    effects = [],
    state = {},
    generation = { current: 0 };
  const alive = { current: true },
    current = { current: 'saved' },
    restored = { current: null };
  const api = (_settings, path, ...args) =>
    new Promise((resolve, reject) => {
      requests.push({ path, args, resolve, reject });
    });
  const names = [
    'setStatus',
    'setConversations',
    'setDefaultProjectId',
    'setPreferencesReady',
    'setProjects',
    'setError',
    'setConversation',
    'setProjectId',
  ];
  const values = names.map((name) => (value) => {
    state[name] = value;
  });
  const refresh = new Function(
    'useRef',
    'useEffect',
    'api',
    'settings',
    'session',
    'alive',
    'currentConversation',
    'restoredConversation',
    ...names,
    `${code}; return refresh;`,
  )(
    () => generation,
    (effect) => effects.push(effect),
    api,
    {},
    {},
    alive,
    current,
    restored,
    ...values,
  );
  const mount = () => effects[0]();
  return { requests, state, refresh, mount, alive, current, restored };
}
const result = (path, suffix = '') =>
  path === '/pi/status'
    ? { available: true, model: 'model' + suffix }
    : path.includes('?archived')
      ? { conversations: [{ id: 'saved' + suffix }] }
      : path === '/pi/preferences'
        ? { preferences: { defaultProjectId: 'project' + suffix } }
        : { projects: [] };

for (const mode of ['initial', 'refresh']) {
  for (const fast of ['/pi/status', '/pi/conversations?archived=include']) {
    test(`${mode}: ${fast} displays before the other response`, async () => {
      const f = setup();
      const pending = mode === 'initial' ? f.mount() : f.refresh();
      f.requests.find((r) => r.path === fast).resolve(result(fast));
      await tick();
      assert.deepEqual(
        f.state[fast === '/pi/status' ? 'setStatus' : 'setConversations'],
        fast === '/pi/status' ? result(fast) : result(fast).conversations,
      );
      for (const r of f.requests) r.resolve(result(r.path));
      if (mode === 'refresh') await pending;
    });
    test(`${mode}: ${fast} failure does not discard the other success`, async () => {
      const f = setup();
      const pending = mode === 'initial' ? f.mount() : f.refresh();
      f.requests.find((r) => r.path === fast).reject(new Error('offline'));
      for (const r of f.requests.filter((r) => r.path !== fast)) r.resolve(result(r.path));
      await tick();
      assert.equal(f.state.setError, 'offline');
      assert.ok(f.state[fast === '/pi/status' ? 'setConversations' : 'setStatus']);
      if (mode === 'refresh') await pending;
      const retry = f.refresh();
      for (const r of f.requests.slice(-3)) r.resolve(result(r.path, '-retry'));
      await retry;
      assert.equal(f.state.setStatus.model, 'model-retry');
      assert.equal(f.state.setConversations[0].id, 'saved-retry');
    });
  }
}
for (const boundary of ['unmount', 'settings', 'new-refresh']) {
  test(`obsolete response ignored after ${boundary}`, async () => {
    const f = setup();
    const cleanup = f.mount();
    const old = [...f.requests];
    const refreshing = f.refresh();
    const refreshRequests = f.requests.slice(-3);
    if (boundary === 'new-refresh') {
      const newer = f.refresh();
      for (const r of f.requests.slice(-3)) r.resolve(result(r.path, '-new'));
      await newer;
    } else {
      cleanup();
      if (boundary === 'settings') f.mount();
      else f.alive.current = false;
    }
    const snapshot = { ...f.state };
    for (const r of [...old, ...refreshRequests]) r.resolve(result(r.path, '-old'));
    await refreshing;
    await tick();
    if (boundary === 'new-refresh') snapshot.setProjects = [];
    assert.deepEqual(f.state, snapshot);
  });
}
test('restored-conversation lookup does not switch a newly selected conversation', async () => {
  const f = setup();
  f.restored.current = 'saved';
  f.mount();
  f.requests
    .find((r) => r.path.includes('?archived'))
    .resolve({ conversations: [{ id: 'recent', updatedAt: '2026' }] });
  await tick();
  const history = f.requests.find((r) => r.path === '/pi/conversations/saved');
  assert.ok(history);
  f.current.current = 'chosen';
  history.resolve({ turns: [], conversation: null });
  await tick();
  assert.equal(f.state.setConversation, undefined);
});
