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

  it('maps Fundserv FID5982 / 5982 / FID-5982 to Fidelity Series F Fund Facts', () => {
    const a = lookupSource('FID5982');
    const b = lookupSource('fid5982');
    const c = lookupSource('5982');
    const d = lookupSource('FID-5982');
    expect(a.issuer).toBe('Fidelity Canada');
    expect(a.series).toBe('F');
    expect(a.fundserv).toBe('5982');
    expect(a.url).toMatch(/FF_UET_F_en\.pdf$/);
    expect(a.fundPulseUrl).toMatch(/fp_fgic\.pdf$/);
    expect(a.url).toBe(b.url);
    expect(c.symbol).toBe('FID5982');
    expect(d.symbol).toBe('FID5982');
    expect(lookupSource('RBF1005')).toBeNull();
  });

  it('maps Fundserv RBF608 / 608 / RBF-608 to RBC Series F Fund Facts', () => {
    const a = lookupSource('RBF608');
    const b = lookupSource('rbf608');
    const c = lookupSource('608');
    const d = lookupSource('RBF-608');
    expect(a.issuer).toBe('RBC GAM');
    expect(a.series).toBe('F');
    expect(a.fundserv).toBe('608');
    expect(a.url).toMatch(/rbf608_e\.pdf$/);
    expect(a.monthlyUrl).toMatch(/monthly\/rbf608_e\.pdf$/);
    expect(a.url).toBe(b.url);
    expect(c.symbol).toBe('RBF608');
    expect(d.symbol).toBe('RBF608');
  });

  it('maps IDIV.B / IDIV.B.TO / IDIVB / IDIVB.TO to the Manulife ETF PDF', () => {
    const a = lookupSource('IDIV.B');
    const b = lookupSource('IDIV.B.TO');
    const c = lookupSource('IDIVB');
    const d = lookupSource('idivb.to');
    const e = lookupSource('IDIV-B');
    expect(a.issuer).toBe('Manulife');
    expect(a.kind).toBe('manulife-etf');
    expect(a.url).toBe('https://funds.manulife.ca/en-us/etfs/IDIV.B/pdf');
    expect(a.parser).toBe('pdf');
    expect(a.url).toBe(b.url);
    expect(b.url).toBe(c.url);
    expect(c.url).toBe(d.url);
    expect(d.url).toBe(e.url);
    expect(a.symbol).toBe('IDIV.B');
    expect(b.symbol).toBe('IDIV.B');
    expect(c.symbol).toBe('IDIV.B');
  });

  it('lists only mapped symbols', () => {
    const list = listMappedSymbols();
    expect(list).toContain('VFV.TO');
    expect(list).toContain('SPY');
    expect(list).toContain('FID5982');
    expect(list).toContain('IDIV.B');
    expect(list).toContain('RBF608');
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

  it('fetches FID5982 Fund Facts + FundPulse from fixtures (no live network)', async () => {
    const facts = fixture('fidelity-uet-f-fund-facts.txt');
    const pulse = fixture('fidelity-uet-f-fundpulse.txt');
    const fetchImpl = async (url) => {
      const body = /fp_fgic|fund-pulse/i.test(url) ? pulse : facts;
      return {
        ok: true,
        status: 200,
        url,
        headers: { get: () => 'application/pdf' },
        arrayBuffer: async () => body,
      };
    };
    const out = await fetchBreakdownForSymbol('FID5982', { fetchImpl, now: new Date('2026-09-07T12:00:00Z') });
    expect(out.proposed.breakdownAsOf).toBe('2026-02-28');
    expect(out.proposed.breakdownNote).toBe('Issuer Fund Facts · Fidelity Canada · scraped 2026-09-07');
    expect(out.proposed.sectorBreakdown.find((r) => r.label === 'Information Technology').weight).toBeCloseTo(44.5, 5);
    expect(out.proposed.countryBreakdown.find((r) => r.label === 'United States').weight).toBeCloseTo(64.7, 5);
    expect(out.proposed.mer).toBeCloseTo(1.10, 5);
    expect(out.proposed.publishedReturns.y1).toBeCloseTo(0.5464, 5);
    expect(out.proposed.publishedReturns.y3ann).toBeCloseTo(0.4428, 5);
    expect(out.proposed.publishedReturns.source).toMatch(/FundPulse/);
    expect(out.proposed.publishedReturns.series).toBe('F');
    expect(out.proposed.publishedPeriodReturns.mtd).toBeNull();
    expect(out.proposed.publishedPeriodReturns.y1).toBeCloseTo(0.5464, 5);
    expect(out.proposed.navPoint).toMatchObject({ date: '2026-08-31', nav: 69.75 });
    expect(out.proposed.publishedReturns.navSeries).toBeUndefined();
  });

  it('fetches IDIV.B Manulife factsheet from fixture (no live network)', async () => {
    const body = fixture('manulife-idiv-b.txt');
    const fetchImpl = async (url) => {
      expect(url).toMatch(/funds\.manulife\.ca\/en-us\/etfs\/IDIV\.B\/pdf$/);
      return {
        ok: true,
        status: 200,
        url,
        headers: { get: () => 'application/pdf' },
        arrayBuffer: async () => body,
      };
    };
    const out = await fetchBreakdownForSymbol('IDIV.B', { fetchImpl, now: new Date('2026-09-08T12:00:00Z') });
    expect(out.mapped).toBe(true);
    expect(out.source.issuer).toBe('Manulife');
    expect(out.proposed.breakdownAsOf).toBe('2026-07-31');
    expect(out.proposed.breakdownNote).toBe('Issuer factsheet · Manulife · scraped 2026-09-08');
    expect(out.proposed.sectorBreakdown.find((r) => r.label === 'Financials').weight).toBeCloseTo(32.1, 5);
    expect(out.proposed.countryBreakdown.find((r) => r.label === 'Japan').weight).toBeCloseTo(18.9, 5);
    expect(out.proposed.mer).toBeCloseTo(0.40, 5);
    expect(out.proposed.publishedReturns.ytd).toBeCloseTo(0.1847, 5);
    expect(out.proposed.publishedReturns.y1).toBeCloseTo(0.3386, 5);
    expect(out.proposed.publishedReturns.y3ann).toBeCloseTo(0.2386, 5);
    expect(out.proposed.publishedReturns.source).toMatch(/Manulife/);
    expect(out.proposed.publishedPeriodReturns.mtd).toBeNull();
    expect(out.proposed.publishedPeriodReturns.y1).toBeCloseTo(0.3386, 5);
    expect(out.proposed.navPoint).toMatchObject({ date: '2026-09-04', nav: 21.07 });
    expect(out.proposed.publishedReturns.navSeries).toBeUndefined();
  });

  it('fetches RBF608 Fund Facts + monthly update from fixtures (no live network)', async () => {
    const facts = fixture('rbc-rbf608-fund-facts.txt');
    const monthly = fixture('rbc-rbf608-monthly.txt');
    const fetchImpl = async (url) => {
      const body = /monthly/i.test(url) ? monthly : facts;
      return {
        ok: true,
        status: 200,
        url,
        headers: { get: () => 'application/pdf' },
        arrayBuffer: async () => body,
      };
    };
    const out = await fetchBreakdownForSymbol('RBF608', { fetchImpl, now: new Date('2026-09-08T12:00:00Z') });
    expect(out.mapped).toBe(true);
    expect(out.source.issuer).toBe('RBC GAM');
    expect(out.proposed.breakdownAsOf).toBe('2026-07-31');
    expect(out.proposed.breakdownNote).toMatch(/Monthly update · RBC GAM · scraped 2026-09-08/);
    expect(out.proposed.sectorBreakdown.find((r) => r.label === 'Financials').weight).toBeCloseTo(31.3, 5);
    expect(out.proposed.countryBreakdown.find((r) => r.label === 'Canada').weight).toBeCloseTo(53.8, 5);
    expect(out.proposed.mer).toBeCloseTo(0.79, 5);
    expect(out.proposed.publishedReturns.y1).toBeCloseTo(0.238, 5);
    expect(out.proposed.publishedReturns.y3ann).toBeCloseTo(0.196, 5);
    expect(out.proposed.publishedReturns.source).toMatch(/Monthly update/);
    expect(out.proposed.publishedReturns.series).toBe('F');
    expect(out.proposed.publishedPeriodReturns.mtd).toBeNull();
    expect(out.proposed.publishedPeriodReturns.y1).toBeCloseTo(0.238, 5);
    expect(out.proposed.navPoint).toMatchObject({ date: '2026-07-31', nav: 53.66 });
    expect(out.proposed.publishedReturns.navSeries).toBeUndefined();
  });
});
