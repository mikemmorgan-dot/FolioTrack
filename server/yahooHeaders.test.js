import { describe, expect, it } from 'vitest';
import {
  DEFAULT_YAHOO_UA,
  ROTATING_UAS,
  buildChartQuery,
  resolveYahooUserAgent,
  yahooRequestHeaders,
} from './yahooHeaders.js';

describe('Yahoo header selection', () => {
  it('defaults to a descriptive FolioTrack user agent', () => {
    expect(resolveYahooUserAgent({})).toEqual({ mode: 'descriptive', userAgent: DEFAULT_YAHOO_UA });
    expect(resolveYahooUserAgent({ YAHOO_UA: '' }).mode).toBe('descriptive');
    expect(resolveYahooUserAgent({ YAHOO_UA: 'descriptive' }).userAgent).toBe(DEFAULT_YAHOO_UA);
    expect(DEFAULT_YAHOO_UA).not.toMatch(/Safari\/605/);
    const headers = yahooRequestHeaders({});
    expect(headers['User-Agent']).toBe(DEFAULT_YAHOO_UA);
    expect(headers.Accept).toMatch(/json/);
    expect(headers.Referer).toBeUndefined();
  });

  it('omits User-Agent when YAHOO_UA=none', () => {
    expect(resolveYahooUserAgent({ YAHOO_UA: 'none' })).toEqual({ mode: 'omit', userAgent: null });
    expect(resolveYahooUserAgent({ YAHOO_UA: 'omit' }).mode).toBe('omit');
    expect(yahooRequestHeaders({ YAHOO_UA: 'none' })['User-Agent']).toBeUndefined();
  });

  it('rotates a small set of common user agents and skips Safari', () => {
    const first = resolveYahooUserAgent({ YAHOO_UA: 'rotate' }, { random: () => 0 });
    const second = resolveYahooUserAgent({ YAHOO_UA: 'rotate' }, { random: () => 0.99 });
    expect(first).toEqual({ mode: 'rotate', userAgent: ROTATING_UAS[0] });
    expect(second.userAgent).toBe(ROTATING_UAS[ROTATING_UAS.length - 1]);
    expect(ROTATING_UAS.join('\n')).not.toMatch(/Version\/17\.0 Safari/);
    expect(new Set([first.userAgent, second.userAgent]).size).toBe(2);
  });

  it('sends an exact custom user agent', () => {
    expect(resolveYahooUserAgent({ YAHOO_UA: 'MyAgent/2' })).toEqual({
      mode: 'custom',
      userAgent: 'MyAgent/2',
    });
    expect(yahooRequestHeaders({ YAHOO_UA: 'MyAgent/2' })['User-Agent']).toBe('MyAgent/2');
  });
});

describe('Yahoo chart query', () => {
  it('uses period1/period2 for history and range for a short quote', () => {
    const nowSec = 1_700_000_000;
    expect(buildChartQuery({ range: 'max', interval: '1d', nowSec })).toBe(
      'period1=0&period2=1700000000&interval=1d'
    );
    expect(buildChartQuery({ range: '5y', interval: '1d', nowSec })).toBe(
      `period1=${nowSec - 1827 * 86400}&period2=${nowSec}&interval=1d`
    );
    expect(buildChartQuery({ range: '1d', interval: '1d', nowSec })).toBe('range=1d&interval=1d');
    expect(buildChartQuery({ range: '5d', interval: '1d', nowSec })).toBe('range=5d&interval=1d');
  });
});
