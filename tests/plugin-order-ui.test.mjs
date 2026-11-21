import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('plugin cards expose drag-and-drop ordering with keyboard fallback controls', async () => {
  const source = await readFile(new URL('../web/src/main.tsx', import.meta.url), 'utf8');
  const css = await readFile(new URL('../web/src/style.css', import.meta.url), 'utf8');

  assert.match(source, /draggable=\{!editor && !wishOpen\}/);
  assert.match(source, /onDragOver=\{\(event\) =>/);
  assert.match(source, /onDrop=\{\(event\) =>/);
  assert.match(source, /将插件 \$\{p\.name\} 上移/);
  assert.match(source, /将插件 \$\{p\.name\} 下移/);
  assert.match(css, /\.plugin-item-draggable\.is-drag-over/);
  assert.match(css, /\.plugin-drag-handle/);
});
