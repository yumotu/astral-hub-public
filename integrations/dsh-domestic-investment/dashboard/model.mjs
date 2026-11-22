import { analyzeMarketRegime, rankFunds, scoreLongTermStock } from "../core/scoring.mjs";
import { EMPTY_PORTFOLIO, recommendDailyActions, summarizePortfolio } from "../core/recommendation.mjs";

function rankWithMetrics(candidates, riskProfile) {
  const rankings = rankFunds(candidates, riskProfile);
  return rankings.map((ranking) => ({
    ...ranking,
    metrics: candidates.find((candidate) => candidate.code === ranking.code) ?? {},
  }));
}

function emptyMarket() {
  return {
    as_of: null,
    regime: "insufficient_data",
    score: null,
    confidence: 0,
    observations: { components: { trend: null, breadth: null, valuation: null, macro: null }, component_spread: 0, benchmark_count: 0 },
    missing: ["market_snapshot"],
  };
}

export async function buildDashboardModel(provider, { riskProfile = "balanced" } = {}) {
  const seed = await provider.getDashboardSeed();
  const candidates = seed.funds?.length ? seed.funds : [];
  const stocks = Array.isArray(seed.stocks) ? seed.stocks : [];
  const market = seed.market ? analyzeMarketRegime(seed.market) : emptyMarket();
  const internationalSeed = seed.international ?? {};
  const internationalMarket = internationalSeed.market ? analyzeMarketRegime(internationalSeed.market) : emptyMarket();
  const internationalStocks = Array.isArray(internationalSeed.stocks) ? internationalSeed.stocks : [];
  const internationalIndices = Array.isArray(internationalSeed.indices) ? internationalSeed.indices : [];
  const portfolio = { ...EMPTY_PORTFOLIO, ...(seed.portfolio ?? {}) };

  return {
    generated_at: new Date().toISOString(),
    source: seed.source,
    data_sources: seed.sources ?? [],
    data_missing: seed.missing ?? [],
    risk_profile: riskProfile,
    views: ["funds", "market", "stocks", "international", "portfolio"],
    funds: {
      count: candidates.length,
      rankings: rankWithMetrics(candidates, riskProfile),
    },
    market,
    stocks: {
      count: stocks.length,
      rankings: stocks.map((candidate) => ({
        ...scoreLongTermStock(candidate),
        metrics: candidate,
      })).sort((left, right) => (right.score ?? -1) - (left.score ?? -1)),
    },
    international: {
      market: internationalMarket,
      indices: internationalIndices,
      stocks: {
        count: internationalStocks.length,
        rankings: internationalStocks.map((candidate) => ({
          ...scoreLongTermStock(candidate),
          metrics: candidate,
        })).sort((left, right) => (right.score ?? -1) - (left.score ?? -1)),
      },
    },
    portfolio: {
      ...portfolio,
      summary: summarizePortfolio(portfolio),
    },
    daily_actions: recommendDailyActions({
      portfolio,
      domesticMarket: market,
      internationalMarket,
      riskProfile,
      asOf: internationalMarket.as_of ?? market.as_of ?? new Date().toISOString().slice(0, 10),
    }),
  };
}
