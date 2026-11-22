import { buildPortfolioPlan } from "./portfolio-plan.mjs";

const finite = (value) => {
  if (value === null || value === undefined || value === "") return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
};

const percent = (value) => Number((value * 100).toFixed(2));

const EMPTY_PORTFOLIO = {
  source: "not_provided",
  data_as_of: null,
  currency: "CNY",
  total_capital: null,
  cash_balance: null,
  monthly_contribution: null,
  horizon_years: null,
  max_drawdown_percent: null,
  holdings: [],
};

function marketRegime(market) {
  return market?.regime ?? "insufficient_data";
}

function addValue(bucket, key, value) {
  bucket[key] = (bucket[key] ?? 0) + (finite(value) ?? 0);
}

export function summarizePortfolio(input = {}) {
  const portfolio = { ...EMPTY_PORTFOLIO, ...input };
  const holdings = Array.isArray(portfolio.holdings) ? portfolio.holdings : [];
  const buckets = {};
  let inferredCash = 0;
  let inferredRiskAssets = 0;
  let largestHolding = null;
  let largestRiskHolding = null;

  for (const holding of holdings) {
    const value = finite(holding.value) ?? 0;
    const assetType = holding.asset_type ?? "other";
    addValue(buckets, assetType, value);
    if (assetType === "cash" || assetType === "cash_management" || assetType === "bond") inferredCash += value;
    if (assetType !== "cash" && assetType !== "cash_management" && assetType !== "bond") {
      inferredRiskAssets += value;
      if (!largestRiskHolding || value > largestRiskHolding.value) largestRiskHolding = { ...holding, value };
    }
    if (!largestHolding || value > largestHolding.value) largestHolding = { ...holding, value };
  }

  const total = finite(portfolio.total_capital) ?? (holdings.length ? holdings.reduce((sum, holding) => sum + (finite(holding.value) ?? 0), 0) : null);
  const cash = finite(portfolio.cash_balance) ?? inferredCash;
  const riskAssets = total === null ? inferredRiskAssets : Math.max(0, total - cash);
  const totalForRatio = total && total > 0 ? total : null;

  return {
    total_capital: total,
    cash_balance: cash,
    risk_assets: riskAssets,
    cash_ratio: totalForRatio ? cash / totalForRatio : null,
    risk_asset_ratio: totalForRatio ? riskAssets / totalForRatio : null,
    domestic_equity_ratio: totalForRatio ? (buckets.domestic_equity ?? 0) / totalForRatio : null,
    international_equity_ratio: totalForRatio ? (buckets.international_equity ?? 0) / totalForRatio : null,
    gold_ratio: totalForRatio ? (buckets.gold ?? 0) / totalForRatio : null,
    holding_count: holdings.length,
    largest_holding: largestHolding,
    largest_holding_ratio: totalForRatio && largestHolding ? largestHolding.value / totalForRatio : null,
    largest_risk_holding: largestRiskHolding,
    largest_risk_holding_ratio: totalForRatio && largestRiskHolding ? largestRiskHolding.value / totalForRatio : null,
    buckets,
    has_data: Boolean(totalForRatio && holdings.length),
  };
}

function action(priority, operation, detail, evidence = []) {
  return { priority, operation, detail, evidence };
}

export function recommendDailyActions({ portfolio = EMPTY_PORTFOLIO, domesticMarket, internationalMarket, riskProfile = "balanced", asOf = new Date().toISOString().slice(0, 10) } = {}) {
  const summary = summarizePortfolio(portfolio);
  const plan = buildPortfolioPlan({
    portfolio,
    summary,
    riskProfile,
    domesticMarket,
    internationalMarket,
    asOf,
  });
  const actions = [];
  const domesticRegime = marketRegime(domesticMarket);
  const internationalRegime = marketRegime(internationalMarket);
  const riskOffCount = [domesticRegime, internationalRegime].filter((regime) => regime === "risk_off" || regime === "mixed").length;

  if (!summary.has_data) {
    actions.push(action("high", "补充账户数据", "录入现金、持仓金额、每月投入与计划期限后，才能生成组合级每日动作。", ["portfolio"]));
    return { as_of: asOf, risk_profile: riskProfile, status: "awaiting_portfolio", summary, plan, actions };
  }

  if (summary.cash_ratio !== null && summary.cash_ratio > 0.85) {
    actions.push(action("medium", "分批规划", `现金类资产约占 ${percent(summary.cash_ratio)}%，组合当前显著偏现金。按计划分批配置，先设定目标区间并保留应急流动性。`, ["portfolio.cash_ratio", "portfolio.horizon_years"]));
  }

  if (summary.cash_ratio !== null && summary.cash_ratio < 0.15) {
    actions.push(action("high", "补充流动性", `现金类资产约占 ${percent(summary.cash_ratio)}%，先核对未来支出与应急资金，再评估新增风险资产。`, ["portfolio.cash_ratio", "portfolio.horizon_years"]));
  }

  if (summary.risk_asset_ratio !== null && summary.risk_asset_ratio > 0.75 && riskOffCount > 0) {
    actions.push(action("high", "降低集中风险", `风险资产约占 ${percent(summary.risk_asset_ratio)}%，且国内或国际市场出现 ${riskOffCount} 个偏弱信号。暂缓追涨，优先检查高波动与单一市场暴露。`, ["portfolio.risk_asset_ratio", "market.regime"]));
  }

  if (summary.largest_risk_holding_ratio !== null && summary.largest_risk_holding_ratio > 0.35) {
    actions.push(action("medium", "检查单一持仓", `最大风险资产持仓约占 ${percent(summary.largest_risk_holding_ratio)}%，优先核对该持仓的行业、地区和产品风险。`, ["portfolio.largest_risk_holding_ratio"]));
  }

  if (summary.international_equity_ratio !== null && summary.international_equity_ratio < 0.05) {
    actions.push(action("low", "观察国际分散", `国际股票或相关基金约占 ${percent(summary.international_equity_ratio)}%，均衡型组合可把国际分散作为后续规划项，按估值和汇率条件分批观察。`, ["portfolio.international_equity_ratio", "international.market.regime"]));
  }

  if (actions.length === 0) {
    actions.push(action("low", "维持计划", "当前组合与均衡型研究口径没有触发明显的结构性动作，按计划投入，避免因单日波动频繁调仓。", ["portfolio", "market.regime"]));
  }

  const largestDrift = plan.target_weights.find((item) => item.action !== "hold");
  if (largestDrift) {
    actions.unshift(
      action(
        "medium",
        largestDrift.action === "increase_gradually" ? "分批补足目标配置" : "分批降低偏离配置",
        `${largestDrift.label}当前约 ${largestDrift.current_weight ?? "—"}% ，研究目标约 ${largestDrift.target_weight}% 。单次调整先控制在组合的 5% 以内。`,
        ["portfolio.plan.target_weights", "portfolio.plan.algorithm"],
      ),
    );
  }

  return { as_of: asOf, risk_profile: riskProfile, status: "ready", summary, plan, actions };
}

export { EMPTY_PORTFOLIO };
