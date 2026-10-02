import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { getQuote } from './providers.js';
import { isCoolingDown, resetCooldowns, setCooldownNow } from './providerCooldown.js';
import { DEFAULT_YAHOO_UA } from './yahooHeaders.js';
import {
  YAHOO_HOSTS,
  getHistory,
  resetYahooForTests,
  setYahooDeps,
  yahooStatus,
} from './yahoo.js';

const NOW = 1_700_000_000_000;

function chartBody(price = 77.2) {
  return {
    chart: {
      result: [{
        meta: {
          regularMarketPrice: price,
          currency: 'CAD',
          exchangeName: 'TOR',
          longName: 'Alimentation Couche-Tard',
          regularMarketTime: 1_700_000_000,
        },
        timestamp: [1_700_000_000],
        indicators: {
          quote: [{ close: [price] }],
          adjclose: [{ adjclose: [price] }],
        },
      }],
      error: null,
    },
  };
}

function mockRes(status, body, headers = {}) {
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (name) => lower[String(name).toLowerCase()] ?? null },
    json: async () => body,
  };
}

function installFetch(fetchImpl) {
  const prev = process.env.YAHOO_UA;
  delete process.env.YAHOO_UA;
  setYahooDeps({
    fetch: fetchImpl,
    sleep: async (ms) => { fetchImpl.sleeps?.push(ms); },
    now: () => NOW,
    random: () => 0,
  });
  return prev;
}

afterEach(() => {
  delete process.env.YAHOO_UA;
  resetYahooForTests();
  resetCooldowns();
  setCooldownNow(null);
});

describe('Yahoo chart fetch', () => {
  it('uses the descriptive UA, query2, and period1/period2 for max history', async () => {
    let headers;
    const calls = [];
    installFetch(async (url, init) => {
      calls.push(url);
      headers = init.headers;
      return mockRes(200, chartBody());
    });
    const out = await getHistory('ATD.TO', 'max');
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain('https://query2.finance.yahoo.com/v8/finance/chart/ATD.TO?');
    expect(calls[0]).toContain('period1=0&period2=1700000000&interval=1d');
    expect(calls[0]).not.toContain('range=max');
    expect(headers['User-Agent']).toBe(DEFAULT_YAHOO_UA);
    expect(headers.Referer).toBeUndefined();
    expect(out.series).toEqual([{ date: '2023-11-14', close: 77.2 }]);
    expect(yahooStatus()).toMatchObject({
      userAgentMode: 'descriptive',
      userAgent: DEFAULT_YAHOO_UA,
      hosts: ['query2', 'query1'],
      historyQuery: 'period1/period2',
      minIntervalMs: 1500,
      concurrency: 1,
      lastSuccessAt: new Date(NOW).toISOString(),
      lastSuccessSymbol: 'ATD.TO',
      lastHttpStatus: 200,
      lastError: null,
    });
  });

  it('tries the other host after one 429 before any Retry-After sleep', async () => {
    const log = [];
    const fetchImpl = async (url) => {
      log.push(url.includes('query2') ? 'q2' : 'q1');
      if (url.includes('query2')) return mockRes(429, 'Too Many Requests', { 'retry-after': '9' });
      return mockRes(200, chartBody(11));
    };
    fetchImpl.sleeps = [];
    installFetch(fetchImpl);
    const quote = await getQuote('ATD.TO');
    expect(quote.price).toBe(11);
    expect(quote.provider).toBe('yahoo');
    expect(log).toEqual(['q2', 'q1']);
    expect(fetchImpl.sleeps).not.toContain(9000);
    expect(isCoolingDown('yahoo-query2')).toBe(true);
    expect(isCoolingDown('yahoo')).toBe(false);
  });

  it('backs off with Retry-After only after both hosts returned 429', async () => {
    const log = [];
    let n = 0;
    const fetchImpl = async (url) => {
      const host = url.includes('query2') ? 'q2' : 'q1';
      log.push(host);
      n += 1;
      if (n < 3) return mockRes(429, 'Too Many Requests', { 'retry-after': '3' });
      return mockRes(200, chartBody());
    };
    fetchImpl.sleeps = [];
    installFetch(fetchImpl);
    const out = await getHistory('ATD.TO', '5d', '1d');
    expect(out.series[0].close).toBe(77.2);
    expect(log.slice(0, 2)).toEqual(['q2', 'q1']);
    expect(fetchImpl.sleeps).toContain(3000);
    const backoffAt = fetchImpl.sleeps.indexOf(3000);
    expect(backoffAt).toBeGreaterThan(0);
    expect(log.filter((item) => item === 'q2' || item === 'q1').length).toBeGreaterThan(2);
  });

  it('does not treat a single-host 429 as Yahoo being exhausted', async () => {
    const fetchImpl = async (url) => {
      fetchImpl.urls.push(url);
      if (url.includes('query1')) return mockRes(200, chartBody(4));
      return mockRes(429, 'Too Many Requests', { 'retry-after': '9' });
    };
    fetchImpl.urls = [];
    fetchImpl.sleeps = [];
    installFetch(fetchImpl);
    await expect(getHistory('ATD.TO', '5d', '1d', [YAHOO_HOSTS[0]])).rejects.toMatchObject({
      status: 429,
      otherHostUntried: true,
    });
    expect(fetchImpl.urls.some((url) => url.includes('query1'))).toBe(false);
    expect(fetchImpl.sleeps).not.toContain(9000);
    const recovered = await getHistory('ATD.TO', '5d', '1d', [YAHOO_HOSTS[1]]);
    expect(recovered.series[0].close).toBe(4);
    expect(fetchImpl.sleeps).not.toContain(9000);
  });

  it('reports yahoo status from the diagnostics route', () => {
    const src = readFileSync(new URL('./index.js', import.meta.url), 'utf8');
    expect(src).toMatch(/app\.get\('\/api\/diagnostics'/);
    expect(src).toContain('yahoo: yahooStatus()');
  });
});
