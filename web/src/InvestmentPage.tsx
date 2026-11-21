import { useCallback, useEffect, useState } from 'react';
import { BarChart3, BookOpen, ChevronRight, Database, LineChart, LoaderCircle, MessageSquareText, Plus, RefreshCw, ShieldCheck, Trash2 } from 'lucide-react';
import { api } from './data';
import type { Settings } from './types';

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
type Holding = {
  id: string;
  asset_type: AssetType;
  symbol: string;
  name: string;
  quantity: number;
  cost_basis: number | null;
  current_price: number | null;
  currency: string;
  price_as_of: string | null;
  source: string;
  value: number | null;
};
type ParsedTransaction = {
  name: string;
  symbol: string;
  type: string;
  amount: number | null;
  quantity: number | null;
  confidence: string;
};
type Ranking = {
  code?: string;
  name?: string;
  score?: number | null;
  confidence?: number | null;
  metrics?: Record<string, unknown>;
  band?: string;
  flags?: string[];
};
type Market = {
  as_of?: string | null;
  regime?: string;
  score?: number | null;
  confidence?: number | null;
  missing?: string[];
  observations?: { benchmark_count?: number };
};
type Dashboard = {
  generated_at: string;
  source: string;
  data_sources: { name: string; url: string; scope: string }[];
  data_missing: string[];
  risk_profile: RiskProfile;
  funds: { count: number; rankings: Ranking[] };
  market: Market;
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

function PortfolioOverview({
  summary,
  holdings,
  dataAsOf,
}: {
  summary?: Record<string, unknown>;
  holdings: Holding[];
  dataAsOf?: string | null;
}) {
  const total = summary?.total_capital;
  const cash = summary?.cash_balance;
  const risk = summary?.risk_assets;
  const buckets = (summary?.buckets || {}) as Record<string, number>;
  const categories = Object.entries(assetTypeLabels)
    .map(([type, label]) => ({ type: type as AssetType, label, value: buckets[type] || 0 }))
    .filter((item) => item.value > 0);
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
        </div>
      </div>
      <div className="investment-overview-buckets">
        {categories.length ? categories.map((item) => (
          <button type="button" key={item.type} className="investment-bucket">
            <span>{item.label}</span><strong>{money(item.value)}</strong><ChevronRight size={15} />
          </button>
        )) : <div className="investment-overview-empty">添加持仓后，这里会显示资产分类和收益分布。</div>}
      </div>
    </section>
  );
}

function TransactionAssistant({ settings, onChanged }: { settings: Settings; onChanged: () => void }) {
  const [text, setText] = useState('');
  const [draft, setDraft] = useState<{ id: string; parsed: ParsedTransaction } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function preview(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true); setError('');
    try {
      const result = await api<{ transaction: { id: string }; parsed: ParsedTransaction }>(settings, '/investment/transactions/preview', { text });
      setDraft({ id: result.transaction.id, parsed: result.parsed });
    } catch (cause) { setError((cause as Error).message); }
    finally { setBusy(false); }
  }
  async function commit() {
    if (!draft) return;
    setBusy(true); setError('');
    try { await api(settings, `/investment/transactions/${draft.id}/commit`, {}, 'POST'); setText(''); setDraft(null); onChanged(); }
    catch (cause) { setError((cause as Error).message); }
    finally { setBusy(false); }
  }
  return (
    <section className="investment-card investment-transaction-assistant">
      <div className="investment-card-heading"><div><span className="investment-eyebrow">自然语言记账</span><h2>告诉 AI 你买了什么</h2></div><MessageSquareText size={20} /></div>
      <form onSubmit={preview} className="investment-transaction-form">
        <input value={text} onChange={(event) => setText(event.target.value)} placeholder="例如：我买了 1000 元招商中证白酒基金" required />
        <button className="primary" disabled={busy}><MessageSquareText size={15} />解析</button>
      </form>
      {draft && <div className="investment-transaction-preview"><div><strong>{draft.parsed.name || '待补充名称'}</strong><small>{draft.parsed.symbol || '未识别代码'} · {draft.parsed.type === 'sell' ? '卖出/赎回' : '买入/申购'} · {draft.parsed.amount ?? '—'} 元 · {draft.parsed.quantity ?? '待确认'} 份</small></div><button className="secondary" type="button" onClick={() => void commit()} disabled={busy}>确认记账</button></div>}
      {error && <p className="error investment-error" role="alert">{error}</p>}
      <p className="investment-muted">这里只更新持仓账本，真实买入和卖出需要单独确认。</p>
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

function HoldingsPanel({
  settings,
  holdings,
  onChanged,
}: {
  settings: Settings;
  holdings: Holding[];
  onChanged: () => void;
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
          <div><span className="investment-eyebrow">账户数据</span><h2>真实持仓</h2></div>
          <div className="investment-holding-actions"><button className="secondary" type="button" onClick={() => void refresh()} disabled={busy}><RefreshCw size={14} className={busy ? 'spin' : ''} />刷新行情</button><BookOpen size={20} /></div>
        </div>
        <p className="investment-muted">只保存到当前账号，用于组合分析和推荐。不会自动读取邮箱、文件或第三方账户。</p>
        <form className="investment-holding-form" onSubmit={add}>
          <label>资产类别<select value={assetType} onChange={(event) => setAssetType(event.target.value as AssetType)}>{Object.entries(assetTypeLabels).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></label>
          <label>名称<input value={name} onChange={(event) => setName(event.target.value)} placeholder="例如：沪深300ETF" required /></label>
          <label>代码或符号<input value={symbol} onChange={(event) => setSymbol(event.target.value)} placeholder="可选" /></label>
          <label>数量<input value={quantity} onChange={(event) => setQuantity(event.target.value)} inputMode="decimal" type="number" min="0" step="any" required /></label>
          <label>当前价格<input value={currentPrice} onChange={(event) => setCurrentPrice(event.target.value)} inputMode="decimal" type="number" min="0" step="any" placeholder="可选" /></label>
          <label>成本价<input value={costBasis} onChange={(event) => setCostBasis(event.target.value)} inputMode="decimal" type="number" min="0" step="any" placeholder="可选" /></label>
          <button className="primary investment-add-holding" disabled={busy}><Plus size={15} />添加持仓</button>
        </form>
        {error && <p className="error investment-error" role="alert">{error}</p>}
        {holdings.length ? <div className="investment-holding-list">{holdings.map((holding) => <div className="investment-holding-row" key={holding.id}>
          <div><strong>{holding.name}</strong><small>{assetTypeLabels[holding.asset_type]} · {holding.symbol || '无代码'} · {holding.quantity}</small></div>
          <div className="investment-holding-value"><strong>{holding.value === null ? '待补价格' : `${holding.value.toFixed(2)} ${holding.currency}`}</strong><small>{holding.current_price === null ? '手动补充当前价格' : `现价 ${holding.current_price}`}</small></div>
          <button className="icon-button" type="button" aria-label={`删除${holding.name}`} onClick={() => void remove(holding.id)} disabled={busy}><Trash2 size={15} /></button>
        </div>)}</div> : <div className="investment-empty investment-portfolio-empty"><p>还没有保存的持仓。</p><small>添加股票、基金、黄金、货币、债券或现金后，系统才会生成组合级操作建议。</small></div>}
      </section>
    </>
  );
}

function RankingList({ items, kind }: { items: Ranking[]; kind: 'fund' | 'stock' }) {
  if (!items.length) return <p className="investment-empty">当前没有可用候选。请刷新或配置更完整的数据源。</p>;
  return (
    <div className="investment-ranking-list">
      {items.slice(0, 12).map((item, index) => (
        <article className="investment-ranking" key={`${item.code || item.name || 'item'}-${index}`}>
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
  const [view, setView] = useState<(typeof views)[number][0]>('portfolio');
  const [riskProfile, setRiskProfile] = useState<RiskProfile>('balanced');
  const [dashboard, setDashboard] = useState<Dashboard | null>(null);
  const [holdings, setHoldings] = useState<Holding[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const load = useCallback(async () => {
    setBusy(true);
    setError('');
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
  }, [riskProfile, settings]);
  useEffect(() => { void load(); }, [load]);
  return (
    <section className="investment-page" aria-label="投资研究">
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
        {views.map(([id, label]) => <button key={id} className={view === id ? 'active' : ''} onClick={() => setView(id)}>{label}</button>)}
      </nav>
      {error && <p className="error investment-error" role="alert">{error}</p>}
      {busy && !dashboard ? <div className="investment-loading"><LoaderCircle className="spin" /><span>正在读取公开市场数据…</span></div> : dashboard && (
        <div className="investment-content">
          {view === 'funds' && <><div className="investment-summary-grid"><div className="investment-summary"><small>候选基金</small><strong>{dashboard.funds.count}</strong></div><div className="investment-summary"><small>数据源</small><strong>{dashboard.source === 'live:tencent+eastmoney' ? '实时公开' : dashboard.source}</strong></div><div className="investment-summary"><small>生成时间</small><strong>{new Date(dashboard.generated_at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}</strong></div></div><section className="investment-card"><div className="investment-card-heading"><div><span className="investment-eyebrow">研究排序</span><h2>基金筛选</h2></div><BarChart3 size={20} /></div><RankingList items={dashboard.funds.rankings} kind="fund" /></section></>}
          {view === 'market' && <div className="investment-market-grid"><MarketCard title="中国市场" market={dashboard.market} /><MarketCard title="综合国际市场" market={dashboard.international.market} /></div>}
          {view === 'stocks' && <section className="investment-card"><div className="investment-card-heading"><div><span className="investment-eyebrow">长期研究</span><h2>股票候选</h2></div><ShieldCheck size={20} /></div><RankingList items={dashboard.stocks.rankings} kind="stock" /></section>}
          {view === 'international' && <><MarketCard title="国际市场" market={dashboard.international.market} /><section className="investment-card"><div className="investment-card-heading"><div><span className="investment-eyebrow">指数观察</span><h2>国际指数</h2></div><Database size={20} /></div><div className="investment-index-grid">{dashboard.international.indices.map((item, index) => <div key={`${String(item.code || item.symbol || 'index')}-${index}`}><strong>{String(item.name || item.code || '指数')}</strong><span>{percent(item.change_1d)}</span><small>{String(item.region || item.currency || '')}</small></div>)}</div></section></>}
          {view === 'portfolio' && <><PortfolioOverview summary={dashboard.portfolio.summary} holdings={holdings} dataAsOf={dashboard.portfolio.data_as_of} /><TransactionAssistant settings={settings} onChanged={() => void load()} /><HoldingsPanel settings={settings} holdings={holdings} onChanged={() => void load()} />{dashboard.daily_actions?.actions?.length ? <section className="investment-card investment-actions-card"><div className="investment-card-heading"><div><span className="investment-eyebrow">AI 建议</span><h2>研究建议</h2></div><ShieldCheck size={20} /></div><div className="investment-action-list">{dashboard.daily_actions.actions.map((item, index) => <article key={`${item.title || item.operation}-${index}`}><strong>{item.title || item.operation || '研究动作'}</strong><p>{item.reason || item.detail || '请查看依据后决定是否执行。'}</p></article>)}</div></section> : null}</>}
          <footer className="investment-footer"><span>数据日期：中国 {dashboard.market.as_of || '—'} · 国际 {dashboard.international.market.as_of || '—'}</span><span>{dashboard.data_sources.length} 个来源</span></footer>
        </div>
      )}
    </section>
  );
}
