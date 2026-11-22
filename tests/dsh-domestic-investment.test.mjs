import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createDomesticInvestmentService, createToolDefinitions } from "../integrations/dsh-domestic-investment/tool-definitions.mjs";

test("bundled investment service exposes the maintained research tools without network access", async (t) => {
  const previous = process.env.INVESTMENT_LIVE_DATA;
  process.env.INVESTMENT_LIVE_DATA = "0";
  t.after(() => {
    if (previous === undefined) delete process.env.INVESTMENT_LIVE_DATA;
    else process.env.INVESTMENT_LIVE_DATA = previous;
  });

  const directory = await mkdtemp(join(tmpdir(), "astral-investment-test-"));
  const dataFile = join(directory, "portfolio-snapshot.json");
  await writeFile(dataFile, JSON.stringify({
    funds: [{
      code: "demo",
      name: "演示基金",
      category: "混合型",
      annualized_return_3y: 8.2,
      annualized_return_5y: 7.1,
      max_drawdown_3y: -12,
      volatility_3y: 10,
      data_as_of: "2026-11-20",
    }],
    market: { as_of: "2026-11-20", benchmarks: [{ name: "演示指数", trend_20d: 1, trend_60d: 3 }] },
    portfolio: { source: "test", data_as_of: "2026-11-20", total_capital: 100, cash_balance: 100, holdings: [{ name: "现金", asset_type: "cash", value: 100 }] },
  }));

  const service = await createDomesticInvestmentService({ dataFile });
  const definitions = createToolDefinitions(service);
  assert.deepEqual(definitions.map((definition) => definition.name), [
    "get_investment_methodology",
    "get_investment_dashboard",
    "query_investment_data",
    "screen_domestic_funds",
    "analyze_bond_fund_risk",
    "analyze_market_regime",
    "research_long_term_stock",
    "recommend_daily_research_actions",
    "build_portfolio_plan",
    "record_investment_holding_intent",
    "refresh_investment_quotes",
    "prepare_investment_order",
  ]);
  const dashboard = await service.dashboard({ risk_profile: "balanced" });
  assert.equal(dashboard.source, "local_file");
  assert.equal(dashboard.funds.count, 1);
  assert.equal((await service.screenFunds({ risk_profile: "balanced" })).rankings.length, 1);
  assert.equal(service.analyzeMarket({ benchmarks: [{ trend_20d: 1, trend_60d: 3 }] }).regime, "neutral");
  assert.equal(service.recordHoldingIntent({ text: "我买了 500 元演示基金" }).type, "buy");
  assert.equal(service.prepareOrder({ type: "buy", name: "演示基金", amount: 500 }).status, "awaiting_confirmation");
});

test("DSH host loads the repository bundle and keeps the optional token out of source paths", async () => {
  const host = await readFile(new URL("../deploy/dsh/host.mjs", import.meta.url), "utf8");
  assert.match(host, /integrations\/dsh-domestic-investment\/index\.mjs/);
  assert.match(host, /TUSHARE_TOKEN/);
  assert.doesNotMatch(host, /\/Users\//);
});
