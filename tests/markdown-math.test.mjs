import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import Markdown from 'react-markdown';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import { normalizeMathDelimiters } from '../shared/markdown-math.mjs';
const render = (text) =>
  renderToStaticMarkup(
    createElement(
      Markdown,
      {
        skipHtml: true,
        remarkPlugins: [remarkMath],
        rehypePlugins: [[rehypeKatex, { trust: false, maxExpand: 1000 }]],
      },
      normalizeMathDelimiters(text),
    ),
  );
test('normalization preserves code boundaries even with an incomplete formula outside them', () => {
  for (const text of [
    '\\(unfinished `\\)`',
    '```text\n```not-a-close\n\\(literal\\)\n```',
    '`` code ``` \\(literal\\) ``',
    '    \\(indented code\\)',
  ])
    assert.equal(normalizeMathDelimiters(text), text);
});
test('RRF and model TeX delimiters render as accessible local math', () => {
  const rrf = String.raw`公式为 \(\text{RRF}(d)=\sum_{r\in R}\frac{1}{k+\text{rank}_r(d)}\)。`;
  const html = render(rrf);
  assert.match(html, /class="katex"/);
  assert.match(html, /<math/);
  assert.match(render(String.raw`\[\frac{a}{b}\]`), /katex-display/);
  assert.match(render('$x^2$ 和 $$\ny=2\n$$'), /class="katex"/);
});
test('code examples and incomplete streamed formulae stay literal, without HTML or trusted TeX injection', () => {
  const code = String.raw`\(x+1\)`;
  assert.equal(normalizeMathDelimiters('`' + code + '`'), '`' + code + '`');
  assert.equal(normalizeMathDelimiters('```tex\n' + code + '\n```'), '```tex\n' + code + '\n```');
  assert.equal(
    normalizeMathDelimiters(String.raw`还在输出 \(\frac{1}`),
    String.raw`还在输出 \(\frac{1}`,
  );
  assert.doesNotMatch(render('`' + code + '`'), /class="katex"/);
  assert.doesNotMatch(
    render(String.raw`<script>alert(1)</script> $\href{javascript:alert(1)}{click}$`),
    /<script|href="javascript:/,
  );
  assert.match(render('$\\invalidcommand{x}$'), /invalidcommand/);
});
