import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPortfolioPlan } from '../server/domestic-investment-bundle/core/portfolio-plan.mjs';
import { recommendDailyActions } from '../server/domestic-investment-bundle/core/recommendation.mjs';

test('risk-budget plan exposes drift and shifts risk-off targets', () => {
  const portfolio = {
    total_capital: 100000,
    holdings: [
      { id: 'cash', asset_type: 'cash_management', value: 10000 },
      { id: 'stock', asset_type: 'domestic_equity', value: 70000 },
      { id: 'gold', asset_type: 'gold', value: 20000 },
    ],
  };
  const summary = {
    total_capital: 100000,
    buckets: { cash_management: 10000, domestic_equity: 70000, gold: 20000 },
    largest_risk_holding_ratio: 0.7,
    cash_ratio: 0.1,
  };
  const plan = buildPortfolioPlan({
    portfolio,
    summary,
    riskProfile: 'balanced',
    domesticMarket: { regime: 'risk_off' },
    internationalMarket: { regime: 'neutral' },
    asOf: '2026-11-21',
  });
  assert.equal(plan.algorithm.name, 'regime-aware risk budgeting');
  assert.ok(plan.regime_changes.length > 0);
  assert.ok(plan.risk_flags.includes('single_holding_over_35_percent'));
  assert.ok(plan.target_weights.some((item) => item.asset_type === 'domestic_equity' && item.action === 'reduce_gradually'));
});

test('recommendations retain an explainable plan when holdings are present', () => {
  const result = recommendDailyActions({
    portfolio: {
      total_capital: 100,
      holdings: [{ id: 'fund', asset_type: 'fund', value: 100, cvar_95_daily: 1.2 }],
    },
    domesticMarket: { regime: 'neutral' },
    internationalMarket: { regime: 'neutral' },
    riskProfile: 'balanced',
    asOf: '2026-11-21',
  });
  assert.equal(result.status, 'ready');
  assert.equal(result.plan.algorithm.methods.includes('CVaR and drawdown guard'), true);
  assert.ok(result.actions.length > 0);
});
