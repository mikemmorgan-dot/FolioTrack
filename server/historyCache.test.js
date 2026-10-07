import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  lastCloseNeedsRefresh,
  lastCloseDate,
  appendQuotePoint,
  createHistoryCache,
  mergeSeries,
  sliceSeriesForRange,
  HISTORY_TTL_MS,
} from './historyCache.js';
import { viaChain } from './providers.js';
import {
  resetCooldowns,
  setCooldownNow,
  isCooldownError,
  isCoolingDown,
} from './providerCooldown.js';

const SERIES = [
  { date: '2020-01-02', close: 10 },
  { date: '2024-01-02', close: 50 },
  { date: '2026-01-02', close: 80 },
  { date: '2026-09-01', close: 90 },
];

function memoryStore(seed = {}) {
  const db = { ...seed };
  return {
    db,
    getPriceHistory: async (symbol) => db[String(symbol).toUpperCase()] || null,
    putPriceHistory: async (symbol, rec) => {
      db[String(symbol).toUpperCase()] = rec;
      return rec;
    },
  };
}

describe('series helpers', () => {
  it('merges incoming closes over prior dates without dropping older points', () => {
    const merged = mergeSeries(
      [{ date: '2020-01-02', close: 10 }, { date: '2026-01-02', close: 70 }],
      [{ date: '2026-01-02', close: 80 }, { date: '2026-09-01', close: 90 }],
    );
    expect(merged).toEqual([
      { date: '2020-01-02', close: 10 },
      { date: '2026-01-02', close: 80 },
      { date: '2026-09-01', close: 90 },
    ]);
  });

  it('slices 1y/5y from a longer stored series', () => {
    const now = Date.parse('2026-09-04T00:00:00.000Z');
    const y1 = sliceSeriesForRange(SERIES, '1y', now);
    expect(y1[0].date).toBe('2026-01-02');
    expect(sliceSeriesForRange(SERIES, 'max', now)).toHaveLength(SERIES.length);
  });
});

describe('lastCloseNeedsRefresh', () => {
  it('treats today and yesterday as current', () => {
    expect(lastCloseNeedsRefresh('2026-10-01', '2026-10-01')).toBe(false);
    expect(lastCloseNeedsRefresh('2026-09-30', '2026-10-01')).toBe(false);
  });

  it('allows Friday close through the weekend and Monday', () => {
    expect(lastCloseNeedsRefresh('2026-09-25', '2026-09-26')).toBe(false); // Fri→Sat
    expect(lastCloseNeedsRefresh('2026-09-25', '2026-09-27')).toBe(false); // Fri→Sun
    expect(lastCloseNeedsRefresh('2026-09-25', '2026-09-28')).toBe(false); // Fri→Mon
    expect(lastCloseNeedsRefresh('2026-09-25', '2026-09-29')).toBe(true); // Fri→Tue
  });

  it('flags a four-week-old close (the PR #6 seed failure)', () => {
    expect(lastCloseNeedsRefresh('2026-09-04', '2026-10-01')).toBe(true);
    expect(lastCloseDate(SERIES)).toBe('2026-09-01');
  });

  it('appends a live quote as today\'s point', () => {
    const out = appendQuotePoint(SERIES, { price: 99.5 }, '2026-10-01');
    expect(out.at(-1)).toEqual({ date: '2026-10-01', close: 99.5 });
    expect(out).toHaveLength(SERIES.length + 1);
  });
});

describe('history cache', () => {
  it('does not call providers on a second open within TTL when last close is current', async () => {
    const store = memoryStore();
    let calls = 0;
    const cache = createHistoryCache({
      ...store,
      now: () => Date.parse('2026-09-01T12:00:00.000Z'),
      today: () => '2026-09-01',
      fetchLive: async () => {
        calls += 1;
        return { symbol: 'CRWD', series: SERIES, provider: 'yahoo' };
      },
      fetchQuote: async () => { throw new Error('unused'); },
    });
    const first = await cache.getHistory('CRWD', 'max');
    expect(first.fromCache).toBe(false);
    expect(first.stale).toBe(false);
    expect(first.series).toHaveLength(SERIES.length);
    expect(calls).toBe(1);

    const second = await cache.getHistory('CRWD', 'max');
    expect(second.fromCache).toBe(true);
    expect(second.stale).toBe(false);
    expect(second.series.at(-1).close).toBe(90);
    expect(calls).toBe(1);

    const sliced = await cache.getHistory('CRWD', '1y');
    expect(sliced.fromCache).toBe(true);
    expect(sliced.series[0].date).toBe('2026-01-02');
    expect(calls).toBe(1);
  });

  it('refreshes when fetchedAt is inside TTL but last close is weeks old', async () => {
    const store = memoryStore({
      TSLA: {
        symbol: 'TSLA',
        series: [
          { date: '2026-01-02', close: 250 },
          { date: '2026-09-04', close: 220 },
        ],
        provider: 'yahoo',
        range: 'max',
        fetchedAt: '2026-10-01T10:00:00.000Z', // "fresh" by TTL alone
      },
    });
    let histCalls = 0;
    let quoteCalls = 0;
    const cache = createHistoryCache({
      ...store,
      now: () => Date.parse('2026-10-01T12:00:00.000Z'),
      today: () => '2026-10-01',
      fetchLive: async () => {
        histCalls += 1;
        return {
          symbol: 'TSLA',
          series: [
            { date: '2026-01-02', close: 250 },
            { date: '2026-09-04', close: 220 },
            { date: '2026-09-28', close: 240 }, // still older than ~1 trading day
          ],
          provider: 'yahoo',
        };
      },
      fetchQuote: async () => {
        quoteCalls += 1;
        return { price: 241, provider: 'yahoo' };
      },
    });
    const out = await cache.getHistory('TSLA', 'max');
    expect(histCalls).toBe(1);
    expect(out.stale).toBe(false);
    expect(out.series.at(-1).date).toBe('2026-10-01');
    expect(out.series.at(-1).close).toBe(241);
    expect(quoteCalls).toBe(1);
    expect(out.quoteAppended).toBe(true);
  });

  it('appends a live quote when history providers fail but quote works', async () => {
    const store = memoryStore({
      TSLA: {
        symbol: 'TSLA',
        series: [
          { date: '2026-01-02', close: 250 },
          { date: '2026-09-04', close: 220 },
        ],
        provider: 'yahoo',
        range: 'max',
        fetchedAt: '2026-09-04T00:00:00.000Z',
      },
    });
    const cache = createHistoryCache({
      ...store,
      now: () => Date.parse('2026-10-01T12:00:00.000Z'),
      today: () => '2026-10-01',
      fetchLive: async () => { throw new Error('All providers failed for TSLA'); },
      fetchQuote: async () => ({ price: 355, provider: 'twelvedata' }),
    });
    const out = await cache.getHistory('TSLA', 'max');
    expect(out.stale).toBe(false);
    expect(out.quoteAppended).toBe(true);
    expect(out.series.at(-1)).toEqual({ date: '2026-10-01', close: 355 });
    expect(store.db.TSLA.series.at(-1).date).toBe('2026-10-01');
  });

  it('returns stale cache when live providers all fail', async () => {
    const store = memoryStore({
      CRWD: {
        symbol: 'CRWD',
        series: SERIES,
        provider: 'yahoo',
        range: 'max',
        fetchedAt: '2026-09-01T00:00:00.000Z', // older than 18h
      },
    });
    let calls = 0;
    const cache = createHistoryCache({
      ...store,
      now: () => Date.parse('2026-09-04T12:00:00.000Z'),
      today: () => '2026-09-04',
      ttlMs: HISTORY_TTL_MS,
      fetchLive: async () => {
        calls += 1;
        throw new Error('All providers failed for CRWD: yahoo (HTTP 429); twelvedata (API credits)');
      },
      fetchQuote: async () => { throw new Error('quote also down'); },
    });
    const out = await cache.getHistory('CRWD', 'max');
    expect(out.stale).toBe(true);
    expect(out.fromCache).toBe(true);
    expect(out.series).toHaveLength(SERIES.length);
    expect(out.error).toMatch(/All providers failed/);
    expect(calls).toBe(1);

    const again = await cache.getHistory('CRWD', 'max');
    expect(again.stale).toBe(true);
    expect(again.series).toHaveLength(SERIES.length);
    expect(calls).toBe(1);

    const forced = await cache.getHistory('CRWD', 'max', { force: true });
    expect(forced.stale).toBe(true);
    expect(calls).toBe(2);
  });

  it('loads a bounded window from meta and skips the series when asked', async () => {
    const calls = [];
    const cache = createHistoryCache({
      getPriceHistory: async (symbol, opts) => {
        calls.push({ symbol, opts });
        return {
          symbol,
          series: SERIES.filter((p) => !opts?.since || p.date >= opts.since),
          provider: 'yahoo',
          range: 'max',
          fetchedAt: '2026-09-01T11:00:00.000Z',
        };
      },
      getPriceHistoryMeta: async () => ({
        symbol: 'CRWD',
        provider: 'yahoo',
        range: 'max',
        fetchedAt: '2026-09-01T11:00:00.000Z',
        lastClose: '2026-09-01',
        pointCount: SERIES.length,
      }),
      putPriceHistory: async () => { throw new Error('fresh cache should not write'); },
      now: () => Date.parse('2026-09-01T12:00:00.000Z'),
      today: () => '2026-09-01',
      fetchLive: async () => { throw new Error('fresh cache should not fetch'); },
    });
    const slim = await cache.getHistory('CRWD', 'max', { omitSeries: true });
    expect(slim.series).toEqual([]);
    expect(slim.lastClose).toBe('2026-09-01');
    expect(slim.fromCache).toBe(true);
    expect(calls).toEqual([]);

    const y1 = await cache.getHistory('CRWD', '1y');
    expect(calls).toEqual([{ symbol: 'CRWD', opts: { since: '2025-09-01' } }]);
    expect(y1.series[0].date >= '2025-09-01').toBe(true);
    expect(y1.series.some((p) => p.date < '2025-09-01')).toBe(false);
  });

  it('hard-fails only when there is no stored series', async () => {
    const store = memoryStore();
    const cache = createHistoryCache({
      ...store,
      fetchLive: async () => { throw new Error('All providers failed for XYZ'); },
      fetchQuote: async () => { throw new Error('no quote'); },
    });
    await expect(cache.getHistory('XYZ', 'max')).rejects.toThrow(/All providers failed/);
  });
});

function mockProvider(id, historyFn) {
  return {
    id,
    supports: () => true,
    history: historyFn,
    quote: async () => { throw new Error('unused'); },
  };
}

describe('provider cooldown', () => {
  beforeEach(() => {
    resetCooldowns();
    setCooldownNow(() => Date.parse('2026-09-04T12:00:00.000Z'));
  });
  afterEach(() => {
    resetCooldowns();
    setCooldownNow(null);
  });

  it('classifies 429 / 403 / credit errors and not a genuine miss', () => {
    expect(isCooldownError({ status: 429, message: 'Yahoo refused' })).toBe(true);
    expect(isCooldownError(new Error('Finnhub HTTP 403: Forbidden'))).toBe(true);
    expect(isCooldownError(new Error('Twelve Data: You have run out of API credits for the current minute. 12 API credits were used, with the limit being 8.'))).toBe(true);
    expect(isCooldownError(new Error('Alpha Vantage: Thank you for using Alpha Vantage! Our standard API rate limit is 25 requests per day.'))).toBe(true);
    expect(isCooldownError(new Error('Finnhub: no candle data for CRWD (no_data)'))).toBe(false);
    expect(isCooldownError(new Error('Yahoo does not know the symbol ZZQQ'))).toBe(false);
  });

  it('skips a provider after a 429 so the next one can succeed', async () => {
    let yahooCalls = 0;
    let tdCalls = 0;
    const yahoo = mockProvider('yahoo', async () => {
      yahooCalls += 1;
      const e = new Error('Yahoo refused the request (HTTP 429)');
      e.status = 429;
      throw e;
    });
    const twelvedata = mockProvider('twelvedata', async () => {
      tdCalls += 1;
      return { symbol: 'CRWD', series: SERIES };
    });

    const first = await viaChain('history', 'CRWD', 'max', [yahoo, twelvedata]);
    expect(first.provider).toBe('twelvedata');
    expect(yahooCalls).toBe(1);
    expect(tdCalls).toBe(1);
    expect(isCoolingDown('yahoo')).toBe(true);

    const second = await viaChain('history', 'CRWD', 'max', [yahoo, twelvedata]);
    expect(second.provider).toBe('twelvedata');
    expect(yahooCalls).toBe(1);
    expect(tdCalls).toBe(2);
    expect(second.attempts.some((a) => a.provider === 'yahoo' && a.skipped)).toBe(true);
    const skipped = second.attempts.find((a) => a.provider === 'yahoo');
    expect(skipped.cooldownUntil).toBe('2026-09-04T12:20:00.000Z');
  });

  it('stops at the first successful provider and does not fan out', async () => {
    let later = 0;
    const yahoo = mockProvider('yahoo', async () => ({ symbol: 'CRWD', series: SERIES }));
    const twelvedata = mockProvider('twelvedata', async () => {
      later += 1;
      return { symbol: 'CRWD', series: SERIES };
    });
    const out = await viaChain('history', 'CRWD', 'max', [yahoo, twelvedata]);
    expect(out.provider).toBe('yahoo');
    expect(later).toBe(0);
  });
});
