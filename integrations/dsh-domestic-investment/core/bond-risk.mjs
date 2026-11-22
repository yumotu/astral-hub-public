const TRADING_DAYS = 252;
const MIN_CVAR_OBSERVATIONS = 20;
const RELIABLE_CVAR_OBSERVATIONS = 60;

function finite(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function average(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

function round(value, digits = 4) {
  return finite(value) === null ? null : Number(value.toFixed(digits));
}

function asFraction(value) {
  const numeric = finite(value);
  if (numeric === null) return null;
  const fraction = numeric > 1 ? numeric / 100 : numeric;
  return fraction >= 0 && fraction <= 1 ? fraction : null;
}

export const DEFAULT_BOND_STRESS_SCENARIO = Object.freeze({
  rate_shock_bps: 50,
  credit_spread_shock_bps: 100,
  redemption_shock_percent: 10,
  liquidity_cost_bps: 50,
});

export function returnsFromValues(values) {
  const returns = [];
  let previous = null;
  for (const item of values) {
    const value = finite(item);
    if (value === null || value <= 0) {
      previous = null;
      continue;
    }
    if (previous !== null) returns.push(value / previous - 1);
    previous = value;
  }
  return returns;
}

export function computeCvar(returns, alpha = 0.95) {
  if (!(alpha > 0 && alpha < 1)) throw new RangeError("alpha must be between 0 and 1.");
  const losses = returns.map(finite).filter((value) => value !== null).map((value) => Math.max(0, -value)).sort((left, right) => right - left);
  if (losses.length < MIN_CVAR_OBSERVATIONS) {
    return { value: null, var: null, observations: losses.length, tail_observations: 0, sample_quality: "insufficient", alpha };
  }
  const tailCount = Math.max(1, Math.ceil(Number(((1 - alpha) * losses.length).toFixed(10))));
  const threshold = losses[tailCount - 1];
  const tail = losses.slice(0, tailCount);
  return {
    value: round(average(tail), 8),
    var: round(threshold, 8),
    observations: losses.length,
    tail_observations: tail.length,
    sample_quality: losses.length >= RELIABLE_CVAR_OBSERVATIONS ? "adequate" : "limited",
    alpha,
  };
}

export function computeTailRisk(values) {
  const returns = returnsFromValues(values);
  const cvar = computeCvar(returns);
  const downsideSquares = returns.map((value) => Math.min(0, value) ** 2);
  const downsideDeviationDaily = downsideSquares.length ? Math.sqrt(average(downsideSquares)) : 0;
  const meanReturn = average(returns);
  return {
    cvar_95_daily: cvar.value === null ? null : round(cvar.value * 100, 4),
    var_95_daily: cvar.var === null ? null : round(cvar.var * 100, 4),
    downside_deviation_3y: returns.length ? round(downsideDeviationDaily * Math.sqrt(TRADING_DAYS) * 100, 4) : null,
    sortino_3y: meanReturn === null || downsideDeviationDaily === 0 ? null : round((meanReturn * TRADING_DAYS) / (downsideDeviationDaily * Math.sqrt(TRADING_DAYS)), 4),
    return_observations: returns.length,
    cvar_observations: cvar.observations,
    cvar_tail_observations: cvar.tail_observations,
    cvar_sample_quality: cvar.sample_quality,
  };
}

function rateImpact(duration, shockBps) {
  return -(duration * shockBps) / 100;
}

function spreadImpact(spreadDuration, shockBps) {
  return -(spreadDuration * shockBps) / 100;
}

function liquidityImpact(candidate, scenario) {
  const cashRatio = asFraction(candidate.cash_ratio);
  if (cashRatio === null) return null;
  const cashPercent = cashRatio * 100;
  const redemptionPercent = scenario.redemption_shock_percent;
  const liquidationPercent = Math.max(0, redemptionPercent - cashPercent);
  return {
    status: "scenario",
    cash_ratio: round(cashRatio, 6),
    repo_asset_ratio: asFraction(candidate.repo_asset_ratio),
    redemption_shock_percent: redemptionPercent,
    liquidation_percent: round(liquidationPercent, 4),
    loss_pct: round(-(scenario.liquidity_cost_bps / 100) * (liquidationPercent / 100), 4),
  };
}

export function bondStressTest(candidate, scenario = {}) {
  const assumptions = { ...DEFAULT_BOND_STRESS_SCENARIO, ...scenario };
  const components = {};
  const missing = [];
  const duration = finite(candidate.duration_years);
  const durationUpperBound = finite(candidate.duration_upper_bound_years);
  if (duration !== null) {
    components.rate = { status: "point", duration_years: duration, loss_pct: round(rateImpact(duration, assumptions.rate_shock_bps), 4) };
  } else if (durationUpperBound !== null) {
    components.rate = { status: "upper_bound", duration_upper_bound_years: durationUpperBound, loss_pct: round(rateImpact(durationUpperBound, assumptions.rate_shock_bps), 4) };
  } else {
    missing.push("duration_years");
  }

  const spreadDuration = finite(candidate.spread_duration_years);
  if (spreadDuration !== null) {
    components.credit_spread = {
      status: "point",
      spread_duration_years: spreadDuration,
      current_credit_spread_bps: finite(candidate.credit_spread_bps),
      loss_pct: round(spreadImpact(spreadDuration, assumptions.credit_spread_shock_bps), 4),
    };
  } else {
    missing.push("spread_duration_years");
  }

  const liquidity = liquidityImpact(candidate, assumptions);
  if (liquidity) components.liquidity = liquidity;
  else missing.push("cash_ratio");

  const losses = Object.values(components).map((component) => component.loss_pct).filter((value) => finite(value) !== null);
  const status = losses.length === 3 ? "complete" : losses.length ? "partial" : "not_computable";
  return {
    method: "deterministic_bond_stress",
    status,
    assumptions,
    components,
    total_scenario_return_pct: losses.length ? round(losses.reduce((sum, value) => sum + value, 0), 4) : null,
    total_scenario_loss_pct: losses.length ? round(Math.max(0, -losses.reduce((sum, value) => sum + value, 0)), 4) : null,
    coverage: Number((losses.length / 3).toFixed(3)),
    missing,
    report_date: candidate.bond_evidence?.report_date ?? null,
    source_url: candidate.bond_evidence?.source_url ?? null,
  };
}

export { finite };
