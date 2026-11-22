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

test('investment demo mode exposes complete synthetic holdings without the account API', async () => {
  const source = await readFile(new URL('../web/src/investment-demo.ts', import.meta.url), 'utf8');
  const page = await readFile(new URL('../web/src/InvestmentPage.tsx', import.meta.url), 'utf8');
  assert.match(source, /演示数据/);
  for (const field of ['symbol:', 'quantity:', 'cost_basis:', 'current_price:', 'price_as_of:', 'source:', 'value:'])
    assert.match(source, new RegExp(field));
  assert.match(page, /isInvestmentDemo\(\)/);
  assert.match(page, /不会读取或写入真实账号/);
  assert.match(page, /investment-donut/);
  assert.match(page, /investment-transaction-choices/);
  assert.match(source, /market_areas/);
});
