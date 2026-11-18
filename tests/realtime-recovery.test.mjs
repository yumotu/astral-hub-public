import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import ts from 'typescript';
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
};
const tick = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};
function effect(file, marker, values) {
  const text = fs.readFileSync(new URL('../web/src/' + file, import.meta.url), 'utf8');
  const ast = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let code;
  function visit(n) {
    if (
      ts.isCallExpression(n) &&
      n.expression.getText(ast) === 'useEffect' &&
      n.arguments[0]?.getText(ast).includes(marker)
    )
      code = n.arguments[0].getText(ast);
    ts.forEachChild(n, visit);
  }
  visit(ast);
  assert.ok(code);
  const js = ts.transpileModule('const run = (' + code + ');', {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
  return new Function(...Object.keys(values), js + ';return run();')(...Object.values(values));
}
function events() {
  const handlers = {};
  return {
    handlers,
    addEventListener: (k, f) => (handlers[k] = f),
    removeEventListener: (k) => delete handlers[k],
  };
}
test('unread mutation rejects old responses and coalesces notifications into one follow-up per module', async () => {
  const window = events(),
    document = { ...events(), visibilityState: 'visible' },
    requests = [],
    writes = [];
  let state = { scope: 's' };
  const cleanup = effect('unread.tsx', 'socialBusy = false', {
    settings: {},
    signedIn: true,
    scope: 's',
    initial: () => state,
    window,
    document,
    AbortController,
    setInterval: () => 1,
    clearInterval() {},
    setAPICache: (_s, p, v) => writes.push([p, v]),
    setSnapshot: (v) => (state = typeof v === 'function' ? v(state) : v),
    api: (_s, path) => {
      const d = deferred();
      requests.push({ path, ...d });
      return d.promise;
    },
  });
  assert.equal(requests.length, 2);
  window.handlers['astral:unread-change']();
  window.handlers['astral:unread-change']();
  requests[0].resolve({ messages: 9, requests: 0 });
  requests[1].resolve({ available: true, count: 9 });
  await tick();
  assert.equal(writes.length, 0);
  assert.equal(requests.length, 4);
  requests[2].resolve({ messages: 0, requests: 0 });
  requests[3].reject(Error('mail down'));
  await tick();
  assert.equal(state.social.messages, 0);
  assert.equal(writes.length, 1);
  assert.equal(requests.length, 4);
  cleanup();
  assert.equal(Object.keys(window.handlers).length, 0);
});
test('Pi status recovery respects backoff, coalesces focus/visible and publishes available', async () => {
  let now = 0,
    timer,
    calls = 0,
    status;
  const window = events(),
    document = { ...events(), hidden: false },
    request = deferred();
  const cleanup = effect('PiPage.tsx', 'attempts >= 5', {
    session: {},
    settings: {},
    status: null,
    window,
    document,
    Date: { now: () => now },
    setTimeout: (f) => {
      timer = f;
      return 1;
    },
    clearTimeout() {},
    setStatus: (v) => (status = v),
    setError() {},
    api: (_s, p, _b, _m, _pub, o) => {
      assert.equal(p, '/pi/status');
      assert.equal(o.fresh, true);
      calls++;
      return request.promise;
    },
  });
  window.handlers.focus();
  assert.equal(calls, 0);
  now = 2000;
  window.handlers.focus();
  document.handlers.visibilitychange();
  window.handlers.online();
  assert.equal(calls, 1);
  request.resolve({ available: true });
  await tick();
  assert.equal(status.available, true);
  cleanup();
  assert.equal(Object.keys(window.handlers).length, 0);
});
test('Pi status retries are bounded, hidden pauses reads, and online can resume an exhausted budget', async () => {
  let now = 0,
    scheduled,
    calls = 0;
  const window = events(),
    document = { ...events(), hidden: true };
  const cleanup = effect('PiPage.tsx', 'attempts >= 5', {
    session: {},
    settings: {},
    status: null,
    window,
    document,
    Date: { now: () => now },
    setTimeout: (fn, ms) => {
      scheduled = { fn, ms };
      return 1;
    },
    clearTimeout: () => {
      scheduled = null;
    },
    setStatus() {},
    setError() {},
    api: async () => {
      calls++;
      throw Error('offline');
    },
  });
  now = 2000;
  scheduled.fn();
  await tick();
  assert.equal(calls, 0);
  assert.equal(scheduled, null);
  document.hidden = false;
  document.handlers.visibilitychange();
  await tick();
  assert.equal(calls, 1);
  for (let i = 1; i < 5; i++) {
    assert.ok(scheduled.ms <= 30000);
    now += scheduled.ms;
    scheduled.fn();
    await tick();
  }
  assert.equal(calls, 5);
  assert.equal(scheduled, null);
  now += 30000;
  window.handlers.online();
  await tick();
  assert.equal(calls, 6);
  cleanup();
});

test('wake during fifth pending status read cannot reset the exhausted budget', async () => {
  let now = 0, scheduled, calls = 0;
  const fifth = deferred(), window = events(), document = { ...events(), hidden: false };
  const cleanup = effect('PiPage.tsx', 'attempts >= 5', {
    session: {}, settings: {}, status: null, window, document,
    Date: { now: () => now },
    setTimeout: (fn, ms) => { scheduled = { fn, ms }; return 1; },
    clearTimeout: () => { scheduled = null; },
    setStatus() {}, setError() {},
    api: () => { calls++; return calls === 5 ? fifth.promise : Promise.reject(Error('offline')); },
  });
  for (let i = 0; i < 5; i++) {
    now += scheduled.ms; scheduled.fn(); await tick();
  }
  assert.equal(calls, 5);
  window.handlers.focus(); window.handlers.online(); document.handlers.visibilitychange();
  assert.equal(calls, 5);
  fifth.reject(Error('still offline')); await tick();
  assert.equal(scheduled, null);
  assert.equal(calls, 5);
  window.handlers.online();
  assert.equal(calls, 5);
  assert.equal(scheduled.ms, 30000);
  cleanup();
});

test('Pi history retries only GET after failure and cleans timer on switch', async () => {
  let timer,
    calls = 0,
    turns = [];
  const requests = [];
  const values = {
    session: {},
    settings: {},
    conversation: 'c',
    peekAPI: () => undefined,
    setTurns: (v) => (turns = typeof v === 'function' ? v(turns) : v),
    setLoadingHistory() {},
    setVisible() {},
    setMore() {},
    setSessionContext() {},
    setCompacting() {},
    setFailedTools() {},
    setEmptyConversation() {},
    setError() {},
    setConversations() {},
    setProjectId() {},
    setAccess() {},
    tasksRef: { current: [] },
    drafts: { current: new Map() },
    savedOperation: () => ({}),
    taskPending: () => false,
    mergeSessionContext: () => null,
    setTimeout: (f, ms) => {
      assert.equal(ms, 2000);
      timer = f;
      return 1;
    },
    clearTimeout: () => {
      timer = null;
    },
    api: (_s, p, _b, _m, _pub, o) => {
      calls++;
      assert.equal(p, '/pi/conversations/c');
      if (calls > 1) assert.equal(o.fresh, true);
      const d = deferred();
      requests.push(d);
      return d.promise;
    },
  };
  const cleanup = effect('PiPage.tsx', 'setLoadingHistory(!cached)', values);
  requests[0].reject(Error('offline'));
  await tick();
  assert.ok(timer);
  timer();
  assert.equal(calls, 2);
  requests[1].resolve({ turns: [{ id: 't', seq: 1 }] });
  await tick();
  assert.equal(turns[0].id, 't');
  cleanup();
  assert.equal(timer, null);
});
