import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import ts from 'typescript';
import { createReadCache } from '../shared/read-cache.mjs';

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
    detailReload: { current: null },
    invalidateAPI() {},
    loadedPages: { current: { lessons: 1, wrong: 1 } },
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
  values.api = (_s, path, _body, _method, _public, options) => {
    const d = deferred();
    requests.push({ path, options, ...d });
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
test('grading after a filter change refreshes the active filter and settles both lists', async () => {
  const h = learning();
  const grading = h.grade('lesson', 'question', { choiceIndex: 0 }, 'attempt');
  h.values.currentFilter.current = true;
  const activeRefresh = compile(named('LearningPage.tsx', 'refresh'), {
    ...h.values,
    resolved: true,
  });
  const filtered = activeRefresh();
  h.requests[1].resolve({ lessons: [{ id: 'lesson' }] });
  h.requests[2].resolve({ items: [{ id: 'mastered' }] });
  await filtered;
  assert.equal(h.state.WrongLoading, false);
  h.requests[0].resolve({ attempt: { id: 'attempt', score: 100 } });
  assert.equal((await grading).score, 100);
  assert.equal(h.requests[5].path, '/learning/wrong?resolved=include');
  h.requests[3].resolve({ lesson: { id: 'lesson' } });
  h.requests[4].resolve({ lessons: [{ id: 'lesson' }] });
  h.requests[5].resolve({ items: [{ id: 'current-mastered' }] });
  await tick();
  assert.equal(h.state.LessonsLoading, false);
  assert.equal(h.state.WrongLoading, false);
  assert.deepEqual(h.state.Wrong, [{ id: 'current-mastered' }]);
});
for (const kind of ['settings', 'session', 'unmount'])
  test('obsolete refresh cannot invalidate active loading: ' + kind, async () => {
    const h = learning();
    if (kind === 'settings') h.values.context.current.settings = {};
    if (kind === 'session') h.values.context.current.session = {};
    if (kind === 'unmount') h.values.alive.current = false;
    const before = structuredClone(h.state);
    const pending = h.refresh();
    assert.equal(h.requests.length, 0);
    assert.equal(h.values.refreshVersion.current, 0);
    await pending;
    assert.deepEqual(h.state, before);
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
test('resume handler preserves unknown UUID, rejects rapid duplicates and releases accepted operations', async () => {
  const settings = {},
    session = {},
    operation = { current: null },
    resuming = { current: false };
  const requests = [];
  let sequence = 0;
  const values = {
    settings,
    session,
    lesson: { id: 'lesson', status: 'error' },
    selection: { current: 'lesson' },
    resumeConfirmed: true,
    busy: '',
    resumeOperation: operation,
    resuming,
    alive: { current: true },
    context: { current: { settings, session } },
    crypto: { randomUUID: () => 'operation-' + ++sequence },
    setBusy() {},
    setError() {},
    setLesson() {},
    setResumeConfirmed() {},
    setResumeEpoch() {},
    detailVersion: { current: 0 },
    invalidateAPI() {},
    setAPICache() {},
    refresh() {},
    api: (_s, _path, input) => {
      const request = deferred();
      requests.push({ ...request, input });
      return request.promise;
    },
  };
  const invoke = () => compile(named('LearningPage.tsx', 'resumeLesson'), values)();
  const first = invoke();
  await invoke();
  assert.equal(requests.length, 1);
  requests[0].reject(Error('unknown network outcome'));
  await first;
  assert.equal(operation.current.id, 'operation-1');
  const retry = invoke();
  assert.equal(requests[1].input.id, 'operation-1');
  requests[1].resolve({ lesson: { id: 'lesson', status: 'generating' } });
  await retry;
  assert.equal(operation.current, null);
  // The same course later fails in a different chapter; explicit confirmation starts a new operation.
  const next = invoke();
  await invoke();
  assert.equal(requests.length, 3);
  assert.equal(requests[2].input.id, 'operation-2');
  requests[2].resolve({ lesson: { id: 'lesson', status: 'ready' } });
  await next;
  assert.equal(operation.current, null);
  assert.equal(resuming.current, false);
  assert.doesNotMatch(
    source('LearningPage.tsx'),
    /if \(e.target.checked\) resumeOperation.current = null/,
  );
});

test('resume receipt cannot replace a different selected course or restore a closed detail', async () => {
  for (const selected of ['other-lesson', '']) {
    const settings = {},
      session = {},
      request = deferred();
    const updates = [],
      operation = { current: null },
      selection = { current: 'lesson' };
    const values = {
      settings,
      session,
      lesson: { id: 'lesson', status: 'error' },
      resumeConfirmed: true,
      busy: '',
      resumeOperation: operation,
      resuming: { current: false },
      alive: { current: true },
      selection,
      context: { current: { settings, session } },
      crypto: { randomUUID: () => 'resume-operation' },
      setBusy() {},
      setError() {},
      setAPICache() {},
      invalidateAPI() {},
      detailVersion: { current: 0 },
      refresh() {},
      setLesson: (value) => updates.push(['lesson', value]),
      setResumeConfirmed: (value) => updates.push(['confirm', value]),
      setResumeEpoch: () => updates.push(['epoch']),
      api: () => request.promise,
    };
    const pending = compile(named('LearningPage.tsx', 'resumeLesson'), values)();
    selection.current = selected;
    operation.current = null;
    request.resolve({ lesson: { id: 'lesson', status: 'generating' } });
    await pending;
    assert.deepEqual(updates, [], 'late receipt must not change the current detail');
  }
});

test('late resume failure stays with its original course', async () => {
  const settings = {},
    session = {},
    request = deferred(),
    errors = [];
  const selection = { current: 'lesson' };
  const values = {
    settings,
    session,
    lesson: { id: 'lesson', status: 'error' },
    resumeConfirmed: true,
    busy: '',
    resumeOperation: { current: null },
    resuming: { current: false },
    alive: { current: true },
    selection,
    context: { current: { settings, session } },
    crypto: { randomUUID: () => 'resume-operation' },
    setBusy() {},
    setError: (value) => {
      if (value) errors.push(value);
    },
    api: () => request.promise,
  };
  const pending = compile(named('LearningPage.tsx', 'resumeLesson'), values)();
  selection.current = 'other-lesson';
  request.reject(Error('old course failed'));
  await pending;
  assert.deepEqual(errors, []);
});

function materialFiles() {
  const settings = {},
    session = {},
    state = { materials: [], error: '' };
  const materialSelection = { current: [] };
  const values = {
    settings,
    session,
    materials: [],
    materialSelection,
    materialLimits: { maxMaterials: 16, maxFileBytes: 65536 },
    materialSections: (items) => {
      assert.ok(items.length <= 16, 'material count');
      return [];
    },
    TextDecoder,
    alive: { current: true },
    context: { current: { settings, session } },
    setMaterials: (items) => {
      state.materials = items;
    },
    setMaterialError: (message) => {
      state.error = message;
    },
  };
  const add = (files) => compile(named('LearningPage.tsx', 'addFiles'), values)(files);
  const file = (name) => {
    const data = deferred();
    return {
      name,
      size: 20,
      arrayBuffer: () => data.promise,
      resolve: () => data.resolve(new TextEncoder().encode(name).buffer),
    };
  };
  return { values, state, add, file };
}

test('overlapping material file reads preserve both accepted selections', async () => {
  const h = materialFiles(),
    a = h.file('a.txt'),
    b = h.file('b.txt');
  const one = h.add([a]),
    two = h.add([b]);
  a.resolve();
  await one;
  b.resolve();
  await two;
  assert.deepEqual(
    h.state.materials.map((m) => m.name),
    ['a.txt', 'b.txt'],
  );
});

test('a pending material read does not restore removed materials', async () => {
  const h = materialFiles(),
    old = { name: 'old.txt', content: 'old' };
  h.values.materials = [old];
  h.values.materialSelection.current = [old];
  const file = h.file('new.txt'),
    pending = h.add([file]);
  h.values.materialSelection.current = [];
  h.state.materials = [];
  file.resolve();
  await pending;
  assert.deepEqual(
    h.state.materials.map((m) => m.name),
    ['new.txt'],
  );
});

test('overlapping material reads revalidate the latest combined count before accepting', async () => {
  const h = materialFiles();
  const existing = Array.from({ length: 15 }, (_, i) => ({ name: `${i}.txt`, content: 'text' }));
  h.values.materialSelection.current = existing;
  h.state.materials = existing;
  const a = h.file('a.txt'),
    b = h.file('b.txt');
  const first = h.add([a]),
    second = h.add([b]);
  a.resolve();
  await first;
  b.resolve();
  await second;
  assert.equal(h.state.materials.length, 16);
  assert.equal(h.state.materials.at(-1).name, 'a.txt');
  assert.match(h.state.error, /material count/);
});

test('material read failures after account changes do not overwrite the active error', async () => {
  const h = materialFiles();
  const data = deferred(),
    pending = h.add([{ name: 'a.txt', size: 1, arrayBuffer: () => data.promise }]);
  h.values.context.current = { settings: {}, session: {} };
  h.state.error = 'active account error';
  data.reject(Error('obsolete file error'));
  await pending;
  assert.equal(h.state.error, 'active account error');
});

test('completed grading after scope change does not start obsolete refresh', async () => {
  const h = learning();
  const run = h.grade('lesson', 'q', {}, 'id');
  h.values.context.current = { settings: {}, session: {} };
  h.requests[0].resolve({ attempt: { id: 'id' } });
  await run;
  assert.equal(h.requests.length, 1);
});

function detail() {
  const h = learning();
  const state = h.state;
  state.Lessons = [];
  const values = {
    ...h.values,
    selected: 'lesson',
    resumeEpoch: 0,
    detailVersion: { current: 0 },
    peekAPI: () => undefined,
    invalidateAPI() {},
    setDetailLoading: (v) => {
      state.DetailLoading = v;
    },
    setDetailError: (v) => {
      state.DetailError = v;
    },
    setLessons: (v) => {
      state.Lessons = typeof v === 'function' ? v(state.Lessons) : v;
    },
    setTimeout: () => 1,
    clearTimeout() {},
  };
  const code = extract(
    'LearningPage.tsx',
    (n, ast) =>
      ts.isCallExpression(n) &&
      n.expression.getText(ast) === 'useEffect' &&
      n.arguments[0]?.getText(ast).includes('async function load(fresh = false)'),
  );
  let cleanup;
  const js = ts.transpileModule(code, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
  function start() {
    new Function('useEffect', ...Object.keys(values), js)(
      (fn) => {
        cleanup = fn();
      },
      ...Object.values(values),
    );
  }
  return { ...h, values, start, cleanup: () => cleanup() };
}

test('failed detail can recover through explicit fresh refresh without replaying writes', async () => {
  const h = detail();
  h.start();
  assert.equal(h.state.DetailLoading, true);
  h.requests[0].reject(Error('read down'));
  await tick();
  assert.match(h.state.DetailError, /read down/);
  assert.equal(h.state.Error, undefined);
  assert.equal(h.state.DetailLoading, false);
  const refresh = compile(named('LearningPage.tsx', 'refresh'), h.values);
  const pending = refresh(true);
  assert.equal(h.requests[1].path, '/learning/lessons/lesson');
  assert.ok(h.requests.slice(1).every((r) => r.options.fresh));
  h.requests[1].resolve({ lesson: { id: 'lesson', status: 'ready' } });
  h.requests[2].resolve({ lessons: [] });
  h.requests[3].resolve({ items: [] });
  await pending;
  await tick();
  assert.equal(h.state.Lesson.status, 'ready');
  assert.equal(h.state.DetailError, '');
  h.cleanup();
});

test('detail repeated refresh and switch ignore obsolete results', async () => {
  const h = detail();
  h.start();
  h.values.detailReload.current();
  h.requests[1].resolve({ lesson: { id: 'lesson', status: 'ready' } });
  await tick();
  h.requests[0].resolve({ lesson: { id: 'lesson', status: 'error' } });
  await tick();
  assert.equal(h.state.Lesson.status, 'ready');
  h.values.detailReload.current();
  h.cleanup();
  h.requests[2].reject(Error('late'));
  await tick();
  assert.equal(h.state.DetailError, '');
});

test('detail read errors never select the new-generation retry entry', () => {
  const text = source('LearningPage.tsx');
  assert.match(text, /\{generationError && \(\s*<button/);
  assert.match(text, /课程详情读取失败：\{detailError\}/);
  assert.match(text, /重试读取课程/);
});

for (const filter of [false, true])
  test('refresh rebuilds all loaded pages using new cursors: ' + filter, async () => {
    const h = learning();
    h.values.loadedPages.current = { lessons: 2, wrong: 2 };
    h.values.currentFilter.current = filter;
    const refresh = compile(named('LearningPage.tsx', 'refresh'), h.values);
    const pending = refresh(true);
    h.requests[0].resolve({ lessons: [{ id: 'new' }], next: 'new-cursor' });
    h.requests[1].resolve({ items: [{ lessonId: 'x', questionId: 'q' }], next: 'wrong-cursor' });
    await tick();
    assert.equal(h.requests[2].path, '/learning/lessons?before=new-cursor');
    assert.equal(
      h.requests[3].path,
      '/learning/wrong?before=wrong-cursor' + (filter ? '&resolved=include' : ''),
    );
    h.requests[2].resolve({ lessons: [{ id: 'older' }], next: 'last' });
    h.requests[3].resolve({ items: [{ lessonId: 'older', questionId: 'q' }], next: null });
    await pending;
    assert.deepEqual(
      h.state.Lessons.map((l) => l.id),
      ['new', 'older'],
    );
    assert.equal(h.state.Wrong.length, 2);
    assert.equal(h.state.LessonsNext, 'last');
  });

test('resume invalidates old pending detail before caching its accepted receipt', async () => {
  const h = detail(),
    cache = createReadCache(),
    old = deferred();
  h.values.api = (_s, path) => cache.read(path, () => old.promise, { force: true });
  h.values.peekAPI = (_s, path) => cache.peek(path);
  h.values.invalidateAPI = (_s, path) => cache.invalidate((key) => key === path);
  h.start();
  await tick();
  const request = deferred();
  const receipt = { lesson: { id: 'lesson', status: 'generating' } };
  const resume = compile(named('LearningPage.tsx', 'resumeLesson'), {
    ...h.values,
    lesson: { id: 'lesson' },
    resumeConfirmed: true,
    busy: '',
    resuming: { current: false },
    resumeOperation: { current: null },
    crypto: { randomUUID: () => 'same-operation' },
    api: () => request.promise,
    setBusy() {},
    setResumeConfirmed() {},
    setResumeEpoch() {},
    refresh() {},
    setAPICache: (_s, path, value) => cache.set(path, value),
  });
  const pending = resume();
  request.resolve(receipt);
  await pending;
  old.resolve({ lesson: { id: 'lesson', status: 'error' } });
  await tick();
  assert.equal(cache.peek('/learning/lessons/lesson').lesson.status, 'generating');
  assert.equal(h.state.Lesson.status, 'generating');
  h.cleanup();
});
