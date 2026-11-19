import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';
import React from 'react';
const source = fs.readFileSync(new URL('../web/src/LearningPage.tsx', import.meta.url), 'utf8');
const ast = ts.createSourceFile(
  'page.tsx',
  source,
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TSX,
);
const code = ast.statements.find((n) => n.name?.text === 'QuestionEditor').getText(ast);
function nodes(tree, predicate) {
  if (!tree || typeof tree !== 'object') return [];
  if (Array.isArray(tree)) return tree.flatMap((n) => nodes(n, predicate));
  return [...(predicate(tree) ? [tree] : []), ...nodes(tree.props?.children, predicate)];
}
test('editor reads history, retains edits on conflict and saves with revision without automatic retry', async () => {
  const states = [],
    refs = [],
    calls = [],
    updates = [];
  let si = 0,
    ri = 0,
    conflict = true;
  const question = {
    id: 'q1',
    kind: 'choice',
    revision: 1,
    prompt: 'old',
    options: ['a', 'b'],
    correctIndex: 0,
    explanation: 'why',
  };
  const values = {
    React,
    useState(initial) {
      const index = si++;
      if (!(index in states)) states[index] = initial;
      return [
        states[index],
        (value) => {
          states[index] = typeof value === 'function' ? value(states[index]) : value;
        },
      ];
    },
    useRef(value) {
      const index = ri++;
      return (refs[index] ||= { current: value });
    },
    useEffect() {},
    api: async (_s, path, payload, method) => {
      calls.push({ path, payload, method });
      if (method === 'PATCH') {
        if (conflict) throw Object.assign(new Error('conflict'), { status: 409 });
        return { question: { ...payload.question, id: 'q1', revision: 2 } };
      }
      return path.endsWith('/history') ? { versions: [question] } : { question };
    },
  };
  const js = ts.transpileModule(code, {
    compilerOptions: { jsx: ts.JsxEmit.React, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const Editor = new Function(...Object.keys(values), js + ';return QuestionEditor;')(
    ...Object.values(values),
  );
  function render() {
    si = ri = 0;
    return Editor({
      settings: {},
      lessonId: 'lesson',
      questionId: 'q1',
      saved: (q) => updates.push(q),
    });
  }
  let tree = render();
  await nodes(tree, (n) => n.type === 'button')[0].props.onClick();
  await new Promise((r) => setImmediate(r));
  tree = render();
  assert.equal(calls.length, 2);
  assert.ok(
    nodes(tree, (n) => n.type === 'summary').some(
      (n) => n.props.children === '读取旧版题目（最近100版，只读）',
    ),
  );
  nodes(tree, (n) => n.type === 'textarea')[0].props.onChange({ target: { value: 'my edit' } });
  tree = render();
  nodes(tree, (n) => n.type === 'form')[0].props.onSubmit({ preventDefault() {} });
  await new Promise((r) => setImmediate(r));
  tree = render();
  assert.equal(nodes(tree, (n) => n.type === 'textarea')[0].props.value, 'my edit');
  assert.match(nodes(tree, (n) => n.props?.role === 'alert')[0].props.children, /未覆盖.*保留/);
  assert.equal(calls.filter((c) => c.method === 'PATCH').length, 1);
  assert.equal(updates.length, 0);
  conflict = false;
  nodes(tree, (n) => n.type === 'form')[0].props.onSubmit({ preventDefault() {} });
  await new Promise((r) => setImmediate(r));
  tree = render();
  assert.equal(updates[0].revision, 2);
  assert.equal(calls.at(-1).payload.revision, 1);
  assert.equal(calls.at(-1).payload.question.id, undefined);
  assert.match(nodes(tree, (n) => n.props?.role === 'status')[0].props.children, /草稿保留/);
});
