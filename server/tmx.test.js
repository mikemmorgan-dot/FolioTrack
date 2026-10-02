import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import {
  fetchTmxInBrowser,
  parseTmxHistory,
  parseTmxQuote,
  seriesFromTimeSeries,
  tmxGraphqlGetUrl,
  tmxHistoryRequest,
  tmxHistoryStart,
  tmxSupports,
  toTmxSymbol,
  QUOTE_QUERY,
} from '../client/src/tmxBrowser.js';
import { isRefreshableAutoHolding } from './alerts/refresh.js';
import { resetCooldowns } from './providerCooldown.js';
import { resetProviderStats } from './providerStats.js';
import { getQuote, providerStatusList } from './providers.js';
import { chainFallbackCopy, navSourceForApply, TMX_PRICE_SOURCE } from './yahooSeries.js';
import { resetTmxForTests, setTmxDeps, tmxStatus } from './tmx.js';
import { resetYahooForTests, setYahooDeps } from './yahoo.js';

const quoteFixture = JSON.parse(readFileSync(new URL('./fixtures/tmx-atd-quote.json', import.meta.url), 'utf8'));
const historyFixture = JSON.parse(readFileSync(new URL('./fixtures/tmx-atd-history.json', import.meta.url), 'utf8'));

function mockRes(status, body) {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => body,
  };
}

afterEach(() => {
  resetTmxForTests();
  resetYahooForTests();
  resetCooldowns();
  resetProviderStats();
});

describe('TMX symbol and recorded payloads', () => {
  it('strips .TO and .V and keeps class shares', () => {
    expect(toTmxSymbol('ATD.TO')).toBe('ATD');
    expect(toTmxSymbol('atd.to')).toBe('ATD');
    expect(toTmxSymbol('TECK.B.TO')).toBe('TECK.B');
    expect(toTmxSymbol('TECK-B.TO')).toBe('TECK.B');
    expect(toTmxSymbol('AUMB.V')).toBe('AUMB');
    expect(tmxSupports('ENB.TO')).toBe(true);
    expect(tmxSupports('AUMB.V')).toBe(true);
    expect(tmxSupports('AAPL')).toBe(false);
    expect(tmxSupports('NEO.NE')).toBe(false);
    expect(tmxSupports('CSE.CN')).toBe(false);
  });

  it('parses the recorded ATD quote and daily bars', () => {
    const quote = parseTmxQuote(quoteFixture, 'ATD.TO');
    expect(quote).toMatchObject({
      symbol: 'ATD.TO',
      price: 76.945,
      previousClose: 77.2,
      currency: 'CAD',
      name: 'Alimentation Couche-Tard Inc.',
      exchange: 'TSX',
      asOf: '2026-10-02T12:24:52-04:00',
    });
    const history = parseTmxHistory(historyFixture, 'ATD.TO');
    expect(history.series.map((p) => p.date)).toEqual([
      '2026-09-28',
      '2026-09-30',
      '2026-10-02',
    ]);
    expect(history.series.at(-1).close).toBe(76.87);
    expect(seriesFromTimeSeries(historyFixture.data.getTimeSeriesData)[0].date).toBe('2026-09-28');
  });

  it('builds a browser GET url for getQuoteBySymbol', () => {
    const url = tmxGraphqlGetUrl('getQuoteBySymbol', QUOTE_QUERY, { symbol: 'ATD', locale: 'en' });
    const u = new URL(url);
    expect(u.origin + u.pathname).toBe('https://app-money.tmx.com/graphql');
    expect(u.searchParams.get('operationName')).toBe('getQuoteBySymbol');
    expect(u.searchParams.get('query')).toContain('getQuoteBySymbol');
    expect(JSON.parse(u.searchParams.get('variables'))).toEqual({ symbol: 'ATD', locale: 'en' });
    const hist = tmxHistoryRequest('XBB.TO', 'max', new Date('2026-10-02T15:00:00Z'));
    expect(hist.operationName).toBe('getTimeSeriesData');
    expect(hist.variables).toEqual({
      symbol: 'XBB',
      freq: 'day',
      start: '1990-01-01',
      end: '2026-10-02',
    });
    expect(tmxHistoryStart('ytd', new Date('2026-10-02T15:00:00Z'))).toBe('2026-01-01');
    expect(tmxHistoryStart('1y', new Date('2026-10-02T00:00:00Z'))).toBe('2025-09-27');
  });

  it('reads a phone fetch from the same fixtures', async () => {
    const calls = [];
    const fetchImpl = async (url) => {
      calls.push(url);
      if (url.includes('getQuoteBySymbol') || url.includes('operationName=getQuoteBySymbol')) {
        return mockRes(200, quoteFixture);
      }
      return mockRes(200, historyFixture);
    };
    const out = await fetchTmxInBrowser('ATD.TO', fetchImpl, new Date('2026-10-02T15:00:00Z'));
    expect(calls).toHaveLength(2);
    expect(calls.every((url) => url.startsWith('https://app-money.tmx.com/graphql?'))).toBe(true);
    expect(out.source).toBe(TMX_PRICE_SOURCE);
    expect(out.quote.price).toBe(76.945);
    expect(out.series).toHaveLength(3);
    expect(out.lastClose).toBe(76.87);
    await expect(fetchTmxInBrowser('AAPL', fetchImpl)).rejects.toThrow(/\.TO and \.V/);
  });
});

describe('TMX hop fallback and diagnostics', () => {
  it('falls through to Yahoo when TMX is rate-limited', async () => {
    setTmxDeps({
      fetch: async () => mockRes(429, { errors: [{ message: 'slow down' }] }),
    });
    setYahooDeps({
      fetch: async () => mockRes(200, {
        chart: {
          result: [{
            meta: {
              regularMarketPrice: 11,
              currency: 'CAD',
              longName: 'Test',
              regularMarketTime: 1_700_000_000,
            },
            timestamp: [1_700_000_000],
            indicators: { quote: [{ close: [11] }], adjclose: [{ adjclose: [11] }] },
          }],
          error: null,
        },
      }),
      sleep: async () => {},
      now: () => 1_700_000_000_000,
      random: () => 0,
    });
    const quote = await getQuote('ATD.TO');
    expect(quote.provider).toBe('yahoo-query2');
    expect(quote.price).toBe(11);
    const tmx = providerStatusList(1_700_000_000_000).find((row) => row.id === 'tmx');
    expect(tmx.coolingDown).toBe(true);
    expect(tmx.lastError).toMatch(/429/);
    const yahoo = providerStatusList().find((row) => row.id === 'yahoo-query2');
    expect(yahoo.lastSuccessSymbol).toBe('ATD.TO');
    expect(yahoo.lastSuccessAt).toBeTruthy();
  });

  it('does not refresh manual or NAV-backed holdings', () => {
    expect(isRefreshableAutoHolding({ source: 'manual', type: 'stock', symbol: 'ATD.TO' }, [])).toBe(false);
    expect(isRefreshableAutoHolding(
      { source: 'auto', type: 'stock', symbol: 'ATD.TO' },
      [{ date: '2026-01-02', nav: 70 }],
    )).toBe(false);
    expect(isRefreshableAutoHolding({ source: 'auto', type: 'stock', symbol: 'ATD.TO' }, [])).toBe(true);
  });

  it('explains a total miss and keeps TMX as an apply source', () => {
    expect(chainFallbackCopy('ATD.TO', new Error('All providers failed for ATD.TO: tmx (HTTP 429)'))).toMatch(/Download the CSV/);
    expect(chainFallbackCopy('ATD.TO', new Error('All providers failed'))).toMatch(/ca\.finance\.yahoo\.com\/quote\/ATD\.TO\/history/);
    expect(navSourceForApply('TMX Money')).toBe(TMX_PRICE_SOURCE);
    expect(navSourceForApply('Yahoo Finance')).toBe('Yahoo Finance');
    expect(navSourceForApply('manual')).toBe('Yahoo Finance');
    expect(navSourceForApply(undefined)).toBe('Yahoo Finance');
  });

  it('lists TMX and the relay on the diagnostics route', () => {
    const src = readFileSync(new URL('./index.js', import.meta.url), 'utf8');
    expect(src).toContain('tmx: tmxStatus()');
    expect(src).toContain('relay: yahooStatus().relay');
    expect(tmxStatus()).toMatchObject({
      quoteOperation: 'getQuoteBySymbol',
      historyOperation: 'getTimeSeriesData',
      lastSuccessAt: null,
    });
    const panel = readFileSync(new URL('../client/src/components/PricesPanel.jsx', import.meta.url), 'utf8');
    expect(panel).toContain('Fill from my phone');
    expect(panel).toContain('Paste last price');
    expect(panel).toContain('Yahoo history for');
    expect(panel).toContain('Historical Data');
  });
});
