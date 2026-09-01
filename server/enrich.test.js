import { describe, it, expect, vi } from 'vitest';
import { createQuoteCache, enrichHoldings, quotePatch } from './enrich.js';

function fakeStore(instruments, navs = {}) {
  return {
    getInstrument: async (id) => instruments[id] || null,
    latestNav: async (id) => navs[id] || null,
  };
}

const AUTO = {
  inst_spy: { id: 'inst_spy', symbol: 'SPY', name: 'SPDR S&P 500', type: 'etf', source: 'auto', currency: 'USD' },
  inst_nvda: { id: 'inst_nvda', symbol: 'NVDA', name: 'NVIDIA', type: 'stock', source: 'auto', currency: 'USD' },
  inst_cash: { id: 'inst_cash', symbol: 'CASH', name: 'Cash', type: 'cash', source: 'manual', currency: 'CAD' },
};

const VERSION = {
  id: 'ver_3',
  holdings: [
    { instrumentId: 'inst_spy', weight: 0.65 },
    { instrumentId: 'inst_nvda', weight: 0.05 },
    { instrumentId: 'inst_cash', weight: 0.30 },
  ],
};

describe('enrichHoldings cache-only (model GET)', () => {
  it('returns current-version holdings without calling getQuote', async () => {
    const getQuote = vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 10_000));
      return { price: 500, asOf: '2026-09-01' };
    });
    const quotes = createQuoteCache({ getQuote });
    const holdings = await enrichHoldings(VERSION, fakeStore(AUTO, {
      inst_cash: { nav: 1, date: '2020-01-01' },
    }), quotes, { liveQuotes: false });

    expect(getQuote).not.toHaveBeenCalled();
    expect(holdings.map((h) => h.symbol)).toEqual(['SPY', 'NVDA', 'CASH']);
    expect(holdings.map((h) => h.weight)).toEqual([0.65, 0.05, 0.30]);
    expect(holdings[0].price).toBeNull();
    expect(holdings[1].price).toBeNull();
    expect(holdings[2].price).toBe(1);
    expect(holdings[2].priceAsOf).toBe('2020-01-01');
  });

  it('uses a warm cache hit on the fast path without a new fetch', async () => {
    const getQuote = vi.fn(async (symbol) => ({ price: symbol === 'SPY' ? 500 : 100, asOf: '2026-09-01' }));
    const quotes = createQuoteCache({ getQuote });
    await quotes.cachedQuote('SPY');
    getQuote.mockClear();

    const holdings = await enrichHoldings(VERSION, fakeStore(AUTO), quotes, { liveQuotes: false });
    expect(getQuote).not.toHaveBeenCalled();
    expect(holdings[0].price).toBe(500);
    expect(holdings[1].price).toBeNull();
  });
});

describe('enrichHoldings live quotes (follow-up)', () => {
  it('fills auto prices in parallel, not stacked per holding', async () => {
    let release;
    const gate = new Promise((r) => { release = r; });
    const getQuote = vi.fn(async (symbol) => {
      await gate;
      return { price: symbol === 'SPY' ? 500 : 100, asOf: '2026-09-01' };
    });
    const quotes = createQuoteCache({ getQuote });
    const pending = enrichHoldings(VERSION, fakeStore(AUTO, {
      inst_cash: { nav: 1, date: '2020-01-01' },
    }), quotes, { liveQuotes: true });
    // Both auto symbols must have started before either resolves — sequential
    // await would still be on SPY, so NVDA wouldn't have been called yet.
    await vi.waitFor(() => expect(getQuote).toHaveBeenCalledTimes(2));
    release();
    const holdings = await pending;

    expect(holdings[0].price).toBe(500);
    expect(holdings[1].price).toBe(100);
    expect(holdings[2].price).toBe(1);
  });

  it('records a failed quote as price n/a without dropping the holding', async () => {
    const getQuote = vi.fn(async (symbol) => {
      if (symbol === 'NVDA') throw new Error('timeout');
      return { price: 500, asOf: '2026-09-01' };
    });
    const quotes = createQuoteCache({ getQuote });
    const holdings = await enrichHoldings(VERSION, fakeStore(AUTO), quotes, { liveQuotes: true });
    expect(holdings).toHaveLength(3);
    expect(holdings[0].price).toBe(500);
    expect(holdings[1].price).toBeNull();
    expect(holdings[1].priceSource).toMatch(/error: timeout/);
  });
});

describe('createQuoteCache', () => {
  it('dedupes in-flight fetches for the same symbol', async () => {
    let calls = 0;
    const getQuote = vi.fn(async () => {
      calls += 1;
      await new Promise((r) => setTimeout(r, 30));
      return { price: 1, asOf: 'x' };
    });
    const quotes = createQuoteCache({ getQuote });
    const [a, b] = await Promise.all([quotes.cachedQuote('SPY'), quotes.cachedQuote('SPY')]);
    expect(a.price).toBe(1);
    expect(b.price).toBe(1);
    expect(calls).toBe(1);
  });
});

describe('quotePatch', () => {
  it('strips to the fields the client merges onto an already-painted book', () => {
    expect(quotePatch([{
      id: 'inst_spy', symbol: 'SPY', weight: 0.65, price: 500, priceAsOf: '2026-09-01', priceSource: 'auto',
    }])).toEqual([{
      id: 'inst_spy', price: 500, priceAsOf: '2026-09-01', priceSource: 'auto',
    }]);
  });
});
