import { afterEach, describe, expect, it } from 'vitest';
import { resetCooldowns } from './providerCooldown.js';
import {
  getHistory,
  resetYahooForTests,
  setYahooDeps,
  yahooStatus,
} from './yahoo.js';
import { RELAY_SECRET_HEADER, buildYahooRelayUrl, yahooProxyConfig } from './yahooRelay.js';

const NOW = 1_700_000_000_000;
const YAHOO = 'https://query2.finance.yahoo.com/v8/finance/chart/ATD.TO?period1=0&period2=1700000000&interval=1d';

function chartBody() {
  return {
    chart: {
      result: [{
        meta: {
          regularMarketPrice: 76.945,
          currency: 'CAD',
          longName: 'Alimentation Couche-Tard',
          regularMarketTime: 1_700_000_000,
        },
        timestamp: [1_700_000_000],
        indicators: { quote: [{ close: [76.945] }], adjclose: [{ adjclose: [76.945] }] },
      }],
      error: null,
    },
  };
}

afterEach(() => {
  delete process.env.YAHOO_PROXY_URL;
  delete process.env.YAHOO_PROXY_SECRET;
  delete process.env.YAHOO_UA;
  resetYahooForTests();
  resetCooldowns();
});

describe('Yahoo relay URL', () => {
  it('leaves the chart URL alone when the relay is unset', () => {
    const out = buildYahooRelayUrl(YAHOO, {});
    expect(out).toEqual({ configured: false, url: YAHOO, headers: {}, host: null });
    expect(yahooProxyConfig({}).configured).toBe(false);
    expect(yahooStatus().relay).toMatchObject({ configured: false, working: false, host: null });
  });

  it('sends the encoded chart URL and the shared-secret header', () => {
    const out = buildYahooRelayUrl(YAHOO, {
      YAHOO_PROXY_URL: 'https://foliotrack-yahoo.example.workers.dev',
      YAHOO_PROXY_SECRET: 'shared-secret',
    });
    const u = new URL(out.url);
    expect(u.origin).toBe('https://foliotrack-yahoo.example.workers.dev');
    expect(u.pathname).toBe('/');
    expect(u.searchParams.get('url')).toBe(YAHOO);
    expect(out.headers[RELAY_SECRET_HEADER]).toBe('shared-secret');
    expect(out.host).toBe('foliotrack-yahoo.example.workers.dev');
  });

  it('uses the relay for chart fetches and reports it working after a 200', async () => {
    process.env.YAHOO_PROXY_URL = 'https://foliotrack-yahoo.example.workers.dev/';
    process.env.YAHOO_PROXY_SECRET = 'shared-secret';
    const calls = [];
    setYahooDeps({
      fetch: async (url, init) => {
        calls.push({ url, headers: init.headers });
        return {
          status: 200,
          ok: true,
          headers: { get: () => null },
          json: async () => chartBody(),
        };
      },
      sleep: async () => {},
      now: () => NOW,
      random: () => 0,
    });
    const out = await getHistory('ATD.TO', 'max');
    expect(out.series[0].close).toBe(76.945);
    expect(calls).toHaveLength(1);
    const hit = new URL(calls[0].url);
    expect(hit.host).toBe('foliotrack-yahoo.example.workers.dev');
    expect(hit.searchParams.get('url')).toContain('https://query2.finance.yahoo.com/v8/finance/chart/ATD.TO?');
    expect(calls[0].headers[RELAY_SECRET_HEADER]).toBe('shared-secret');
    expect(yahooStatus().relay).toMatchObject({
      configured: true,
      host: 'foliotrack-yahoo.example.workers.dev',
      secretConfigured: true,
      working: true,
      lastSuccessSymbol: 'ATD.TO',
      lastHttpStatus: 200,
      lastError: null,
    });
  });
});
