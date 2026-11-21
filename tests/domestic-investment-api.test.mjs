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
  async function request(path, authorization) {
    const response = await fetch(base + path, {
      headers: authorization ? { Authorization: 'Bearer ' + authorization } : {},
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
  assert.equal((await request('/investment/dashboard')).status, 401);
});
