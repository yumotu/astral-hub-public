import { bondStressTest } from "./bond-risk.mjs";

const clamp = (value, min = 0, max = 100) => Math.min(max, Math.max(min, value));

function finite(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function scoreHigher(value, low, high) {
  const numeric = finite(value);
  if (numeric === null) return null;
  return clamp(((numeric - low) / (high - low)) * 100);
}

function scoreLower(value, best, worst) {
  const numeric = finite(value);
  if (numeric === null) return null;
  return clamp(((worst - numeric) / (worst - best)) * 100);
}

function scorePercentile(value) {
  const numeric = finite(value);
  if (numeric === null) return null;
  return clamp(100 - numeric);
}

function weightedAverage(parts) {
  const available = parts.filter((part) => part.score !== null);
  if (available.length === 0) return { score: null, coverage: 0 };
  const weight = available.reduce((sum, part) => sum + part.weight, 0);
  const score = available.reduce((sum, part) => sum + part.score * part.weight, 0) / weight;
  return { score: Number(score.toFixed(2)), coverage: Number(weight.toFixed(3)) };
}

function confidenceFrom(required, available, coverage) {
  const requiredAvailable = required.filter((field) => available.includes(field)).length;
  const requiredCoverage = required.length === 0 ? 1 : requiredAvailable / required.length;
  return Number((100 * (0.6 * requiredCoverage + 0.4 * coverage)).toFixed(1));
}

function freshnessFlag(asOf) {
  if (!asOf) return "missing_data_as_of";
  const date = new Date(asOf);
  if (Number.isNaN(date.valueOf())) return "invalid_data_as_of";
  const ageDays = (Date.now() - date.valueOf()) / 86_400_000;
  if (ageDays > 180) return "stale_data_over_180_days";
  if (ageDays > 90) return "data_over_90_days_old";
  return null;
}

const FUND_WEIGHTS = {
  conservative: {
    return3y: 0.11,
    return5y: 0.05,
    drawdown: 0.18,
    volatility: 0.1,
    recentDrawdown: 0.1,
    recentVolatility: 0.1,
    tailRisk: 0.12,
    fee: 0.07,
    manager: 0.07,
    style: 0.07,
    aum: 0.03,
  },
  balanced: {
    return3y: 0.15,
    return5y: 0.09,
    drawdown: 0.14,
    volatility: 0.07,
    recentDrawdown: 0.09,
    recentVolatility: 0.07,
    tailRisk: 0.08,
    fee: 0.08,
    manager: 0.12,
    style: 0.08,
    aum: 0.03,
  },
  growth: {
    return3y: 0.19,
    return5y: 0.14,
    drawdown: 0.08,
    volatility: 0.06,
    recentDrawdown: 0.06,
    recentVolatility: 0.05,
    tailRisk: 0.04,
    fee: 0.07,
    manager: 0.1,
    style: 0.15,
    aum: 0.06,
  },
};

export function scoreFundCandidate(candidate, riskProfile = "balanced") {
  const weights = FUND_WEIGHTS[riskProfile] ?? FUND_WEIGHTS.balanced;
  const scores = [
    { key: "annualized_return_3y", score: scoreHigher(candidate.annualized_return_3y, 0, 30), weight: weights.return3y },
    { key: "annualized_return_5y", score: scoreHigher(candidate.annualized_return_5y, 0, 25), weight: weights.return5y },
    { key: "max_drawdown_3y", score: scoreLower(candidate.max_drawdown_3y, -10, -50), weight: weights.drawdown },
    { key: "volatility_3y", score: scoreLower(candidate.volatility_3y, 10, 50), weight: weights.volatility },
    { key: "max_drawdown_60d", score: scoreLower(candidate.max_drawdown_60d, -1, -10), weight: weights.recentDrawdown },
    { key: "volatility_60d", score: scoreLower(candidate.volatility_60d, 2, 30), weight: weights.recentVolatility },
    { key: "tail_risk", score: average([
      scoreLower(candidate.cvar_95_daily, 0.1, 2),
      scoreHigher(candidate.sortino_3y, 0, 2),
      scoreHigher(candidate.calmar_3y, 0, 2),
    ]), weight: weights.tailRisk },
    { key: "fee_rate", score: scoreLower(candidate.fee_rate, 0.3, 2), weight: weights.fee },
    { key: "manager_tenure_years", score: scoreHigher(candidate.manager_tenure_years, 0, 10), weight: weights.manager },
    { key: "style_consistency", score: scoreHigher(candidate.style_consistency, 0, 1), weight: weights.style },
    { key: "aum_billion", score: scoreHigher(candidate.aum_billion, 0, 20), weight: weights.aum },
  ];
  const available = scores.filter((part) => part.score !== null).map((part) => part.key);
  const missing = scores.filter((part) => part.score === null).map((part) => part.key);
  const aggregate = weightedAverage(scores);
  const bondLike = /债|固收|货币/.test(candidate.category ?? "");
  const bondRiskFields = bondLike ? ["duration_years", "spread_duration_years", "credit_quality_score", "leverage_ratio"] : [];
  const bondLiquidityFields = bondLike ? ["cash_ratio", "repo_asset_ratio"] : [];
  const bondRiskMissing = bondRiskFields.filter((field) => finite(candidate[field]) === null);
  const bondLiquidityMissing = bondLiquidityFields.filter((field) => finite(candidate[field]) === null);
  const confidenceFields = candidate.data_as_of ? [...available, "data_as_of", ...bondRiskFields.filter((field) => !bondRiskMissing.includes(field))] : [...available, ...bondRiskFields.filter((field) => !bondRiskMissing.includes(field))];
  const flags = [freshnessFlag(candidate.data_as_of)].filter(Boolean);
  const allMissing = [...new Set([...missing, ...bondRiskMissing, ...bondLiquidityMissing])];
  if (bondRiskMissing.includes("duration_years")) flags.push("bond_duration_missing");
  if (bondRiskMissing.includes("spread_duration_years")) flags.push("bond_spread_duration_missing");
  if (bondRiskMissing.includes("credit_quality_score")) flags.push("bond_credit_quality_missing");
  if (bondRiskMissing.includes("leverage_ratio")) flags.push("bond_leverage_missing");
  if (bondLiquidityMissing.includes("cash_ratio")) flags.push("bond_cash_buffer_missing");
  if (bondLiquidityMissing.includes("repo_asset_ratio")) flags.push("bond_repo_ratio_missing");
  if (bondLike && finite(candidate.volatility_60d) !== null && candidate.volatility_60d > 2) flags.push("recent_bond_volatility_elevated");
  if (bondLike && finite(candidate.max_drawdown_60d) !== null && candidate.max_drawdown_60d < -1) flags.push("recent_bond_drawdown");
  if (bondLike && finite(candidate.cvar_95_daily) !== null && candidate.cvar_95_daily > 0.25) flags.push("bond_cvar_elevated");
  if (candidate.cvar_sample_quality === "limited") flags.push("cvar_limited_sample");
  if (finite(candidate.sortino_3y) !== null && candidate.sortino_3y < 0) flags.push("negative_sortino");
  if (finite(candidate.calmar_3y) !== null && candidate.calmar_3y < 0.25) flags.push("low_calmar");
  if (bondLike && finite(candidate.repo_asset_ratio) !== null && candidate.repo_asset_ratio > 0.1) flags.push("bond_repo_dependence");
  const bondStress = bondLike ? bondStressTest(candidate) : null;
  if (bondStress && bondStress.status !== "complete") flags.push("bond_stress_incomplete");
  if (candidate.category === "指数型" && candidate.tracking_error !== undefined && candidate.tracking_error > 3) {
    flags.push("high_tracking_error");
  }
  if (candidate.manager_change_recently === true) flags.push("recent_manager_change");
  if (candidate.inception_years !== undefined && candidate.inception_years < 3) flags.push("short_live_history");

  return {
    code: candidate.code ?? null,
    name: candidate.name ?? null,
    category: candidate.category ?? null,
    risk_profile: riskProfile,
    score: aggregate.score,
    confidence: confidenceFrom(["annualized_return_3y", "max_drawdown_3y", "data_as_of", ...bondRiskFields], confidenceFields, aggregate.coverage),
    missing: allMissing,
    flags,
    evidence: {
      data_as_of: candidate.data_as_of ?? null,
      available_fields: available,
      bond_risk_fields: {
        available: bondRiskFields.filter((field) => !bondRiskMissing.includes(field)),
        missing: bondRiskMissing,
        liquidity_available: bondLiquidityFields.filter((field) => !bondLiquidityMissing.includes(field)),
        liquidity_missing: bondLiquidityMissing,
        report: candidate.bond_evidence ?? null,
      },
      bond_stress: bondStress,
      tail_risk: {
        cvar_95_daily: candidate.cvar_95_daily ?? null,
        var_95_daily: candidate.var_95_daily ?? null,
        sortino_3y: candidate.sortino_3y ?? null,
        calmar_3y: candidate.calmar_3y ?? null,
        observations: candidate.return_observations ?? null,
        cvar_observations: candidate.cvar_observations ?? null,
        cvar_tail_observations: candidate.cvar_tail_observations ?? null,
        cvar_sample_quality: candidate.cvar_sample_quality ?? null,
      },
      metric_scores: Object.fromEntries(scores.map((part) => [part.key, part.score])),
    },
  };
}

export function rankFunds(candidates, riskProfile = "balanced") {
  return candidates
    .map((candidate) => scoreFundCandidate(candidate, riskProfile))
    .sort((left, right) => (right.score ?? -1) - (left.score ?? -1));
}

function average(values) {
  const available = values.map(finite).filter((value) => value !== null);
  return available.length ? available.reduce((sum, value) => sum + value, 0) / available.length : null;
}

export function analyzeMarketRegime(input) {
  const benchmarks = Array.isArray(input.benchmarks) ? input.benchmarks : [];
  const breadth = input.breadth ?? {};
  const macro = input.macro ?? {};
  const trend = average(benchmarks.flatMap((item) => [item.trend_20d, item.trend_60d].map((value) => scoreHigher(value, -20, 20))));
  const breadthScore = average([
    finite(breadth.advancing_ratio) === null ? null : breadth.advancing_ratio * 100,
    finite(breadth.above_ma_20_ratio) === null ? null : breadth.above_ma_20_ratio * 100,
    finite(breadth.above_ma_60_ratio) === null ? null : breadth.above_ma_60_ratio * 100,
    finite(breadth.new_high_low_ratio) === null ? null : scoreHigher(breadth.new_high_low_ratio, 0.2, 3),
  ]);
  const valuation = average(benchmarks.map((item) => scorePercentile(item.valuation_percentile)));
  const macroScore = average([
    finite(macro.growth_momentum) === null ? null : 50 + macro.growth_momentum * 50,
    finite(macro.liquidity_momentum) === null ? null : 50 + macro.liquidity_momentum * 50,
    finite(macro.inflation_pressure) === null ? null : 50 - macro.inflation_pressure * 40,
  ]);
  const components = [
    { name: "trend", score: trend, weight: 0.3 },
    { name: "breadth", score: breadthScore, weight: 0.25 },
    { name: "valuation", score: valuation, weight: 0.15 },
    { name: "macro", score: macroScore, weight: 0.3 },
  ];
  const aggregate = weightedAverage(components);
  const componentValues = components.map((component) => component.score).filter((score) => score !== null);
  const spread = componentValues.length > 1 ? Math.max(...componentValues) - Math.min(...componentValues) : 0;
  let regime = "insufficient_data";
  if (aggregate.score !== null) {
    regime = spread >= 35 ? "mixed" : aggregate.score >= 65 ? "risk_on" : aggregate.score <= 35 ? "risk_off" : "neutral";
  }
  const missing = [];
  if (trend === null) missing.push("benchmarks.trend_20d_or_trend_60d");
  if (breadthScore === null) missing.push("breadth");
  if (valuation === null) missing.push("benchmarks.valuation_percentile");
  if (macroScore === null) missing.push("macro");

  return {
    as_of: input.as_of ?? null,
    regime,
    score: aggregate.score,
    confidence: Number((100 * aggregate.coverage).toFixed(1)),
    observations: {
      components: Object.fromEntries(components.map((component) => [component.name, component.score === null ? null : Number(component.score.toFixed(2))])),
      component_spread: Number(spread.toFixed(2)),
      benchmark_count: benchmarks.length,
    },
    missing,
  };
}

export function scoreLongTermStock(stock) {
  const parts = [
    { key: "growth", score: average([scoreHigher(stock.revenue_growth_3y, -20, 30), scoreHigher(stock.earnings_growth_3y, -30, 40)]), weight: 0.25 },
    { key: "profitability", score: average([scoreHigher(stock.roe, -10, 30), scoreHigher(stock.gross_margin, 0, 70)]), weight: 0.2 },
    { key: "cash_conversion", score: scoreHigher(stock.cfo_to_net_income, 0, 1.5), weight: 0.15 },
    { key: "balance_sheet", score: scoreLower(stock.debt_to_assets, 0.2, 0.8), weight: 0.15 },
    { key: "valuation", score: scorePercentile(stock.valuation_percentile), weight: 0.1 },
    { key: "shareholder_return", score: average([scoreHigher(stock.dividend_yield, 0, 8), scoreLower(stock.share_dilution, -2, 10)]), weight: 0.05 },
    { key: "governance", score: scoreLower(stock.governance_flags ?? 0, 0, 4), weight: 0.1 },
  ];
  const available = parts.filter((part) => part.score !== null).map((part) => part.key);
  const missing = parts.filter((part) => part.score === null).map((part) => part.key);
  const aggregate = weightedAverage(parts);
  const rawAvailable = [
    "revenue_growth_3y",
    "roe",
    "cfo_to_net_income",
    "valuation_percentile",
    "data_as_of",
  ].filter((field) => field === "data_as_of" ? Boolean(stock.data_as_of) : finite(stock[field]) !== null);
  const flags = [freshnessFlag(stock.data_as_of)].filter(Boolean);
  if (finite(stock.cfo_to_net_income) !== null && stock.cfo_to_net_income < 0.8) flags.push("weak_cash_conversion");
  if (finite(stock.debt_to_assets) !== null && stock.debt_to_assets > 0.65) flags.push("high_leverage");
  if (finite(stock.valuation_percentile) !== null && stock.valuation_percentile > 80) flags.push("expensive_valuation");
  if ((stock.governance_flags ?? 0) > 0) flags.push("governance_review_required");

  let researchBand = "insufficient_data";
  if (aggregate.score !== null) {
    researchBand = aggregate.score >= 75 ? "strong_candidate" : aggregate.score >= 60 ? "watchlist" : "needs_review";
  }

  return {
    code: stock.code ?? null,
    name: stock.name ?? null,
    research_band: researchBand,
    score: aggregate.score,
    confidence: confidenceFrom(["revenue_growth_3y", "roe", "cfo_to_net_income", "valuation_percentile", "data_as_of"], rawAvailable, aggregate.coverage),
    missing,
    flags,
    evidence: {
      data_as_of: stock.data_as_of ?? null,
      available_dimensions: available,
      dimension_scores: Object.fromEntries(parts.map((part) => [part.key, part.score === null ? null : Number(part.score.toFixed(2))])),
    },
  };
}
