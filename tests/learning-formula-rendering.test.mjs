import fs from 'node:fs';
import assert from 'node:assert/strict';
import test from 'node:test';
import ts from 'typescript';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import { normalizeMathDelimiters } from '../shared/markdown-math.mjs';

const source = fs.readFileSync(new URL('../web/src/LearningPage.tsx', import.meta.url), 'utf8');
const renderer = fs.readFileSync(
  new URL('../web/src/PiMarkdownRenderer.tsx', import.meta.url),
  'utf8',
);
function extract(source, name) {
  const ast = ts.createSourceFile(
    'fixture.tsx',
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  return ast.statements
    .find((n) => n.name?.text === name)
    .getText(ast)
    .replace(/^export /, '');
}
function compile(code, values, name) {
  const js = ts.transpileModule(code, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React },
  }).outputText;
  return new Function(...Object.keys(values), js + '\nreturn ' + name)(...Object.values(values));
}
const PiMarkdown = compile(
  extract(renderer, 'PiMarkdown'),
  {
    React,
    Markdown,
    remarkGfm,
    remarkMath,
    rehypeKatex,
    normalizeMathDelimiters,
    CodeBlock: ({ children }) => React.createElement('pre', null, children),
  },
  'PiMarkdown',
);
const optionDescription = compile(extract(source, 'optionDescription'), {}, 'optionDescription');
const Boundary = compile(
  extract(source, 'ExerciseMarkdownBoundary'),
  { React, Component: React.Component },
  'ExerciseMarkdownBoundary',
);
const ExerciseMarkdown = compile(
  extract(source, 'ExerciseMarkdown'),
  { React, ExerciseMarkdownBoundary: Boundary, PiMarkdown },
  'ExerciseMarkdown',
);
function html(text) {
  return renderToStaticMarkup(React.createElement(ExerciseMarkdown, { text }));
}

test('existing renderer handles inline and display math and ordinary text safely', () => {
  assert.match(html('计算 $x^2$'), /class="katex"/);
  assert.match(html('$$\nx^2 + y^2 = z^2\n$$'), /katex-display/);
  assert.match(html('普通文字 A & B'), /普通文字 A &amp; B/);
  assert.doesNotMatch(html('<script>alert(1)</script>'), /<script>/);
  assert.match(renderer, /trust: false/);
  assert.match(renderer, /skipHtml/);
});

test('bad LaTeX and unclosed dollars keep content; adjacent valid question still renders', () => {
  assert.match(html('$\\notARealCommand{x}$'), /notARealCommand/);
  assert.match(html('未闭合 $x + 1'), /未闭合 \$x \+ 1/);
  const questions = renderToStaticMarkup(
    React.createElement(
      'section',
      null,
      React.createElement(ExerciseMarkdown, { text: '$\\notARealCommand{x}$' }),
      React.createElement(ExerciseMarkdown, { text: '$x^2$' }),
    ),
  );
  assert.match(questions, /notARealCommand/);
  assert.match(questions, /class="katex"/);
});

test('thrown renderer has original-text fallback isolated to that content and keyed on changes', () => {
  const bad = new Boundary({ text: '$broken$', children: 'bad child' });
  bad.state = Boundary.getDerivedStateFromError(new Error('render failed'));
  assert.equal(
    renderToStaticMarkup(bad.render()),
    '<div class="learning-math-fallback">$broken$</div>',
  );
  const good = new Boundary({
    text: '$x$',
    children: React.createElement(PiMarkdown, { text: '$x$' }),
  });
  assert.match(renderToStaticMarkup(good.render()), /class="katex"/);
  const wrapper = ExerciseMarkdown({ text: 'changed' });
  assert.equal(wrapper.props.children.key, 'changed');
  assert.equal(wrapper.props.children.props.text, 'changed');
});

test('Exercise uses formula renderer at all three locations, with stable plain-text radio names and clickable labels', () => {
  let state = 0;
  const question = { id: 'q', kind: 'choice', prompt: '$x^2$', options: ['$$x=1$$', '普通答案'] };
  const Exercise = compile(
    extract(source, 'Exercise'),
    {
      React,
      ExerciseMarkdown,
      optionDescription,
      PiMarkdown,
      useState: (initial) => {
        const i = state++;
        return [i === 6 ? true : typeof initial === 'function' ? initial() : initial, () => {}];
      },
      useRef: (current) => ({ current }),
      useId: () => 'test-radio',
      useEffect: () => {},
      sessionStorage: { getItem: () => null },
      LoaderCircle: () => null,
      CheckCircle2: () => null,
    },
    'Exercise',
  );
  const markup = renderToStaticMarkup(
    Exercise({
      question,
      latest: {
        score: 100,
        passed: true,
        feedback: 'ok',
        correctIndex: 0,
        explanation: '解析',
        question: { options: ['$x=2$'] },
      },
      draftKey: 'q',
      onGrade: async () => {},
    }),
  );
  const names = [...markup.matchAll(/type="radio"[^>]*aria-label="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(names, ['选项 A', '选项 B']);
  assert.ok(names.every((name) => name.trim() && !name.includes('$')));
  assert.match(markup, /<label><input type="radio"/);
  assert.match(markup, /aria-describedby="test-radio-option-0"/);
  assert.match(markup, /id="test-radio-option-0"/);
  const descriptions = [
    ...markup.matchAll(/<span class="sr-only" id="test-radio-option-\d+">([^<]+)<\/span>/g),
  ].map((m) => m[1]);
  assert.equal(descriptions.length, 2);
  assert.ok(descriptions.every((text) => text.trim() && !/\$|\\frac/.test(text)));
  assert.match(
    markup,
    /<div aria-hidden="true"><span>A\.<\/span><div class="learning-exercise-markdown">/,
  );
  assert.equal(optionDescription('$$\\frac{1}{2} + \\alpha$$'), '(1) / (2) + alpha');
  assert.equal(optionDescription('plain answer'), 'plain answer');
  assert.ok(optionDescription('$$').trim());
  assert.match(markup, /正确选项：A/);
  assert.ok((markup.match(/class="katex"/g) || []).length >= 3);
  assert.match(markup, /x=2/);
});

test('narrow layout contains long formulas locally and retains preexisting count/wrap accessibility', () => {
  const css = fs.readFileSync(new URL('../web/src/learning.css', import.meta.url), 'utf8');
  assert.match(css, /\.learning-option-content\s*\{[^}]*min-width: 0/s);
  assert.match(css, /\.learning-exercise-markdown\s*\{[^}]*max-width: 100%;[^}]*overflow-x: auto/s);
  assert.match(css, /\.learning-exercise-markdown \.katex-display\s*\{[^}]*overflow-x: auto/s);
  assert.match(
    css,
    /\.learning-math-fallback\s*\{[^}]*white-space: pre-wrap;[^}]*overflow-wrap: anywhere/s,
  );
  assert.match(source, /aria-invalid=\{countsError \|\| undefined\}/);
  assert.doesNotMatch(source, /from ['"](?:katex|react-markdown|remark-math|rehype-katex)['"]/);
});
