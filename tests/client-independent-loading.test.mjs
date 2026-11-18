import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import ts from 'typescript';

function source(file) {
  return fs.readFileSync(new URL('../web/src/' + file, import.meta.url), 'utf8');
}
function extract(file, match) {
  const ast = ts.createSourceFile(
    file,
    source(file),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const found = [];
  function visit(n) {
    if (match(n, ast)) found.push(n.getText(ast));
    ts.forEachChild(n, visit);
  }
  visit(ast);
  assert.equal(found.length, 1, file + ': unique extraction');
  return found[0];
}
function compile(code, values) {
  const js = ts.transpileModule('const extracted = (' + code + ');', {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText;
  return new Function(...Object.keys(values), js + '; return extracted;')(...Object.values(values));
}
const named = (file, name) =>
  extract(file, (n) => ts.isFunctionDeclaration(n) && n.name?.text === name);
function deferred() {
  let resolve, reject;
  const promise = new Promise((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
}
async function tick() {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}
function fileLoad(backupId = 'backup') {
  const state = {},
    calls = [],
    requests = { document: deferred(), diff: deferred() };
  const values = {
    target: { projectId: 'project', path: 'a.txt', backupId },
    settings: {},
    revision: 0,
    controller: { current: null },
  };
  for (const key of [
    'Selection',
    'Doc',
    'Diff',
    'Error',
    'Saved',
    'Busy',
    'Mode',
    'MobileTab',
    'Draft',
  ])
    values['set' + key] = (v) => {
      const k = key.toLowerCase();
      state[k] = typeof v === 'function' ? v(state[k]) : v;
    };
  values.api = (_s, path) => {
    const kind = path.endsWith('/diff') ? 'diff' : 'document';
    calls.push(kind);
    return requests[kind].promise;
  };
  const code = extract(
    'FileWorkbench.tsx',
    (n, ast) =>
      ts.isCallExpression(n) &&
      n.expression.getText(ast) === 'useEffect' &&
      n.arguments[0]?.getText(ast).includes('const base = `/pi/projects/${target.projectId}`'),
  );
  let cleanup;
  // Evaluate the actual effect call with injected hook and setters.
  const js = ts.transpileModule(code, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
  new Function('useEffect', ...Object.keys(values), js)(
    (fn) => {
      cleanup = fn();
    },
    ...Object.values(values),
  );
  return { state, calls, requests, cleanup, controller: values.controller };
}

test('file diff and document start together; ready diff publishes without document', async () => {
  const h = fileLoad();
  assert.deepEqual(h.calls, ['document', 'diff']);
  h.requests.diff.resolve({ before: 'old', after: 'new' });
  await tick();
  assert.equal(h.state.diff.after, 'new');
  assert.equal(h.state.doc, null);
  assert.equal(h.state.busy, true);
  h.requests.document.resolve({ content: 'current', sha256: 'hash', readOnly: false });
  await tick();
  assert.equal(h.state.doc.sha256, 'hash');
  assert.equal(h.state.draft, 'current');
  assert.equal(h.state.busy, false);
});
test('document failure keeps diff but never manufactures editable document', async () => {
  const h = fileLoad();
  h.requests.document.reject(Error('denied'));
  await tick();
  h.requests.diff.resolve({ after: 'redacted snapshot' });
  await tick();
  assert.equal(h.state.doc, null);
  assert.equal(h.state.diff.after, 'redacted snapshot');
  assert.match(h.state.error, /denied/);
  assert.equal(h.state.busy, false);
});
test('diff failure does not discard successful document and changes default to read', async () => {
  const h = fileLoad();
  h.requests.document.resolve({ content: 'file', readOnly: true });
  h.requests.diff.reject(Error('gone'));
  await tick();
  assert.equal(h.state.doc.readOnly, true);
  assert.equal(h.state.mode, 'read');
  assert.match(h.state.error, /gone/);
});
test('cancel, target switch or unmount ignores late file outcomes', async () => {
  const h = fileLoad();
  h.cleanup();
  const before = structuredClone(h.state);
  h.requests.document.resolve({ content: 'stale' });
  h.requests.diff.reject(Error('late'));
  await tick();
  assert.deepEqual(h.state, before);
  assert.equal(h.controller.current.signal.aborted, true);
});
test('ordinary file does not request diff', async () => {
  const normal = fileLoad('');
  assert.deepEqual(normal.calls, ['document']);
  normal.requests.document.resolve({ content: 'plain' });
  await tick();
  assert.equal(normal.state.busy, false);
});
test('ready content rendering is not gated by aggregate busy; unknown document cannot edit', () => {
  const text = source('FileWorkbench.tsx');
  assert.ok(text.includes("(mode === 'diff' ? diff : doc)"));
  assert.ok(text.includes("readOnly={mode !== 'edit' || !doc || doc.readOnly || busy}"));
});
function learning() {
  const state = {},
    requests = [],
    settings = {},
    session = {};
  const values = {
    settings,
    session,
    resolved: false,
    alive: { current: true },
    refreshVersion: { current: 0 },
    currentFilter: { current: false },
    context: { current: { settings, session } },
    selection: { current: 'lesson' },
  };
  for (const key of [
    'Lessons',
    'Wrong',
    'LessonsNext',
    'WrongNext',
    'LessonsLoading',
    'WrongLoading',
    'LessonsError',
    'WrongError',
    'Lesson',
    'Error',
  ])
    values['set' + key] = (v) => {
      state[key] = v;
    };
  values.api = (_s, path) => {
    const d = deferred();
    requests.push({ path, ...d });
    return d.promise;
  };
  const refresh = compile(named('LearningPage.tsx', 'refresh'), values);
  const grade = compile(named('LearningPage.tsx', 'grade'), { ...values, refresh });
  return { state, requests, values, refresh, grade };
}
test('lessons publish with their cursor while wrong is pending, then wrong fails independently', async () => {
  const h = learning();
  const run = h.refresh();
  h.requests[0].resolve({ lessons: [{ id: 'l' }], next: 'cursor' });
  await tick();
  assert.equal(h.state.Lessons[0].id, 'l');
  assert.equal(h.state.LessonsNext, 'cursor');
  assert.equal(h.state.LessonsLoading, false);
  assert.equal(h.state.WrongLoading, true);
  h.requests[1].reject(Error('wrong down'));
  await run;
  assert.match(h.state.WrongError, /wrong down/);
  assert.equal(h.state.WrongLoading, false);
});
test('wrong list publishes even when lessons fail; retry clears error and replaces data', async () => {
  const h = learning();
  const run = h.refresh();
  h.requests[0].reject(Error('lessons down'));
  h.requests[1].resolve({ items: [{ id: 'w' }] });
  await run;
  assert.equal(h.state.Wrong[0].id, 'w');
  assert.match(h.state.LessonsError, /lessons down/);
  const retry = h.refresh();
  assert.equal(h.state.LessonsError, '');
  h.requests[2].resolve({ lessons: [{ id: 'retry' }] });
  h.requests[3].resolve({ items: [] });
  await retry;
  assert.equal(h.state.Lessons[0].id, 'retry');
});
for (const kind of ['new refresh', 'filter', 'settings', 'session', 'unmount'])
  test('learning ignores expired outcomes: ' + kind, async () => {
    const h = learning();
    const run = h.refresh();
    if (kind === 'new refresh') h.values.refreshVersion.current++;
    if (kind === 'filter') h.values.currentFilter.current = true;
    if (kind === 'settings') h.values.context.current = { settings: {}, session: h.values.session };
    if (kind === 'session') h.values.context.current = { settings: h.values.settings, session: {} };
    if (kind === 'unmount') h.values.alive.current = false;
    const before = structuredClone(h.state);
    h.requests[0].resolve({ lessons: ['obsolete'] });
    h.requests[1].reject(Error('obsolete'));
    await run;
    assert.deepEqual(h.state, before);
  });
test('grading returns successful attempt without waiting for detail or list refresh', async () => {
  const h = learning();
  const run = h.grade('lesson', 'question', { choiceIndex: 0 }, 'same-id');
  h.requests[0].resolve({ attempt: { id: 'same-id', score: 100 } });
  assert.equal((await run).score, 100);
  assert.equal(h.requests.length, 4);
  assert.equal(h.state.LessonsLoading, true);
  h.requests[1].reject(Error('detail down'));
  h.requests[2].reject(Error('list down'));
  h.requests[3].resolve({ items: [] });
  await tick();
  assert.match(h.state.Error, /判题已完成/);
  assert.match(h.state.LessonsError, /list down/);
});
test('document publishes while diff is pending, both errors remain actionable', async () => {
  const h = fileLoad();
  h.requests.document.resolve({ content: 'current', readOnly: false });
  await tick();
  assert.equal(h.state.doc.content, 'current');
  assert.equal(h.state.diff, null);
  assert.equal(h.state.busy, true);
  h.requests.diff.reject(Error('diff unavailable'));
  await tick();
  assert.equal(h.state.busy, false);
  const failed = fileLoad();
  failed.requests.document.reject(Error('document unavailable'));
  failed.requests.diff.reject(Error('diff unavailable'));
  await tick();
  assert.match(failed.state.error, /document unavailable/);
  assert.match(failed.state.error, /diff unavailable/);
});
test('rapid repeated refresh keeps only latest list result and loading state', async () => {
  const h = learning();
  const first = h.refresh(),
    second = h.refresh();
  h.requests[0].resolve({ lessons: ['old'] });
  h.requests[1].reject(Error('old error'));
  await first;
  assert.equal(h.state.Lessons, undefined);
  assert.equal(h.state.LessonsLoading, true);
  assert.equal(h.state.WrongError, '');
  h.requests[2].resolve({ lessons: ['new'] });
  h.requests[3].resolve({ items: [] });
  await second;
  assert.deepEqual(h.state.Lessons, ['new']);
});
test('exercise single-flight prevents rapid duplicate grading and ignores completion after unmount', async () => {
  const request = deferred(),
    submitting = { current: false },
    mounted = { current: true },
    updates = [],
    attempt = { current: null };
  let calls = 0;
  const submit = compile(named('LearningPage.tsx', 'submit'), {
    submitting,
    mounted,
    attempt,
    answer: { choiceIndex: 0 },
    draftKey: 'test',
    choice: 0,
    text: '',
    sessionStorage: { setItem() {} },
    crypto: { randomUUID: () => 'stable-id' },
    setBusy: (v) => updates.push(['busy', v]),
    setError: (v) => updates.push(['error', v]),
    setResult: (v) => updates.push(['result', v]),
    onGrade: () => {
      calls++;
      return request.promise;
    },
  });
  const first = submit();
  await submit();
  assert.equal(calls, 1);
  assert.equal(attempt.current.id, 'stable-id');
  mounted.current = false;
  const before = structuredClone(updates);
  request.resolve({ score: 100 });
  await first;
  assert.deepEqual(updates, before);
  assert.equal(submitting.current, false);
});
test('completed grading after scope change does not start obsolete refresh', async () => {
  const h = learning();
  const run = h.grade('lesson', 'q', {}, 'id');
  h.values.context.current = { settings: {}, session: {} };
  h.requests[0].resolve({ attempt: { id: 'id' } });
  await run;
  assert.equal(h.requests.length, 1);
});
