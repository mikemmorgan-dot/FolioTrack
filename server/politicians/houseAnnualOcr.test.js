import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { annualCoverage } from './annualIngest.js';
import { buildAnnualFiling, buildHoldingRows } from './annualRecords.js';
import { buildPoliticianDigest } from './digest.js';
import { memoryMethods, politicianBucket } from './memoryStore.js';
import { presentHoldings } from './holdingsView.js';

function memoryStore() {
  const db = politicianBucket({ models: {}, instruments: {} });
  const store = { db };
  for (const [name, fn] of Object.entries(memoryMethods)) {
    store[name] = (...args) => fn.apply({ db, persist() {} }, args);
  }
  return store;
}

describe('House annual OCR queue and revisits', () => {
  it('counts pending_ocr separately and lists House filings for the OCR job', async () => {
    const store = memoryStore();
    const scanned = buildAnnualFiling({
      source: 'house', filingKey: '2025:9116175', first: 'Jamie', last: 'Raskin', office: 'house',
      reportYear: 2025, filedDate: '2026-05-15', sourceUrl: 'https://example.test/raskin.pdf',
      parsed: { status: 'pending_ocr', note: 'pending', ocrDone: false },
    });
    const empty = buildAnnualFiling({
      source: 'house', filingKey: '2025:10076811', first: 'Clay', last: 'Higgins', office: 'house',
      reportYear: 2025, filedDate: '2026-05-06', sourceUrl: 'https://example.test/higgins.pdf',
      parsed: { status: 'parsed', note: 'Schedule A reported none disclosed.' },
    });
    const oge = buildAnnualFiling({
      source: 'oge', filingKey: 'ABC', first: 'Donald', last: 'Trump', office: 'president',
      reportYear: 2025, filedDate: '2026-07-01', sourceUrl: 'https://example.test/278e.pdf',
      parsed: { status: 'pending_ocr', note: 'pending', ocrDone: false },
    });
    await store.insertAnnualBundle(scanned, []);
    await store.insertAnnualBundle(empty, []);
    await store.insertAnnualBundle(oge, []);
    const coverage = annualCoverage(await store.listAnnualFilingSummaries());
    expect(coverage).toMatchObject({ parsed: 1, pendingOcr: 2, unreadable: 0 });
    const houseOnly = await store.listPendingAnnualOcr({ sources: ['house'] });
    expect(houseOnly.map((row) => row.filingKey)).toEqual(['2025:9116175']);
    const ogeOnly = await store.listPendingAnnualOcr({ sources: ['oge'] });
    expect(ogeOnly.map((row) => row.filingKey)).toEqual(['ABC']);
  });

  it('replaces a needs_manual_review House filing when the parser is rerun', async () => {
    const store = memoryStore();
    const filing = buildAnnualFiling({
      source: 'house', filingKey: '2025:1', first: 'Clay', last: 'Higgins', office: 'house',
      reportYear: 2025, filedDate: '2026-05-06', sourceUrl: 'https://example.test/higgins.pdf',
      parsed: { status: 'needs_manual_review', note: 'No Schedule A text layer. The annual report looks scanned, so no holdings were guessed.', parserVersion: 0 },
    });
    filing.parserVersion = 0;
    await store.insertAnnualBundle(filing, []);
    expect((await store.listRevisitableAnnualFilings({ source: 'house', limit: 5 }))).toHaveLength(1);
    const updated = {
      ...filing,
      parseStatus: 'parsed',
      parseNote: 'Schedule A reported none disclosed.',
    };
    const again = await store.insertAnnualBundle(updated, [], { replace: true });
    expect(again.created).toBe(false);
    const [row] = await store.listAnnualFilingsForPerson(filing.personKey);
    expect(row.parseStatus).toBe('parsed');
    expect(row.parseNote).toMatch(/none disclosed/i);
    expect(await store.listRevisitableAnnualFilings({ source: 'house' })).toEqual([]);
  });

  it('does not put OCR annual holdings in the trade digest', () => {
    const digest = buildPoliticianDigest({
      trades: [{
        personName: 'Jamie Raskin', office: 'house', ticker: 'VB', tickerNorm: 'VB',
        assetClass: 'etf', asset: 'Vanguard Small-Cap ETF', owner: 'joint', txType: 'buy',
        txDate: '2024-09-05', disclosedDate: '2026-05-15', amountRange: '$1,001 - $15,000',
        sourceUrl: 'https://example.test/ptr',
      }],
    });
    const holdings = buildHoldingRows(buildAnnualFiling({
      source: 'house', filingKey: '2025:1', first: 'Jamie', last: 'Raskin', office: 'house',
      reportYear: 2025, filedDate: '2026-05-15', sourceUrl: 'https://example.test/raskin.pdf',
      parsed: { status: 'partial', holdings: [] },
    }), {
      holdings: [{
        asset: 'TIAA CREF Total Global Stock',
        owner: 'self',
        valueRange: '$100,001 - $250,000',
        valueMin: 100001,
        valueMax: 250000,
        valueMid: 175001,
        valueBound: 'range',
        ocr: true,
        ocrConfidence: 82,
        assetClass: 'etf_fund',
      }],
    });
    expect(holdings[0].ocr).toBe(true);
    expect(digest.text).not.toContain('TIAA');
    expect(digest.text).not.toContain('$100,001');
    const view = presentHoldings({
      filings: [buildAnnualFiling({
        source: 'house', filingKey: '2025:1', first: 'Jamie', last: 'Raskin', office: 'house',
        reportYear: 2025, filedDate: '2026-05-15', sourceUrl: 'https://example.test/raskin.pdf',
        parsed: { status: 'partial', note: 'Holdings were read by OCR and values were not guessed.' },
      })],
      holdings,
    });
    expect(view.ocrCount).toBe(1);
    expect(view.positions[0].ocr).toBe(true);
    expect(view.positions[0].ocrConfidence).toBe(82);
  });

  it('does not list Senate paper filings for House OCR', async () => {
    const store = memoryStore();
    await store.insertAnnualBundle(buildAnnualFiling({
      source: 'senate', filingKey: 'paper:1', first: 'Maria', last: 'Cantwell', office: 'senate',
      reportYear: 2025, filedDate: '2026-05-15', sourceUrl: 'https://example.test/cantwell',
      parsed: { status: 'needs_manual_review', note: 'Paper annual report. The Senate publishes this as a scanned image, so the holdings were not guessed.' },
    }), []);
    expect(await store.listRevisitableAnnualFilings({ source: 'house' })).toEqual([]);
    expect(await store.listPendingAnnualOcr({ sources: ['house'] })).toEqual([]);
    expect(annualCoverage(await store.listAnnualFilingSummaries()).unreadable).toBe(1);
  });

  it('keeps the Actions default at 8 filings every 4 hours', () => {
    const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
    const yml = readFileSync(join(root, '.github/workflows/house-annual-ocr.yml'), 'utf8');
    const js = readFileSync(join(root, 'server/politicians/houseAnnualOcr.js'), 'utf8');
    expect(yml).toContain("cron: '45 */4 * * *'");
    expect(yml).toContain('Blank uses 8.');
    expect(yml).toContain('timeout-minutes: 60');
    expect(yml).toContain('group: house-annual-ocr');
    expect(yml).toContain('cancel-in-progress: false');
    expect(js).toMatch(/Number\(env\.HOUSE_OCR_LIMIT\) \|\| 8/);
  });
});
