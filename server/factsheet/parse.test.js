import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  parseAsOfDate,
  extractAsOf,
  parseFactsheetText,
  parseFactsheetHtml,
  parseFactsheetPdf,
  extractBlackRockTables,
  findFactsheetPdfUrl,
} from './parse.js';

const dir = path.dirname(fileURLToPath(import.meta.url));
const fixture = (name) => fs.readFileSync(path.join(dir, 'fixtures', name));

describe('parseAsOfDate', () => {
  it('parses month-day-year and ISO', () => {
    expect(parseAsOfDate('July 31, 2026')).toBe('2026-07-31');
    expect(parseAsOfDate('Sep 3, 2026')).toBe('2026-09-03');
    expect(parseAsOfDate('31 July 2026')).toBe('2026-07-31');
    expect(parseAsOfDate('as of 2026-06-30')).toBe('2026-06-30');
  });
});

describe('extractAsOf', () => {
  it('prefers a Factsheet | date over a generic as-of', () => {
    const r = extractAsOf('Factsheet | July 31, 2026\nas of Sep 3, 2026');
    expect(r.asOf).toBe('2026-07-31');
    expect(r.estimated).toBe(false);
  });
});

describe('Vanguard PDF text fixture', () => {
  const parsed = parseFactsheetText(fixture('vanguard-vfv-pdf.txt').toString('utf8'));

  it('reads the factsheet as-of and GICS sector weights', () => {
    expect(parsed.asOf).toBe('2026-07-31');
    expect(parsed.asOfEstimated).toBe(false);
    const it = parsed.sectorBreakdown.find((r) => r.label === 'Information Technology');
    expect(it.weight).toBeCloseTo(36.6, 5);
    expect(parsed.sectorBreakdown.find((r) => r.label === 'Financials').weight).toBeCloseTo(12.5, 5);
    expect(parsed.sectorBreakdown.some((r) => r.label === 'Diversified' && r.weight === 0)).toBe(false);
  });

  it('skips the Total row', () => {
    expect(parsed.sectorBreakdown.every((r) => !/^total$/i.test(r.label))).toBe(true);
  });
});

describe('Vanguard mini PDF', () => {
  it('extracts text from a committed PDF snippet', async () => {
    const parsed = await parseFactsheetPdf(fixture('vanguard-vfv-mini.pdf'));
    expect(parsed.asOf).toBe('2026-07-31');
    expect(parsed.sectorBreakdown.map((r) => r.label)).toEqual(
      expect.arrayContaining(['Information Technology', 'Financials'])
    );
    expect(parsed.countryBreakdown[0]).toEqual({ label: 'United States', weight: 99.2 });
  });
});

describe('iShares / BlackRock HTML fixture', () => {
  const html = fixture('ishares-xic.html').toString('utf8');
  const parsed = parseFactsheetHtml(html);

  it('reads sector + country arrays from embedded DataTable JS', () => {
    const js = extractBlackRockTables(html);
    expect(js.sector[0].label).toBe('Financials');
    expect(parsed.asOf).toBe('2026-09-03');
    expect(parsed.sectorBreakdown[0]).toEqual({ label: 'Financials', weight: 34.5 });
    expect(parsed.countryBreakdown[0]).toEqual({ label: 'Canada', weight: 99.4 });
    expect(parsed.countryBreakdown.every((r) => r.label !== 'Cash and/or Derivatives')).toBe(true);
  });
});

describe('SSGA SPY HTML fixture', () => {
  const parsed = parseFactsheetHtml(fixture('ssga-spy.html').toString('utf8'));

  it('reads sector and country tables', () => {
    expect(parsed.asOf).toBe('2026-07-31');
    expect(parsed.sectorBreakdown.find((r) => r.label === 'Information Technology').weight).toBeCloseTo(37.8, 5);
    expect(parsed.countryBreakdown.find((r) => r.label === 'United States').weight).toBeCloseTo(99.2, 5);
  });

  it('does not double weights when the same sector table is repeated (fund + clone)', () => {
    const html = fixture('ssga-spy.html').toString('utf8');
    const doubled = html.replace('</body>', `${html.match(/<table>[\s\S]*?<\/table>/)[0]}</body>`);
    const parsed = parseFactsheetHtml(doubled);
    expect(parsed.sectorBreakdown.find((r) => r.label === 'Information Technology').weight).toBeCloseTo(37.8, 5);
  });
});

describe('BMO HTML fixture', () => {
  const html = fixture('bmo-zsp.html').toString('utf8');
  const parsed = parseFactsheetHtml(html);

  it('maps issuer aliases onto FolioTrack sector names', () => {
    expect(parsed.asOf).toBe('2026-06-30');
    expect(parsed.sectorBreakdown.find((r) => r.label === 'Information Technology').weight).toBeCloseTo(36.1, 5);
    expect(parsed.sectorBreakdown.find((r) => r.label === 'Financials').weight).toBeCloseTo(13.2, 5);
    expect(parsed.sectorBreakdown.find((r) => r.label === 'Health Care').weight).toBeCloseTo(9.0, 5);
    expect(parsed.sectorBreakdown.find((r) => r.label === 'Consumer Discretionary').weight).toBeCloseTo(10.4, 5);
    expect(parsed.sectorBreakdown.find((r) => r.label === 'Materials').weight).toBeCloseTo(1.7, 5);
  });

  it('finds a follow-on factsheet PDF link', () => {
    expect(findFactsheetPdfUrl(html, 'https://www.bmogam.com/zsp/')).toMatch(/zsp-factsheet\.pdf$/);
  });
});
