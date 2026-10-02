import { describe, it, expect } from 'vitest';
import {
  MISS_BACKOFF_BASE_MS,
  MISS_BACKOFF_MAX_MS,
  MISS_BACKOFF_NO_HISTORY_MAX_MS,
  MISS_NOT_FOUND_MS,
  backoffMsForMiss,
  formatRetryClock,
  normalizeMissRecord,
} from './missBackoff.js';
import { refreshOneAutoHolding } from './refresh.js';

const T0 = Date.parse('2026-10-02T15:00:00.000Z');

describe('adaptive miss backoff', () => {
  it('starts near 20 minutes and doubles up to 3 hours', () => {
    expect(backoffMsForMiss({ strikes: 0, hasHistory: true, reason: 'rate-limit' })).toBe(MISS_BACKOFF_BASE_MS);
    expect(MISS_BACKOFF_BASE_MS).toBe(20 * 60 * 1000);
    expect(backoffMsForMiss({ strikes: 1, hasHistory: true })).toBe(40 * 60 * 1000);
    expect(backoffMsForMiss({ strikes: 2, hasHistory: true })).toBe(80 * 60 * 1000);
    expect(backoffMsForMiss({ strikes: 3, hasHistory: true })).toBe(160 * 60 * 1000);
    expect(backoffMsForMiss({ strikes: 4, hasHistory: true })).toBe(MISS_BACKOFF_MAX_MS);
    expect(backoffMsForMiss({ strikes: 8, hasHistory: true })).toBe(3 * 60 * 60 * 1000);
  });

  it('never waits longer than 30 minutes when the holding has no cached history', () => {
    expect(backoffMsForMiss({ strikes: 0, hasHistory: false, reason: 'rate-limit' })).toBe(20 * 60 * 1000);
    expect(backoffMsForMiss({ strikes: 1, hasHistory: false })).toBe(MISS_BACKOFF_NO_HISTORY_MAX_MS);
    expect(backoffMsForMiss({ strikes: 6, hasHistory: false, reason: 'total-miss' })).toBe(30 * 60 * 1000);
  });

  it('waits 24 hours when the symbol was not found, even with no history', () => {
    expect(backoffMsForMiss({ strikes: 0, hasHistory: false, reason: 'not-found' })).toBe(MISS_NOT_FOUND_MS);
    expect(backoffMsForMiss({ strikes: 4, hasHistory: true, reason: 'not-found' })).toBe(24 * 60 * 60 * 1000);
  });

  it('pulls a legacy 6 hour timer back to the first step and keeps a shorter one', () => {
    const sixHours = new Date(T0 + 6 * 60 * 60 * 1000).toISOString();
    expect(normalizeMissRecord(sixHours, T0)).toEqual({
      until: T0 + MISS_BACKOFF_BASE_MS,
      strikes: 0,
      reason: 'total-miss',
    });
    const oneHour = new Date(T0 + 60 * 60 * 1000).toISOString();
    expect(normalizeMissRecord(oneHour, T0).until).toBe(T0 + 60 * 60 * 1000);
    const notFound = {
      until: new Date(T0 + MISS_NOT_FOUND_MS).toISOString(),
      strikes: 2,
      reason: 'not-found',
    };
    expect(normalizeMissRecord(notFound, T0).until).toBe(T0 + MISS_NOT_FOUND_MS);
  });

  it('formats the retry clock in Toronto time', () => {
    expect(formatRetryClock('2026-10-02T15:45:00.000Z')).toBe('11:45');
  });
});

function rateLimitError() {
  const err = new Error('Yahoo refused the request (HTTP 429)');
  err.status = 429;
  err.attempts = [{
    provider: 'yahoo',
    error: err.message,
    skipped: false,
    status: 429,
    kind: 'rate-limit',
  }];
  return err;
}

function notFoundError() {
  const err = new Error('All providers failed for ZZ.TO');
  err.notFound = true;
  err.attempts = [
    { provider: 'yahoo', error: 'Yahoo does not know the symbol ZZ.TO', notFound: true, skipped: false, kind: 'not-found' },
    { provider: 'yahoo-query2', error: 'No data returned for ZZ.TO', notFound: true, skipped: false, kind: 'not-found' },
    { provider: 'stooq', error: 'Stooq has no data for ZZ.TO', notFound: true, skipped: false, kind: 'not-found' },
  ];
  return err;
}

describe('refreshOneAutoHolding backoff', () => {
  const inst = { id: 'inst_enb', symbol: 'ENB.TO' };
  const withHistory = async () => ({
    series: [{ date: '2026-09-01', close: 60 }],
  });

  it('doubles after each rate-limit miss and resets when a provider answers', async () => {
    const state = new Map();
    let mode = 'fail';
    const getHistory = async () => {
      if (mode === 'fail') throw rateLimitError();
      return {
        series: [{ date: '2026-09-01', close: 60 }, { date: '2026-10-02', close: 66 }],
        stale: false,
        provider: 'yahoo',
      };
    };
    const first = await refreshOneAutoHolding(inst, {
      getHistory, getPriceHistory: withHistory, nowMs: T0, liveMissUntil: state,
    });
    expect(first.status).toBe('failed');
    expect(first.line).toMatch(/Providers were rate-limited — retry after 11:20/);
    expect(state.get('ENB.TO')).toMatchObject({ strikes: 1, until: T0 + 20 * 60 * 1000 });

    const held = await refreshOneAutoHolding(inst, {
      getHistory, getPriceHistory: withHistory, nowMs: T0 + 60_000, liveMissUntil: state,
    });
    expect(held.status).toBe('cooldown');
    expect(held.line).toMatch(/retry after 11:20/);

    const second = await refreshOneAutoHolding(inst, {
      getHistory, getPriceHistory: withHistory, nowMs: T0 + 20 * 60 * 1000, liveMissUntil: state,
    });
    expect(second.status).toBe('failed');
    expect(state.get('ENB.TO').strikes).toBe(2);
    expect(state.get('ENB.TO').until - (T0 + 20 * 60 * 1000)).toBe(40 * 60 * 1000);

    mode = 'ok';
    const third = await refreshOneAutoHolding(inst, {
      getHistory, getPriceHistory: withHistory, nowMs: T0 + 60 * 60 * 1000, liveMissUntil: state,
    });
    expect(third.status).toBe('updated');
    expect(state.has('ENB.TO')).toBe(false);
  });

  it('caps the wait at 30 minutes when there is no cached history', async () => {
    const state = new Map();
    const getHistory = async () => { throw rateLimitError(); };
    await refreshOneAutoHolding(inst, {
      getHistory, getPriceHistory: async () => null, nowMs: T0, liveMissUntil: state,
    });
    expect(state.get('ENB.TO').until - T0).toBe(20 * 60 * 1000);
    await refreshOneAutoHolding(inst, {
      getHistory, getPriceHistory: async () => null, nowMs: T0 + 20 * 60 * 1000, liveMissUntil: state,
    });
    expect(state.get('ENB.TO').until - (T0 + 20 * 60 * 1000)).toBe(30 * 60 * 1000);
    expect(state.get('ENB.TO').strikes).toBe(2);
  });

  it('backs off a confirmed miss for 24 hours', async () => {
    const state = new Map();
    const out = await refreshOneAutoHolding(
      { id: 'inst_zz', symbol: 'ZZ.TO' },
      {
        getHistory: async () => { throw notFoundError(); },
        getPriceHistory: async () => null,
        nowMs: T0,
        liveMissUntil: state,
      },
    );
    expect(out.reason).toBe('not-found');
    expect(out.line).toMatch(/Symbol was not found at the price providers — retry after \d{2}:\d{2}/);
    expect(state.get('ZZ.TO').until - T0).toBe(24 * 60 * 60 * 1000);
  });

  it('bypasses the holding timer on a manual refresh and reports cooled-down hops', async () => {
    const state = new Map();
    state.set('ENB.TO', { until: T0 + 6 * 60 * 60 * 1000, strikes: 3, reason: 'rate-limit' });
    let calls = 0;
    const blocked = await refreshOneAutoHolding(inst, {
      getHistory: async () => { calls += 1; throw new Error('should not run'); },
      getPriceHistory: async () => null,
      nowMs: T0,
      liveMissUntil: state,
    });
    expect(calls).toBe(0);
    expect(blocked.status).toBe('cooldown');

    const out = await refreshOneAutoHolding(inst, {
      bypassMissBackoff: true,
      getPriceHistory: async () => null,
      nowMs: T0,
      liveMissUntil: state,
      getHistory: async (_symbol, _range, opts) => {
        calls += 1;
        expect(opts.force).toBe(true);
        const err = new Error('All providers failed for ENB.TO');
        err.attempts = [
          {
            provider: 'yahoo',
            error: 'cooling down after a recent rate-limit',
            skipped: true,
            kind: 'rate-limit',
            cooldownUntil: '2026-10-02T15:40:00.000Z',
          },
          {
            provider: 'yahoo-query2',
            error: 'cooling down after a recent rate-limit',
            skipped: true,
            kind: 'rate-limit',
            cooldownUntil: '2026-10-02T15:50:00.000Z',
          },
        ];
        throw err;
      },
    });
    expect(calls).toBe(1);
    expect(out.status).toBe('cooldown');
    expect(out.skippedHops.map((h) => h.provider)).toEqual(['yahoo', 'yahoo-query2']);
    expect(out.line).toMatch(/Price providers are still cooling down — retry after \d{2}:\d{2}/);
    expect(out.line).toMatch(/Skipped while cooling down: yahoo until 11:40, yahoo-query2 until 11:50/);
    expect(state.get('ENB.TO').strikes).toBe(3);
  });
});
