import { useCallback, useEffect, useState } from 'react';
import { BarChart3, BookOpen, ChevronRight, Database, ExternalLink, LineChart, LoaderCircle, MessageSquareText, Plus, RefreshCw, ShieldCheck, Trash2, X } from 'lucide-react';
import { api } from './data';
import type { Settings } from './types';
import { investmentDemoDashboard, investmentDemoHoldings, isInvestmentDemo, isInvestmentMobileDemo } from './investment-demo';

type RiskProfile = 'conservative' | 'balanced' | 'growth';
type AssetType =
  | 'domestic_equity'
  | 'international_equity'
  | 'fund'
  | 'gold'
  | 'fx'
  | 'bond'
  | 'cash'
  | 'cash_management'
  | 'other';
type HistorySeries = {
  period: string;
  unit?: string;
  granularity?: string;
  points: number[];
  labels?: string[];
  change_percent?: number | null;
};
type ResearchMetric = {
  label: string;
  value: string;
  detail?: string;
  tone?: 'positive' | 'negative' | 'neutral';
};
type AssetResearch = {
  as_of?: string | null;
  history?: HistorySeries[];
  valuation?: {
    status?: string | null;
    percentile?: number | null;
    metrics?: ResearchMetric[];
    note?: string | null;
  };
  risk?: {
    level?: string | null;
    volatility_1y?: number | null;
    max_drawdown_3y?: number | null;
    sharpe_1y?: number | null;
    beta?: number | null;
    liquidity?: string | null;
    metrics?: ResearchMetric[];
    note?: string | null;
  };
  dividends?: {
    yield_1y?: number | null;
    frequency?: string | null;
    last_amount?: number | null;
    last_date?: string | null;
    next_date?: string | null;
    trailing_3y?: number | null;
    metrics?: ResearchMetric[];
    note?: string | null;
  };
};
type Holding = {
  id: string;
  asset_type: AssetType;
  symbol: string;
  name: string;
  quantity: number;
  cost_basis: number | null;
  current_price: number | null;
  previous_close?: number | null;
  day_gain?: number | null;
  day_gain_percent?: number | null;
  currency: string;
  price_as_of: string | null;
  source: string;
  value: number | null;
  research?: AssetResearch;
};
type ParsedTransaction = {
  name: string;
  symbol: string;
  type: string;
  amount: number | null;
  quantity: number | null;
  confidence: string;
  needs_clarification?: boolean;
  suggestions?: { name: string; symbol: string; asset_type: AssetType; similarity: number }[];
};
type Ranking = {
  code?: string;
  name?: string;
  score?: number | null;
  confidence?: number | null;
  metrics?: Record<string, unknown>;
  band?: string;
  flags?: string[];
  research?: AssetResearch;
};
type RankingKind = 'fund' | 'stock';
type AssetSelection =
  | { kind: 'holding'; item: Holding }
  | { kind: RankingKind; item: Ranking };
type Market = {
  as_of?: string | null;
  regime?: string;
  score?: number | null;
  confidence?: number | null;
  missing?: string[];
  observations?: { benchmark_count?: number };
};
type MarketArea = {
  id: string;
  title: string;
  market: Market;
  quote?: { value?: number | null; unit?: string; change_1d?: number | null } | null;
  source?: string | null;
  status?: string;
};
type Dashboard = {
  generated_at: string;
  source: string;
  data_sources: { name: string; url: string; scope: string }[];
  data_missing: string[];
  risk_profile: RiskProfile;
  funds: { count: number; rankings: Ranking[] };
  market: Market;
  market_areas?: MarketArea[];
  stocks: { count: number; rankings: Ranking[] };
  international: { market: Market; indices: Record<string, unknown>[]; stocks: { count: number; rankings: Ranking[] } };
  portfolio: { summary?: Record<string, unknown>; holdings?: Holding[]; data_as_of?: string | null };
  daily_actions?: { actions?: { title?: string; reason?: string; operation?: string; detail?: string }[] };
};

const assetTypeLabels: Record<AssetType, string> = {
  domestic_equity: '国内股票',
  international_equity: '国际股票',
  fund: '基金',
  gold: '黄金',
  fx: '货币',
  bond: '债券与固收',
  cash: '现金',
  cash_management: '货币基金',
  other: '其他',
};

const views = [
  ['portfolio', '资产总览'],
  ['funds', '基金筛选'],
  ['market', '市场态势'],
  ['stocks', '长期股票'],
  ['international', '国际市场'],
] as const;

const regimeLabel: Record<string, string> = {
  risk_on: '风险偏好',
  neutral: '中性',
  mixed: '分化',
  risk_off: '风险收缩',
  insufficient_data: '数据不足',
};

function percent(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) ? `${value.toFixed(2)}%` : '—';
}

function score(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) ? value.toFixed(1) : '—';
}

function metric(metrics: Record<string, unknown> | undefined, key: string) {
  return metrics && typeof metrics[key] === 'number' ? metrics[key] : null;
}

function money(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value)
    ? value.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    : '—';
}

function holdingGain(holding: Holding) {
  if (holding.current_price === null || holding.cost_basis === null) return null;
  return Number(((holding.current_price - holding.cost_basis) * holding.quantity).toFixed(2));
}

function holdingGainPercent(holding: Holding) {
  if (holding.current_price === null || holding.cost_basis === null || holding.cost_basis <= 0) return null;
  return ((holding.current_price / holding.cost_basis - 1) * 100).toFixed(2);
}

function holdingDayGain(holding: Holding) {
  if (typeof holding.day_gain === 'number') return holding.day_gain;
  if (holding.current_price === null || typeof holding.previous_close !== 'number') return null;
  return Number(((holding.current_price - holding.previous_close) * holding.quantity).toFixed(2));
}

function holdingDayGainPercent(holding: Holding) {
  if (typeof holding.day_gain_percent === 'number') return holding.day_gain_percent;
  if (holding.current_price === null || typeof holding.previous_close !== 'number' || holding.previous_close <= 0) return null;
  return Number(((holding.current_price / holding.previous_close - 1) * 100).toFixed(2));
}

function assetResearchUrl(kind: AssetSelection['kind'], name: string, symbol: string, assetType?: AssetType) {
  const code = symbol.trim();
  if ((kind === 'fund' || assetType === 'fund') && /^\d{6}$/.test(code)) return `https://fund.eastmoney.com/${code}.html`;
  if (/^\d{6}$/.test(code)) {
    const market = /^(5|6)/.test(code) ? 'sh' : /^(0|3)/.test(code) ? 'sz' : /^(4|8)/.test(code) ? 'bj' : '';
    if (market) return `https://quote.eastmoney.com/${market}${code}.html`;
  }
  const query = code || name.trim();
  return query ? `https://so.eastmoney.com/web/s?keyword=${encodeURIComponent(query)}` : null;
}

function dateLabel(value: unknown) {
  if (typeof value !== 'string' || !value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleDateString('zh-CN');
}

function DetailMetricGrid({ metrics }: { metrics: ResearchMetric[] }) {
  if (!metrics.length) return <div className="investment-detail-empty">暂无可用数据，连接数据源后显示。</div>;
  return <div className="investment-research-metrics">{metrics.map((item) => <div key={`${item.label}-${item.value}`}><small>{item.label}</small><strong className={item.tone ? `investment-metric-${item.tone}` : undefined}>{item.value}</strong>{item.detail && <span>{item.detail}</span>}</div>)}</div>;
}

function TrendChart({ name, series }: { name: string; series: HistorySeries | null }) {
  if (!series || series.points.length < 2) return <div className="investment-detail-empty">暂无历史走势，刷新数据源后显示。</div>;
  const points = series.points.filter((point) => Number.isFinite(point));
  if (points.length < 2) return <div className="investment-detail-empty">暂无历史走势，刷新数据源后显示。</div>;
  const width = 560;
  const height = 190;
  const padding = 18;
  const min = Math.min(...points);
  const max = Math.max(...points);
  const span = max - min || Math.max(Math.abs(max) * 0.02, 1);
  const low = min - span * 0.14;
  const high = max + span * 0.14;
  const coordinates = points.map((point, index) => ({
    x: padding + ((width - padding * 2) * index) / Math.max(points.length - 1, 1),
    y: height - padding - ((point - low) / (high - low)) * (height - padding * 2),
  }));
  const linePath = coordinates.map((point, index) => `${index ? 'L' : 'M'} ${point.x.toFixed(2)} ${point.y.toFixed(2)}`).join(' ');
  const first = coordinates[0];
  const last = coordinates.at(-1) as (typeof coordinates)[number];
  const areaPath = `${linePath} L ${last.x.toFixed(2)} ${(height - padding).toFixed(2)} L ${first.x.toFixed(2)} ${(height - padding).toFixed(2)} Z`;
  const labels = series.labels || [];
  const change = series.change_percent;
  return (
    <div className="investment-trend-wrap">
      <div className="investment-trend-meta"><span>{series.unit || '指数化走势'} · {series.granularity === 'day' ? '每日' : series.period}</span><strong className={typeof change === 'number' && change < 0 ? 'investment-metric-negative' : 'investment-metric-positive'}>{typeof change === 'number' ? `${change >= 0 ? '+' : ''}${change.toFixed(2)}%` : '区间涨跌 —'}</strong></div>
      <svg className="investment-trend-chart" viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`${name} ${series.period}历史走势`} preserveAspectRatio="none">
        <line className="investment-trend-gridline" x1={padding} x2={width - padding} y1={height * 0.25} y2={height * 0.25} />
        <line className="investment-trend-gridline" x1={padding} x2={width - padding} y1={height * 0.5} y2={height * 0.5} />
        <line className="investment-trend-gridline" x1={padding} x2={width - padding} y1={height * 0.75} y2={height * 0.75} />
        <path className="investment-trend-area" d={areaPath} />
        <path className="investment-trend-line" d={linePath} />
        <circle className="investment-trend-point" cx={last.x} cy={last.y} r="4" />
      </svg>
      <div className="investment-trend-axis"><span>{labels[0] || series.period}</span><span>{labels[Math.floor(labels.length / 2)] || ''}</span><span>{labels.at(-1) || '最新'}</span></div>
    </div>
  );
}

const allocationColors: Record<AssetType, string> = {
  domestic_equity: '#5b7cfa',
  international_equity: '#8e7dff',
  fund: '#35a88b',
  gold: '#d9a441',
  fx: '#d1779c',
  bond: '#6b9acb',
  cash: '#9b9b9b',
  cash_management: '#53b6c7',
  other: '#b58c6a',
};

function PortfolioOverview({
  summary,
  holdings,
  dataAsOf,
  onCategorySelect,
}: {
  summary?: Record<string, unknown>;
  holdings: Holding[];
  dataAsOf?: string | null;
  onCategorySelect: (assetType: AssetType) => void;
}) {
  const total = summary?.total_capital;
  const cash = summary?.cash_balance;
  const risk = summary?.risk_assets;
  const buckets = (summary?.buckets || {}) as Record<string, number>;
  const categories = Object.entries(assetTypeLabels)
    .map(([type, label]) => ({ type: type as AssetType, label, value: buckets[type] || 0 }))
    .filter((item) => item.value > 0);
  const dayGain = holdings.reduce((total, holding) => total + (holdingDayGain(holding) || 0), 0);
  const allocationTotal = categories.reduce((total, item) => total + item.value, 0);
  const donutRadius = 58;
  const donutCircumference = 2 * Math.PI * donutRadius;
  let donutOffset = 0;
  const donutSegments = categories.map((item) => {
    const length = allocationTotal ? (item.value / allocationTotal) * donutCircumference : 0;
    const segment = { ...item, length, offset: donutOffset };
    donutOffset += length;
    return segment;
  });
  return (
    <section className="investment-overview" aria-label="资产总览">
      <div className="investment-overview-hero">
        <div>
          <span className="investment-eyebrow">我的资产</span>
          <strong>{money(total)} <small>元</small></strong>
          <p>持仓 {holdings.length} 项 · 数据更新于 {dataAsOf ? new Date(dataAsOf).toLocaleString('zh-CN') : '待补充'}</p>
        </div>
        <div className="investment-overview-hero-stats">
          <div><small>现金及固收</small><b>{money(cash)}</b></div>
          <div><small>风险资产</small><b>{money(risk)}</b></div>
          <div><small>今日相对昨日</small><b className={dayGain >= 0 ? 'investment-gain-positive' : 'investment-gain-negative'}>{dayGain >= 0 ? '+' : ''}{money(dayGain)} 元</b></div>
        </div>
      </div>
      <div className="investment-allocation">
        <div className="investment-donut" role="img" aria-label="持仓比例环形图">
          <svg className="investment-donut-svg" viewBox="0 0 160 160" aria-hidden="true">
            <circle className="investment-donut-track" cx="80" cy="80" r={donutRadius} />
            {donutSegments.map((segment) => <circle className="investment-donut-segment" key={segment.type} cx="80" cy="80" r={donutRadius} stroke={allocationColors[segment.type]} strokeDasharray={`${Math.max(0, segment.length - 2)} ${donutCircumference}`} strokeDashoffset={-segment.offset} />)}
          </svg>
          <div className="investment-donut-center"><strong>{money(total)}</strong><span>总资产</span></div>
        </div>
        <div className="investment-allocation-legend">
          {categories.length ? categories.map((item) => (
            <button type="button" key={item.type} className="investment-allocation-item" onClick={() => onCategorySelect(item.type)}>
              <span><i style={{ background: allocationColors[item.type] }} />{item.label}</span><div className="investment-allocation-values"><strong>{money(item.value)} 元</strong><small>{allocationTotal ? ((item.value / allocationTotal) * 100).toFixed(1) : '0.0'}%</small></div><ChevronRight size={14} />
            </button>
          )) : <div className="investment-overview-empty">添加持仓后，这里会显示资产分类和收益分布。</div>}
        </div>
      </div>
    </section>
  );
}

function CategoryDetail({ assetType, holdings, onClose, onSelectHolding }: { assetType: AssetType; holdings: Holding[]; onClose: () => void; onSelectHolding: (holding: Holding) => void }) {
  const matching = holdings.filter((holding) => holding.asset_type === assetType);
  const total = matching.reduce((sum, holding) => sum + (holding.value || 0), 0);
  const dayGain = matching.reduce((sum, holding) => sum + (holdingDayGain(holding) || 0), 0);
  return (
    <section className="investment-card investment-category-detail" aria-label={`${assetTypeLabels[assetType]}详情`}>
      <div className="investment-card-heading">
        <div><span className="investment-eyebrow">分类详情</span><h2>{assetTypeLabels[assetType]}</h2></div>
        <button className="icon-button" type="button" aria-label="关闭分类详情" onClick={onClose}><X size={17} /></button>
      </div>
      <div className="investment-category-summary"><span>合计市值 <b>{money(total)} 元</b></span><span className={dayGain >= 0 ? 'investment-gain-positive' : 'investment-gain-negative'}>今日相对昨日 <b>{dayGain >= 0 ? '+' : ''}{money(dayGain)} 元</b></span></div>
      <div className="investment-holding-list">
        {matching.map((holding) => <button className="investment-holding-row investment-holding-row-button" type="button" key={holding.id} onClick={() => onSelectHolding(holding)}><div className="investment-holding-main"><strong>{holding.name}</strong><small>{holding.symbol || '无代码'} · 份额 {holding.quantity}</small><small>成本 {money(holding.cost_basis)} · 现价 {money(holding.current_price)} · 来源 {holding.source}</small></div><div className="investment-holding-value"><strong>{money(holding.value)} {holding.currency}</strong><small className={(holdingDayGain(holding) || 0) >= 0 ? 'investment-gain-positive' : 'investment-gain-negative'}>昨日比较 {(holdingDayGain(holding) || 0) >= 0 ? '+' : ''}{money(holdingDayGain(holding))} ({holdingDayGainPercent(holding) ?? '—'}%)</small></div><ChevronRight size={16} aria-hidden="true" /></button>)}
      </div>
    </section>
  );
}

function AssetDetailPanel({ selection, holdings, onClose }: { selection: AssetSelection; holdings: Holding[]; onClose: () => void }) {
  const isHolding = selection.kind === 'holding';
  const holding = isHolding ? selection.item : null;
  const ranking = isHolding ? null : selection.item;
  const name = holding?.name || ranking?.name || ranking?.code || '未命名标的';
  const symbol = holding?.symbol || ranking?.code || '';
  const assetType = holding?.asset_type || (selection.kind === 'fund' ? 'fund' : 'domestic_equity');
  const research = holding?.research || ranking?.research || {};
  const history = research.history || [];
  const defaultHistoryPeriod = history.find((item) => item.period === '1Y')?.period || history[0]?.period || '1Y';
  const [historyPeriod, setHistoryPeriod] = useState(defaultHistoryPeriod);
  useEffect(() => { setHistoryPeriod(defaultHistoryPeriod); }, [defaultHistoryPeriod, name, symbol]);
  const historySeries = history.find((item) => item.period === historyPeriod) || history[0] || null;
  const valuation = research.valuation;
  const valuationMetrics = [...(valuation?.metrics || [])];
  const hasValuationPercentile = valuationMetrics.some((item) => item.label.includes('分位'));
  if (typeof valuation?.percentile === 'number' && !hasValuationPercentile) valuationMetrics.unshift({ label: '估值分位', value: `${valuation.percentile.toFixed(0)}%`, detail: '历史区间' });
  const risk = research.risk;
  const riskMetrics: ResearchMetric[] = [];
  if (typeof risk?.volatility_1y === 'number') riskMetrics.push({ label: '近 1 年波动', value: percent(risk.volatility_1y) });
  const maxDrawdown = typeof risk?.max_drawdown_3y === 'number' ? risk.max_drawdown_3y : metric(ranking?.metrics, 'max_drawdown_3y');
  if (typeof maxDrawdown === 'number') riskMetrics.push({ label: '近 3 年最大回撤', value: percent(maxDrawdown), tone: 'negative' });
  if (typeof risk?.sharpe_1y === 'number') riskMetrics.push({ label: '近 1 年夏普', value: risk.sharpe_1y.toFixed(2) });
  if (typeof risk?.beta === 'number') riskMetrics.push({ label: 'Beta', value: risk.beta.toFixed(2) });
  if (risk?.liquidity) riskMetrics.push({ label: '流动性', value: risk.liquidity });
  riskMetrics.push(...(risk?.metrics || []));
  const dividends = research.dividends;
  const dividendMetrics: ResearchMetric[] = [];
  if (typeof dividends?.yield_1y === 'number') dividendMetrics.push({ label: '近 1 年分红率', value: percent(dividends.yield_1y), tone: dividends.yield_1y > 0 ? 'positive' : 'neutral' });
  if (dividends?.frequency) dividendMetrics.push({ label: '分配频率', value: dividends.frequency });
  if (typeof dividends?.last_amount === 'number') dividendMetrics.push({ label: '最近每份分配', value: money(dividends.last_amount) });
  if (dividends?.last_date) dividendMetrics.push({ label: '最近登记日', value: dateLabel(dividends.last_date) });
  if (dividends?.next_date) dividendMetrics.push({ label: '下次观察日', value: dateLabel(dividends.next_date) });
  if (typeof dividends?.trailing_3y === 'number') dividendMetrics.push({ label: '近 3 年累计分配', value: money(dividends.trailing_3y) });
  dividendMetrics.push(...(dividends?.metrics || []));
  const value = holding?.value ?? null;
  const dayGain = holding ? holdingDayGain(holding) : null;
  const dayGainPercent = holding ? holdingDayGainPercent(holding) : null;
  const totalGain = holding ? holdingGain(holding) : null;
  const totalGainPercent = holding ? holdingGainPercent(holding) : null;
  const total = holdings.reduce((sum, item) => sum + (item.value || 0), 0);
  const source = holding?.source || '当前研究快照';
  const asOf = holding?.price_as_of || research.as_of || null;
  const url = assetResearchUrl(selection.kind, name, symbol, holding?.asset_type);
  const details = holding
    ? [
        ['市值', value === null ? '待补价格' : `${money(value)} ${holding.currency}`],
        ['今日相对昨日', dayGain === null ? '待补充' : `${dayGain >= 0 ? '+' : ''}${money(dayGain)} (${dayGainPercent ?? '—'}%)`],
        ['累计盈亏', totalGain === null ? '待补充' : `${totalGain >= 0 ? '+' : ''}${money(totalGain)} (${totalGainPercent ?? '—'}%)`],
        ['组合占比', total > 0 && value !== null ? `${((value / total) * 100).toFixed(1)}%` : '—'],
        ['数量', String(holding.quantity)],
        ['成本价 / 现价', `${money(holding.cost_basis)} / ${money(holding.current_price)}`],
      ]
    : [
        ['研究评分', score(ranking?.score)],
        ['近 3 年年化', percent(metric(ranking?.metrics, 'annualized_return_3y'))],
        ['近 3 年最大回撤', percent(metric(ranking?.metrics, 'max_drawdown_3y'))],
        ['研究区间', ranking?.band || '—'],
        ['置信度', ranking?.confidence === undefined ? '—' : percent((ranking.confidence || 0) * 100)],
        ['标的类型', assetTypeLabels[assetType] || '股票'],
      ];
  return (
    <section className="investment-card investment-asset-detail" aria-label={`${name}详情`}>
      <div className="investment-card-heading">
        <div><span className="investment-eyebrow">{isHolding ? '持仓详情' : '研究详情'}</span><h2>{name}</h2><p className="investment-detail-symbol">{assetTypeLabels[assetType] || '股票'} · {symbol || '无代码'}</p></div>
        <button className="icon-button" type="button" aria-label="关闭资产详情" onClick={onClose}><X size={17} /></button>
      </div>
      <div className="investment-detail-grid">{details.map(([label, content]) => <div key={label}><small>{label}</small><strong>{content}</strong></div>)}</div>
      <div className="investment-research-windows">
        <section className="investment-detail-window investment-detail-window-wide" aria-label="历史走势">
          <div className="investment-detail-window-heading"><div><span className="investment-eyebrow">历史走势</span><h3>{historySeries ? `${historySeries.period}走势` : '历史走势'}</h3></div>{history.length > 0 && <div className="investment-period-tabs" role="tablist" aria-label="历史走势区间">{history.map((item) => <button type="button" role="tab" aria-selected={item.period === historyPeriod} className={item.period === historyPeriod ? 'active' : ''} key={item.period} onClick={() => setHistoryPeriod(item.period)}>{item.period}</button>)}</div>}</div>
          <TrendChart name={name} series={historySeries} />
        </section>
        <section className="investment-detail-window" aria-label="估值信息">
          <div className="investment-detail-window-heading"><div><span className="investment-eyebrow">估值</span><h3>估值水平</h3></div><span className="investment-detail-status">{valuation?.status || '待同步'}</span></div>
          <DetailMetricGrid metrics={valuationMetrics} />
          {valuation?.note && <p className="investment-detail-note">{valuation.note}</p>}
        </section>
        <section className="investment-detail-window" aria-label="风险信息">
          <div className="investment-detail-window-heading"><div><span className="investment-eyebrow">风险</span><h3>风险画像</h3></div><span className="investment-detail-status">{risk?.level || '待同步'}</span></div>
          <DetailMetricGrid metrics={riskMetrics} />
          {risk?.note && <p className="investment-detail-note">{risk.note}</p>}
        </section>
        <section className="investment-detail-window" aria-label="分红信息">
          <div className="investment-detail-window-heading"><div><span className="investment-eyebrow">分红</span><h3>分红与收益分配</h3></div><span className="investment-detail-status">{dividends?.frequency || '待同步'}</span></div>
          <DetailMetricGrid metrics={dividendMetrics} />
          {dividends?.note && <p className="investment-detail-note">{dividends.note}</p>}
        </section>
      </div>
      <div className="investment-detail-footer"><span>数据来源：{source}{asOf ? ` · ${new Date(asOf).toLocaleString('zh-CN')}` : ''}</span>{url && <a className="secondary investment-detail-link" href={url} target="_blank" rel="noreferrer"><ExternalLink size={14} />查看公开资料</a>}</div>
      <p className="investment-muted">走势、估值、风险和分红信息用于研究参考，公开网页用于补充资料，净值和成交状态以对应官方披露或交易所数据为准。</p>
    </section>
  );
}

function TransactionAssistant({ settings, onChanged, demo = false }: { settings: Settings; onChanged: () => void; demo?: boolean }) {
  const [text, setText] = useState('');
  const [otherText, setOtherText] = useState('');
  const [draft, setDraft] = useState<{ id: string; parsed: ParsedTransaction; rawText: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function previewText(value: string) {
    setBusy(true); setError('');
    try {
      const result = await api<{ transaction: { id: string }; parsed: ParsedTransaction }>(settings, '/investment/transactions/preview', { text: value });
      setText(value);
      setDraft({ id: result.transaction.id, parsed: result.parsed, rawText: value });
    } catch (cause) { setError((cause as Error).message); }
    finally { setBusy(false); }
  }
  async function preview(event: React.FormEvent) {
    event.preventDefault();
    await previewText(text);
  }
  async function chooseSuggestion(candidate: NonNullable<ParsedTransaction['suggestions']>[number]) {
    if (!draft) return;
    await previewText(`${draft.rawText}，标的为${candidate.name}（${candidate.symbol}）`);
  }
  async function useOther(event: React.FormEvent) {
    event.preventDefault();
    if (!draft || !otherText.trim()) return;
    await previewText(`${draft.rawText}，标的为${otherText.trim()}`);
    setOtherText('');
  }
  async function commit() {
    if (!draft) return;
    setBusy(true); setError('');
    try { await api(settings, `/investment/transactions/${draft.id}/commit`, {}, 'POST'); setText(''); setDraft(null); onChanged(); }
    catch (cause) { setError((cause as Error).message); }
    finally { setBusy(false); }
  }
  const demoText = '我买了 2 份黄金ETF，代码 518880，金额 1000 元';
  return (
    <section className="investment-card investment-transaction-assistant">
      <div className="investment-card-heading"><div><span className="investment-eyebrow">自然语言记账</span><h2>告诉 AI 你买了什么</h2></div><MessageSquareText size={20} /></div>
      <form onSubmit={preview} className="investment-transaction-form">
        <input value={demo ? demoText : text} onChange={(event) => setText(event.target.value)} placeholder="例如：我买了 1000 元招商中证白酒基金" required disabled={demo} />
        <button className="primary" disabled={busy || demo}><MessageSquareText size={15} />{demo ? '演示预览' : '解析'}</button>
      </form>
      {(draft || demo) && <div className="investment-transaction-preview"><div><strong>{demo ? '黄金ETF · 518880' : (draft?.parsed.name || '待补充名称')}</strong><small>{demo ? '买入/申购 · 1,000 元 · 2 份 · 演示草稿' : `${draft?.parsed.symbol || '未识别代码'} · ${draft?.parsed.type === 'sell' ? '卖出/赎回' : '买入/申购'} · ${draft?.parsed.amount ?? '—'} 元 · ${draft?.parsed.quantity ?? '待确认'} 份`}</small></div><button className="secondary" type="button" onClick={() => void commit()} disabled={busy || demo}>{demo ? '演示模式不写入' : '确认记账'}</button></div>}
      {!demo && draft?.parsed.needs_clarification && <div className="investment-transaction-choices"><p>标的名称不够明确，请选择最接近的候选：</p><div className="investment-choice-buttons">{(draft.parsed.suggestions || []).map((candidate) => <button type="button" className="secondary" key={candidate.symbol} onClick={() => void chooseSuggestion(candidate)} disabled={busy}><span>{candidate.name}</span><small>{candidate.symbol} · 相似度 {Math.round(candidate.similarity * 100)}%</small></button>)}</div><form className="investment-other-choice" onSubmit={useOther}><input value={otherText} onChange={(event) => setOtherText(event.target.value)} placeholder="其他答案：输入基金/股票名称或代码" /><button className="secondary" type="submit" disabled={busy || !otherText.trim()}>使用填写内容</button></form></div>}
      {error && <p className="error investment-error" role="alert">{error}</p>}
      <p className="investment-muted">{demo ? '演示数据不会写入真实账号，刷新页面即可恢复。' : '这里只更新持仓账本，真实买入和卖出需要单独确认。'}</p>
    </section>
  );
}

function MarketCard({ title, market }: { title: string; market: Market }) {
  return (
    <article className="investment-card investment-market-card">
      <div className="investment-card-heading">
        <div>
          <span className="investment-eyebrow">市场态势</span>
          <h2>{title}</h2>
        </div>
        <span className="investment-regime">{regimeLabel[market.regime || ''] || '待分析'}</span>
      </div>
      <div className="investment-stat-grid">
        <div><small>综合分数</small><strong>{score(market.score)}</strong></div>
        <div><small>置信度</small><strong>{percent(typeof market.confidence === 'number' ? market.confidence * 100 : null)}</strong></div>
        <div><small>基准数量</small><strong>{market.observations?.benchmark_count ?? '—'}</strong></div>
        <div><small>数据日期</small><strong>{market.as_of || '—'}</strong></div>
      </div>
      {!!market.missing?.length && <p className="investment-muted">缺少字段：{market.missing.join('、')}</p>}
    </article>
  );
}

function MarketAreaCard({ area }: { area: MarketArea }) {
  const ready = area.status === 'ready';
  return (
    <article className="investment-card investment-market-area-card">
      <div className="investment-card-heading">
        <div><span className="investment-eyebrow">领域态势</span><h2>{area.title}</h2></div>
        <span className="investment-regime">{regimeLabel[area.market.regime || ''] || (ready ? '已更新' : '待数据')}</span>
      </div>
      <div className="investment-stat-grid">
        <div><small>综合分数</small><strong>{score(area.market.score)}</strong></div>
        <div><small>置信度</small><strong>{percent(typeof area.market.confidence === 'number' ? area.market.confidence * 100 : null)}</strong></div>
        <div><small>领域报价</small><strong>{area.quote?.value === null || area.quote?.value === undefined ? '—' : `${money(area.quote.value)}${area.quote.unit ? ` ${area.quote.unit}` : ''}`}</strong></div>
        <div><small>数据日期</small><strong>{area.market.as_of || '—'}</strong></div>
      </div>
      <p className="investment-market-area-foot">{area.quote?.change_1d === null || area.quote?.change_1d === undefined ? '相对昨日暂无报价变化' : `相对昨日 ${area.quote.change_1d >= 0 ? '+' : ''}${area.quote.change_1d.toFixed(2)}%`} · {area.source || (ready ? '公开市场数据' : '等待数据源')}</p>
    </article>
  );
}

function HoldingsPanel({
  settings,
  holdings,
  onChanged,
  onSelectHolding,
  demo = false,
}: {
  settings: Settings;
  holdings: Holding[];
  onChanged: () => void;
  onSelectHolding: (holding: Holding) => void;
  demo?: boolean;
}) {
  const [assetType, setAssetType] = useState<AssetType>('fund');
  const [name, setName] = useState('');
  const [symbol, setSymbol] = useState('');
  const [quantity, setQuantity] = useState('');
  const [currentPrice, setCurrentPrice] = useState('');
  const [costBasis, setCostBasis] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const add = async (event: React.FormEvent) => {
    event.preventDefault();
    if (demo) return;
    setBusy(true);
    setError('');
    try {
      await api(settings, '/investment/holdings', {
        asset_type: assetType,
        name: name.trim(),
        symbol: symbol.trim(),
        quantity: Number(quantity),
        current_price: currentPrice.trim() ? Number(currentPrice) : null,
        cost_basis: costBasis.trim() ? Number(costBasis) : null,
        currency: 'CNY',
        price_as_of: currentPrice.trim() ? new Date().toISOString() : null,
        source: 'manual',
      });
      setName('');
      setSymbol('');
      setQuantity('');
      setCurrentPrice('');
      setCostBasis('');
      onChanged();
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const remove = async (id: string) => {
    if (demo) return;
    setBusy(true);
    setError('');
    try {
      await api(settings, `/investment/holdings/${id}`, undefined, 'DELETE');
      onChanged();
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const refresh = async () => {
    if (demo) return;
    setBusy(true);
    setError('');
    try {
      await api(settings, '/investment/holdings/refresh', {}, 'POST');
      onChanged();
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <section className="investment-card investment-holdings-card">
        <div className="investment-card-heading">
          <div><span className="investment-eyebrow">{demo ? '演示数据' : '账户数据'}</span><h2>{demo ? '演示持仓' : '真实持仓'}</h2></div>
          <div className="investment-holding-actions"><button className="secondary" type="button" onClick={() => void refresh()} disabled={busy}><RefreshCw size={14} className={busy ? 'spin' : ''} />{demo ? '重新展示' : '刷新行情'}</button><BookOpen size={20} /></div>
        </div>
        <p className="investment-muted">{demo ? '这是完整合成数据，用于展示桌面端和手机端布局，不会写入真实账号。' : '只保存到当前账号，用于组合分析和推荐。不会自动读取邮箱、文件或第三方账户。'}</p>
        <form className="investment-holding-form" onSubmit={add}>
          <label>资产类别<select value={assetType} onChange={(event) => setAssetType(event.target.value as AssetType)} disabled={demo}>{Object.entries(assetTypeLabels).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></label>
          <label>名称<input value={demo ? '演示持仓仅供查看' : name} onChange={(event) => setName(event.target.value)} placeholder="例如：沪深300ETF" required disabled={demo} /></label>
          <label>代码或符号<input value={demo ? '—' : symbol} onChange={(event) => setSymbol(event.target.value)} placeholder="可选" disabled={demo} /></label>
          <label>数量<input value={demo ? '—' : quantity} onChange={(event) => setQuantity(event.target.value)} inputMode="decimal" type="number" min="0" step="any" required disabled={demo} /></label>
          <label>当前价格<input value={demo ? '—' : currentPrice} onChange={(event) => setCurrentPrice(event.target.value)} inputMode="decimal" type="number" min="0" step="any" placeholder="可选" disabled={demo} /></label>
          <label>成本价<input value={demo ? '—' : costBasis} onChange={(event) => setCostBasis(event.target.value)} inputMode="decimal" type="number" min="0" step="any" placeholder="可选" disabled={demo} /></label>
          <button className="primary investment-add-holding" disabled={busy || demo}><Plus size={15} />{demo ? '演示模式不可写入' : '添加持仓'}</button>
        </form>
        {error && <p className="error investment-error" role="alert">{error}</p>}
        {holdings.length ? <div className="investment-holding-list">{holdings.map((holding) => {
          const gain = holdingGain(holding);
          const gainPercent = holdingGainPercent(holding);
          return <div className="investment-holding-row investment-holding-row-button" role="button" tabIndex={0} key={holding.id} onClick={() => onSelectHolding(holding)} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onSelectHolding(holding); } }}>
            <div className="investment-holding-main"><strong>{holding.name}</strong><small>{assetTypeLabels[holding.asset_type]} · {holding.symbol || '无代码'} · 份额 {holding.quantity}</small><small>成本 {money(holding.cost_basis)} · 现价 {money(holding.current_price)} · {holding.currency}</small><small>来源 {holding.source} · 数据 {holding.price_as_of ? new Date(holding.price_as_of).toLocaleString('zh-CN') : '待补充'}</small></div>
            <div className="investment-holding-value"><strong>{holding.value === null ? '待补价格' : `${money(holding.value)} ${holding.currency}`}</strong><small className={gain !== null && gain >= 0 ? 'investment-gain-positive' : 'investment-gain-negative'}>{gain === null ? '盈亏待补充' : `盈亏 ${gain >= 0 ? '+' : ''}${money(gain)} (${gainPercent}%)`}</small></div>
            {!demo && <button className="icon-button" type="button" aria-label={`删除${holding.name}`} onClick={(event) => { event.stopPropagation(); void remove(holding.id); }} disabled={busy}><Trash2 size={15} /></button>}
          </div>;
        })}</div> : <div className="investment-empty investment-portfolio-empty"><p>还没有保存的持仓。</p><small>添加股票、基金、黄金、货币、债券或现金后，系统才会生成组合级操作建议。</small></div>}
      </section>
    </>
  );
}

function RankingList({ items, kind, onSelectItem }: { items: Ranking[]; kind: RankingKind; onSelectItem: (item: Ranking) => void }) {
  if (!items.length) return <p className="investment-empty">当前没有可用候选。请刷新或配置更完整的数据源。</p>;
  return (
    <div className="investment-ranking-list">
      {items.slice(0, 12).map((item, index) => (
        <article className="investment-ranking investment-ranking-button" role="button" tabIndex={0} key={`${item.code || item.name || 'item'}-${index}`} onClick={() => onSelectItem(item)} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onSelectItem(item); } }}>
          <div className="investment-ranking-main">
            <span className="investment-rank">{String(index + 1).padStart(2, '0')}</span>
            <div>
              <strong>{item.name || item.code || '未命名标的'}</strong>
              <small>{item.code || item.band || (kind === 'fund' ? '基金候选' : '股票候选')}</small>
            </div>
          </div>
          <div className="investment-ranking-metrics">
            <span>评分 <b>{score(item.score)}</b></span>
            {kind === 'fund' && <span>近3年 <b>{percent(metric(item.metrics, 'annualized_return_3y'))}</b></span>}
            {kind === 'fund' && <span>回撤 <b>{percent(metric(item.metrics, 'max_drawdown_3y'))}</b></span>}
            {kind === 'stock' && <span>{item.band || '研究区间'}</span>}
          </div>
        </article>
      ))}
    </div>
  );
}

export function InvestmentPage({ settings }: { settings: Settings }) {
  const demoMode = isInvestmentDemo();
  const mobileDemoMode = isInvestmentMobileDemo();
  const [view, setView] = useState<(typeof views)[number][0]>('portfolio');
  const [selectedAssetType, setSelectedAssetType] = useState<AssetType | null>(null);
  const [selectedAsset, setSelectedAsset] = useState<AssetSelection | null>(null);
  const [riskProfile, setRiskProfile] = useState<RiskProfile>('balanced');
  const [dashboard, setDashboard] = useState<Dashboard | null>(null);
  const [holdings, setHoldings] = useState<Holding[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const load = useCallback(async () => {
    setBusy(true);
    setError('');
    if (demoMode) {
      setDashboard({ ...investmentDemoDashboard, risk_profile: riskProfile } as Dashboard);
      setHoldings(investmentDemoHoldings as Holding[]);
      setBusy(false);
      return;
    }
    try {
      const [result, account] = await Promise.all([
        api<Dashboard>(settings, `/investment/dashboard?risk_profile=${riskProfile}`),
        api<{ holdings: Holding[] }>(settings, '/investment/holdings'),
      ]);
      setDashboard(result);
      setHoldings(account.holdings);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }, [demoMode, riskProfile, settings]);
  useEffect(() => { void load(); }, [load]);
  return (
    <section className={`investment-page${mobileDemoMode ? ' investment-demo-mobile' : ''}`} aria-label="投资研究">
      <header className="investment-heading">
        <div className="investment-title">
          <span className="investment-icon"><LineChart size={22} /></span>
          <div><span className="investment-eyebrow">独立研究插件</span><h1>投资研究</h1><p>基金、市场、股票和组合使用同一套可追溯数据与评分方法。</p></div>
        </div>
        <div className="investment-actions">
          <label>风险偏好<select value={riskProfile} onChange={(e) => setRiskProfile(e.target.value as RiskProfile)}><option value="conservative">保守</option><option value="balanced">均衡</option><option value="growth">成长</option></select></label>
          <button className="secondary" onClick={() => void load()} disabled={busy}><RefreshCw size={15} className={busy ? 'spin' : ''} />刷新</button>
        </div>
      </header>
      <nav className="investment-tabs" aria-label="投资研究视图">
        {views.map(([id, label]) => <button key={id} className={view === id ? 'active' : ''} onClick={() => { setView(id); setSelectedAsset(null); setSelectedAssetType(null); }}>{label}</button>)}
      </nav>
      {demoMode && <div className="investment-demo-banner" role="status"><strong>演示数据</strong><span>完整合成持仓与行情，仅用于展示，不会读取或写入真实账号。</span><code>?demo=investment</code></div>}
      {error && <p className="error investment-error" role="alert">{error}</p>}
      {busy && !dashboard ? <div className="investment-loading"><LoaderCircle className="spin" /><span>正在读取公开市场数据…</span></div> : dashboard && (
        <div className="investment-content">
          {selectedAsset && <AssetDetailPanel selection={selectedAsset} holdings={holdings} onClose={() => setSelectedAsset(null)} />}
          {view === 'funds' && <><div className="investment-summary-grid"><div className="investment-summary"><small>候选基金</small><strong>{dashboard.funds.count}</strong></div><div className="investment-summary"><small>数据源</small><strong>{dashboard.source === 'live:tencent+eastmoney' ? '实时公开' : dashboard.source}</strong></div><div className="investment-summary"><small>生成时间</small><strong>{new Date(dashboard.generated_at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}</strong></div></div><section className="investment-card"><div className="investment-card-heading"><div><span className="investment-eyebrow">研究排序</span><h2>基金筛选</h2></div><BarChart3 size={20} /></div><RankingList items={dashboard.funds.rankings} kind="fund" onSelectItem={(item) => setSelectedAsset({ kind: 'fund', item })} /></section></>}
          {view === 'market' && <div className="investment-market-grid investment-market-area-grid">{(dashboard.market_areas || [{ id: 'domestic_equity', title: '国内权益', market: dashboard.market }, { id: 'international_equity', title: '海外权益', market: dashboard.international.market }]).map((area) => <MarketAreaCard key={area.id} area={area} />)}</div>}
          {view === 'stocks' && <section className="investment-card"><div className="investment-card-heading"><div><span className="investment-eyebrow">长期研究</span><h2>股票候选</h2></div><ShieldCheck size={20} /></div><RankingList items={dashboard.stocks.rankings} kind="stock" onSelectItem={(item) => setSelectedAsset({ kind: 'stock', item })} /></section>}
          {view === 'international' && <><MarketCard title="国际市场" market={dashboard.international.market} /><section className="investment-card"><div className="investment-card-heading"><div><span className="investment-eyebrow">指数观察</span><h2>国际指数</h2></div><Database size={20} /></div><div className="investment-index-grid">{dashboard.international.indices.map((item, index) => <div key={`${String(item.code || item.symbol || 'index')}-${index}`}><strong>{String(item.name || item.code || '指数')}</strong><span>{percent(item.change_1d)}</span><small>{String(item.region || item.currency || '')}</small></div>)}</div></section></>}
          {view === 'portfolio' && <><PortfolioOverview summary={dashboard.portfolio.summary} holdings={holdings} dataAsOf={dashboard.portfolio.data_as_of} onCategorySelect={setSelectedAssetType} />{selectedAssetType && <CategoryDetail assetType={selectedAssetType} holdings={holdings} onClose={() => setSelectedAssetType(null)} onSelectHolding={(holding) => setSelectedAsset({ kind: 'holding', item: holding })} />}<TransactionAssistant settings={settings} demo={demoMode} onChanged={() => void load()} /><HoldingsPanel settings={settings} demo={demoMode} holdings={holdings} onChanged={() => void load()} onSelectHolding={(holding) => setSelectedAsset({ kind: 'holding', item: holding })} />{dashboard.daily_actions?.actions?.length ? <section className="investment-card investment-actions-card"><div className="investment-card-heading"><div><span className="investment-eyebrow">AI 建议</span><h2>研究建议</h2></div><ShieldCheck size={20} /></div><div className="investment-action-list">{dashboard.daily_actions.actions.map((item, index) => <article key={`${item.title || item.operation}-${index}`}><strong>{item.title || item.operation || '研究动作'}</strong><p>{item.reason || item.detail || '请查看依据后决定是否执行。'}</p></article>)}</div></section> : null}</>}
          <footer className="investment-footer"><span>数据日期：中国 {dashboard.market.as_of || '—'} · 国际 {dashboard.international.market.as_of || '—'}</span><span>{dashboard.data_sources.length} 个来源</span></footer>
        </div>
      )}
    </section>
  );
}
