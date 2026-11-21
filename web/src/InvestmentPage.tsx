import { useCallback, useEffect, useState } from 'react';
import { BarChart3, BookOpen, Database, LineChart, LoaderCircle, RefreshCw, ShieldCheck } from 'lucide-react';
import { api } from './data';
import type { Settings } from './types';

type RiskProfile = 'conservative' | 'balanced' | 'growth';
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
  portfolio: { summary?: Record<string, unknown>; holdings?: Record<string, unknown>[] };
  daily_actions?: { actions?: { title?: string; reason?: string }[] };
};

const views = [
  ['funds', '基金筛选'],
  ['market', '市场态势'],
  ['stocks', '长期股票'],
  ['international', '国际市场'],
  ['portfolio', '我的资金'],
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
  const [view, setView] = useState<(typeof views)[number][0]>('funds');
  const [riskProfile, setRiskProfile] = useState<RiskProfile>('balanced');
  const [dashboard, setDashboard] = useState<Dashboard | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const load = useCallback(async () => {
    setBusy(true);
    setError('');
    try {
      const result = await api<Dashboard>(settings, `/investment/dashboard?risk_profile=${riskProfile}`);
      setDashboard(result);
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
          {view === 'portfolio' && <section className="investment-card"><div className="investment-card-heading"><div><span className="investment-eyebrow">账户快照</span><h2>我的资金</h2></div><BookOpen size={20} /></div>{dashboard.portfolio.holdings?.length ? <div className="investment-index-grid">{dashboard.portfolio.holdings.map((item, index) => <div key={`${String(item.name || 'holding')}-${index}`}><strong>{String(item.name || '未命名')}</strong><span>{typeof item.value === 'number' ? item.value.toFixed(2) : '—'}</span><small>{String(item.asset_type || '')}</small></div>)}</div> : <div className="investment-empty investment-portfolio-empty"><p>当前未配置个人持仓。</p><small>研究窗口只读取服务器配置的数据源，不会自动读取邮箱、文件或账户资产。</small></div>}</section>}
          <footer className="investment-footer"><span>数据日期：中国 {dashboard.market.as_of || '—'} · 国际 {dashboard.international.market.as_of || '—'}</span><span>{dashboard.data_sources.length} 个来源</span></footer>
        </div>
      )}
    </section>
  );
}
