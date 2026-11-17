import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
const source = readFileSync(
  new URL('../web/src/PreparingConversation.tsx', import.meta.url),
  'utf8',
);
const compiled = ts.transpileModule(source, {
  compilerOptions: {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    jsx: ts.JsxEmit.ReactJSX,
  },
}).outputText;
const hook = compiled
  .slice(
    compiled.indexOf('export function usePreparedConversation('),
    compiled.indexOf('export function PreparingConversation('),
  )
  .replace('export function', 'function');
function setup() {
  const effects = [];
  let resolveClaim,
    sends = 0,
    restores = 0;
  const value = {
    id: 'test',
    draft: 'supplement',
    message: { id: 'message', text: 'first' },
    state: 'ready',
    native: { origin: 'remote', nativeId: 'native' },
  };
  let savedCallback,
    finishes = 0;
  const model = {
    preparing: value,
    settings: {},
    claimPreparation: () =>
      new Promise((resolve) => {
        resolveClaim = resolve;
      }),
    finishPreparation: async () => {
      finishes++;
    },
  };
  const run = new Function(
    'useRef',
    'useState',
    'useEffect',
    'useUnifiedConversations',
    'api',
    `${hook}; return usePreparedConversation;`,
  )(
    (current) => ({ current }),
    () => ['["test","remote","native"]', () => {}],
    (effect) => effects.push(effect),
    () => model,
    async () => ({ conversation: { id: 'native' } }),
  );
  run({
    origin: 'remote',
    nativeId: 'native',
    ready: true,
    restoreDraft: () => {
      restores++;
    },
    send: (message, saved) => {
      sends++;
      savedCallback = saved;
    },
  });
  const cleanup = effects[0]();
  effects[2]();
  return {
    model,
    value,
    cleanup,
    resolve: () => resolveClaim(value),
    counts: () => ({ sends, restores }),
    saved: () => savedCallback(),
    finishes: () => finishes,
  };
}
test('actual handoff effect does not dispatch after selection changes during claim', async () => {
  const fixture = setup();
  fixture.model.preparing = { id: 'other' };
  fixture.resolve();
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(fixture.counts(), { sends: 0, restores: 0 });
  assert.equal(fixture.value.message.text, 'first');
  assert.equal(fixture.value.draft, 'supplement');
});
test('actual handoff effect does not dispatch after unmount during claim', async () => {
  const fixture = setup();
  fixture.cleanup();
  fixture.resolve();
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(fixture.counts(), { sends: 0, restores: 0 });
});
test('actual submit handler does not clear text typed during queue wait', async () => {
  const body = source.slice(
    source.indexOf('  const submit = async () => {'),
    source.indexOf('  return (', source.indexOf('  const submit = async () => {')),
  );
  const js = ts.transpileModule(body, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
  let resolve,
    input = 'first',
    error;
  const version = { current: 1 };
  const submit = new Function(
    'inputVersion',
    'model',
    'prep',
    'input',
    'setInput',
    'setError',
    `${js}; return submit;`,
  )(
    version,
    {
      preparationQueue: () =>
        new Promise((r) => {
          resolve = r;
        }),
    },
    { id: 'test' },
    input,
    (value) => {
      input = value;
    },
    (value) => {
      error = value;
    },
  );
  const pending = submit();
  input = 'new supplement';
  version.current++;
  resolve();
  await pending;
  assert.equal(input, 'new supplement');
  assert.equal(error, '');
});
for (const boundary of ['typing', 'selection']) {
  test(`actual edit handler preserves input after ${boundary} during wait`, async () => {
    const body = source.slice(
      source.indexOf('  const edit = async () => {'),
      source.indexOf('  const submit = async () => {'),
    );
    const js = ts.transpileModule(body, {
      compilerOptions: { target: ts.ScriptTarget.ES2022 },
    }).outputText;
    let resolve,
      input = 'old supplement';
    const version = { current: 1 },
      identity = { current: 'test' };
    const edit = new Function(
      'inputVersion',
      'inputPreparation',
      'model',
      'prep',
      'input',
      'setInput',
      'setError',
      `${js}; return edit;`,
    )(
      version,
      identity,
      {
        preparationEdit: () =>
          new Promise((r) => {
            resolve = r;
          }),
      },
      { id: 'test', message: { text: 'first' } },
      input,
      (value) => {
        input = value;
      },
      () => {},
    );
    const pending = edit();
    input = boundary === 'typing' ? 'new input' : 'other conversation input';
    if (boundary === 'typing') version.current++;
    else identity.current = 'other';
    resolve();
    await pending;
    assert.equal(input, boundary === 'typing' ? 'new input' : 'other conversation input');
  });
}
for (const boundary of ['selection', 'unmount']) {
  test(`delayed saved callback retains journal after ${boundary}`, async () => {
    const fixture = setup();
    fixture.resolve();
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(fixture.counts().sends, 1);
    if (boundary === 'selection') fixture.model.preparing = { id: 'other' };
    else fixture.cleanup();
    fixture.saved();
    assert.equal(fixture.finishes(), 0);
    assert.equal(fixture.counts().restores, 0);
    assert.equal(fixture.value.message.text, 'first');
    assert.equal(fixture.value.draft, 'supplement');
  });
}
