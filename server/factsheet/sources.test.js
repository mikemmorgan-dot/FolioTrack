import { describe, it, expect } from 'vitest';
import { lookupSource, listMappedSymbols, FACTSHEET_SOURCES } from './sources.js';
import { fetchBreakdownForSymbol, BreakdownFetchError, buildNote } from './fetchBreakdown.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const dir = path.dirname(fileURLToPath(import.meta.url));
const fixture = (name) => fs.readFileSync(path.join(dir, 'fixtures', name));

describe('lookupSource', () => {
  it('maps VFV / VFV.TO / vfv.to to the same Vanguard PDF', () => {
    const a = lookupSource('VFV');
    const b = lookupSource('VFV.TO');
    const c = lookupSource('vfv.to');
    expect(a.issuer).toBe('Vanguard Canada');
    expect(a.url).toBe(b.url);
    expect(b.url).toBe(c.url);
    expect(a.parser).toBe('pdf');
  });

  it('maps common Canadian + US tickers and skips stocks', () => {
    expect(lookupSource('XEQT.TO').issuer).toBe('iShares Canada');
    expect(lookupSource('XBB').issuer).toBe('iShares Canada');
    expect(lookupSource('SPY').issuer).toBe('State Street');
    expect(lookupSource('ZSP.TO').issuer).toBe('BMO');
    expect(lookupSource('RY.TO')).toBeNull();
    expect(lookupSource('CASH')).toBeNull();
    expect(lookupSource('OCIC')).toBeNull();
  });

  it('lists only mapped symbols', () => {
    const list = listMappedSymbols();
    expect(list).toContain('VFV.TO');
    expect(list).toContain('SPY');
    expect(list.every((s) => FACTSHEET_SOURCES[s])).toBe(true);
  });
});

describe('buildNote', () => {
  it('labels estimates when as-of or weights are uncertain', () => {
    expect(buildNote({ issuer: 'Vanguard Canada', scrapedAt: '2026-09-04' }))
      .toBe('Issuer factsheet · Vanguard Canada · scraped 2026-09-04');
    expect(buildNote({ issuer: 'iShares Canada', scrapedAt: '2026-09-04', asOfEstimated: true, estimates: true }))
      .toBe('Issuer factsheet · iShares Canada · scraped 2026-09-04 · as-of estimated · estimates');
  });
});

describe('fetchBreakdownForSymbol (mocked network)', () => {
  it('returns a proposed payload and does not need a live issuer', async () => {
    const html = fixture('ishares-xic.html');
    const fetchImpl = async () => ({
      ok: true,
      status: 200,
      url: 'https://www.blackrock.com/ca/investors/en/products/239837/xic',
      headers: { get: () => 'text/html' },
      arrayBuffer: async () => html,
    });
    const out = await fetchBreakdownForSymbol('XIC.TO', { fetchImpl, now: new Date('2026-09-04T12:00:00Z') });
    expect(out.mapped).toBe(true);
    expect(out.source.issuer).toBe('iShares Canada');
    expect(out.proposed.breakdownAsOf).toBe('2026-09-03');
    expect(out.proposed.breakdownNote).toMatch(/^Issuer factsheet · iShares Canada · scraped 2026-09-04/);
    expect(out.proposed.sectorBreakdown[0].label).toBe('Financials');
    expect(out.proposed.countryBreakdown[0].label).toBe('Canada');
  });

  it('parses a mocked Vanguard PDF', async () => {
    const pdf = fixture('vanguard-vfv-mini.pdf');
    const fetchImpl = async () => ({
      ok: true,
      status: 200,
      url: 'https://fund-docs.vanguard.com/VFV.pdf',
      headers: { get: () => 'application/pdf' },
      arrayBuffer: async () => pdf,
    });
    const out = await fetchBreakdownForSymbol('VFV.TO', { fetchImpl, now: new Date('2026-09-04T12:00:00Z') });
    expect(out.proposed.breakdownAsOf).toBe('2026-07-31');
    expect(out.proposed.sectorBreakdown.find((r) => r.label === 'Information Technology').weight).toBeCloseTo(36.6, 5);
  });

  it('errors clearly when unmapped, non-200, or parse miss — no proposed rows', async () => {
    await expect(fetchBreakdownForSymbol('RY.TO')).rejects.toMatchObject({
      name: 'BreakdownFetchError', status: 422, code: 'unmapped',
    });

    const notOk = async () => ({
      ok: false, status: 404, url: 'https://example.test',
      headers: { get: () => 'text/html' },
      arrayBuffer: async () => Buffer.from(''),
    });
    await expect(fetchBreakdownForSymbol('SPY', { fetchImpl: notOk })).rejects.toBeInstanceOf(BreakdownFetchError);

    const empty = async () => ({
      ok: true, status: 200, url: 'https://www.ssga.com/spy',
      headers: { get: () => 'text/html' },
      arrayBuffer: async () => Buffer.from('<html><body>no tables</body></html>'),
    });
    await expect(fetchBreakdownForSymbol('SPY', { fetchImpl: empty })).rejects.toMatchObject({ code: 'parse' });
  });
});
