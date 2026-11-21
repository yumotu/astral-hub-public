import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server/index.mjs';

const token = 'investment-api-test-admin-token-12345678901234567890';

test('investment research window is authenticated and reuses the maintained service', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'astral-investment-api-'));
  const dashboard = {
    generated_at: '2026-11-21T00:00:00.000Z',
    source: 'synthetic',
    data_sources: [],
    data_missing: [],
    risk_profile: 'balanced',
    funds: { count: 1, rankings: [] },
    market: { regime: 'neutral' },
    stocks: { count: 0, rankings: [] },
    international: { market: { regime: 'neutral' }, indices: [], stocks: { count: 0, rankings: [] } },
    portfolio: { holdings: [] },
  };
  const app = await createApp({
    token,
    dataDir: dir,
    notifications: { start: false },
    investmentConfig: {
      service: {
        dashboard: async ({ risk_profile }) => ({ ...dashboard, risk_profile }),
        methodology: () => ({ instructions: 'synthetic', methodology: 'read-only' }),
      },
    },
  });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}/api`;
  async function request(path, authorization, method = 'GET', payload) {
    const response = await fetch(base + path, {
      method,
      headers: {
        ...(authorization ? { Authorization: 'Bearer ' + authorization } : {}),
        ...(payload ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(payload ? { body: JSON.stringify(payload) } : {}),
    });
    return { status: response.status, body: await response.json() };
  }
  t.after(async () => {
    await new Promise((resolve) => app.server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  });
  const owner = (
    await fetch(base + '/auth/bootstrap', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: 'investment-owner',
        displayName: 'Investment Owner',
        password: 'synthetic-investment-password',
        adminToken: token,
      }),
    }).then((r) => r.json())
  ).token;
  assert.equal((await request('/investment/dashboard', owner)).status, 200);
  const result = await request('/investment/dashboard?risk_profile=conservative', owner);
  assert.equal(result.status, 200);
  assert.equal(result.body.risk_profile, 'conservative');
  assert.equal((await request('/investment/methodology', owner)).body.methodology, 'read-only');
  const created = await request('/investment/holdings', owner, 'POST', {
    asset_type: 'gold',
    symbol: 'AU9999',
    name: '黄金持仓',
    quantity: 10,
    cost_basis: 500,
    current_price: 520,
    currency: 'CNY',
    price_as_of: '2026-11-21T00:00:00.000Z',
    source: 'manual',
  });
  assert.equal(created.status, 201);
  assert.equal(created.body.holding.asset_type, 'gold');
  const holdings = await request('/investment/holdings', owner);
  assert.equal(holdings.body.holdings.length, 1);
  assert.equal(holdings.body.summary.gold_ratio, 1);
  const afterHolding = await request('/investment/dashboard', owner);
  assert.equal(afterHolding.body.portfolio.holdings.length, 1);
  assert.equal(afterHolding.body.daily_actions.plan.algorithm.name, 'regime-aware risk budgeting');
  const transactionPreview = await request('/investment/transactions/preview', owner, 'POST', {
    text: '我买了 2 份黄金 ETF，代码 518880，金额 1000 元',
  });
  assert.equal(transactionPreview.status, 201);
  assert.equal(transactionPreview.body.parsed.type, 'buy');
  assert.equal(transactionPreview.body.parsed.symbol, '518880');
  const transactionId = transactionPreview.body.transaction.id;
  const committed = await request(`/investment/transactions/${transactionId}/commit`, owner, 'POST', {});
  assert.equal(committed.status, 200);
  assert.equal(committed.body.transaction.status, 'confirmed_holding');
  assert.equal((await request('/investment/holdings', owner)).body.holdings.length, 2);
  const schedule = await request('/investment/schedules', owner, 'POST', {
    kind: 'quotes',
    interval_minutes: 30,
    enabled: true,
  });
  assert.equal(schedule.status, 201);
  assert.equal(schedule.body.schedules[0].interval_minutes, 30);
  assert.equal((await request('/investment/schedules', owner)).body.schedules.length, 1);
  assert.ok((await request('/investment/recommendations', owner)).body);
  assert.equal((await request(`/investment/holdings/${created.body.holding.id}`, owner, 'DELETE')).status, 200);
  assert.equal((await request('/investment/holdings', owner)).body.holdings.length, 1);
  assert.equal((await request('/investment/dashboard')).status, 401);
});
