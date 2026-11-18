import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';
import { conversationEntries } from '../shared/pi-conversation.mjs';

function component() {
  const file = fs.readFileSync(new URL('../web/src/ToolLog.tsx', import.meta.url), 'utf8');
  const ast = ts.createSourceFile(
    'ToolLog.tsx',
    file,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const code = ast.statements
    .filter((n) => !ts.isImportDeclaration(n))
    .map((n) => n.getText(ast))
    .join('\n');
  const js = ts.transpileModule(code, {
    compilerOptions: {
      jsx: ts.JsxEmit.React,
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;
  const exports = {},
    state = [];
  let cursor = 0,
    calls = 0;
  const useState = (value) => {
    const i = cursor++;
    if (!(i in state)) state[i] = value;
    return [
      state[i],
      (v) => {
        state[i] = typeof v === 'function' ? v(state[i]) : v;
      },
    ];
  };
  new Function(
    'exports',
    'React',
    'useState',
    'useFileWorkbench',
    'Terminal',
    'FileText',
    'Check',
    'RotateCcw',
    'api',
    js,
  )(
    exports,
    React,
    useState,
    () => null,
    () => null,
    () => null,
    () => null,
    () => null,
    () => {
      calls++;
      throw Error('unexpected restore');
    },
  );
  const render = (tools) => {
    cursor = 0;
    return exports.ToolLog({ tools });
  };
  return {
    render,
    state,
    get calls() {
      return calls;
    },
  };
}
function nodes(node, type, result = []) {
  if (Array.isArray(node)) {
    for (const n of node) nodes(n, type, result);
  } else if (React.isValidElement(node)) {
    if (node.type === type) result.push(node);
    nodes(node.props.children, type, result);
  }
  return result;
}
function toggle(node, open, bubbled = false) {
  const currentTarget = { open };
  node.props.onToggle({ currentTarget, target: bubbled ? {} : currentTarget });
}
const tool = (id, status = 'done') => ({
  id,
  name: 'bash',
  path: '.',
  status,
  command: 'synthetic',
  output: 'x'.repeat(12000),
});
test('ToolLog defers closed payload, toggles one row, remembers reopens, ignores bubbled toggle', () => {
  const h = component(),
    tools = Array.from({ length: 100 }, (_, i) => tool(String(i)));
  let tree = h.render(tools),
    html = renderToStaticMarkup(tree);
  assert.equal(nodes(tree, 'pre').length, 0);
  assert.ok(!html.includes('xxxx'));
  console.log('closed100 HTML bytes', Buffer.byteLength(html));
  let outer = nodes(tree, 'details')[0];
  toggle(outer, true, true);
  assert.equal(nodes(h.render(tools), 'pre').length, 0);
  toggle(outer, true);
  tree = h.render(tools);
  assert.equal(nodes(tree, 'pre').length, 0);
  toggle(nodes(tree, 'details')[1], true);
  tree = h.render(tools);
  assert.equal(nodes(tree, 'pre').length, 2);
  assert.ok(renderToStaticMarkup(tree).includes('x'.repeat(12000)));
  toggle(nodes(tree, 'details')[0], false);
  assert.equal(nodes(h.render(tools), 'pre').length, 0);
  toggle(nodes(h.render(tools), 'details')[0], true);
  tree = h.render(tools);
  assert.equal(nodes(tree, 'pre').length, 2);
  toggle(nodes(tree, 'details')[1], false);
  assert.equal(nodes(h.render(tools), 'pre').length, 0);
  assert.equal(h.calls, 0);
});
test('running bash defaults open only inside opened log and explicit collapse survives updates', () => {
  const h = component();
  let tools = [tool('run', 'running')],
    tree = h.render(tools);
  assert.equal(nodes(tree, 'pre').length, 0);
  toggle(nodes(tree, 'details')[0], true);
  tree = h.render(tools);
  assert.equal(nodes(tree, 'pre').length, 2);
  toggle(nodes(tree, 'details')[1], false);
  tree = h.render([tool('run', 'running')]);
  assert.equal(nodes(tree, 'pre').length, 0);
  assert.equal(nodes(h.render([tool('run', 'done')]), 'pre').length, 0);
});
test('nonbash details defer arguments and output; empty list and empty output remain valid', () => {
  const h = component();
  assert.equal(h.render([]), null);
  const tools = [
    { id: 'r', name: 'read', path: '.', status: 'done', arguments: 'args', output: 'result' },
    { ...tool('e'), output: '' },
  ];
  let tree = h.render(tools);
  toggle(nodes(tree, 'details')[0], true);
  tree = h.render(tools);
  assert.equal(nodes(tree, 'pre').length, 0);
  toggle(nodes(tree, 'details')[1], true);
  tree = h.render(tools);
  assert.equal(nodes(tree, 'pre').length, 2);
  toggle(nodes(tree, 'details')[2], true);
  assert.equal(nodes(h.render(tools), 'pre').length, 3);
});
test('conversation index preserves scoped, saved, duplicate, missing and sorted supplements', () => {
  const turns = [{ id: 'p', createdAt: '2026-01-02', supplements: [{ id: 'saved' }] }];
  const tasks = [
    { id: 'late', parentId: 'p', createdAt: '2026-01-04' },
    { id: 'saved', parentId: 'p', createdAt: '2026-01-03' },
    { id: 'early', parentId: 'p', createdAt: '2026-01-01' },
    { id: 'orphan', parentId: 'missing', status: 'error', createdAt: '2026-01-05' },
    { id: 'foreign', parentId: 'p', conversationId: 'other' },
  ].map((t) => ({ conversationId: 'c', status: 'accepted', ...t }));
  const original = structuredClone({ turns, tasks }),
    entries = conversationEntries(turns, tasks, 'c');
  assert.deepEqual(
    entries.map((e) => e.turn.id),
    ['p', 'orphan'],
  );
  assert.deepEqual(
    entries[0].supplements.map((t) => t.id),
    ['early', 'late'],
  );
  assert.deepEqual({ turns, tasks }, original);
});
for (const n of [0, 1, 100, 500, 1000])
  test('conversation parent lookups scale linearly ' + n, () => {
    let reads = 0;
    const turns = Array.from({ length: n }, (_, i) => ({ id: 't' + i, createdAt: '2026-01-01' }));
    const tasks = Array.from({ length: 2 * n }, (_, i) => ({
      id: 's' + i,
      conversationId: 'c',
      status: 'done',
      createdAt: '2026-01-01',
      get parentId() {
        reads++;
        return 't' + (i % n);
      },
    }));
    const entries = conversationEntries(turns, tasks, 'c');
    assert.equal(entries.length, n);
    assert.equal(
      entries.reduce((sum, e) => sum + e.supplements.length, 0),
      2 * n,
    );
    assert.ok(reads <= 8 * n);
    console.log('parentId count', n, reads);
  });
