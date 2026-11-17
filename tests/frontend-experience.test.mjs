import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

test('collapsed process group does not mount tool payloads and expansion restores them', () => {
  const file = source('PiTimeline.tsx');
  const component = find(
    file,
    (n) => ts.isFunctionDeclaration(n) && n.name?.text === 'ProcessGroup',
  );
  const javascript = ts.transpile(component.getText(file), {
    target: ts.ScriptTarget.ES2022,
    jsx: ts.JsxEmit.React,
  });
  const Icon = () => null;
  function render(expanded) {
    const ProcessGroup = Function(
      'React',
      'useState',
      'useFileWorkbench',
      'activityTarget',
      'toolLabels',
      'isTodoTool',
      'LoaderCircle',
      'CircleAlert',
      'CheckCircle2',
      'ChevronDown',
      'StepIcon',
      javascript + '; return ProcessGroup;',
    )(
      React,
      () => [expanded, () => {}],
      () => null,
      () => ({ label: 'fixture' }),
      {},
      () => false,
      Icon,
      Icon,
      Icon,
      Icon,
      Icon,
    );
    const items = Array.from({ length: 200 }, (_, i) => ({
      kind: 'tool',
      id: String(i),
      name: 'bash',
      status: 'done',
      output: 'large-output-' + 'x'.repeat(1000),
    }));
    return renderToStaticMarkup(React.createElement(ProcessGroup, { items, active: false }));
  }
  const collapsed = render(false),
    expanded = render(true);
  assert.ok(!collapsed.includes('process-steps'));
  assert.ok(!collapsed.includes('large-output-'));
  assert.equal((expanded.match(/large-output-/g) || []).length, 200);
  assert.ok(expanded.length > collapsed.length + 200000);
});

function source(name) {
  return ts.createSourceFile(
    name,
    readFileSync(new URL('../web/src/' + name, import.meta.url), 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
}
function find(root, predicate) {
  let result;
  function visit(node) {
    if (result) return;
    if (predicate(node)) result = node;
    else ts.forEachChild(node, visit);
  }
  visit(root);
  assert.ok(result, 'expected component behavior must exist');
  return result;
}
function evaluate(expression, bindings) {
  const javascript = ts.transpile('const behavior = ' + expression + ';', {
    target: ts.ScriptTarget.ES2022,
  });
  return Function(
    ...Object.keys(bindings),
    javascript + '; return behavior;',
  )(...Object.values(bindings));
}

test('management polling skips hidden documents and resumes on visible focus; cleanup removes timer/listeners', () => {
  const file = source('UnifiedConversations.tsx');
  const effect = find(
    file,
    (n) =>
      ts.isCallExpression(n) &&
      n.expression.getText(file) === 'useEffect' &&
      n.arguments[1]?.getText(file) === '[refreshManagement]',
  );
  const listeners = new Map();
  let tick,
    requests = 0,
    cleared = false;
  const document = { hidden: false };
  const cleanup = evaluate(effect.arguments[0].getText(file), {
    document,
    refreshManagement: () => {
      requests++;
      return Promise.resolve();
    },
    setError: assert.fail,
    managementRead: { current: 0 },
    setInterval: (fn, interval) => {
      assert.equal(interval, 15000);
      tick = fn;
      return 42;
    },
    clearInterval: (id) => {
      assert.equal(id, 42);
      cleared = true;
    },
    window: {
      addEventListener: (name, fn) => listeners.set(name, fn),
      removeEventListener: (name, fn) => {
        assert.equal(listeners.get(name), fn);
        listeners.delete(name);
      },
    },
  })();
  assert.equal(requests, 1);
  document.hidden = true;
  for (let i = 0; i < 4; i++) tick();
  listeners.get('focus')();
  assert.equal(requests, 1, 'hidden periodic and focus callbacks do not fetch');
  document.hidden = false;
  listeners.get('focus')();
  tick();
  assert.equal(requests, 3);
  cleanup();
  assert.equal(cleared, true);
  assert.equal(listeners.size, 0);
});

test('incoming social messages retain reader position, latest button resumes following, and near-bottom follows', () => {
  const file = source('SocialPage.tsx');
  const effect = find(
    file,
    (n) =>
      ts.isCallExpression(n) &&
      n.expression.getText(file) === 'useEffect' &&
      n.arguments[1]?.getText(file) === '[messages.at(-1)?.seq, selected]',
  );
  const scrollHandler = find(
    file,
    (n) => ts.isJsxAttribute(n) && n.name.getText(file) === 'onScroll',
  );
  const latestButton = find(
    file,
    (n) =>
      ts.isJsxElement(n) &&
      n.getText(file).includes('回到最新消息') &&
      n.openingElement.tagName.getText(file) === 'button',
  );
  const latestClick = latestButton.openingElement.attributes.properties.find(
    (n) => n.name?.getText(file) === 'onClick',
  );
  const followLatest = { current: true };
  const panel = {
    scrollHeight: 2000,
    scrollTop: 1500,
    clientHeight: 500,
    scrollTo: ({ top }) => {
      panel.scrollTop = top - panel.clientHeight;
    },
  };
  let away = false,
    older = true;
  const bindings = {
    followLatest,
    scroll: { current: panel },
    setAwayFromLatest: (v) => {
      away = v;
    },
    setOlder: (v) => {
      older = v;
    },
  };
  const onScroll = evaluate(scrollHandler.initializer.expression.getText(file), bindings);
  const incoming = evaluate(effect.arguments[0].getText(file), bindings);
  const latest = evaluate(latestClick.initializer.expression.getText(file), bindings);
  incoming();
  assert.equal(panel.scrollTop, 1500);
  panel.scrollTop = 600;
  onScroll({ currentTarget: panel });
  assert.equal(away, true);
  panel.scrollHeight = 2100;
  incoming();
  assert.equal(panel.scrollTop, 600, 'new messages must not move a reader away from history');
  latest();
  assert.equal(panel.scrollTop, 1600);
  assert.equal(away, false);
  assert.equal(older, false);
  panel.scrollHeight = 2200;
  incoming();
  assert.equal(panel.scrollTop, 1700);
  panel.scrollTop = 1660;
  onScroll({ currentTarget: panel });
  assert.equal(followLatest.current, true, 'within 80px still follows');
  panel.scrollTop = 1400;
  onScroll({ currentTarget: panel });
  assert.equal(followLatest.current, false);
});
