import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
const source = readFileSync(
  new URL('../web/src/UnifiedConversations.tsx', import.meta.url),
  'utf8',
);
const compiled = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText;
const body = compiled
  .slice(
    compiled.indexOf('const refresh = useCallback(') + 'const refresh = useCallback('.length,
    compiled.indexOf('const targetRead ='),
  )
  .replace(/, \[settings, storageKey\]\);\s*$/, '');
function setup(ids) {
  const entries = ids.map((id) => ({ id, state: 'unknown', draft: 'keep ' + id }));
  const errors = new Map(),
    recovered = [],
    requests = [];
  let fail = true,
    selected = { origin: 'server', nativeId: 'old' },
    visible = [],
    ready = false;
  const values = {
    generation: { current: 0 },
    historyRead: { current: 0 },
    mutationLock: { current: false },
    settings: {},
    localStorage: {},
    storageKey: 'scope',
    endpoint: '/assistant/conversations',
    api: async (...args) => {
      requests.push(args);
      return {
        conversations: ids.map((id) => ({ id, active: { origin: 'server', nativeId: id } })),
      };
    },
    setConversations() {},
    preparationJournal: { current: { list: () => entries } },
    resolvePreparation: async (id) => {
      if (fail && id === ids[0]) throw Error('IDB write failed');
      recovered.push(id);
      entries.find((v) => v.id === id).state = 'ready';
      errors.delete(id);
    },
    preparationAlive: { current: true },
    preparationRecoveryErrors: { current: errors },
    updatePreparations: () => {
      visible = entries.map((v) => ({ ...v, recoveryError: errors.get(v.id) }));
    },
    setSelected: (fn) => {
      selected = fn(selected);
    },
    activeUnifiedSelection: (rows) => rows.at(-1).active,
    saveUnifiedSelection() {},
    piDirectoryReady: { current: false },
    setTargets() {},
    setDefaultBackend() {},
    setReady: (v) => {
      ready = v;
    },
    setError: (v) => assert.equal(v, ''),
  };
  const refresh = new Function(...Object.keys(values), 'return (' + body + ')')(
    ...Object.values(values),
  );
  return {
    refresh,
    recovered,
    requests,
    errors,
    get selected() {
      return selected;
    },
    get visible() {
      return visible;
    },
    get ready() {
      return ready;
    },
    allow: () => {
      fail = false;
    },
  };
}
test('one rejected preparation does not block other recovery or active selection', async () => {
  const run = setup(['bad', 'good']);
  await run.refresh();
  assert.deepEqual(run.recovered, ['good']);
  assert.equal(run.selected.nativeId, 'good');
  assert.equal(run.ready, true);
  assert.match(run.visible.find((v) => v.id === 'bad').recoveryError, /此条准备记录恢复失败/);
  assert.equal(run.visible.find((v) => v.id === 'bad').draft, 'keep bad');
});
test('single failed entry stays visible and retries only catalogue reads', async () => {
  const run = setup(['bad']);
  await run.refresh();
  assert.equal(run.visible[0].state, 'unknown');
  run.allow();
  await run.refresh();
  assert.deepEqual(run.recovered, ['bad']);
  assert.equal(run.errors.size, 0);
  assert.ok(
    run.requests.every(
      (args) =>
        args[1] === '/assistant/conversations?targets=deferred' &&
        args[2] === undefined &&
        args[3] === undefined,
    ),
  );
  const view = readFileSync(
    new URL('../web/src/PreparingConversation.tsx', import.meta.url),
    'utf8',
  );
  assert.match(view, /重新读取恢复状态/);
  assert.match(view, /model\s*\.refresh\(\)/);
});
