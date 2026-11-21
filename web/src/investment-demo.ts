const asOf = '2026-11-21T15:30:00.000+08:00';

export const investmentDemoHoldings = [
  {
    id: 'demo-fund-110022',
    asset_type: 'fund',
    symbol: '110022',
    name: '易方达消费行业股票',
    quantity: 128.34,
    cost_basis: 3.12,
    current_price: 3.48,
    previous_close: 3.44,
    day_gain: 5.14,
    day_gain_percent: 1.16,
    currency: 'CNY',
    price_as_of: asOf,
    source: '演示数据 · 天天基金样例',
    value: 446.62,
  },
  {
    id: 'demo-etf-510300',
    asset_type: 'domestic_equity',
    symbol: '510300',
    name: '沪深300ETF',
    quantity: 800,
    cost_basis: 3.86,
    current_price: 4.12,
    previous_close: 4.08,
    day_gain: 32,
    day_gain_percent: 0.98,
    currency: 'CNY',
    price_as_of: asOf,
    source: '演示数据 · 公开行情样例',
    value: 3296,
  },
  {
    id: 'demo-gold-518880',
    asset_type: 'gold',
    symbol: '518880',
    name: '黄金ETF',
    quantity: 600,
    cost_basis: 4.72,
    current_price: 5.08,
    previous_close: 5.02,
    day_gain: 36,
    day_gain_percent: 1.2,
    currency: 'CNY',
    price_as_of: asOf,
    source: '演示数据 · 公开行情样例',
    value: 3048,
  },
  {
    id: 'demo-cash-000330',
    asset_type: 'cash_management',
    symbol: '000330',
    name: '货币基金示例',
    quantity: 12000,
    cost_basis: 1,
    current_price: 1.0008,
    previous_close: 1.0007,
    day_gain: 1.2,
    day_gain_percent: 0.01,
    currency: 'CNY',
    price_as_of: asOf,
    source: '演示数据 · 账户快照样例',
    value: 12009.6,
  },
  {
    id: 'demo-cash',
    asset_type: 'cash',
    symbol: '',
    name: '备用现金',
    quantity: 6800,
    cost_basis: 1,
    current_price: 1,
    previous_close: 1,
    day_gain: 0,
    day_gain_percent: 0,
    currency: 'CNY',
    price_as_of: asOf,
    source: '演示数据 · 账户快照样例',
    value: 6800,
  },
];

export const investmentDemoDashboard = {
  generated_at: asOf,
  source: 'demo:portfolio-and-market-fixture',
  data_sources: [
    { name: '演示行情快照', url: '#demo', scope: '基金、股票、黄金价格示例' },
    { name: '演示账户快照', url: '#demo', scope: '合成持仓、现金和收益示例' },
  ],
  data_missing: [],
  risk_profile: 'balanced',
  funds: { count: 3, rankings: [] },
  market: { as_of: '2026-11-21', regime: 'neutral', score: 61.8, confidence: 0.78, observations: { benchmark_count: 4 } },
  market_areas: [
    { id: 'domestic_equity', title: '国内权益', status: 'ready', market: { as_of: '2026-11-21', regime: 'neutral', score: 61.8, confidence: 0.78, observations: { benchmark_count: 4 } }, quote: { value: 3410.25, unit: '点', change_1d: 0.58 }, source: '演示行情快照' },
    { id: 'international_equity', title: '海外权益', status: 'ready', market: { as_of: '2026-11-21', regime: 'mixed', score: 54.2, confidence: 0.7, observations: { benchmark_count: 4 } }, quote: { value: 18920.4, unit: '点', change_1d: -0.23 }, source: '演示行情快照' },
    { id: 'bond', title: '债券与固收', status: 'ready', market: { as_of: '2026-11-21', regime: 'neutral', score: 58.4, confidence: 0.66, observations: { benchmark_count: 3 } }, quote: { value: 102.18, unit: '净值', change_1d: 0.04 }, source: '演示固收快照' },
    { id: 'gold', title: '黄金与大宗', status: 'ready', market: { as_of: '2026-11-21', regime: 'risk_on', score: 67.2, confidence: 0.72, observations: { benchmark_count: 2 } }, quote: { value: 518.6, unit: '元/克', change_1d: 0.72 }, source: '演示贵金属快照' },
    { id: 'fx', title: '汇率与现金', status: 'ready', market: { as_of: '2026-11-21', regime: 'neutral', score: 49.5, confidence: 0.61, observations: { benchmark_count: 2 } }, quote: { value: 7.245, unit: 'USD/CNY', change_1d: -0.08 }, source: '演示汇率快照' },
  ],
  stocks: { count: 2, rankings: [] },
  international: {
    market: { as_of: '2026-11-21', regime: 'mixed', score: 54.2, confidence: 0.7, observations: { benchmark_count: 4 } },
    indices: [],
    stocks: { count: 0, rankings: [] },
  },
  portfolio: {
    source: 'demo_fixture',
    data_as_of: asOf,
    currency: 'CNY',
    holdings: investmentDemoHoldings,
    summary: {
      total_capital: 25600.22,
      cash_balance: 18809.6,
      risk_assets: 6790.62,
      buckets: { fund: 446.62, domestic_equity: 3296, gold: 3048, cash_management: 12009.6, cash: 6800 },
    },
  },
  daily_actions: {
    actions: [
      { title: '保持现金缓冲', operation: 'hold_cash_buffer', reason: '演示组合现金及货币基金约占 73.5%，暂不建议为了追涨减少应急流动性。', detail: '先确认未来三个月的求职、考试和生活支出。' },
      { title: '检查黄金仓位', operation: 'review_gold_weight', reason: '黄金约占 11.9%，作为分散资产可保留，但不要把单一品种当作主要收益来源。', detail: '建议按目标区间观察，不因单日波动频繁调仓。' },
      { title: '分批观察权益资产', operation: 'observe_equity', reason: '权益类资产约占 14.6%，当前市场信号中性，可按计划分批观察。', detail: '这是研究建议，不是自动交易指令。' },
    ],
  },
};

export function isInvestmentDemo() {
  if (typeof window === 'undefined') return false;
  const query = new URLSearchParams(window.location.search);
  const demo = query.get('demo')?.replace(/`+$/, '');
  return demo === 'investment' || query.get('investmentDemo') === '1';
}

export function isInvestmentMobileDemo() {
  if (typeof window === 'undefined') return false;
  return isInvestmentDemo() && new URLSearchParams(window.location.search).get('device') === 'mobile';
}
