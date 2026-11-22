const clamp = (value, min = 0, max = 1) => Math.min(max, Math.max(min, value));

const PROFILE_TARGETS = {
  conservative: {
    cash: 0.12,
    cash_management: 0.13,
    bond: 0.35,
    fund: 0.12,
    domestic_equity: 0.1,
    international_equity: 0.08,
    gold: 0.1,
  },
  balanced: {
    cash: 0.08,
    cash_management: 0.07,
    bond: 0.25,
    fund: 0.18,
    domestic_equity: 0.16,
    international_equity: 0.16,
    gold: 0.1,
  },
  growth: {
    cash: 0.05,
    cash_management: 0.05,
    bond: 0.12,
    fund: 0.18,
    domestic_equity: 0.25,
    international_equity: 0.25,
    gold: 0.1,
  },
};

const DISPLAY_NAMES = {
  cash: "现金",
  cash_management: "货币基金",
  bond: "债券与固收",
  fund: "基金",
  domestic_equity: "国内股票",
  international_equity: "国际股票",
  gold: "黄金",
  fx: "货币",
  other: "其他",
};

const finite = (value) => {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};

const percent = (value) => Number((value * 100).toFixed(2));

function normalizeTargets(riskProfile = "balanced") {
  return { ...(PROFILE_TARGETS[riskProfile] ?? PROFILE_TARGETS.balanced) };
}

function move(targets, from, to, amount) {
  const available = Math.min(targets[from] ?? 0, amount);
  targets[from] -= available;
  targets[to] = (targets[to] ?? 0) + available;
}

function applyRegimeViews(targets, domesticMarket, internationalMarket) {
  const domestic = domesticMarket?.regime;
  const international = internationalMarket?.regime;
  const changes = [];
  if (domestic === "risk_off") {
    move(targets, "domestic_equity", "cash_management", 0.05);
    move(targets, "fund", "gold", 0.03);
    changes.push("国内市场风险收缩，降低国内风险资产目标并提高流动性与黄金缓冲");
  } else if (domestic === "risk_on") {
    move(targets, "cash_management", "domestic_equity", 0.03);
    changes.push("国内市场风险偏好改善，释放少量现金管理仓位到国内风险资产");
  }
  if (international === "risk_off") {
    move(targets, "international_equity", "gold", 0.04);
    changes.push("国际市场风险收缩，降低国际风险资产目标并提高黄金缓冲");
  } else if (international === "risk_on") {
    move(targets, "cash_management", "international_equity", 0.03);
    changes.push("国际市场风险偏好改善，释放少量现金管理仓位到国际风险资产");
  }
  return changes;
}

function cvarPenalty(holding) {
  const cvar = finite(holding.cvar_95_daily);
  if (cvar === null || cvar <= 0) return 0;
  return clamp(cvar / 2, 0, 0.35);
}

function riskParityWeights(holdings) {
  const rows = holdings
    .map((holding) => ({
      id: holding.id,
      name: holding.name,
      volatility: finite(holding.volatility),
    }))
    .filter((holding) => holding.volatility !== null && holding.volatility > 0);
  if (!rows.length) return { available: false, weights: [] };
  const inverse = rows.map((row) => ({ ...row, inverseRisk: 1 / row.volatility }));
  const total = inverse.reduce((sum, row) => sum + row.inverseRisk, 0);
  return {
    available: true,
    weights: inverse.map((row) => ({ ...row, weight: Number((row.inverseRisk / total).toFixed(4)) })),
  };
}

export function buildPortfolioPlan({
  portfolio = {},
  summary = {},
  riskProfile = "balanced",
  domesticMarket,
  internationalMarket,
  asOf,
} = {}) {
  const targets = normalizeTargets(riskProfile);
  const regimeChanges = applyRegimeViews(targets, domesticMarket, internationalMarket);
  const actual = summary.buckets ?? {};
  const total = finite(summary.total_capital);
  const rebalance = Object.entries(targets)
    .map(([assetType, target]) => {
      const current = total && total > 0 ? (finite(actual[assetType]) ?? 0) / total : null;
      const drift = current === null ? null : target - current;
      return {
        asset_type: assetType,
        label: DISPLAY_NAMES[assetType] ?? assetType,
        target_weight: percent(target),
        current_weight: current === null ? null : percent(current),
        drift: drift === null ? null : percent(drift),
        action:
          drift === null || Math.abs(drift) < 0.05
            ? "hold"
            : drift > 0
              ? "increase_gradually"
              : "reduce_gradually",
      };
    })
    .sort((left, right) => Math.abs(right.drift ?? 0) - Math.abs(left.drift ?? 0));
  const riskFlags = [];
  if (summary.largest_risk_holding_ratio !== null && summary.largest_risk_holding_ratio > 0.35)
    riskFlags.push("single_holding_over_35_percent");
  if (summary.cash_ratio !== null && summary.cash_ratio < 0.1)
    riskFlags.push("cash_buffer_below_10_percent");
  for (const holding of portfolio.holdings ?? []) {
    if (cvarPenalty(holding) > 0.2) riskFlags.push(`tail_risk_${holding.id ?? holding.symbol ?? "holding"}`);
  }
  return {
    as_of: asOf ?? null,
    risk_profile: riskProfile,
    algorithm: {
      name: "regime-aware risk budgeting",
      version: "0.1",
      methods: ["risk-budget targets", "CVaR and drawdown guard", "turnover threshold", "confidence-weighted market views"],
      limitations: [
        "没有足够的同步收益序列时，不执行完整 HRP 或 Black-Litterman 矩阵优化。",
        "结果用于研究与复核，不会自动下单。",
      ],
    },
    target_weights: rebalance.filter((item) => item.target_weight > 0),
    risk_parity: riskParityWeights(portfolio.holdings ?? []),
    regime_changes: regimeChanges,
    risk_flags: [...new Set(riskFlags)],
    status: total && total > 0 ? "ready" : "awaiting_portfolio_value",
  };
}

export { DISPLAY_NAMES, PROFILE_TARGETS };
