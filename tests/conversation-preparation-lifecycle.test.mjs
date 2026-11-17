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
function editorHandler(name) {
  const start = source.indexOf(`  const ${name} = `);
  const end =
    name === 'submit'
      ? source.indexOf('  return (', start)
      : source.indexOf(`  const ${name === 'change' ? 'edit' : 'submit'} = `, start);
  const js = ts.transpileModule(source.slice(start, end), {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
  let resolve,
    reject,
    input = 'first',
    error;
  const version = { current: 1 },
    identity = { current: 'test' },
    value = { current: input },
    activity = { current: { id: 'test', pending: 0, failed: false } },
    calls = [];
  const operation = (...args) => {
    calls.push(args);
    return new Promise((r, j) => {
      resolve = r;
      reject = j;
    });
  };
  const handler = new Function(
    'inputVersion',
    'inputPreparation',
    'inputValue',
    'inputActivity',
    'setInputRevision',
    'model',
    'prep',
    'setInput',
    'setError',
    `${js}; return ${name};`,
  )(
    version,
    identity,
    value,
    activity,
    () => {},
    { preparationQueue: operation, preparationEdit: operation, preparationDraft: operation },
    { id: 'test', message: { text: 'queued' } },
    (text) => {
      input = text;
    },
    (text) => {
      error = text;
    },
  );
  return {
    handler,
    version,
    identity,
    value,
    activity,
    calls,
    resolve: () => resolve(),
    reject: () => reject(Error('conflict')),
    type(text) {
      input = text;
      value.current = text;
      version.current++;
    },
    read: () => ({ input, error }),
  };
}
test('actual submit handler forwards displayed draft and does not clear newer input', async () => {
  const fixture = editorHandler('submit');
  const pending = fixture.handler();
  assert.deepEqual(fixture.calls, [['test', 'first', 'first']]);
  fixture.type('new supplement');
  fixture.resolve();
  await pending;
  assert.equal(fixture.read().input, 'new supplement');
  assert.equal(fixture.activity.current.pending, 0);
});
for (const boundary of ['typing', 'selection']) {
  test(`actual edit handler preserves input after ${boundary} during wait`, async () => {
    const fixture = editorHandler('edit');
    const pending = fixture.handler();
    assert.deepEqual(fixture.calls, [['test', 'first']]);
    fixture.type(boundary === 'typing' ? 'new input' : 'other conversation input');
    if (boundary === 'selection') fixture.identity.current = 'other';
    fixture.resolve();
    await pending;
    assert.equal(
      fixture.read().input,
      boundary === 'typing' ? 'new input' : 'other conversation input',
    );
  });
}
test('actual change handler supplies previous displayed value and retains rejected local input', async () => {
  const fixture = editorHandler('change');
  fixture.handler('local unsaved');
  assert.deepEqual(fixture.calls, [['test', 'local unsaved', 'first']]);
  fixture.reject();
  for (let i = 0; i < 5; i++) await Promise.resolve();
  assert.equal(fixture.read().input, 'local unsaved');
  assert.equal(fixture.activity.current.failed, true);
  assert.equal(fixture.activity.current.pending, 0);
  assert.equal(fixture.read().error, 'conflict');
});
for (const protection of ['idle', 'pending', 'failed']) {
  test(`external draft layout sync respects ${protection} editor`, () => {
    const start = source.indexOf('  useLayoutEffect(() => {');
    const body = source.slice(start, source.indexOf('  const change = ', start));
    const js = ts.transpileModule(body, {
      compilerOptions: { target: ts.ScriptTarget.ES2022 },
    }).outputText;
    const inputValue = { current: 'local A' },
      version = { current: 1 },
      activity = {
        current: {
          id: 'test',
          pending: protection === 'pending' ? 1 : 0,
          failed: protection === 'failed',
        },
      };
    let input = 'local A';
    new Function(
      'useLayoutEffect',
      'inputActivity',
      'inputValue',
      'inputVersion',
      'setInput',
      'prep',
      'inputRevision',
      js,
    )(
      (fn) => fn(),
      activity,
      inputValue,
      version,
      (text) => {
        input = text;
      },
      { id: 'test', draft: 'other B' },
      0,
    );
    assert.equal(input, protection === 'idle' ? 'other B' : 'local A');
    assert.equal(inputValue.current, input);
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
