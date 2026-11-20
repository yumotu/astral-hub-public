// CNY, verified against the official page on 2026-11-05. Never rewrite this card:
// append a new effective version when the provider changes its published rates.
export const deepseekPriceCard = Object.freeze({
  id: 'deepseek-cny-2026-11-05',
  verifiedAt: '2026-11-05',
  effectiveFrom: '2026-11-05T00:00:00+08:00',
  source: 'https://api-docs.deepseek.com/zh-cn/quick_start/pricing/',
  currency: 'CNY',
  unit: 'per-million-tokens',
  models: {
    'deepseek-flash': {
      offPeak: { cacheHit: '0.02', cacheMiss: '1', output: '4' },
      peak: { cacheHit: '0.04', cacheMiss: '2', output: '8' },
    },
    'deepseek-v4-pro': {
      offPeak: { cacheHit: '0.15', cacheMiss: '4.5', output: '13.5' },
      peak: { cacheHit: '0.30', cacheMiss: '9', output: '27' },
    },
  },
  holidaySource: 'https://www.gov.cn/zhengce/content/202511/content_7047090.htm',
  holidayYear: 2026,
});
const holidays2026 = [
  ['01-01', '01-03'],
  ['02-15', '02-23'],
  ['04-04', '04-06'],
  ['05-01', '05-05'],
  ['06-19', '06-21'],
  ['09-25', '09-27'],
  ['10-01', '10-07'],
];
const count = (v) => (Number.isSafeInteger(v) && v >= 0 && v <= 1e12 ? v : null);
export function providerTokenUsage(raw) {
  const input = count(raw?.prompt_tokens),
    output = count(raw?.completion_tokens);
  let hit = count(raw?.prompt_cache_hit_tokens ?? raw?.prompt_tokens_details?.cached_tokens),
    miss = count(raw?.prompt_cache_miss_tokens);
  if (input !== null && hit !== null && miss === null && hit <= input) miss = input - hit;
  if (input !== null && miss !== null && hit === null && miss <= input) hit = input - miss;
  if (input === null || hit === null || miss === null || hit + miss !== input) hit = miss = null;
  return {
    input,
    output,
    cacheHit: hit,
    cacheMiss: miss,
    total: input !== null && output !== null ? input + output : null,
  };
}
export function piTokenUsage(raw) {
  const input = count(raw?.input),
    output = count(raw?.output),
    hit = count(raw?.cacheRead),
    write = count(raw?.cacheWrite);
  const miss = input !== null && write !== null ? input + write : null;
  return {
    input: miss !== null && hit !== null ? miss + hit : null,
    output,
    cacheHit: hit,
    cacheMiss: miss,
    total: miss !== null && hit !== null && output !== null ? miss + hit + output : null,
  };
}
export function priceFor(model, at) {
  const canonical = ['deepseek-v4-flash', 'deepseek-v4-flash-vision-exp'].includes(model)
    ? 'deepseek-flash'
    : model;
  const prices = deepseekPriceCard.models[canonical];
  if (!prices) return { reason: 'model_not_priced' };
  const time = new Date(at).getTime();
  if (!Number.isFinite(time) || time < new Date(deepseekPriceCard.effectiveFrom).getTime())
    return { reason: 'price_not_verified_for_date' };
  const beijing = new Date(time + 8 * 3600000),
    day = beijing.getUTCDay(),
    minutes = beijing.getUTCHours() * 60 + beijing.getUTCMinutes(),
    year = beijing.getUTCFullYear();
  const weekday = day >= 1 && day <= 5,
    peakHour = (minutes >= 540 && minutes < 720) || (minutes >= 840 && minutes < 1080);
  if (weekday && peakHour && year !== 2026) return { reason: 'holiday_calendar_missing' };
  const date = beijing.toISOString().slice(5, 10),
    holiday = year === 2026 && holidays2026.some(([start, end]) => date >= start && date <= end);
  const band = weekday && peakHour && !holiday ? 'peak' : 'offPeak';
  return {
    version: deepseekPriceCard.id,
    model: canonical,
    band,
    rates: prices[band],
    currency: 'CNY',
    basis: 'request-start-beijing',
    source: deepseekPriceCard.source,
  };
}
export function tokenCost(usage, price) {
  if (!usage || [usage.cacheHit, usage.cacheMiss, usage.output].some((v) => count(v) === null))
    return { costNanos: null, reason: 'usage_incomplete' };
  if (!price?.rates) return { costNanos: null, reason: price?.reason || 'model_not_priced' };
  const rate = (v) => BigInt(Math.round(Number(v) * 1000)); // CNY / 1M -> nano-CNY / token.
  return {
    costNanos: (
      BigInt(usage.cacheHit) * rate(price.rates.cacheHit) +
      BigInt(usage.cacheMiss) * rate(price.rates.cacheMiss) +
      BigInt(usage.output) * rate(price.rates.output)
    ).toString(),
    reason: null,
  };
}
export function formatCny(nanos) {
  if (nanos === null || nanos === undefined) return null;
  const n = BigInt(nanos);
  return `${n / 1000000000n}.${String(n % 1000000000n).padStart(9, '0')}`;
}
