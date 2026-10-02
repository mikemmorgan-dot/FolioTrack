import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  YAHOO_PASTE_PLACEHOLDER,
  formatFetchYahooError,
  navFieldError,
  parseNavInput,
} from '../client/src/navField.js';

describe('New NAV validation', () => {
  it('rejects text like skip and accepts a positive number', () => {
    expect(parseNavInput('')).toEqual({ empty: true, value: null, error: null });
    expect(parseNavInput('   ')).toEqual({ empty: true, value: null, error: null });
    expect(navFieldError('skip')).toBe('New NAV must be a number');
    expect(navFieldError('n/a')).toBe('New NAV must be a number');
    expect(navFieldError('0')).toBe('New NAV must be a number greater than 0');
    expect(navFieldError('-4')).toBe('New NAV must be a number');
    expect(parseNavInput('128.50')).toEqual({ empty: false, value: 128.5, error: null });
    expect(parseNavInput('$1,280.00').value).toBe(1280);
  });

  it('keeps the paste sample as a placeholder and explains a 429', () => {
    const src = readFileSync(new URL('../client/src/components/PricesPanel.jsx', import.meta.url), 'utf8');
    expect(YAHOO_PASTE_PLACEHOLDER).toBe('Date,Close\n2024-01-02,128.00');
    expect(src).toContain('placeholder={YAHOO_PASTE_PLACEHOLDER}');
    expect(src).toContain("paste: ''");
    expect(src).not.toMatch(/value=\{YAHOO_PASTE_PLACEHOLDER\}|value=\{['"]Date,Close/);
    expect(formatFetchYahooError('Yahoo rate-limited this server (HTTP 429). Retry after 12s. Paste Date / Close from https://ca.finance.yahoo.com/quote/ATD.TO/history into Prices, or type a NAV.', {
      code: 'rate_limit',
      retryAfterMs: 12_000,
    })).toMatch(/Retry after 12s/);
    expect(formatFetchYahooError('Yahoo rate-limited this server (HTTP 429).', { code: 'rate_limit', retryAfterMs: 45000 }))
      .toBe('Yahoo rate-limited this server (HTTP 429). Retry after 45s. Paste Date / Close below, or type a NAV.');
    expect(formatFetchYahooError('network down')).toMatch(/Paste Date \/ Close below/);
  });
});
