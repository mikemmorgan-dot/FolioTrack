import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { parseFundFactsText, parseFundPulseText, parseRbcMonthlyText } from './parseFundDocs.js';
import { extractAsOf } from './parse.js';
import { mergePublishedReturns, publishedToPeriodRow, hasPublishedReturns } from './publishedReturns.js';

const dir = path.dirname(fileURLToPath(import.meta.url));
const fixture = (name) => fs.readFileSync(path.join(dir, 'fixtures', name), 'utf8');

describe('Fidelity Global Innovators Series F — Fund Facts', () => {
  const text = fixture('fidelity-uet-f-fund-facts.txt');
  const parsed = parseFundFactsText(text);

  it('uses the investment-mix date, not the document header date', () => {
    expect(extractAsOf(text).asOf).toBe('2026-02-28');
    expect(parsed.asOf).toBe('2026-02-28');
    expect(parsed.asOfEstimated).toBe(false);
  });

  it('reads Series F MER 1.10% from Quick Facts', () => {
    expect(parsed.mer).toBeCloseTo(1.10, 5);
  });

  it('reads BY SECTOR / BY COUNTRY mix', () => {
    expect(parsed.sectorBreakdown.find((r) => r.label === 'Information Technology').weight).toBeCloseTo(44.5, 5);
    expect(parsed.sectorBreakdown.find((r) => r.label === 'Communication Services').weight).toBeCloseTo(15.9, 5);
    expect(parsed.countryBreakdown.find((r) => r.label === 'United States').weight).toBeCloseTo(64.7, 5);
    expect(parsed.countryBreakdown.find((r) => r.label === 'Canada').weight).toBeCloseTo(13.6, 5);
    expect(parsed.countryBreakdown.find((r) => r.label === 'Finland').weight).toBeCloseTo(1.3, 5);
    expect(parsed.sectorBreakdown.every((r) => !/^remaining/i.test(r.label))).toBe(true);
  });

  it('reads Series F calendar-year returns from the accessibility text', () => {
    const byYear = Object.fromEntries((parsed.published.calendarYears || []).map((r) => [r.year, r.value]));
    expect(byYear[2018]).toBeCloseTo(-0.0461, 5);
    expect(byYear[2020]).toBeCloseTo(0.9503, 5);
    expect(byYear[2024]).toBeCloseTo(0.6055, 5);
    expect(byYear[2025]).toBeCloseTo(0.2135, 5);
    expect(parsed.published.inceptionAnn).toBeCloseTo(0.238, 5);
    expect(parsed.published.series).toBe('F');
  });
});

describe('Fidelity Global Innovators Series F — FundPulse', () => {
  const text = fixture('fidelity-uet-f-fundpulse.txt');
  const parsed = parseFundPulseText(text);

  it('prefers performance as-of August 31 for published returns', () => {
    expect(parsed.performanceAsOf).toBe('2026-08-31');
    expect(parsed.published.asOf).toBe('2026-08-31');
  });

  it('reads Class F standard period returns as decimals', () => {
    expect(parsed.published.m1).toBeCloseTo(0.0339, 5);
    expect(parsed.published.y1).toBeCloseTo(0.5464, 5);
    expect(parsed.published.y3ann).toBeCloseTo(0.4428, 5);
    expect(parsed.published.y5ann).toBeCloseTo(0.2357, 5);
    expect(parsed.published.inceptionAnn).toBeCloseTo(0.2653, 5);
  });

  it('reads calendar YTD + prior years', () => {
    const ytd = parsed.published.calendarYears.find((r) => r.ytd);
    expect(ytd).toMatchObject({ year: 2026 });
    expect(ytd.value).toBeCloseTo(0.4264, 5);
    expect(parsed.published.ytd).toBeCloseTo(0.4264, 5);
    const cy2022 = parsed.published.calendarYears.find((r) => r.year === 2022 && !r.ytd);
    expect(cy2022.value).toBeCloseTo(-0.2965, 5);
  });

  it('reads current-month sector/country mix and Class F NAV', () => {
    expect(parsed.allocationAsOf).toBe('2026-07-31');
    expect(parsed.sectorBreakdown.find((r) => r.label === 'Information Technology').weight).toBeCloseTo(47.6, 5);
    expect(parsed.countryBreakdown.find((r) => r.label === 'United States').weight).toBeCloseTo(83.0, 5);
    expect(parsed.navPoint).toEqual({ date: '2026-08-31', nav: 69.75, source: 'FundPulse' });
    expect(parsed.mer).toBeCloseTo(1.10, 5);
  });
});

describe('RBC North American Value Series F — Fund Facts', () => {
  const text = fixture('rbc-rbf608-fund-facts.txt');
  const parsed = parseFundFactsText(text);

  it('reads Series F MER 0.79% and May 31 mix date', () => {
    expect(parsed.mer).toBeCloseTo(0.79, 5);
    expect(parsed.asOf).toBe('2026-05-31');
  });

  it('reads leading-percent investment mix', () => {
    expect(parsed.sectorBreakdown.find((r) => r.label === 'Financials').weight).toBeCloseTo(26.1, 5);
    expect(parsed.sectorBreakdown.find((r) => r.label === 'Information Technology').weight).toBeCloseTo(11.2, 5);
    expect(parsed.sectorBreakdown.find((r) => r.label === 'Energy').weight).toBeCloseTo(10.6, 5);
    expect(parsed.sectorBreakdown.every((r) => !/cash|underlying/i.test(r.label))).toBe(true);
  });

  it('reads year-by-year chart and 10Y compound — not as inception', () => {
    const byYear = Object.fromEntries((parsed.published.calendarYears || []).map((r) => [r.year, r.value]));
    expect(byYear[2016]).toBeCloseTo(0.139, 5);
    expect(byYear[2018]).toBeCloseTo(-0.079, 5);
    expect(byYear[2025]).toBeCloseTo(0.198, 5);
    expect(parsed.published.y10ann).toBeCloseTo(0.13, 5);
    expect(parsed.published.inceptionAnn).toBeUndefined();
    expect(parsed.published.series).toBe('F');
  });
});

describe('RBC North American Value Series F — monthly update', () => {
  const text = fixture('rbc-rbf608-monthly.txt');
  const parsed = parseRbcMonthlyText(text);

  it('reads trailing and calendar returns as of July 31', () => {
    expect(parsed.performanceAsOf).toBe('2026-07-31');
    expect(parsed.published.asOf).toBe('2026-07-31');
    expect(parsed.published.y1).toBeCloseTo(0.238, 5);
    expect(parsed.published.y3ann).toBeCloseTo(0.196, 5);
    expect(parsed.published.y5ann).toBeCloseTo(0.147, 5);
    expect(parsed.published.y10ann).toBeCloseTo(0.129, 5);
    expect(parsed.published.inceptionAnn).toBeCloseTo(0.107, 5);
    expect(parsed.published.ytd).toBeCloseTo(0.12, 5);
    expect(parsed.published.calendarYears.find((r) => r.year === 2018 && !r.ytd).value).toBeCloseTo(-0.079, 5);
    expect(parsed.published.series).toBe('F');
  });

  it('reads sector / geo look-through and Series F NAV without inventing a series', () => {
    expect(parsed.sectorBreakdown.find((r) => r.label === 'Financials').weight).toBeCloseTo(31.3, 5);
    expect(parsed.countryBreakdown.find((r) => r.label === 'Canada').weight).toBeCloseTo(53.8, 5);
    expect(parsed.countryBreakdown.find((r) => r.label === 'United States').weight).toBeCloseTo(34.8, 5);
    expect(parsed.navPoint).toEqual({ date: '2026-07-31', nav: 53.66, source: 'Monthly update' });
    expect(parsed.mer).toBeCloseTo(0.79, 5);
    expect(parsed.published.navSeries).toBeUndefined();
  });
});

describe('published return merge', () => {
  it('lets FundPulse win on overlapping periods and unions calendar years', () => {
    const facts = parseFundFactsText(fixture('fidelity-uet-f-fund-facts.txt')).published;
    const pulse = parseFundPulseText(fixture('fidelity-uet-f-fundpulse.txt')).published;
    const merged = mergePublishedReturns(pulse, facts);
    expect(merged.y1).toBeCloseTo(0.5464, 5);
    expect(merged.y3ann).toBeCloseTo(0.4428, 5);
    expect(merged.calendarYears.find((r) => r.year === 2018).value).toBeCloseTo(-0.0461, 5);
    expect(merged.calendarYears.find((r) => r.ytd).value).toBeCloseTo(0.4264, 5);
    expect(hasPublishedReturns(merged)).toBe(true);
  });

  it('maps onto the NAV period-return row without filling MTD from 1-month', () => {
    const pulse = parseFundPulseText(fixture('fidelity-uet-f-fundpulse.txt')).published;
    const row = publishedToPeriodRow(pulse);
    expect(row.mtd).toBeNull();
    expect(row.qtd).toBeNull();
    expect(row.y1).toBeCloseTo(0.5464, 5);
    expect(row.y3ann).toBeCloseTo(0.4428, 5);
    expect(row.meta.y1.published).toBe(true);
    expect(row.meta.y1.estimate).toBe(false);
  });
});
