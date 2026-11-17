import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import ts from 'typescript';

const root = resolve(import.meta.dirname, '../web/src');
function staticImports(entry, seen = new Set(), external = new Set()) {
  if (seen.has(entry)) return { seen, external };
  seen.add(entry);
  const source = ts.createSourceFile(
    entry,
    readFileSync(entry, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
  );
  for (const node of source.statements) {
    if (!ts.isImportDeclaration(node) && !ts.isExportDeclaration(node)) continue;
    if (!node.moduleSpecifier || node.importClause?.isTypeOnly || node.isTypeOnly) continue;
    if (
      node.importClause?.namedBindings &&
      ts.isNamedImports(node.importClause.namedBindings) &&
      !node.importClause.name &&
      node.importClause.namedBindings.elements.every((item) => item.isTypeOnly)
    )
      continue;
    const specifier = node.moduleSpecifier.text;
    if (!specifier.startsWith('.')) {
      external.add(specifier);
      continue;
    }
    const base = resolve(dirname(entry), specifier);
    const file = [base, base + '.ts', base + '.tsx', base + '.mjs', base + '/index.ts'].find(
      existsSync,
    );
    if (file && /\.(?:tsx?|mjs)$/.test(file)) staticImports(file, seen, external);
  }
  return { seen, external };
}

test('initial static graph excludes optional pages and Markdown/math rendering', () => {
  const { seen, external } = staticImports(resolve(root, 'main.tsx'));
  for (const name of ['MailPage', 'LearningPage', 'PiMarkdownRenderer'])
    assert.equal(seen.has(resolve(root, name + '.tsx')), false, name + ' must remain dynamic');
  for (const name of [
    'react-markdown',
    'remark-gfm',
    'remark-math',
    'rehype-katex',
    'katex/dist/katex.min.css',
  ])
    assert.equal(external.has(name), false, name + ' must not enter the static graph');
});

test('Markdown renderer retains local math resources and safe rendering options', () => {
  const { external } = staticImports(resolve(root, 'PiMarkdownRenderer.tsx'));
  assert.ok(external.has('react-markdown'));
  assert.ok(external.has('rehype-katex'));
  assert.ok(external.has('katex/dist/katex.min.css'));
  const renderer = readFileSync(resolve(root, 'PiMarkdownRenderer.tsx'), 'utf8');
  assert.match(renderer, /trust: false/);
  assert.match(renderer, /skipHtml/);
  const boundary = readFileSync(resolve(root, 'PiMarkdown.tsx'), 'utf8');
  assert.match(boundary, /import\('\.\/PiMarkdownRenderer'\)/);
  assert.match(boundary, /Suspense fallback=/);
  assert.match(boundary, /role="status"/);
  assert.match(boundary, /whiteSpace: 'pre-wrap'/);
});
