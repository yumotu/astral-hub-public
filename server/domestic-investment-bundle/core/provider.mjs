import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { computeTailRisk } from "./bond-risk.mjs";

const ALLOWED_DATASETS = new Set([
  "fund_basic",
  "fund_nav",
  "index_daily",
  "daily_basic",
  "fina_indicator",
  "income",
  "balancesheet",
  "cashflow",
  "dividend",
  "us_daily_adj",
  "us_fina_indicator",
  "us_etf_basic",
  "us_etf_daily",
  "us_tradecal",
  "hk_daily",
  "fx_daily",
  "eco_cal",
]);

const DEFAULT_FUND_CODES = [
  "004870", "004597", "008163", "002611", "004253",
  "012922", "019172", "021528", "022364", "012773", "016790", "000084",
];

const DOMESTIC_INDEXES = [
  { symbol: "sh000001", code: "000001.SH", name: "上证指数", region: "中国A股" },
  { symbol: "sz399001", code: "399001.SZ", name: "深证成指", region: "中国A股" },
  { symbol: "sz399006", code: "399006.SZ", name: "创业板指", region: "中国A股" },
  { symbol: "sh000688", code: "000688.SH", name: "科创50", region: "中国A股" },
];

const INTERNATIONAL_INDEXES = [
  { symbol: "hkHSI", code: "HSI", name: "恒生指数", region: "中国香港", currency: "HKD" },
  { symbol: "hkHSTECH", code: "HSTECH", name: "恒生科技指数", region: "中国香港", currency: "HKD" },
  { symbol: "usSPY", code: "SPY", name: "标普500 ETF", region: "美国", currency: "USD" },
  { symbol: "usQQQ", code: "QQQ", name: "纳斯达克100 ETF", region: "美国", currency: "USD" },
];

const LIVE_SOURCES = [
  { name: "腾讯财经行情与历史接口", url: "https://qt.gtimg.cn/、https://web.ifzq.gtimg.cn/", scope: "国内指数、港股指数和国际 ETF 行情" },
  { name: "天天基金公开接口", url: "https://fund.eastmoney.com/、https://api.fund.eastmoney.com/", scope: "基金名称、类别、净值和历史净值曲线" },
];

const DEFAULT_TIMEOUT_MS = 8_000;
const DASHBOARD_CACHE_MS = 60_000;
const FUND_CACHE_MS = 6 * 60 * 60 * 1_000;

function normalizeRecords(payload) {
  if (Array.isArray(payload)) return payload;
  if (payload && Array.isArray(payload.data)) return payload.data;
  if (payload && Array.isArray(payload.items)) return payload.items;
  return [];
}

function number(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function isoDate(value) {
  if (!value) return null;
  const text = String(value).replace(/^(\d{4})(\d{2})(\d{2}).*$/, "$1-$2-$3").replaceAll("/", "-");
  const date = new Date(text);
  return Number.isNaN(date.valueOf()) ? null : text.slice(0, 10);
}

function extractJsonAssignment(text, variable) {
  const marker = `${variable} = `;
  const start = text.indexOf(marker);
  if (start < 0) return null;
  const valueStart = start + marker.length;
  const opening = text[valueStart];
  if (opening !== "[" && opening !== "{") return null;
  let depth = 0;
  let quote = null;
  let escaped = false;
  for (let index = valueStart; index < text.length; index += 1) {
    const character = text[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === quote) quote = null;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character === "[" || character === "{") depth += 1;
    if (character === "]" || character === "}") {
      depth -= 1;
      if (depth === 0) {
        try {
          return JSON.parse(text.slice(valueStart, index + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

function parseTencentQuotes(text) {
  const quotes = {};
  for (const part of String(text).split(";").map((item) => item.trim()).filter(Boolean)) {
    const match = part.match(/^v_([^=]+)="([\s\S]*)"$/);
    if (!match) continue;
    const fields = match[2].split("~");
    quotes[match[1]] = {
      symbol: match[1],
      name: fields[1] || match[1],
      code: fields[2] || null,
      price: number(fields[3]),
      previous_close: number(fields[4]),
      open: number(fields[5]),
      change: number(fields[31]),
      change_percent: number(fields[32]),
      high: number(fields[33]),
      low: number(fields[34]),
      volume: number(fields[36]),
      as_of: isoDate(fields[30]),
      raw_timestamp: fields[30] || null,
    };
  }
  return quotes;
}

function parseTencentHistory(payload, symbol) {
  const rows = payload?.data?.[symbol]?.day;
  if (!Array.isArray(rows)) return [];
  return rows.map((row) => ({
    date: isoDate(row[0]), open: number(row[1]), close: number(row[2]),
    high: number(row[3]), low: number(row[4]), volume: number(row[5]),
  })).filter((row) => row.date && row.close !== null);
}

function trend(history, length) {
  if (!history.length || history.length < 2) return null;
  const last = history.at(-1)?.close;
  const first = history[Math.max(0, history.length - length)]?.close;
  return last !== null && first > 0 ? Number(((last / first - 1) * 100).toFixed(2)) : null;
}

function change(history, length) {
  return trend(history, length);
}

function annualizedReturn(points, days) {
  const ordered = points.filter((point) => Number.isFinite(point?.x) && Number.isFinite(point?.y)).toSorted((left, right) => left.x - right.x);
  if (!ordered.length) return null;
  const latest = ordered.at(-1);
  const threshold = latest.x - days * 86_400_000;
  const reference = ordered.find((point) => point.x >= threshold) ?? ordered[0];
  if (!Number.isFinite(latest.y) || !Number.isFinite(reference.y) || reference.y <= 0) return null;
  const elapsedDays = Math.max(1, (latest.x - reference.x) / 86_400_000);
  return Number(((Math.pow(latest.y / reference.y, 365 / elapsedDays) - 1) * 100).toFixed(2));
}

function fundRiskMetrics(points) {
  const ordered = points.filter((point) => Number.isFinite(point?.x) && Number.isFinite(point?.y)).toSorted((left, right) => left.x - right.x);
  const latestX = ordered.at(-1)?.x ?? null;
  const threeYearPoints = latestX === null ? [] : ordered.filter((point) => point.x >= latestX - 3 * 365 * 86_400_000);
  const values = threeYearPoints.map((point) => point.y).filter((value) => Number.isFinite(value) && value > 0);
  const recentPoints = latestX === null ? [] : threeYearPoints.filter((point) => point.x >= latestX - 60 * 86_400_000);
  if (values.length < 2) {
    return {
      max_drawdown_3y: null,
      volatility_3y: null,
      max_drawdown_60d: null,
      volatility_60d: null,
      cvar_95_daily: null,
      var_95_daily: null,
      downside_deviation_3y: null,
      sortino_3y: null,
      return_observations: 0,
      cvar_observations: 0,
      cvar_tail_observations: 0,
      cvar_sample_quality: "insufficient",
    };
  }
  let peak = values[0];
  let maxDrawdown = 0;
  const returns = [];
  for (const value of values) {
    peak = Math.max(peak, value);
    maxDrawdown = Math.min(maxDrawdown, (value / peak - 1) * 100);
  }
  for (let index = 1; index < values.length; index += 1) returns.push(values[index] / values[index - 1] - 1);
  const mean = returns.reduce((sum, value) => sum + value, 0) / returns.length;
  const variance = returns.reduce((sum, value) => sum + (value - mean) ** 2, 0) / returns.length;
  const recentValues = recentPoints.map((point) => point.y).filter((value) => Number.isFinite(value) && value > 0);
  let recentDrawdown = null;
  let recentVolatility = null;
  if (recentValues.length >= 2) {
    let recentPeak = recentValues[0];
    recentDrawdown = 0;
    for (const value of recentValues) {
      recentPeak = Math.max(recentPeak, value);
      recentDrawdown = Math.min(recentDrawdown, (value / recentPeak - 1) * 100);
    }
    const recentReturns = [];
    for (let index = 1; index < recentValues.length; index += 1) recentReturns.push(recentValues[index] / recentValues[index - 1] - 1);
    const recentMean = recentReturns.reduce((sum, value) => sum + value, 0) / recentReturns.length;
    const recentVariance = recentReturns.reduce((sum, value) => sum + (value - recentMean) ** 2, 0) / recentReturns.length;
    recentVolatility = Number((Math.sqrt(recentVariance) * Math.sqrt(252) * 100).toFixed(2));
  }
  return {
    max_drawdown_3y: Number(maxDrawdown.toFixed(2)),
    volatility_3y: Number((Math.sqrt(variance) * Math.sqrt(252) * 100).toFixed(2)),
    max_drawdown_60d: recentDrawdown === null ? null : Number(recentDrawdown.toFixed(2)),
    volatility_60d: recentVolatility,
    ...computeTailRisk(values),
  };
}

function parseFundList(text) {
  const start = text.indexOf("var r = ");
  if (start < 0) return [];
  const list = extractJsonAssignment(text.slice(start), "var r");
  return Array.isArray(list) ? list.map((row) => ({ code: row[0], name: row[2], category: row[3] })).filter((row) => row.code) : [];
}

function parseFundProfile(text) {
  const name = text.match(/var fS_name = "([^"]*)"/i)?.[1] ?? null;
  const code = text.match(/var fS_code = "([^"]*)"/i)?.[1] ?? null;
  const trend = extractJsonAssignment(text, "Data_netWorthTrend");
  const points = Array.isArray(trend) ? trend.map((point) => ({ x: Number(point.x), y: Number(point.y) })).filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y)) : [];
  return { code, name, points };
}

function toFundCandidate(meta, profile, evidence = null) {
  const points = profile.points;
  const metrics = fundRiskMetrics(points);
  const latest = points.filter((point) => Number.isFinite(point?.x)).toSorted((left, right) => left.x - right.x).at(-1);
  const bondMetrics = evidence?.metrics ?? {};
  const annualizedReturn3y = annualizedReturn(points, 365 * 3);
  const calmar3y = annualizedReturn3y !== null && metrics.max_drawdown_3y < 0
    ? Number((annualizedReturn3y / Math.abs(metrics.max_drawdown_3y)).toFixed(2))
    : null;
  return {
    code: meta.code,
    name: profile.name || meta.name || evidence?.name || meta.code,
    category: meta.category || evidence?.category || null,
    annualized_return_3y: annualizedReturn3y,
    annualized_return_5y: annualizedReturn(points, 365 * 5),
    max_drawdown_3y: metrics.max_drawdown_3y,
    volatility_3y: metrics.volatility_3y,
    max_drawdown_60d: metrics.max_drawdown_60d,
    volatility_60d: metrics.volatility_60d,
    cvar_95_daily: metrics.cvar_95_daily,
    var_95_daily: metrics.var_95_daily,
    downside_deviation_3y: metrics.downside_deviation_3y,
    sortino_3y: metrics.sortino_3y,
    calmar_3y: calmar3y,
    return_observations: metrics.return_observations,
    cvar_observations: metrics.cvar_observations,
    cvar_tail_observations: metrics.cvar_tail_observations,
    cvar_sample_quality: metrics.cvar_sample_quality,
    duration_years: bondMetrics.duration_years ?? null,
    duration_upper_bound_years: bondMetrics.duration_upper_bound_years ?? null,
    spread_duration_years: bondMetrics.spread_duration_years ?? null,
    credit_spread_bps: bondMetrics.credit_spread_bps ?? null,
    credit_quality_score: bondMetrics.credit_quality_score ?? null,
    leverage_ratio: bondMetrics.leverage_ratio ?? null,
    cash_ratio: bondMetrics.cash_ratio ?? null,
    repo_asset_ratio: bondMetrics.repo_asset_ratio ?? null,
    fixed_income_asset_ratio: bondMetrics.fixed_income_asset_ratio ?? null,
    equity_ratio: bondMetrics.equity_ratio ?? null,
    bond_evidence: evidence ? {
      report_date: evidence.report_date,
      published_date: evidence.published_date,
      source_url: evidence.source_url,
      evidence_notes: evidence.evidence_notes,
    } : null,
    data_as_of: latest ? new Date(latest.x).toISOString().slice(0, 10) : null,
    current_price: latest?.y ?? null,
    source: "eastmoney_fund_profile",
  };
}

function datasetCodes(params = {}) {
  const value = params.ts_code ?? params.fund_code ?? params.code;
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === "string") return value.split(",").map((item) => item.trim()).filter(Boolean);
  return [];
}

export async function createDataProvider({
  dataFile = process.env.INVESTMENT_DATA_FILE ?? fileURLToPath(new URL("../../data/portfolio-snapshot.json", import.meta.url)),
  bondEvidenceFile = process.env.INVESTMENT_BOND_EVIDENCE_FILE ?? fileURLToPath(new URL("../../data/bond-fund-evidence.json", import.meta.url)),
  token = process.env.TUSHARE_TOKEN,
  live = process.env.INVESTMENT_LIVE_DATA !== "0",
  fetchImpl = globalThis.fetch,
  timeoutMs = Number(process.env.INVESTMENT_LIVE_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS),
} = {}) {
  let fixture = null;
  if (dataFile) {
    try {
      fixture = JSON.parse(await readFile(dataFile, "utf8"));
    } catch (error) {
      if (process.env.INVESTMENT_DATA_FILE) throw error;
    }
  }
  let bondEvidence = { funds: {} };
  try {
    bondEvidence = JSON.parse(await readFile(bondEvidenceFile, "utf8"));
  } catch (error) {
    if (process.env.INVESTMENT_BOND_EVIDENCE_FILE) throw error;
  }
  const dashboardCache = { expiresAt: 0, value: null };
  let dashboardRequest = null;
  const fundCache = new Map();

  async function requestText(url, headers = {}) {
    if (typeof fetchImpl !== "function") throw new Error("No fetch implementation is available for live data.");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(url, { signal: controller.signal, headers: { "user-agent": "domestic-investment-mcp/0.1", ...headers } });
      const text = await response.text();
      if (!response.ok) throw new Error(`Live data request failed with HTTP ${response.status}.`);
      return text;
    } catch (error) {
      if (error?.name === "AbortError") throw new Error(`Live data request timed out after ${timeoutMs}ms.`);
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  async function requestJson(url, headers = {}) {
    const text = await requestText(url, headers);
    try { return JSON.parse(text); } catch { throw new Error("Live data source returned invalid JSON."); }
  }

  async function queryLive(dataset, params = {}) {
    const codes = datasetCodes(params);
    if (dataset === "fund_basic") {
      return { source: "eastmoney", dataset, records: parseFundList(await requestText("https://fund.eastmoney.com/js/fundcode_search.js")), params };
    }
    if (dataset === "fund_nav") {
      const code = codes[0];
      if (!code) throw new Error("fund_nav requires fund_code or ts_code.");
      const profile = parseFundProfile(await requestText(`https://fund.eastmoney.com/pingzhongdata/${encodeURIComponent(code)}.js`));
      return { source: "eastmoney", dataset, records: profile.points.map((point) => ({ ts_code: code, trade_date: new Date(point.x).toISOString().slice(0, 10), nav: point.y, accum_nav: point.y })), params };
    }
    const symbols = {
      index_daily: { "000001.SH": "sh000001", "399001.SZ": "sz399001", "399006.SZ": "sz399006", "000688.SH": "sh000688" },
      hk_daily: { HSI: "hkHSI", HSTECH: "hkHSTECH" },
      us_daily_adj: { SPY: "usSPY", QQQ: "usQQQ" },
    }[dataset];
    const symbol = symbols?.[params.ts_code];
    if (symbol) {
      const end = new Date();
      const start = new Date(end);
      start.setFullYear(start.getFullYear() - 5);
      const payload = await requestJson(`https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=${symbol},day,${start.toISOString().slice(0, 10)},${end.toISOString().slice(0, 10)},2000,qfq`);
      return { source: "tencent", dataset, records: parseTencentHistory(payload, symbol), params };
    }
    throw new Error(`Live source does not provide ${dataset} without TUSHARE_TOKEN.`);
  }

  async function query(dataset, params = {}, fields = "") {
    if (!ALLOWED_DATASETS.has(dataset)) throw new Error(`Unsupported dataset: ${dataset}. Allowed datasets are ${[...ALLOWED_DATASETS].join(", ")}.`);
    if (fixture?.datasets?.[dataset]) return { source: "fixture", dataset, records: normalizeRecords(fixture.datasets[dataset]), params };
    if (token) {
      const response = await fetchImpl("https://api.tushare.pro", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token, api_name: dataset, params, fields }) });
      if (!response.ok) throw new Error(`Tushare request failed with HTTP ${response.status}.`);
      const payload = await response.json();
      if (payload.code !== 0) throw new Error(`Tushare ${dataset} failed: ${payload.msg ?? "unknown error"}`);
      const fieldsList = payload.data?.fields ?? [];
      const records = (payload.data?.items ?? []).map((row) => Object.fromEntries(fieldsList.map((field, index) => [field, row[index]])));
      return { source: "tushare", dataset, records, params };
    }
    if (live) return queryLive(dataset, params);
    throw new Error("No data source configured. Set TUSHARE_TOKEN, INVESTMENT_DATA_FILE, or enable live public data.");
  }

  function fixtureCandidates(kind) {
    const list = fixture?.[kind];
    return Array.isArray(list) ? list : [];
  }

  async function funds(codes = []) {
    const candidates = fixtureCandidates("funds");
    if (candidates.length && !token && !live) return codes.length ? candidates.filter((item) => codes.includes(item.code)) : candidates;
    const requested = codes.length ? codes.slice(0, 20) : DEFAULT_FUND_CODES;
    if (token) {
      const result = [];
      for (const code of requested) {
        const nav = await query("fund_nav", { ts_code: code }, "ts_code,trade_date,nav,accum_nav,adj_nav");
        const rows = nav.records.filter((row) => row.ts_code === code).sort((left, right) => String(left.trade_date).localeCompare(String(right.trade_date)));
        if (!rows.length) continue;
        const points = rows.map((row) => ({ x: Date.parse(String(row.trade_date)), y: Number(row.accum_nav ?? row.nav) })).filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y) && point.y > 0);
        const metrics = fundRiskMetrics(points);
        const annualizedReturn3y = annualizedReturn(points, 365 * 3);
        const calmar3y = annualizedReturn3y !== null && metrics.max_drawdown_3y < 0
          ? Number((annualizedReturn3y / Math.abs(metrics.max_drawdown_3y)).toFixed(2))
          : null;
        const evidence = bondEvidence.funds?.[code] ?? null;
        const bondMetrics = evidence?.metrics ?? {};
        result.push({
          code,
          name: code,
          category: evidence?.category ?? null,
          annualized_return_3y: annualizedReturn3y,
          annualized_return_5y: annualizedReturn(points, 365 * 5),
          max_drawdown_3y: metrics.max_drawdown_3y,
          volatility_3y: metrics.volatility_3y,
          max_drawdown_60d: metrics.max_drawdown_60d,
          volatility_60d: metrics.volatility_60d,
          cvar_95_daily: metrics.cvar_95_daily,
          var_95_daily: metrics.var_95_daily,
          downside_deviation_3y: metrics.downside_deviation_3y,
          sortino_3y: metrics.sortino_3y,
          calmar_3y: calmar3y,
          return_observations: metrics.return_observations,
          cvar_observations: metrics.cvar_observations,
          cvar_tail_observations: metrics.cvar_tail_observations,
          cvar_sample_quality: metrics.cvar_sample_quality,
          duration_years: bondMetrics.duration_years ?? null,
          duration_upper_bound_years: bondMetrics.duration_upper_bound_years ?? null,
          spread_duration_years: bondMetrics.spread_duration_years ?? null,
          credit_spread_bps: bondMetrics.credit_spread_bps ?? null,
          credit_quality_score: bondMetrics.credit_quality_score ?? null,
          leverage_ratio: bondMetrics.leverage_ratio ?? null,
          cash_ratio: bondMetrics.cash_ratio ?? null,
          repo_asset_ratio: bondMetrics.repo_asset_ratio ?? null,
          fixed_income_asset_ratio: bondMetrics.fixed_income_asset_ratio ?? null,
          equity_ratio: bondMetrics.equity_ratio ?? null,
          bond_evidence: evidence ? { report_date: evidence.report_date, published_date: evidence.published_date, source_url: evidence.source_url, evidence_notes: evidence.evidence_notes } : null,
          data_as_of: rows.at(-1).trade_date,
          current_price: Number(rows.at(-1).accum_nav ?? rows.at(-1).nav) || null,
        });
      }
      return result;
    }
    if (!live) return candidates;
    const now = Date.now();
    const result = [];
    let metadata = new Map();
    try {
      metadata = new Map(parseFundList(await requestText("https://fund.eastmoney.com/js/fundcode_search.js")).map((item) => [item.code, item]));
    } catch { /* Profile data remains useful when the optional metadata endpoint is unavailable. */ }
    const fetched = await Promise.all(requested.map(async (code) => {
      const cached = fundCache.get(code);
      if (cached && cached.expiresAt > now) return cached.value;
      try {
        const profile = parseFundProfile(await requestText(`https://fund.eastmoney.com/pingzhongdata/${encodeURIComponent(code)}.js`));
        const value = toFundCandidate(metadata.get(code) ?? { code }, profile, bondEvidence.funds?.[code] ?? null);
        fundCache.set(code, { expiresAt: now + FUND_CACHE_MS, value });
        return value;
      } catch { return null; }
    }));
    return fetched.filter(Boolean);
  }

  async function liveMarket() {
    const quotes = parseTencentQuotes(await requestText(`https://qt.gtimg.cn/q=${DOMESTIC_INDEXES.map((item) => item.symbol).join(",")}`));
    const historyResults = await Promise.allSettled(DOMESTIC_INDEXES.map(async (item) => {
      const end = new Date(); const start = new Date(end); start.setFullYear(start.getFullYear() - 1);
      const payload = await requestJson(`https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=${item.symbol},day,${start.toISOString().slice(0, 10)},${end.toISOString().slice(0, 10)},400,qfq`);
      return [item.symbol, parseTencentHistory(payload, item.symbol)];
    }));
    const histories = new Map(historyResults.filter((result) => result.status === "fulfilled").map((result) => result.value));
    const benchmarks = DOMESTIC_INDEXES.map((item) => { const history = histories.get(item.symbol) ?? []; return { name: item.name, code: item.code, trend_20d: trend(history, 20), trend_60d: trend(history, 60), valuation_percentile: null }; });
    const asOf = DOMESTIC_INDEXES.map((item) => quotes[item.symbol]?.as_of).filter(Boolean).sort().at(-1) ?? null;
    return { snapshot: { as_of: asOf, benchmarks, breadth: null, macro: null }, indices: DOMESTIC_INDEXES.map((item) => ({ ...item, price: quotes[item.symbol]?.price, change_1d: quotes[item.symbol]?.change_percent, data_as_of: quotes[item.symbol]?.as_of })).filter((item) => Number.isFinite(item.price)), sources: LIVE_SOURCES.filter((source) => source.name.includes("腾讯")) };
  }

  async function liveInternational() {
    const quotes = parseTencentQuotes(await requestText(`https://qt.gtimg.cn/q=${INTERNATIONAL_INDEXES.map((item) => item.symbol).join(",")}`));
    const historyResults = await Promise.allSettled(INTERNATIONAL_INDEXES.map(async (item) => {
      const end = new Date(); const start = new Date(end); start.setFullYear(start.getFullYear() - 1);
      const payload = await requestJson(`https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=${item.symbol},day,${start.toISOString().slice(0, 10)},${end.toISOString().slice(0, 10)},400,qfq`);
      return [item.symbol, parseTencentHistory(payload, item.symbol)];
    }));
    const histories = new Map(historyResults.filter((result) => result.status === "fulfilled").map((result) => result.value));
    const benchmarks = INTERNATIONAL_INDEXES.map((item) => { const history = histories.get(item.symbol) ?? []; return { name: item.name, code: item.code, trend_20d: trend(history, 20), trend_60d: trend(history, 60), valuation_percentile: null }; });
    const asOf = INTERNATIONAL_INDEXES.map((item) => quotes[item.symbol]?.as_of).filter(Boolean).sort().at(-1) ?? null;
    return { market: { as_of: asOf, benchmarks, breadth: null, macro: null }, indices: INTERNATIONAL_INDEXES.map((item) => { const history = histories.get(item.symbol) ?? []; return { ...item, price: quotes[item.symbol]?.price, change_1d: quotes[item.symbol]?.change_percent, change_1m: change(history, 22), ytd: change(history, history.length), valuation_percentile: null, data_as_of: quotes[item.symbol]?.as_of }; }).filter((item) => Number.isFinite(item.price)), stocks: [], sources: LIVE_SOURCES.filter((source) => source.name.includes("腾讯")) };
  }

  async function getDashboardSeed() {
    if (dashboardCache.value && dashboardCache.expiresAt > Date.now()) return dashboardCache.value;
    if (dashboardRequest) return dashboardRequest;
    dashboardRequest = (async () => {
      const localSource = fixture?.portfolio?.source === "user_screenshot" ? "user_snapshot" : fixture ? "local_file" : "unconfigured";
      const base = { source: token && fixture ? `tushare+${localSource}` : token ? "tushare" : localSource, funds: fixtureCandidates("funds"), market: fixture?.market ?? null, stocks: fixtureCandidates("stocks"), international: fixture?.international ?? null, portfolio: fixture?.portfolio ?? null, sources: [], missing: [] };
      if (!live || token || fixture?.market || fixture?.international || fixtureCandidates("funds").length) { if (token && !base.funds.length) base.funds = await funds(); return base; }
      const [marketResult, internationalResult, fundsResult] = await Promise.allSettled([liveMarket(), liveInternational(), funds()]);
      if (marketResult.status === "fulfilled") { base.market = marketResult.value.snapshot; base.sources.push(...marketResult.value.sources); } else base.missing.push(`domestic_market:${marketResult.reason?.message ?? "unavailable"}`);
      if (internationalResult.status === "fulfilled") { base.international = internationalResult.value; base.sources.push(...internationalResult.value.sources); } else base.missing.push(`international_market:${internationalResult.reason?.message ?? "unavailable"}`);
      if (fundsResult.status === "fulfilled") {
        base.funds = fundsResult.value;
        base.sources.push(...LIVE_SOURCES.filter((source) => source.name.includes("天天")));
        base.sources.push(...Object.values(bondEvidence.funds ?? {}).map((item) => ({ name: `${item.name}定期报告`, url: item.source_url, scope: "基金资产构成、久期与流动性证据" })));
      } else base.missing.push(`funds:${fundsResult.reason?.message ?? "unavailable"}`);
      base.source = base.sources.length ? "live:tencent+eastmoney" : "unconfigured";
      base.sources = [...new Map(base.sources.map((source) => [source.name, source])).values()];
      dashboardCache.value = base; dashboardCache.expiresAt = Date.now() + DASHBOARD_CACHE_MS;
      return base;
    })();
    try {
      return await dashboardRequest;
    } finally {
      dashboardRequest = null;
    }
  }

  function stockSymbol(symbol) {
    const value = String(symbol || '').trim();
    if (/^(sh|sz)\d{6}$/i.test(value)) return value.toLowerCase();
    if (/^6\d{5}$/.test(value)) return `sh${value}`;
    if (/^[03]\d{5}$/.test(value)) return `sz${value}`;
    if (/^us|^hk/i.test(value)) return value;
    return null;
  }

  async function quoteHoldings(holdings = []) {
    if (!live) return [];
    const quotes = [];
    const stockHoldings = holdings.filter((holding) =>
      ['domestic_equity', 'international_equity'].includes(holding.asset_type) && stockSymbol(holding.symbol),
    );
    if (stockHoldings.length) {
      try {
        const symbols = stockHoldings.map((holding) => stockSymbol(holding.symbol)).join(',');
        const parsed = parseTencentQuotes(await requestText(`https://qt.gtimg.cn/q=${symbols}`));
        for (const holding of stockHoldings) {
          const quote = parsed[stockSymbol(holding.symbol)];
          if (Number.isFinite(quote?.price)) quotes.push({ id: holding.id, current_price: quote.price, price_as_of: quote.as_of, source: 'tencent' });
        }
      } catch {
        // Keep manual values when a public quote source is unavailable.
      }
    }
    for (const holding of holdings.filter((item) => item.asset_type === 'fund' && item.symbol)) {
      try {
        const candidate = (await funds([holding.symbol]))[0];
        if (Number.isFinite(candidate?.current_price)) quotes.push({ id: holding.id, current_price: candidate.current_price, price_as_of: candidate.data_as_of ? `${candidate.data_as_of}T00:00:00.000Z` : null, source: 'eastmoney' });
      } catch {
        // Keep manual values when a fund profile is temporarily unavailable.
      }
    }
    const precious = holdings.filter((holding) => holding.asset_type === 'gold' && ['hf_XAU', 'hf_GC'].includes(holding.symbol));
    if (precious.length) {
      try {
        const parsed = parseTencentQuotes(await requestText(`https://qt.gtimg.cn/q=${precious.map((holding) => holding.symbol).join(',')}`));
        for (const holding of precious) {
          const quote = parsed[holding.symbol];
          if (Number.isFinite(quote?.price)) quotes.push({ id: holding.id, current_price: quote.price, price_as_of: quote.as_of, source: 'tencent' });
        }
      } catch {
        // Keep manual values when a precious-metal quote is unavailable.
      }
    }
    const fxHoldings = holdings.filter((holding) => holding.asset_type === 'fx' && /^[A-Z]{3}$/.test(holding.symbol));
    for (const holding of fxHoldings) {
      try {
        const payload = await requestJson(`https://open.er-api.com/v6/latest/${holding.symbol}`);
        const rate = Number(payload?.rates?.CNY);
        if (Number.isFinite(rate)) quotes.push({ id: holding.id, current_price: rate, price_as_of: new Date().toISOString(), source: 'open.er-api' });
      } catch {
        // Keep manual values when the FX source is unavailable.
      }
    }
    return quotes;
  }

  return { async query(dataset, params, fields) { return query(dataset, params, fields); }, async getDashboardSeed() { return getDashboardSeed(); }, async funds(codes = []) { return funds(codes); }, async quoteHoldings(holdings = []) { return quoteHoldings(holdings); } };
}

export { ALLOWED_DATASETS, DEFAULT_FUND_CODES, DOMESTIC_INDEXES, INTERNATIONAL_INDEXES, LIVE_SOURCES, parseTencentQuotes, parseTencentHistory, parseFundProfile };
