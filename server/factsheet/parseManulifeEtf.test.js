import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { parseManulifeEtfText, isManulifeEtfText } from './parseManulifeEtf.js';
import { extractAsOf, extractMer } from './parse.js';
import { publishedToPeriodRow } from './publishedReturns.js';

const dir = path.dirname(fileURLToPath(import.meta.url));
const fixture = (name) => fs.readFileSync(path.join(dir, 'fixtures', name), 'utf8');

describe('Manulife Smart International Dividend ETF — IDIV.B factsheet', () => {
  const text = fixture('manulife-idiv-b.txt');
  const parsed = parseManulifeEtfText(text);

  it('detects the Manulife ETF layout', () => {
    expect(isManulifeEtfText(text)).toBe(true);
    expect(isManulifeEtfText('Vanguard S&P 500 Index ETF | VFV')).toBe(false);
  });

  it('uses holdings as-of (not the later NAV date) for look-through', () => {
    expect(extractAsOf(text).asOf).toBe('2026-07-31');
    expect(parsed.asOf).toBe('2026-07-31');
    expect(parsed.asOfEstimated).toBe(false);
  });

  it('reads MER 0.40% and does not pick the management fee', () => {
    expect(extractMer(text)).toBeCloseTo(0.40, 5);
    expect(parsed.mer).toBeCloseTo(0.40, 5);
  });

  it('pairs Geographic Allocation pie labels with preceding slice weights', () => {
    expect(parsed.countryBreakdown.find((r) => r.label === 'Japan').weight).toBeCloseTo(18.9, 5);
    expect(parsed.countryBreakdown.find((r) => r.label === 'France').weight).toBeCloseTo(12.4, 5);
    expect(parsed.countryBreakdown.find((r) => r.label === 'United Kingdom').weight).toBeCloseTo(10.8, 5);
    expect(parsed.countryBreakdown.find((r) => r.label === 'Italy').weight).toBeCloseTo(9.1, 5);
    expect(parsed.countryBreakdown.find((r) => r.label === 'Other').weight).toBeCloseTo(20.1, 5);
    expect(parsed.countryBreakdown.every((r) => !/^cash/i.test(r.label))).toBe(true);
  });

  it('reads Sector Allocation (Equities) and skips cash', () => {
    expect(parsed.sectorBreakdown.find((r) => r.label === 'Financials').weight).toBeCloseTo(32.1, 5);
    expect(parsed.sectorBreakdown.find((r) => r.label === 'Industrials').weight).toBeCloseTo(14.8, 5);
    expect(parsed.sectorBreakdown.find((r) => r.label === 'Information Technology').weight).toBeCloseTo(7.6, 5);
    expect(parsed.sectorBreakdown.find((r) => r.label === 'Consumer Discretionary').weight).toBeCloseTo(4.1, 5);
    expect(parsed.sectorBreakdown.every((r) => !/^cash/i.test(r.label))).toBe(true);
  });

  it('reads compound + calendar published returns as decimals', () => {
    expect(parsed.published.asOf).toBe('2026-07-31');
    expect(parsed.published.ytd).toBeCloseTo(0.1847, 5);
    expect(parsed.published.y1).toBeCloseTo(0.3386, 5);
    expect(parsed.published.y3ann).toBeCloseTo(0.2386, 5);
    expect(parsed.published.m1).toBeCloseTo(0.0345, 5);
    expect(parsed.published.inceptionAnn).toBeCloseTo(0.2547, 5);
    expect(parsed.published.y5ann).toBeUndefined();
    const byYear = Object.fromEntries((parsed.published.calendarYears || []).map((r) => [r.year, r.value]));
    expect(byYear[2023]).toBeCloseTo(0.1542, 5);
    expect(byYear[2024]).toBeCloseTo(0.1434, 5);
    expect(byYear[2025]).toBeCloseTo(0.3886, 5);
    expect(byYear[2016]).toBeUndefined();
  });

  it('mentions the sheet NAV without inventing a series', () => {
    expect(parsed.navPoint).toEqual({ date: '2026-09-04', nav: 21.07, source: 'Manulife factsheet' });
    expect(parsed.published.navSeries).toBeUndefined();
  });

  it('maps onto the published period row without filling MTD from 1-month', () => {
    const row = publishedToPeriodRow(parsed.published);
    expect(row.mtd).toBeNull();
    expect(row.ytd).toBeCloseTo(0.1847, 5);
    expect(row.y1).toBeCloseTo(0.3386, 5);
    expect(row.y3ann).toBeCloseTo(0.2386, 5);
    expect(row.y5ann).toBeNull();
    expect(row.meta.y1.published).toBe(true);
    expect(row.meta.y1.estimate).toBe(false);
  });
});
