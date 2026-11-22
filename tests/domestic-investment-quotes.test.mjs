import test from 'node:test';
import assert from 'node:assert/strict';
import { createDataProvider } from '../server/domestic-investment-bundle/core/provider.mjs';

test('allowlisted holding quote refresh supports stocks, gold and FX', async () => {
  const provider = await createDataProvider({
    live: true,
    fetchImpl: async (url) => {
      if (String(url).includes('open.er-api.com'))
        return { ok: true, status: 200, text: async () => JSON.stringify({ rates: { CNY: 7.2 } }) };
      return {
        ok: true,
        status: 200,
        text: async () =>
          'v_sh600000="0~浦发银行~600000~12.50~12.30~12.40~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~2026-11-21";v_hf_XAU="0~伦敦金~hf_XAU~2600.5~0~0~0~0~0~0~0~0~0~0~2026-11-21";',
      };
    },
  });
  const quotes = await provider.quoteHoldings([
    { id: 'stock', asset_type: 'domestic_equity', symbol: '600000' },
    { id: 'gold', asset_type: 'gold', symbol: 'hf_XAU' },
    { id: 'fx', asset_type: 'fx', symbol: 'USD' },
  ]);
  assert.deepEqual(
    quotes.map((quote) => [quote.id, quote.current_price]),
    [['stock', 12.5], ['gold', 2600.5], ['fx', 7.2]],
  );
});
