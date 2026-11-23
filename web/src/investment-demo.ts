const asOf = '2026-11-21T15:30:00.000+08:00';

function dailySeries(period: string, unit: string, start: number, end: number, days: number, labels: string[], change_percent: number) {
  const points = Array.from({ length: days }, (_, index) => {
    const progress = index / Math.max(days - 1, 1);
    const wave = Math.sin(index * 0.37) * (Math.abs(end - start) * 0.035 + 0.0005);
    return Number((start + (end - start) * progress + wave).toFixed(4));
  });
  return { period, unit, granularity: 'day', points, labels, change_percent };
}

const fundResearch = {
  as_of: asOf,
  history: [
    dailySeries('1M', '单位净值', 3.25, 3.48, 31, ['10/22', '11/06', '11/21'], 7.08),
    dailySeries('3M', '单位净值', 3.08, 3.48, 92, ['08/21', '10/06', '11/21'], 12.99),
    dailySeries('1Y', '单位净值', 2.94, 3.48, 366, ['2025/11/21', '2026/05/22', '2026/11/21'], 18.37),
    dailySeries('3Y', '单位净值', 2.46, 3.48, 1097, ['2023/11/21', '2025/05/22', '2026/11/21'], 41.46),
  ],
  valuation: {
    status: '估值适中',
    percentile: 46,
    metrics: [
      { label: '同类分位', value: '46%', detail: '近三年历史区间' },
      { label: '基金规模', value: '¥128.4亿', detail: '中等规模' },
      { label: '管理费', value: '0.80%', detail: '按基金公告' },
    ],
    note: '债券基金重点观察久期、信用质量和费率，净值估值以基金公司公告为准。',
  },
  risk: {
    level: '中风险',
    volatility_1y: 12.8,
    max_drawdown_3y: -8.6,
    sharpe_1y: 0.92,
    beta: 0.64,
    liquidity: '日常申赎',
    note: '回撤和波动为演示统计，实际风险会随组合久期和市场利率变化。',
  },
  dividends: {
    yield_1y: 1.8,
    frequency: '不定期',
    last_amount: 0.06,
    last_date: '2026-06-10',
    next_date: '待公告',
    trailing_3y: 0.16,
    note: '基金分红以公告和实际登记日为准，分红会影响净值表现的展示方式。',
  },
};

const equityResearch = {
  as_of: asOf,
  history: [
    dailySeries('1M', '收盘价', 3.95, 4.12, 31, ['10/22', '11/06', '11/21'], 4.30),
    dailySeries('3M', '收盘价', 3.74, 4.12, 92, ['08/21', '10/06', '11/21'], 10.16),
    dailySeries('1Y', '收盘价', 3.62, 4.12, 366, ['2025/11/21', '2026/05/22', '2026/11/21'], 13.81),
    dailySeries('3Y', '收盘价', 3.44, 4.12, 1097, ['2023/11/21', '2025/05/22', '2026/11/21'], 19.77),
  ],
  valuation: {
    status: '估值中性',
    percentile: 38,
    metrics: [
      { label: 'PE(TTM)', value: '12.6x', detail: '五年中位 14.2x' },
      { label: 'PB', value: '1.35x', detail: '宽基估值' },
      { label: '股息率', value: '2.40%', detail: '滚动 12 个月' },
    ],
    note: 'ETF 估值聚合成分股数据，指数调整和成分变化会影响指标。',
  },
  risk: {
    level: '中高风险',
    volatility_1y: 16.4,
    max_drawdown_3y: -15.7,
    sharpe_1y: 0.71,
    beta: 0.98,
    liquidity: '交易日可买卖',
    note: '权益资产可能出现较大日内波动，回撤指标用于设置持仓上限。',
  },
  dividends: {
    yield_1y: 2.4,
    frequency: '年度',
    last_amount: 0.102,
    last_date: '2026-07-08',
    next_date: '待公告',
    trailing_3y: 0.28,
    note: 'ETF 分红取决于成分股现金分红和基金分配安排，到账时间以基金公告为准。',
  },
};

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
    research: fundResearch,
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
    research: equityResearch,
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
  funds: {
    count: 3,
    rankings: [
      { name: '招商鑫利中短债债券A', code: '016790', score: 68.1, confidence: 0.82, band: '稳健研究', metrics: { annualized_return_3y: 2.1, max_drawdown_3y: -0.14 }, research: fundResearch },
      { name: '嘉实超短债债券A', code: '012773', score: 58.2, confidence: 0.76, band: '现金替代', metrics: { annualized_return_3y: 0.11, max_drawdown_3y: -0.77 }, research: { ...fundResearch, valuation: { ...fundResearch.valuation, status: '估值偏低', percentile: 31 }, risk: { ...fundResearch.risk, level: '低风险', volatility_1y: 4.6, max_drawdown_3y: -1.8 }, dividends: { ...fundResearch.dividends, yield_1y: 1.2, last_amount: 0.03 } } },
      { name: '博时安盈债券A', code: '000084', score: 57.4, confidence: 0.74, band: '稳健研究', metrics: { annualized_return_3y: 0.01, max_drawdown_3y: -1.32 }, research: { ...fundResearch, valuation: { ...fundResearch.valuation, status: '估值中性', percentile: 52 }, risk: { ...fundResearch.risk, level: '低风险', volatility_1y: 5.2, max_drawdown_3y: -2.4 }, dividends: { ...fundResearch.dividends, yield_1y: 1.0, last_amount: 0.02 } } },
    ],
  },
  market: { as_of: '2026-11-21', regime: 'neutral', score: 61.8, confidence: 0.78, observations: { benchmark_count: 4 } },
  market_areas: [
    { id: 'domestic_equity', title: '国内权益', status: 'ready', market: { as_of: '2026-11-21', regime: 'neutral', score: 61.8, confidence: 0.78, observations: { benchmark_count: 4 } }, quote: { value: 3410.25, unit: '点', change_1d: 0.58 }, source: '演示行情快照' },
    { id: 'international_equity', title: '海外权益', status: 'ready', market: { as_of: '2026-11-21', regime: 'mixed', score: 54.2, confidence: 0.7, observations: { benchmark_count: 4 } }, quote: { value: 18920.4, unit: '点', change_1d: -0.23 }, source: '演示行情快照' },
    { id: 'bond', title: '债券与固收', status: 'ready', market: { as_of: '2026-11-21', regime: 'neutral', score: 58.4, confidence: 0.66, observations: { benchmark_count: 3 } }, quote: { value: 102.18, unit: '净值', change_1d: 0.04 }, source: '演示固收快照' },
    { id: 'gold', title: '黄金与大宗', status: 'ready', market: { as_of: '2026-11-21', regime: 'risk_on', score: 67.2, confidence: 0.72, observations: { benchmark_count: 2 } }, quote: { value: 518.6, unit: '元/克', change_1d: 0.72 }, source: '演示贵金属快照' },
    { id: 'fx', title: '汇率与现金', status: 'ready', market: { as_of: '2026-11-21', regime: 'neutral', score: 49.5, confidence: 0.61, observations: { benchmark_count: 2 } }, quote: { value: 7.245, unit: 'USD/CNY', change_1d: -0.08 }, source: '演示汇率快照' },
  ],
  stocks: {
    count: 3,
    rankings: [
      { name: '沪深300ETF', code: '510300', score: 72.4, confidence: 0.79, band: '宽基观察', research: equityResearch },
      { name: '中证红利ETF', code: '515180', score: 64.7, confidence: 0.73, band: '现金流观察', research: { ...equityResearch, valuation: { ...equityResearch.valuation, status: '估值偏低', percentile: 26, metrics: [{ label: 'PE(TTM)', value: '7.8x', detail: '红利风格' }, { label: 'PB', value: '0.86x', detail: '近五年低位' }, { label: '股息率', value: '5.10%', detail: '滚动 12 个月' }] }, risk: { ...equityResearch.risk, level: '中风险', volatility_1y: 12.1, max_drawdown_3y: -13.2 }, dividends: { ...equityResearch.dividends, yield_1y: 5.1, last_amount: 0.086 } } },
      { name: '科创50ETF', code: '588000', score: 55.6, confidence: 0.68, band: '成长观察', research: { ...equityResearch, valuation: { ...equityResearch.valuation, status: '估值偏高', percentile: 72, metrics: [{ label: 'PE(TTM)', value: '43.2x', detail: '成长板块' }, { label: 'PB', value: '3.85x', detail: '高波动区间' }, { label: '股息率', value: '0.60%', detail: '滚动 12 个月' }] }, risk: { ...equityResearch.risk, level: '高风险', volatility_1y: 28.6, max_drawdown_3y: -31.4, sharpe_1y: 0.38 }, dividends: { ...equityResearch.dividends, yield_1y: 0.6, last_amount: 0.018 } } },
    ],
  },
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
