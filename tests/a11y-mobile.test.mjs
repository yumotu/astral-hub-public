import fs from 'node:fs';
import assert from 'node:assert/strict';
import test from 'node:test';
import ts from 'typescript';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
const read = (file) => fs.readFileSync(new URL('../web/src/' + file, import.meta.url), 'utf8');
function extract(file, predicate) {
  const ast = ts.createSourceFile(
    file,
    read(file),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const found = [];
  function visit(n) {
    if (predicate(n, ast)) found.push(n.getText(ast));
    ts.forEachChild(n, visit);
  }
  visit(ast);
  assert.equal(found.length, 1);
  return found[0];
}
function evaluate(code, values, expression) {
  const js = ts.transpileModule(code, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React },
  }).outputText;
  return new Function(...Object.keys(values), js + '\nreturn ' + expression)(
    ...Object.values(values),
  );
}
test('count fields expose shared stable error only after interaction and retain entered value', () => {
  for (const label of ['选择题数量', '问答题数量']) {
    const input = extract(
      'LearningPage.tsx',
      (n) =>
        ts.isJsxSelfClosingElement(n) &&
        n.tagName.getText() === 'input' &&
        n.getText().includes('aria-label="' + label + '"'),
    );
    for (const countsError of [false, true]) {
      let touched = false,
        value;
      const element = evaluate(
        'const element = (' + input + ');',
        {
          React,
          choiceCount: '30',
          shortCount: '30',
          maximum: 40,
          countsError,
          countsErrorId: 'stable-error',
          setCountsTouched: (v) => (touched = v),
          setChoiceCount: (v) => (value = v),
          setShortCount: (v) => (value = v),
        },
        'element',
      );
      assert.equal(element.props['aria-invalid'], countsError || undefined);
      assert.equal(element.props['aria-describedby'], countsError ? 'stable-error' : undefined);
      assert.equal(element.props.value, '30');
      element.props.onChange({ target: { value: '25' } });
      assert.equal(touched, true);
      assert.equal(value, '25');
    }
  }
  assert.match(read('LearningPage.tsx'), /countsTouched, setCountsTouched\] = useState\(false\)/);
  assert.match(read('LearningPage.tsx'), /const countsErrorId = useId\(\)/);
  assert.match(read('LearningPage.tsx'), /id=\{countsErrorId\} className="error" role="alert"/);
});
test('download handler synchronously prevents duplicates and exposes failure', async () => {
  const fn = extract(
    'ChatFiles.tsx',
    (n) => ts.isFunctionDeclaration(n) && n.name?.text === 'download',
  );
  let reject,
    calls = 0,
    error,
    busy,
    detail;
  const pending = new Promise((_r, r) => (reject = r));
  const downloading = { current: false };
  const download = evaluate(
    fn,
    {
      downloading,
      setDownloadError: (v) => (detail = v),
      setBusy: (v) => (busy = v),
      setError: (v) => (error = v),
      fetchChatFile: () => {
        calls++;
        return pending;
      },
      settings: {},
      conversation: 'fixture',
    },
    'download',
  );
  const first = download({ id: 'f', name: 'f.md' });
  await download({ id: 'f', name: 'f.md' });
  assert.equal(calls, 1);
  assert.equal(busy, 'f');
  reject(Error('offline'));
  await first;
  assert.equal(error, 'offline');
  assert.deepEqual(detail, { id: 'f', message: 'offline' });
  assert.equal(busy, '');
  assert.equal(downloading.current, false);
});
test('preview download disabled and error is inside modal markup', () => {
  const button = extract(
    'FilePreview.tsx',
    (n) =>
      ts.isJsxElement(n) &&
      n.openingElement.tagName.getText() === 'button' &&
      n.openingElement.getText().includes('disabled={downloadBusy}'),
  );
  const Icon = () => null;
  const html = renderToStaticMarkup(
    evaluate(
      'const element = (' + button + ');',
      { React, downloadBusy: true, download: () => {}, LoaderCircle: Icon, Download: Icon },
      'element',
    ),
  );
  assert.match(html, /disabled/);
  assert.ok(html.includes('正在下载'));
  assert.match(read('FilePreview.tsx'), /downloadError && \(\s*<p className="error" role="alert">/);
  assert.match(read('ChatFiles.tsx'), /downloadBusy=\{!!busy\}/);
});
test('failed preview boundary keeps download busy state and errors inside its dialog', () => {
  const code = extract('ChatFiles.tsx', (n) => ts.isClassDeclaration(n) && n.name?.text === 'PreviewBoundary');
  const Dialog = ({ children }) => React.createElement('section', { role: 'dialog' }, children);
  const Boundary = evaluate(code, { React, Component: React.Component, ConversationDialog: Dialog }, 'PreviewBoundary');
  const boundary = new Boundary({ close: () => {}, download: () => {}, downloadBusy: true, downloadError: 'offline' });
  boundary.state = { failed: true };
  const html = renderToStaticMarkup(boundary.render());
  assert.match(html, /disabled/);
  assert.ok(html.includes('正在下载'));
  assert.match(html, /role="alert">offline/);
  const wrapper = extract('ChatFiles.tsx', (n) => ts.isJsxElement(n) && n.openingElement.tagName.getText() === 'PreviewBoundary');
  assert.match(wrapper, /downloadBusy=\{!!busy\}/);
  assert.match(wrapper, /downloadError=\{downloadError\?\.id === preview\.id/);
});
test('dialog focus collection includes links, summary, textarea and filters unavailable elements', () => {
  const declaration = extract(
    'ConversationMenu.tsx',
    (n) => ts.isVariableStatement(n) && n.getText().includes('const elements ='),
  );
  let selector;
  const node = (name, options = {}) => ({
    name,
    tabIndex: 0,
    matches: () => !!options.disabled,
    closest: () => !!options.hidden,
    getClientRects: () => (options.noRect ? [] : [{}]),
    ...options,
  });
  const nodes = [
    node('link'),
    node('summary'),
    node('textarea'),
    node('disabled', { disabled: true }),
    node('hidden', { hidden: true }),
    node('cssHidden', { noRect: true }),
    node('invisible', { visibility: 'hidden' }),
    node('negative', { tabIndex: -1 }),
  ];
  const elements = evaluate(
    declaration,
    {
      content: {
        current: {
          querySelectorAll: (s) => {
            selector = s;
            return nodes;
          },
        },
      },
      getComputedStyle: (e) => ({ visibility: e.visibility || 'visible' }),
    },
    'elements',
  );
  assert.ok(selector.includes('a[href]'));
  assert.ok(selector.includes('summary'));
  assert.ok(selector.includes('textarea'));
  assert.deepEqual(
    elements.map((e) => e.name),
    ['link', 'summary', 'textarea'],
  );
});
test('chapter constraints wrap metadata without changing Markdown scrolling', () => {
  const css = read('learning.css');
  assert.match(
    css,
    /\.learning-explanation > article > \.field-help\s*\{\s*overflow-wrap: anywhere/,
  );
  assert.match(css, /\.learning-explanation > \.field-label select\s*\{[^}]*width: 100%/);
  assert.match(
    css,
    /\.learning-page \.pi-markdown table\s*\{\s*max-width: 100%;\s*overflow-x: auto/,
  );
});
