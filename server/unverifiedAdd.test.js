import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { classifyAttempt, classifyAttempts, decideAddSource } from './failureClass.js';
import { inferListing, currencyAfterFailedLookup } from './listing.js';
import { offlineLookup, offlineCatalogSize, SUGGESTED_LABEL } from './offlineNames.js';
import { quoteFromChartResult, readChartPayload, seriesFromChartResult, YahooError } from './yahoo.js';
import { isStooqBlockPage, parseStooqCsv, toStooqSymbol } from './stooq.js';
import { metadataPatchFromQuote } from './metadataRefresh.js';
import { createQuoteCache, enrichHoldings } from './enrich.js';
import { monthGrid, returnsForRefs } from './perf.js';
import { compareStaticRisk } from './projection.js';
import { PROVIDERS, providerStatusList } from './providers.js';
import { markCooldown, resetCooldowns, setCooldownNow } from './providerCooldown.js';

const chartFixture = {
  chart: {
    result: [{
      meta: {
        currency: 'USD',
        symbol: 'AVGO',
        exchangeName: 'NasdaqGS',
        regularMarketPrice: 345.67,
        chartPreviousClose: 340.1,
        longName: 'Broadcom Inc.',
        regularMarketTime: 1750000000,
      },
      timestamp: [1700000000, 1700086400],
      indicators: {
        quote: [{ close: [340.1, 345.67] }],
        adjclose: [{ adjclose: [339.5, 344.2] }],
      },
    }],
    error: null,
  },
};

describe('failure classification', () => {
  it('treats an all-cooldown chain as rate-limited and still auto', () => {
    const attempts = ['yahoo', 'twelvedata', 'finnhub', 'alphavantage'].map((provider) => ({
      provider,
      error: 'cooling down after a recent rate-limit',
      skipped: true,
    }));
    const v = classifyAttempts(attempts);
    expect(v.rateLimited).toBe(true);
    expect(v.allowAuto).toBe(true);
    expect(v.anyNotFound).toBe(false);
    expect(decideAddSource({ found: false, allowAuto: v.allowAuto, manualNav: false })).toBe('auto');
  });

  it('counts HTTP 429 and 403 as rate limits', () => {
    expect(classifyAttempt({ error: 'Yahoo refused the request (HTTP 429)', status: 429 })).toBe('rate-limit');
    expect(classifyAttempt({ error: 'Finnhub HTTP 403: Forbidden', status: 403 })).toBe('rate-limit');
    expect(classifyAttempt({ error: 'Alpha Vantage: Our standard API rate limit is 25 requests per day.' })).toBe('rate-limit');
  });

  it('allows auto when rate limits are mixed only with missing keys and unreachable hosts', () => {
    const v = classifyAttempts([
      { error: 'cooling down after a recent rate-limit', skipped: true },
      { error: 'TWELVEDATA_API_KEY not configured' },
      { error: 'FINNHUB_API_KEY not configured' },
      { error: 'Network error reaching Yahoo: fetch failed' },
      { error: 'Stooq returned a block page' },
    ]);
    expect(v.kinds).toEqual(['rate-limit', 'missing-key', 'missing-key', 'unreachable', 'unreachable']);
    expect(v.allowAuto).toBe(true);
    expect(decideAddSource({ allowAuto: true })).toBe('auto');
  });

  it('keeps a confirmed quote on auto', () => {
    expect(decideAddSource({ found: true })).toBe('auto');
    expect(decideAddSource({ found: true, allowAuto: false })).toBe('auto');
  });

  it('does not allow auto when nothing was rate-limiting', () => {
    const v = classifyAttempts([
      { error: 'TWELVEDATA_API_KEY not configured' },
      { error: 'Network error reaching Yahoo: timeout' },
    ]);
    expect(v.allowAuto).toBe(false);
    expect(decideAddSource({ allowAuto: false })).toBe('manual');
  });

  it('keeps a mix with not-found on manual, and an entered NAV forces manual', () => {
    const v = classifyAttempts([
      { error: 'cooling down after a recent rate-limit', skipped: true },
      { error: 'Yahoo does not know the symbol AVGO', notFound: true },
    ]);
    expect(v.anyNotFound).toBe(true);
    expect(v.allowAuto).toBe(false);
    expect(decideAddSource({ allowAuto: v.allowAuto })).toBe('manual');
    expect(decideAddSource({ found: true, allowAuto: true, manualNav: true })).toBe('manual');
    expect(decideAddSource({ found: false, allowAuto: true, manualNav: true })).toBe('manual');
  });

  it('does not treat a Stooq block page as not found', () => {
    expect(classifyAttempt({ error: 'Stooq returned a block page' })).toBe('unreachable');
    expect(classifyAttempt({ error: 'Stooq returned a block page', status: 403 })).toBe('rate-limit');
    expect(classifyAttempt({ error: 'Yahoo does not know the symbol ZZQQ', notFound: true })).toBe('not-found');
  });
});

describe('symbol listing inference', () => {
  it('maps a bare US ticker to USD', () => {
    expect(inferListing('AVGO')).toEqual({ currency: 'USD', exchange: 'US', region: 'United States' });
    expect(inferListing('brk.b')).toEqual({ currency: 'USD', exchange: 'US', region: 'United States' });
  });

  it('maps TSX, TSXV, and London suffixes', () => {
    expect(inferListing('RY.TO')).toEqual({ currency: 'CAD', exchange: 'TSX', region: 'Canada' });
    expect(inferListing('ABX.NE')).toEqual({ currency: 'CAD', exchange: 'TSX', region: 'Canada' });
    expect(inferListing('XYZ.CN')).toEqual({ currency: 'CAD', exchange: 'TSX', region: 'Canada' });
    expect(inferListing('ABC.V')).toEqual({ currency: 'CAD', exchange: 'TSXV', region: 'Canada' });
    expect(inferListing('HSBA.L')).toEqual({ currency: 'GBP', exchange: 'London', region: 'United Kingdom' });
    expect(inferListing('GIB.A.TO').exchange).toBe('TSX');
    expect(inferListing('TECK.B.TO').currency).toBe('CAD');
  });

  it('keeps FundServ codes in CAD and respects a currency the user edited', () => {
    expect(inferListing('RBF1005').currency).toBe('CAD');
    expect(inferListing('FID5982').currency).toBe('CAD');
    expect(currencyAfterFailedLookup({
      current: 'EUR', inferred: 'USD', userEdited: true,
    })).toBe('EUR');
    expect(currencyAfterFailedLookup({
      current: 'CAD', inferred: 'USD', userEdited: false,
    })).toBe('USD');
  });
});

describe('offline name prefill', () => {
  it('suggests AVGO and RY.TO and labels the guess', () => {
    const avgo = offlineLookup('avgo');
    expect(avgo).toMatchObject({
      name: 'Broadcom Inc.',
      sector: 'Information Technology',
      region: 'United States',
      label: SUGGESTED_LABEL,
    });
    expect(SUGGESTED_LABEL).toBe('suggested, edit if wrong');
    const ry = offlineLookup('RY.TO');
    expect(ry).toMatchObject({ name: 'Royal Bank of Canada', sector: 'Financials', region: 'Canada' });
    expect(offlineLookup('ZZZNOTREAL')).toBeNull();
  });

  it('covers a large S&P 500 set and the TSX 60', () => {
    const size = offlineCatalogSize();
    expect(size.us).toBeGreaterThanOrEqual(80);
    expect(size.tsx).toBeGreaterThanOrEqual(60);
  });
});

describe('provider parsers', () => {
  it('reads a Yahoo chart quote fixture', () => {
    const result = readChartPayload(chartFixture, 'AVGO');
    expect(quoteFromChartResult('AVGO', result)).toMatchObject({
      symbol: 'AVGO',
      price: 345.67,
      currency: 'USD',
      name: 'Broadcom Inc.',
      exchange: 'NasdaqGS',
    });
  });

  it('reads a Yahoo chart history fixture', () => {
    const result = readChartPayload(chartFixture, 'AVGO');
    const series = seriesFromChartResult(result);
    expect(series).toHaveLength(2);
    expect(series[0].close).toBe(339.5);
    expect(series[1].close).toBe(344.2);
    expect(series[0].date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('treats a Yahoo chart not-found payload as not found, and a block as not that', () => {
    expect(() => readChartPayload({
      chart: { result: null, error: { code: 'Not Found', description: 'No data found, symbol may be delisted' } },
    }, 'ZZQQ')).toThrow(YahooError);
    try {
      readChartPayload({
        chart: { result: null, error: { code: 'Not Found', description: 'No data found, symbol may be delisted' } },
      }, 'ZZQQ');
    } catch (e) {
      expect(e.notFound).toBe(true);
      expect(e.blocked).toBe(false);
    }
  });

  it('parses a Stooq daily CSV fixture', () => {
    const csv = [
      'Date,Open,High,Low,Close,Volume',
      '2024-01-03,172,174,171,173.25,1100',
      '2024-01-02,170,172,169,171.50,1000',
    ].join('\n');
    const parsed = parseStooqCsv(csv, 'AVGO');
    expect(parsed.series.map((p) => p.date)).toEqual(['2024-01-02', '2024-01-03']);
    expect(parsed.price).toBe(173.25);
    expect(parsed.asOf).toBe('2024-01-03');
  });

  it('treats a Stooq header with no rows as not found', () => {
    expect(() => parseStooqCsv('Date,Open,High,Low,Close,Volume\n', 'AVGO')).toThrow(/no data/i);
    try {
      parseStooqCsv('Date,Open,High,Low,Close,Volume\n', 'AVGO');
    } catch (e) {
      expect(e.notFound).toBe(true);
    }
  });

  it('maps Stooq symbols and rejects a challenge page', () => {
    expect(toStooqSymbol('AVGO')).toBe('avgo.us');
    expect(toStooqSymbol('RY.TO')).toBe('ry.ca');
    expect(toStooqSymbol('HSBA.L')).toBe('hsba.uk');
    const html = '<!DOCTYPE html><html><body>Just a moment... Enable JavaScript</body></html>';
    expect(isStooqBlockPage(html, 200)).toBe(true);
    expect(() => parseStooqCsv(html, 'AVGO')).toThrow(/block page/);
    try {
      parseStooqCsv(html, 'AVGO');
    } catch (e) {
      expect(e.notFound).toBe(false);
      expect(e.status).toBe(403);
    }
  });
});

describe('metadata refresh and unverified preview', () => {
  it('updates unlocked suggestions and keeps fields the user edited', () => {
    const inst = {
      symbol: 'AVGO',
      name: 'Broadcom Inc.',
      sector: 'Information Technology',
      country: 'United States',
      meta: {
        unverified: true,
        locks: { name: true, sector: false, country: true },
        suggested: { name: 'Broadcom Inc.', sector: 'Information Technology', region: 'United States' },
      },
    };
    const patch = metadataPatchFromQuote(inst, {
      price: 350,
      name: 'Broadcom Incorporated',
      sector: 'Information Technology',
      country: 'Ireland',
    });
    expect(patch.name).toBeUndefined();
    expect(patch.sector).toBeUndefined();
    expect(patch.country).toBeUndefined();
    expect(patch.meta.unverified).toBe(false);

    const open = metadataPatchFromQuote({
      ...inst,
      meta: { ...inst.meta, locks: { name: false, sector: false, country: false } },
    }, {
      price: 350,
      name: 'Broadcom Incorporated',
      sector: 'Information Technology',
      country: 'United States',
    });
    expect(open.name).toBe('Broadcom Incorporated');
    expect(open.sector).toBeUndefined();
    expect(open.country).toBeUndefined();
  });

  it('does not refresh a holding that was already verified', () => {
    expect(metadataPatchFromQuote({
      symbol: 'AVGO', name: 'Broadcom Inc.', meta: { unverified: false, locks: {} },
    }, { price: 10, name: 'Other' })).toBeNull();
    const same = metadataPatchFromQuote({
      symbol: 'AVGO',
      name: 'Broadcom Inc.',
      meta: { unverified: true, locks: { name: false, sector: false, country: false } },
    }, { price: 10, name: 'AVGO' });
    expect(same.name).toBeUndefined();
    expect(same.meta.unverified).toBe(false);
  });

  it('does not replace a suggestion with a quote that only echoes the ticker', () => {
    const patch = metadataPatchFromQuote({
      symbol: 'RY.TO',
      name: 'Royal Bank of Canada',
      sector: 'Financials',
      country: 'Canada',
      meta: { unverified: true, locks: { name: false, sector: false, country: false } },
    }, { price: 180, name: 'RY.TO', sector: 'Financials' });
    expect(patch.name).toBeUndefined();
    expect(patch.sector).toBeUndefined();
    expect(patch.meta.unverified).toBe(false);
  });

  it('refreshes an unverified name on a later live quote', async () => {
    const inst = {
      id: 'inst_avgo',
      symbol: 'AVGO',
      name: 'Broadcom Inc.',
      type: 'stock',
      source: 'auto',
      currency: 'USD',
      sector: 'Information Technology',
      country: 'United States',
      meta: {
        unverified: true,
        locks: { name: false, sector: true, country: false },
        suggested: { name: 'Broadcom Inc.', sector: 'Information Technology', region: 'United States' },
      },
    };
    const updateInstrument = vi.fn(async (_id, patch) => ({ ...inst, ...patch }));
    const quotes = createQuoteCache({
      getQuote: async () => ({
        price: 350, asOf: '2026-10-01', name: 'Broadcom Incorporated', sector: 'Technology', country: 'United States',
      }),
    });
    const holdings = await enrichHoldings(
      { holdings: [{ instrumentId: 'inst_avgo', weight: 1 }] },
      { getInstrument: async () => inst, latestNav: async () => null, updateInstrument },
      quotes,
      { liveQuotes: true },
    );
    expect(updateInstrument).toHaveBeenCalledOnce();
    const patch = updateInstrument.mock.calls[0][1];
    expect(patch.name).toBe('Broadcom Incorporated');
    expect(patch.sector).toBeUndefined();
    expect(patch.meta.unverified).toBe(false);
    expect(holdings[0].name).toBe('Broadcom Incorporated');
    expect(holdings[0].sector).toBe('Information Technology');
    expect(holdings[0].price).toBe(350);
  });

  it('previews an auto holding with no history instead of failing', async () => {
    const grid = monthGrid('2024-01', '2024-06');
    const steady = {};
    for (let i = 1; i < grid.length; i++) steady[grid[i]] = 0.01 + (i % 2) * 0.02;
    const getHistory = vi.fn(async () => {
      throw new Error('All providers failed for AVGO: yahoo (cooling down after a recent rate-limit)');
    });
    const extra = await returnsForRefs(
      [{ ref: 'AVGO', symbol: 'AVGO', source: 'auto', hypothetical: true }],
      { getHistory, getNavSeries: async () => [] },
      grid,
    );
    expect(extra.AVGO).toBeUndefined();
    const out = compareStaticRisk({
      baseline: [{ ref: 'A', symbol: 'VFV', weight: 1 }],
      proposed: [
        { ref: 'A', symbol: 'VFV', weight: 0.8 },
        { ref: 'AVGO', symbol: 'AVGO', weight: 0.2, hypothetical: true, source: 'auto' },
      ],
      returnsByRef: { A: steady },
      grid,
      rf: 0.04,
    });
    expect(out.unresolved).toEqual(['AVGO']);
    expect(Math.round(out.coverage * 100)).toBe(80);
    expect(out.deltas.sharpe).toBe(0);
  });
});

describe('diagnostics cooldown list', () => {
  it('tries query2 before query1 and keeps Stooq as its own hop', () => {
    expect(PROVIDERS.map((p) => p.id)).toEqual([
      'tmx', 'yahoo-query2', 'yahoo', 'twelvedata', 'finnhub', 'alphavantage', 'stooq',
    ]);
  });

  beforeEach(() => {
    resetCooldowns();
    setCooldownNow(() => Date.parse('2026-10-01T16:00:00.000Z'));
  });
  afterEach(() => {
    resetCooldowns();
    setCooldownNow(null);
  });

  it('lists every provider, including the new hops, with time remaining', () => {
    markCooldown('yahoo', 5 * 60 * 1000);
    const rows = providerStatusList(Date.parse('2026-10-01T16:00:00.000Z'));
    const ids = rows.map((r) => r.id);
    expect(ids).toEqual(['tmx', 'yahoo-query2', 'yahoo', 'twelvedata', 'finnhub', 'alphavantage', 'stooq']);
    expect(PROVIDERS.map((p) => p.id)).toEqual(ids);
    expect(PROVIDERS.find((p) => p.id === 'yahoo-query2').quote).toBeTypeOf('function');
    expect(PROVIDERS.find((p) => p.id === 'stooq').history).toBeTypeOf('function');
    const yahoo = rows.find((r) => r.id === 'yahoo');
    expect(yahoo.coolingDown).toBe(true);
    expect(yahoo.remainingMs).toBe(5 * 60 * 1000);
    expect(yahoo.cooldownUntil).toBe('2026-10-01T16:05:00.000Z');
    const q2 = rows.find((r) => r.id === 'yahoo-query2');
    expect(q2.coolingDown).toBe(false);
    expect(q2.remainingMs).toBe(0);
    expect(q2.cooldownUntil).toBeNull();
  });
});
