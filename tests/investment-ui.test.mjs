import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('investment cards keep long names inside the mobile viewport', async () => {
  const css = await readFile(new URL('../web/src/investment.css', import.meta.url), 'utf8');
  assert.match(css, /\.investment-page\s*, \.investment-page \* \{ box-sizing: border-box; \}/);
  assert.match(css, /\.investment-page \{[^}]*overflow-x: hidden/);
  assert.match(css, /\.investment-ranking-main > div \{[^}]*min-width: 0/);
  assert.match(css, /\.investment-ranking-metrics \{[^}]*min-width: 0/);
  assert.match(css, /\.investment-ranking-main, \.investment-ranking-metrics \{ width: 100%; \}/);
});
