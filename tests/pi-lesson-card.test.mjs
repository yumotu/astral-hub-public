import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';
import vm from 'node:vm';
import { applyPiTimeline } from '../shared/pi-timeline.mjs';
const source = fs.readFileSync(new URL('../web/src/PiLessonCard.tsx', import.meta.url), 'utf8');
const file = ts.createSourceFile(
  'card.tsx',
  source,
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TSX,
);
const functions = file.statements
  .filter(ts.isFunctionDeclaration)
  .map((n) => n.getText(file))
  .join('\n');
const code = ts.transpile(functions.replaceAll('export function', 'function'), {
  jsx: ts.JsxEmit.React,
  target: ts.ScriptTarget.ES2022,
});
const id = '12345678-1234-1234-1234-123456789012';
function harness(responses) {
  const states = [],
    timers = new Map(),
    listeners = new Map(),
    calls = [];
  let effect,
    cleanup,
    now = 0;
  const context = {
    React: { createElement: (...args) => args },
    AbortController,
    Date: { now: () => now },
    document: {
      hidden: false,
      addEventListener: (k, v) => listeners.set(k, v),
      removeEventListener: (k) => listeners.delete(k),
    },
    useState: (initial) => {
      const i = states.length;
      states.push(initial);
      return [initial, (v) => (states[i] = v)];
    },
    useEffect: (fn) => {
      effect = fn;
    },
    setTimeout: (fn, delay) => {
      const key = {};
      timers.set(key, { fn, delay });
      return key;
    },
    clearTimeout: (key) => timers.delete(key),
    api: async (...args) => {
      calls.push(args);
      const next = responses.shift();
      if (next instanceof Error) throw next;
      return { lesson: next };
    },
  };
  vm.createContext(context);
  vm.runInContext(code, context);
  context.PiLessonCard({
    id,
    settings: { url: 'test', sessionToken: 'fixture' },
    openLesson: () => {},
  });
  cleanup = effect();
  return {
    context,
    states,
    timers,
    calls,
    cleanup,
    async flush() {
      await Promise.resolve();
      await Promise.resolve();
    },
    async tick() {
      const [key, t] = timers.entries().next().value;
      timers.delete(key);
      now += t.delay;
      t.fn();
      await this.flush();
    },
    visible(hidden) {
      context.document.hidden = hidden;
      listeners.get('visibilitychange')();
    },
  };
}
test('recognizes metadata and legacy lesson only from app tool results', () => {
  const h = harness([{ title: 'x', status: 'ready' }]);
  assert.deepEqual(
    Array.from(
      h.context.deliveredLessons([
        { name: 'bash', status: 'done', lessonId: id },
        { name: 'app_functions', status: 'running', lessonId: id },
      ]),
    ),
    [],
  );
  assert.deepEqual(
    Array.from(
      h.context.deliveredLessons([
        {
          name: 'app_functions',
          status: 'done',
          output: JSON.stringify({ learning: { lessonId: id } }),
        },
        {
          name: 'app_functions',
          status: 'done',
          output: JSON.stringify({ result: { lesson: { id } } }),
        },
      ]),
    ),
    [id],
  );
  h.cleanup();
});
test('generating polls with backoff then ready stops', async () => {
  const h = harness([
    { title: 'course', status: 'generating' },
    { title: 'course', status: 'generating' },
    { title: 'course', status: 'ready' },
  ]);
  await h.flush();
  assert.equal(h.states[0].status, 'generating');
  assert.equal([...h.timers.values()][0].delay, 3000);
  await h.tick();
  assert.equal([...h.timers.values()][0].delay, 6000);
  await h.tick();
  assert.equal(h.states[0].status, 'ready');
  assert.equal(h.timers.size, 0);
  assert.ok(h.calls.every((c) => c[1] === '/learning/lessons/' + id && c[5].signal));
  h.cleanup();
  assert.equal(h.calls[0][5].signal.aborted, true);
});
for (const status of ['error', 403, 404, 500])
  test('terminal ' + status + ' never retries', async () => {
    const response =
      typeof status === 'number'
        ? Object.assign(new Error('fixture'), { status })
        : { title: 'course', status };
    const h = harness([response]);
    await h.flush();
    h.visible(true);
    h.visible(false);
    await h.flush();
    assert.equal(h.calls.length, 1);
    assert.equal(h.timers.size, 0);
    if (status === 403 || status === 404) assert.equal(h.states[1], '课程不可用');
    h.cleanup();
  });
test('hidden pause, cleanup, and finite generating budget', async () => {
  const h = harness(Array.from({ length: 20 }, () => ({ title: 'x', status: 'generating' })));
  await h.flush();
  h.visible(true);
  assert.equal(h.timers.size, 0);
  h.visible(false);
  await h.flush();
  assert.equal(h.calls.length, 1);
  while (h.timers.size) await h.tick();
  assert.equal(h.calls.length, 20);
  assert.equal(h.states[2], true);
  h.cleanup();
});
test('timeline appends fields without mutating prior or old records', () => {
  const before = applyPiTimeline([], { type: 'tool_start', id: 't', name: 'app_functions' });
  const after = applyPiTimeline(before, {
    type: 'tool_end',
    id: 't',
    lessonId: id,
    lessonStatus: 'generating',
  });
  assert.equal(before[0].status, 'running');
  assert.equal(before[0].lessonId, undefined);
  assert.equal(after[0].lessonId, id);
  const old = applyPiTimeline(before, { type: 'tool_end', id: 't' });
  assert.equal(old[0].status, 'done');
});
test('ready entry wires exact id and overrides prior wrong tab', () => {
  assert.match(source, /onClick=\{\(\) => openLesson\(id\)\}/);
  const main = fs.readFileSync(new URL('../web/src/main.tsx', import.meta.url), 'utf8');
  const learning = fs.readFileSync(new URL('../web/src/LearningPage.tsx', import.meta.url), 'utf8');
  assert.match(main, /setLessonTarget\(id\)/);
  assert.match(main, /initialLessonId=\{lessonTarget\}/);
  assert.match(learning, /initialLessonId \|\| saved.selected/);
  assert.match(learning, /!initialLessonId && saved.tab/);
});
