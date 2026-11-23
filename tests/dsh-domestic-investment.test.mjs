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
  assert.deepEqual(dashboard.market_areas.map((area) => [area.id, area.status]), [
    ["domestic_equity", "ready"],
    ["international_equity", "pending"],
    ["bond", "pending"],
    ["gold", "pending"],
    ["fx", "pending"],
  ]);
});

test("investment market areas preserve fixture quotes and sources without fabricating live data", async (t) => {
  const previous = process.env.INVESTMENT_LIVE_DATA;
  process.env.INVESTMENT_LIVE_DATA = "0";
  t.after(() => {
    if (previous === undefined) delete process.env.INVESTMENT_LIVE_DATA;
    else process.env.INVESTMENT_LIVE_DATA = previous;
  });

  const directory = await mkdtemp(join(tmpdir(), "astral-investment-areas-"));
  const dataFile = join(directory, "portfolio-snapshot.json");
  await writeFile(dataFile, JSON.stringify({
    market: { as_of: "2026-11-20", benchmarks: [{ name: "沪深300", trend_20d: 1, trend_60d: 3 }] },
    international: { market: { as_of: "2026-11-20", benchmarks: [{ name: "标普500", trend_20d: -1, trend_60d: 2 }] } },
    asset_markets: {
      bond: { as_of: "2026-11-20", benchmarks: [{ name: "中债", trend_20d: 0.2, trend_60d: 0.5 }] },
      bond_meta: { quote: { value: 102.18, unit: "净值", change_1d: 0.04 }, source: "演示固收快照" },
      gold: { as_of: "2026-11-20", benchmarks: [{ name: "黄金", trend_20d: 1.1, trend_60d: 2.2 }] },
      gold_meta: { quote: { value: 518.6, unit: "元/克", change_1d: 0.72 }, source: "演示贵金属快照" },
      fx: { as_of: "2026-11-20", benchmarks: [{ name: "USD/CNY", trend_20d: -0.1, trend_60d: 0.2 }] },
      fx_meta: { quote: { value: 7.245, unit: "USD/CNY", change_1d: -0.08 }, source: "演示汇率快照" },
    },
  }));

  const dashboard = await (await createDomesticInvestmentService({ dataFile })).dashboard();
  assert.equal(dashboard.market_areas.length, 5);
  assert.deepEqual(dashboard.market_areas.map((area) => area.status), ["ready", "ready", "ready", "ready", "ready"]);
  assert.deepEqual(dashboard.market_areas.slice(2).map((area) => [area.quote.value, area.source]), [
    [102.18, "演示固收快照"],
    [518.6, "演示贵金属快照"],
    [7.245, "演示汇率快照"],
  ]);
});

test("DSH host loads the repository bundle and keeps the optional token out of source paths", async () => {
  const host = await readFile(new URL("../deploy/dsh/host.mjs", import.meta.url), "utf8");
  assert.match(host, /integrations\/dsh-domestic-investment\/index\.mjs/);
  assert.match(host, /TUSHARE_TOKEN/);
  assert.doesNotMatch(host, /\/Users\//);
});
