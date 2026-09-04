import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
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

describe('history cache', () => {
  it('does not call providers on a second open within TTL', async () => {
    const store = memoryStore();
    let calls = 0;
    const cache = createHistoryCache({
      ...store,
      now: () => Date.parse('2026-09-04T12:00:00.000Z'),
      fetchLive: async () => {
        calls += 1;
        return { symbol: 'CRWD', series: SERIES, provider: 'yahoo' };
      },
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
      ttlMs: HISTORY_TTL_MS,
      fetchLive: async () => {
        calls += 1;
        throw new Error('All providers failed for CRWD: yahoo (HTTP 429); twelvedata (API credits)');
      },
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

  it('hard-fails only when there is no stored series', async () => {
    const store = memoryStore();
    const cache = createHistoryCache({
      ...store,
      fetchLive: async () => { throw new Error('All providers failed for XYZ'); },
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
