import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('non-conversation pages use the same full content swipe area', async () => {
  const main = await readFile(new URL('../web/src/main.tsx', import.meta.url), 'utf8');
  const panels = await readFile(new URL('../web/src/MobilePanels.tsx', import.meta.url), 'utf8');

  assert.match(main, /data-panel-swipe=\{page !== 'pi' && page !== 'superagent' \? '' : undefined\}/);
  assert.match(panels, /\[data-conversation-swipe\],\[data-panel-swipe\]/);
  assert.match(
    panels,
    /input,textarea,select,\[contenteditable="true"\],\[role="slider"\],\.cm-editor,pre,table,\[role="dialog"\],\[data-no-panel-swipe\]/,
  );
  assert.match(panels, /startX: x/);
  assert.match(panels, /y < 16 \|\| y > innerHeight - 24/);
});
