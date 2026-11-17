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
    finishPreparation: async (_id, restoreDraft) => {
      restoreDraft(model.preparing.draft);
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

const provider = readFileSync(
  new URL('../web/src/UnifiedConversations.tsx', import.meta.url),
  'utf8',
);
function finishFixture() {
  const start = provider.indexOf('finishPreparation: async (');
  const body = provider.slice(start, provider.indexOf('        discardPreparation:', start));
  const js = ts.transpileModule(`const operations = {${body}};`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const selection = { current: 'test' },
    alive = { current: true };
  const inputs = { current: new Map([['test', { text: 'latest supplement' }]]) };
  const saved = { id: 'test', draft: 'claim snapshot', message: { text: 'first' } };
  let resolveRemove,
    rejectRemove,
    draft = '',
    closed = false,
    updates = 0,
    error = '';
  const finish = new Function(
    'preparationSelection',
    'preparationAlive',
    'preparationInputs',
    'preparationJournal',
    'flushSync',
    'showPreparation',
    'setError',
    'updatePreparations',
    `${js};return operations.finishPreparation;`,
  )(
    selection,
    alive,
    inputs,
    {
      current: {
        list: () => [saved],
        remove: () =>
          new Promise((resolve, reject) => {
            resolveRemove = resolve;
            rejectRemove = reject;
          }),
      },
    },
    (work) => work(),
    () => {
      closed = true;
      selection.current = null;
    },
    (value) => {
      error = value;
    },
    () => {
      updates++;
    },
  );
  return {
    start: () =>
      finish('test', (text) => {
        draft = text;
      }),
    read: () => ({ draft, closed, updates, error }),
    selection,
    alive,
    saved,
    inputs,
    resolve: () => resolveRemove(),
    reject: () => rejectRemove(Error('storage failure')),
  };
}
test('handoff restores latest synchronous input and closes preparing editor before cleanup waits', async () => {
  const fixture = finishFixture();
  const pending = fixture.start();
  assert.deepEqual(fixture.read(), {
    draft: 'latest supplement',
    closed: true,
    updates: 0,
    error: '',
  });
  assert.equal(fixture.saved.message.text, 'first');
  fixture.resolve();
  await pending;
  assert.equal(fixture.read().draft, 'latest supplement');
  assert.equal(fixture.inputs.current.has('test'), false);
});
test('cleanup failure retains recovery and never clears restored supplement', async () => {
  const fixture = finishFixture();
  const pending = fixture.start();
  fixture.reject();
  await pending;
  assert.equal(fixture.read().draft, 'latest supplement');
  assert.equal(fixture.inputs.current.get('test').text, 'latest supplement');
  assert.equal(fixture.saved.message.text, 'first');
  assert.match(fixture.read().error, /不会自动重复发送/);
});
for (const boundary of ['selection', 'unmount']) {
  test(`finishing a handed conversation does nothing after ${boundary}`, async () => {
    const fixture = finishFixture();
    if (boundary === 'selection') fixture.selection.current = 'other';
    else fixture.alive.current = false;
    await fixture.start();
    assert.deepEqual(fixture.read(), { draft: '', closed: false, updates: 0, error: '' });
  });
}
