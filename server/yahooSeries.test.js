import { describe, it, expect } from 'vitest';
import {
  yahooSymbolFor,
  isYahooHistoryEligible,
  looksLikeFundserv,
  parseLooseDate,
  parseYahooPaste,
  applySummary,
  planApplySeries,
  fetchYahooHistoryForSymbol,
  classifyYahooFailure,
  yahooFallbackCopy,
  YAHOO_PRICE_SOURCE,
  LONG_MANUAL_SERIES,
  YahooSeriesError,
} from './yahooSeries.js';
import { periodReturnsFromSeries } from './periodReturns.js';
import { YahooError } from './yahoo.js';

describe('yahooSymbolFor', () => {
  it('maps RY / RY.TO aliases and passes other .TO names through', () => {
    expect(yahooSymbolFor('RY')).toBe('RY.TO');
    expect(yahooSymbolFor('ry.to')).toBe('RY.TO');
    expect(yahooSymbolFor('RY.TO')).toBe('RY.TO');
    expect(yahooSymbolFor('ENB.TO')).toBe('ENB.TO');
    expect(yahooSymbolFor('AAPL')).toBe('AAPL');
  });
});

describe('eligibility', () => {
  it('allows stocks and unmapped TSX ETFs; skips funds/alts/cash', () => {
    expect(isYahooHistoryEligible({ type: 'stock', symbol: 'RY.TO' })).toBe(true);
    expect(isYahooHistoryEligible({ type: 'stock', symbol: 'RY' })).toBe(true);
    expect(isYahooHistoryEligible({ type: 'etf', symbol: 'ORPHAN.TO' })).toBe(true);
    expect(isYahooHistoryEligible({ type: 'etf', symbol: 'VFV.TO' })).toBe(false);
    expect(isYahooHistoryEligible({ type: 'mutualfund', symbol: 'RBF608' })).toBe(false);
    expect(isYahooHistoryEligible({ type: 'stock', symbol: 'RBF608' })).toBe(false);
    expect(isYahooHistoryEligible({ type: 'alt', symbol: 'OCIC' })).toBe(false);
    expect(isYahooHistoryEligible({ type: 'cash', symbol: 'CASH' })).toBe(false);
    expect(looksLikeFundserv('FID5982')).toBe(true);
    expect(looksLikeFundserv('608')).toBe(false);
  });
});

describe('parseYahooPaste', () => {
  it('reads Yahoo CSV preferring Adj Close', () => {
    const text = [
      'Date,Open,High,Low,Close,Adj Close,Volume',
      '2024-01-02,130.00,131.00,129.00,130.50,128.00,1000',
      '2025-12-31,177.00,179.00,176.00,178.20,178.20,2000',
    ].join('\n');
    expect(parseYahooPaste(text)).toEqual([
      { date: '2024-01-02', close: 128 },
      { date: '2025-12-31', close: 178.2 },
    ]);
  });

  it('reads Date, Close and website-style month dates', () => {
    const text = [
      'Dec 31, 2025\t178.20',
      '2026-01-02, 179.10',
    ].join('\n');
    expect(parseYahooPaste(text)).toEqual([
      { date: '2025-12-31', close: 178.2 },
      { date: '2026-01-02', close: 179.1 },
    ]);
  });

  it('parses loose dates', () => {
    expect(parseLooseDate('2026-09-04')).toBe('2026-09-04');
    expect(parseLooseDate('September 4, 2026')).toBe('2026-09-04');
    expect(parseLooseDate('4 Sep 2026')).toBe('2026-09-04');
    expect(parseLooseDate('09/04/2026')).toBe('2026-09-04');
  });
});

describe('planApplySeries', () => {
  it('merges by date and confirms before overwriting a long manual series', () => {
    const existing = Array.from({ length: LONG_MANUAL_SERIES }, (_, i) => ({
      date: `2026-01-${String(i + 1).padStart(2, '0')}`,
      nav: 100 + i,
    }));
    const incoming = [
      { date: '2026-01-01', close: 200 },
      { date: '2026-02-01', close: 210 },
    ];
    const blocked = planApplySeries(existing, incoming, { existingSource: 'manual' });
    expect(blocked.needsConfirm).toBe(true);
    expect(blocked.summary.overwriteCount).toBe(1);
    expect(blocked.summary.addedCount).toBe(1);

    const ok = planApplySeries(existing, incoming, { existingSource: 'manual', confirm: true });
    expect(ok.needsConfirm).toBe(false);
    expect(ok.merged.find((p) => p.date === '2026-01-01').close).toBe(200);
    expect(ok.merged).toHaveLength(LONG_MANUAL_SERIES + 1);
  });

  it('does not require confirm when refreshing a Yahoo series', () => {
    const existing = Array.from({ length: 20 }, (_, i) => ({
      date: `2025-01-${String(i + 1).padStart(2, '0')}`,
      close: 10 + i,
    }));
    const incoming = existing.map((p) => ({ ...p, close: p.close + 1 }));
    const plan = planApplySeries(existing, incoming, { existingSource: YAHOO_PRICE_SOURCE });
    expect(plan.needsConfirm).toBe(false);
  });
});

describe('fetchYahooHistoryForSymbol', () => {
  const series = [
    { date: '2021-09-01', close: 100 },
    { date: '2026-09-01', close: 180 },
  ];

  it('proposes a live Yahoo series and stores the cache record', async () => {
    const stored = [];
    const out = await fetchYahooHistoryForSymbol('RY', {
      getHistoryImpl: async (symbol, range) => {
        expect(symbol).toBe('RY.TO');
        expect(range).toBe('max');
        return { symbol, range, series, provider: 'yahoo' };
      },
      putCached: async (symbol, rec) => stored.push({ symbol, rec }),
      now: () => Date.parse('2026-09-08T12:00:00Z'),
    });
    expect(out.source).toBe(YAHOO_PRICE_SOURCE);
    expect(out.yahooSymbol).toBe('RY.TO');
    expect(out.count).toBe(2);
    expect(out.from).toBe('2021-09-01');
    expect(out.to).toBe('2026-09-01');
    expect(out.pageUrl).toMatch(/RY\.TO/);
    expect(stored[0].rec.provider).toBe('yahoo');
  });

  it('returns a 429 fallback message and keeps a cached series when Yahoo is blocked', async () => {
    const cached = { symbol: 'RY.TO', series, provider: 'yahoo', fetchedAt: '2026-09-01T00:00:00.000Z' };
    const out = await fetchYahooHistoryForSymbol('RY.TO', {
      getHistoryImpl: async () => {
        throw new YahooError('Yahoo refused the request (HTTP 429)', { blocked: true, status: 429 });
      },
      getCached: async () => cached,
    });
    expect(out.stale).toBe(true);
    expect(out.fromCache).toBe(true);
    expect(out.code).toBe('rate_limit');
    expect(out.series).toHaveLength(2);
    expect(out.error).toMatch(/429/);
    expect(out.error).toMatch(/Prices/);
  });

  it('throws a typed 429 with manual fallback when there is no cache', async () => {
    await expect(fetchYahooHistoryForSymbol('RY.TO', {
      getHistoryImpl: async () => {
        throw new YahooError('Yahoo refused the request (HTTP 429)', { blocked: true, status: 429 });
      },
    })).rejects.toMatchObject({
      name: 'YahooSeriesError',
      code: 'rate_limit',
      status: 429,
      manualFallback: true,
    });
  });
});

describe('classify + fallback copy', () => {
  it('labels 429 vs not-found', () => {
    expect(classifyYahooFailure({ status: 429, message: 'HTTP 429' }).code).toBe('rate_limit');
    expect(classifyYahooFailure(new YahooError('unknown', { notFound: true })).code).toBe('not_found');
    expect(yahooFallbackCopy('RY.TO', { code: 'rate_limit' })).toMatch(/ca\.finance\.yahoo\.com/);
  });
});

describe('applied series feeds period returns', () => {
  it('computes multi-year windows from an EOD series (not Fund Facts)', () => {
    const series = [];
    let px = 100;
    for (let y = 2020; y <= 2026; y += 1) {
      for (let m = 1; m <= 12; m += 1) {
        if (y === 2026 && m > 8) break;
        const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
        px *= 1.01;
        series.push({
          date: `${y}-${String(m).padStart(2, '0')}-${String(last).padStart(2, '0')}`,
          value: px,
        });
      }
    }
    const row = periodReturnsFromSeries(series);
    expect(row.y1).not.toBeNull();
    expect(row.y3ann).not.toBeNull();
    expect(row.y5ann).not.toBeNull();
    expect(row.mtd).not.toBeNull();
  });
});
