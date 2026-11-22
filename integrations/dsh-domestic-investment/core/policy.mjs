export const SERVER_INSTRUCTIONS = [
  "You are connected to a read-only domestic and international investment research server.",
  "Use official disclosures and dated data before community commentary.",
  "For fund research, evaluate multi-year return, drawdown, volatility, recent path risk, CVaR, fees, manager tenure, style consistency, data freshness, and for bond funds duration, credit spread duration, leverage, cash buffer, repo exposure, and stress loss.",
  "For domestic and international market regime analysis, separate observed market data from inference and report missing fields.",
  "For domestic and international stock research, examine growth, profitability, cash flow, leverage, dilution, valuation, dividends, currency exposure, and governance evidence.",
  "For portfolio review, preserve the user's as-of date and treat screenshots or manual entries as user-supplied snapshots that require later reconciliation.",
  "For daily actions, produce read-only research steps and portfolio checks. Do not place orders or imply certainty about future returns.",
  "Long-horizon schedules call only registered plugin actions, never place orders or replay missed runs, and each plugin must apply its own confirmation policy for external side effects.",
  "Do not treat a short-term ranking, a single valuation ratio, or an uncited opinion as a sufficient basis for a conclusion.",
  "Every conclusion should preserve the as-of date and identify the fields that support it.",
].join(" ");

export const METHODOLOGY = {
  fund: {
    required: ["annualized_return_3y", "max_drawdown_3y", "data_as_of"],
    dimensions: [
      "multi-year return",
      "drawdown",
      "volatility",
      "recent path risk",
      "95% CVaR",
      "downside deviation, Sortino, and Calmar",
      "fee",
      "manager tenure",
      "style consistency",
      "assets under management",
    ],
    bond_dimensions: [
      "modified duration or an explicitly disclosed upper bound",
      "credit-spread duration and credit-spread evidence",
      "cash buffer and repo exposure",
      "rate, credit-spread, and redemption-liquidity stress",
    ],
    output: ["score", "confidence", "missing", "flags", "evidence"],
  },
  market: {
    dimensions: ["trend", "breadth", "valuation", "macro momentum", "risk concentration"],
    output: ["regime", "score", "confidence", "observations", "missing"],
  },
  stock: {
    required: ["revenue_growth_3y", "roe", "cfo_to_net_income", "valuation_percentile", "data_as_of"],
    dimensions: [
      "growth",
      "profitability",
      "cash conversion",
      "balance-sheet risk",
      "valuation",
      "shareholder return",
      "governance",
    ],
    output: ["research_band", "score", "confidence", "missing", "flags", "evidence"],
  },
  international: {
    dimensions: [
      "regional and index trend",
      "breadth",
      "valuation",
      "currency exposure",
      "international stock quality",
      "fund and ETF structure",
    ],
    output: ["market", "indices", "stocks", "missing", "confidence"],
  },
  portfolio: {
    dimensions: [
      "cash and liquidity",
      "domestic exposure",
      "international exposure",
      "single-holding concentration",
      "risk-asset ratio",
      "data freshness",
    ],
    output: ["summary", "daily_actions", "evidence", "missing"],
  },
};

export const SOURCE_HIERARCHY = [
  "CSRC, AMAC, SSE, SZSE, CSI, CNINFO, NBS, and PBOC disclosures",
  "SEC, company filings, exchange notices, index administrators, and fund-manager disclosures for international assets",
  "fund manager and listed-company official reports",
  "licensed professional databases such as Tushare Pro, Wind, Choice, or iFinD",
  "open data libraries such as AkShare or BaoStock",
  "community and media sources for idea generation, followed by primary-source verification",
];
