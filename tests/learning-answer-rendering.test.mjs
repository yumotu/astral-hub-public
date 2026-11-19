import fs from 'node:fs';
import assert from 'node:assert/strict';
import test from 'node:test';
import ts from 'typescript';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const source = fs.readFileSync(new URL('../web/src/LearningPage.tsx', import.meta.url), 'utf8');
const ast = ts.createSourceFile(
  'LearningPage.tsx',
  source,
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TSX,
);
function extract(match) {
  const nodes = [];
  function visit(node) {
    if (match(node)) nodes.push(node.getText(ast));
    ts.forEachChild(node, visit);
  }
  visit(ast);
  assert.equal(nodes.length, 1);
  return nodes[0];
}
function compile(code, values, result) {
  const js = ts.transpileModule(code, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React },
  }).outputText;
  return new Function(...Object.keys(values), js + '\nreturn ' + result)(...Object.values(values));
}
const exerciseSource = extract((n) => ts.isFunctionDeclaration(n) && n.name?.text === 'Exercise');
function fixture() {
  const states = [],
    refs = [];
  let stateIndex = 0,
    refIndex = 0,
    markdown = [];
  const storage = new Map([['draft', JSON.stringify({ text: 'saved input' })]]);
  const values = {
    React,
    useState: (initial) => {
      const i = stateIndex++;
      if (!(i in states)) states[i] = typeof initial === 'function' ? initial() : initial;
      return [
        states[i],
        (value) => {
          states[i] = typeof value === 'function' ? value(states[i]) : value;
        },
      ];
    },
    useRef: (initial) => (refs[refIndex++] ||= { current: initial }),
    useId: () => 'fixture-radio',
    useEffect: () => {},
    sessionStorage: {
      getItem: (key) => storage.get(key) ?? null,
      setItem: (key, value) => storage.set(key, value),
    },
    ExerciseMarkdown: ({ text }) => React.createElement('div', null, text),
    PiMarkdown: ({ text }) => {
      markdown.push(text);
      return React.createElement('div', { 'data-markdown': true }, text);
    },
    LoaderCircle: () => null,
    CheckCircle2: () => null,
  };
  const Exercise = compile(exerciseSource, values, 'Exercise');
  const latest = {
    id: 'attempt',
    score: 90,
    passed: true,
    feedback: 'feedback',
    referenceAnswer: 'reference',
    explanation: 'explanation',
    questionRevision: 1,
    method: 'ai',
  };
  const props = {
    question: { id: 'q', kind: 'short', prompt: 'question', revision: 2 },
    latest,
    draftKey: 'draft',
    onGrade: async () => latest,
  };
  return {
    latest,
    render() {
      stateIndex = 0;
      refIndex = 0;
      markdown = [];
      return Exercise(props);
    },
    markdown: () => markdown,
  };
}
function find(tree, predicate) {
  if (!tree || typeof tree !== 'object') return;
  if (predicate(tree)) return tree;
  for (const child of React.Children.toArray(tree.props?.children)) {
    const result = find(child, predicate);
    if (result) return result;
  }
}
function toggle(tree, open) {
  const details = find(tree, (node) => node.type === 'details');
  const target = { open };
  details.props.onToggle({ target, currentTarget: target });
}

test('closed answers mount no Markdown; open and close retain result, draft and disclosure state', () => {
  const h = fixture();
  let tree = h.render();
  let html = renderToStaticMarkup(tree);
  assert.deepEqual(h.markdown(), []);
  assert.ok(html.includes('feedback'));
  assert.ok(html.includes('saved input'));
  toggle(tree, true);
  tree = h.render();
  html = renderToStaticMarkup(tree);
  assert.deepEqual(h.markdown(), ['reference', 'explanation']);
  assert.equal(find(tree, (n) => n.type === 'details').props.open, true);
  assert.ok(html.includes('reference'));
  assert.ok(html.includes('explanation'));
  assert.ok(html.includes('saved input'));
  // An unrelated parent render must not close the user's disclosure.
  tree = h.render();
  assert.equal(find(tree, (n) => n.type === 'details').props.open, true);
  toggle(tree, false);
  tree = h.render();
  renderToStaticMarkup(tree);
  assert.deepEqual(h.markdown(), []);
  toggle(tree, true);
  tree = h.render();
  html = renderToStaticMarkup(tree);
  assert.deepEqual(h.markdown(), ['reference', 'explanation']);
  assert.ok(html.includes('90 / 100'));
  assert.ok(html.includes('saved input'));
  assert.ok(html.includes('历史分数保留'));
});

test('nested toggle cannot alter answer disclosure', () => {
  const h = fixture();
  const tree = h.render();
  find(tree, (n) => n.type === 'details').props.onToggle({
    target: { open: true },
    currentTarget: { open: true },
  });
  assert.equal(find(h.render(), (n) => n.type === 'details').props.open, false);
});

const indexDeclaration = extract(
  (n) =>
    ts.isVariableStatement(n) &&
    n.declarationList.declarations.some((d) => d.name.getText(ast) === 'latestAttempts'),
);
const indexLoop = extract(
  (n) => ts.isForOfStatement(n) && n.getText(ast).includes('latestAttempts.set'),
);
const lookup = extract(
  (n) =>
    ts.isJsxAttribute(n) &&
    n.name.getText(ast) === 'latest' &&
    n.initializer?.getText(ast).includes('latestAttempts'),
);
function indexed(lesson) {
  return compile(indexDeclaration + '\n' + indexLoop, { lesson }, 'latestAttempts');
}

test('index preserves last array occurrence across questions, revisions and unsorted timestamps', () => {
  const attempts = [
    { id: 'a', questionId: 'q2', questionRevision: 3, createdAt: '2099' },
    { id: 'b', questionId: 'q1', questionRevision: 2, createdAt: '2099' },
    { id: 'c', questionId: 'q2', questionRevision: 1, createdAt: '2000' },
    { id: 'd', questionId: '__proto__', createdAt: '2000' },
    { id: 'e', questionId: 'q1', questionRevision: 1, createdAt: '2000' },
  ];
  const snapshot = structuredClone(attempts);
  const map = indexed({ attempts });
  for (const id of ['q1', 'q2', '__proto__', 'missing'])
    assert.equal(map.get(id), attempts.filter((a) => a.questionId === id).at(-1));
  assert.deepEqual(attempts, snapshot);
  assert.equal(map.get('q1').questionRevision, 1);
  assert.ok(lookup.includes('latestAttempts.get(q.id)'));
  assert.equal(indexed(null).size, 0);
  assert.equal(indexed({}).size, 0);
});

test('index reads questionId once per attempt rather than once per question per attempt', () => {
  let reads = 0;
  const attempts = Array.from({ length: 600 }, (_, i) => ({
    id: String(i),
    get questionId() {
      reads++;
      return 'q' + (i % 40);
    },
  }));
  const map = indexed({ attempts });
  for (let i = 0; i < 40; i++) assert.ok(map.get('q' + i));
  assert.equal(reads, 600);
  reads = 0;
  for (let i = 0; i < 40; i++) attempts.filter((a) => a.questionId === 'q' + i).at(-1);
  assert.equal(reads, 24000);
});
