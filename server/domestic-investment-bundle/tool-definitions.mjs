import { join } from "node:path";
import { createDataProvider } from "./core/provider.mjs";
import { bondStressTest } from "./core/bond-risk.mjs";
import { METHODOLOGY, SERVER_INSTRUCTIONS, SOURCE_HIERARCHY } from "./core/policy.mjs";
import { recommendDailyActions } from "./core/recommendation.mjs";
import { buildPortfolioPlan } from "./core/portfolio-plan.mjs";
import { summarizePortfolio } from "./core/recommendation.mjs";
import { analyzeMarketRegime, rankFunds, scoreLongTermStock } from "./core/scoring.mjs";
import { buildDashboardModel } from "./dashboard/model.mjs";

const RISK_PROFILES = ["conservative", "balanced", "growth"];
const DATASET_NAMES = ["fund_basic", "fund_nav", "index_daily", "daily_basic", "fina_indicator", "income", "balancesheet", "cashflow", "dividend", "us_daily_adj", "us_fina_indicator", "us_etf_basic", "us_etf_daily", "us_tradecal", "hk_daily", "fx_daily", "eco_cal"];
const riskProfile = { type: "string", enum: RISK_PROFILES };
const candidate = { type: "object", additionalProperties: true };
const orderType = { type: "string", enum: ["buy", "sell", "recurring"] };

function workspaceFile(root, name) { return join(root, "data", name); }

export async function createDomesticInvestmentService(config = {}) {
  const workspaceRoot = config.workspaceRoot || process.env.ASTRAL_DSH_WORKSPACE || process.cwd();
  const provider = await createDataProvider({
    dataFile: config.dataFile || process.env.INVESTMENT_DATA_FILE || workspaceFile(workspaceRoot, "portfolio-snapshot.json"),
    bondEvidenceFile: config.bondEvidenceFile || process.env.INVESTMENT_BOND_EVIDENCE_FILE || new URL("./data/bond-fund-evidence.json", import.meta.url),
    token: process.env.TUSHARE_TOKEN || undefined,
    live: process.env.INVESTMENT_LIVE_DATA !== "0",
  });
  return {
    provider,
    async dashboard({ risk_profile = "balanced" } = {}) { return buildDashboardModel(provider, { riskProfile: risk_profile }); },
    methodology() { return { instructions: SERVER_INSTRUCTIONS, methodology: METHODOLOGY, source_hierarchy: SOURCE_HIERARCHY }; },
    async query({ dataset, params = {}, fields } = {}) { return provider.query(dataset, params, fields); },
    async screenFunds({ risk_profile = "balanced", codes = [] } = {}) {
      const candidates = await provider.funds(Array.isArray(codes) ? codes : []);
      return { risk_profile, count: candidates.length, rankings: rankFunds(candidates, risk_profile), source: "astral-dsh-domestic-investment" };
    },
    analyzeBondRisk({ fund, scenario } = {}) { return bondStressTest(fund || {}, scenario || {}); },
    analyzeMarket(input) { return analyzeMarketRegime(input || {}); },
    researchStock(stock) { return scoreLongTermStock(stock || {}); },
    recommendActions({ portfolio, domestic_market, international_market, risk_profile = "balanced", as_of } = {}) {
      return recommendDailyActions({ portfolio: portfolio || {}, domesticMarket: domestic_market, internationalMarket: international_market, riskProfile: risk_profile, asOf: as_of });
    },
    portfolioPlan({ portfolio, domestic_market, international_market, risk_profile = "balanced", as_of } = {}) {
      const value = portfolio || {};
      return buildPortfolioPlan({
        portfolio: value,
        summary: summarizePortfolio(value),
        domesticMarket: domestic_market,
        internationalMarket: international_market,
        riskProfile: risk_profile,
        asOf: as_of,
      });
    },
    recordHoldingIntent({ text = "", source = "chat" } = {}) {
      const value = String(text).trim();
      const symbol = value.match(/\b\d{6}\b/)?.[0] || "";
      const amount = value.match(/(\d+(?:\.\d+)?)\s*(?:元|块)/)?.[1];
      const quantity = value.match(/(\d+(?:\.\d+)?)\s*(?:份|股)/)?.[1];
      const type = /卖出|赎回|卖了/.test(value) ? "sell" : /定投|每月|每周/.test(value) ? "recurring" : "buy";
      return {
        status: "draft",
        source,
        type,
        symbol,
        amount: amount ? Number(amount) : null,
        quantity: quantity ? Number(quantity) : null,
        text: value,
        requires_confirmation: true,
      };
    },
    async refreshQuotes({ holdings = [] } = {}) {
      if (typeof provider.quoteHoldings !== "function") return { status: "unavailable", updated: 0, quotes: [] };
      const quotes = await provider.quoteHoldings(Array.isArray(holdings) ? holdings : []);
      return { status: "preview", updated: quotes.length, quotes };
    },
    prepareOrder({ type, name = "", symbol = "", amount = null, quantity = null, source = "chat" } = {}) {
      if (!orderType.enum.includes(type)) throw new Error("交易类型不受支持。");
      if (!String(name).trim() && !String(symbol).trim()) throw new Error("请提供基金或资产名称、代码。");
      if (amount === null && quantity === null) throw new Error("请提供金额或份额。");
      return {
        status: "awaiting_confirmation",
        operation_id: `investment-order-${Date.now()}`,
        type,
        name: String(name).trim(),
        symbol: String(symbol).trim(),
        amount,
        quantity,
        source,
        executes_order: false,
        message: "已生成交易预览，确认后再提交真实订单。",
      };
    },
  };
}

export function createToolDefinitions(service) {
  return [
    { name: "get_investment_methodology", title: "Get Investment Methodology", description: "Return the fixed read-only research methodology, source hierarchy, and evidence rules.", parameters: {}, execute: () => service.methodology() },
    { name: "get_investment_dashboard", title: "Get Investment Dashboard", description: "Refresh domestic and international fund, market, stock, and portfolio research using configured live sources.", parameters: { risk_profile: riskProfile }, execute: (args) => service.dashboard(args) },
    { name: "query_investment_data", title: "Query Investment Data", description: "Read one allowlisted Tushare dataset when TUSHARE_TOKEN is configured. The tool is read-only and never accepts arbitrary URLs.", parameters: { dataset: { type: "string", enum: DATASET_NAMES }, params: candidate, fields: { type: "string" } }, execute: (args) => service.query(args) },
    { name: "screen_domestic_funds", title: "Screen Domestic Funds", description: "Rank fund candidates with multi-year return, drawdown, volatility, tail risk, bond evidence, missing fields, and confidence.", parameters: { risk_profile: riskProfile, codes: { type: "array", items: { type: "string" } } }, execute: (args) => service.screenFunds(args) },
    { name: "analyze_bond_fund_risk", title: "Analyze Bond Fund Risk", description: "Run a deterministic read-only bond stress test from supplied duration, credit-spread, cash, and repo fields.", parameters: { fund: candidate, scenario: candidate }, execute: (args) => service.analyzeBondRisk(args) },
    { name: "analyze_market_regime", title: "Analyze Market Regime", description: "Classify a supplied domestic or international market snapshot while preserving observations and missing inputs.", parameters: { market: candidate }, execute: ({ market }) => service.analyzeMarket(market) },
    { name: "research_long_term_stock", title: "Research Long-Term Stock", description: "Score a long-term stock candidate on growth, profitability, cash conversion, leverage, valuation, shareholder return, and governance.", parameters: { stock: candidate }, execute: ({ stock }) => service.researchStock(stock) },
    { name: "recommend_daily_research_actions", title: "Recommend Daily Research Actions", description: "Generate read-only portfolio research actions from supplied portfolio and market snapshots. It never places orders.", parameters: { portfolio: candidate, domestic_market: candidate, international_market: candidate, risk_profile: riskProfile, as_of: { type: "string" } }, execute: (args) => service.recommendActions(args) },
    { name: "build_portfolio_plan", title: "Build Portfolio Plan", description: "Build a regime-aware risk-budget plan with concentration and tail-risk guards. It never places orders and requires an explicit portfolio snapshot.", parameters: { portfolio: candidate, domestic_market: candidate, international_market: candidate, risk_profile: riskProfile, as_of: { type: "string" } }, execute: (args) => service.portfolioPlan(args) },
    { name: "record_investment_holding_intent", title: "Record Investment Holding Intent", description: "Parse a natural-language purchase, sale, or recurring investment note into a scoped draft. It never mutates holdings until the host confirms it.", parameters: { text: { type: "string" }, source: { type: "string" } }, execute: (args) => service.recordHoldingIntent(args) },
    { name: "refresh_investment_quotes", title: "Refresh Investment Quotes", description: "Refresh allowlisted quotes for the supplied holdings and return a preview. It never places orders or changes holdings.", parameters: { holdings: { type: "array", items: candidate } }, execute: (args) => service.refreshQuotes(args) },
    { name: "prepare_investment_order", title: "Prepare Investment Order", description: "Prepare a buy, sell, or recurring investment preview with amount or quantity. It never submits a real order.", parameters: { type: orderType, name: { type: "string" }, symbol: { type: "string" }, amount: { type: ["number", "null"] }, quantity: { type: ["number", "null"] }, source: { type: "string" } }, execute: (args) => service.prepareOrder(args) },
  ];
}
