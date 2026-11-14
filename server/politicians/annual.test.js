import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { ANNUAL_HOLDINGS_SCHEMA } from '../db.js';
import { parseAssetValue, sumHoldingValues } from './assetValue.js';
import { annotateHolding, buildAnnualFiling, buildHoldingRows, selectCurrentAnnual } from './annualRecords.js';
import { presentHoldings, positionSlices } from './holdingsView.js';
import { parseHouseAnnualIndexXml, parseHouseAnnualPdf } from './parseHouseAnnual.js';
import { consumeHouseAnnualPage, createHouseAnnualParse, houseAnnualResult } from './parseHouseAnnual.js';
import { parseSenateAnnualHtml, parseSenateAnnualSearchRow } from './parseSenateAnnual.js';
import { consumeOgeAnnualPage, createOgeAnnualParse, ogeAnnualResult, parseOgeAnnualApiRow } from './parseOgeAnnual.js';
import { buildCatalog } from './nameMatch.js';
import { memoryMethods, politicianBucket } from './memoryStore.js';
import { buildPoliticianDigest } from './digest.js';
import { runPoliticianPoll } from './ingest.js';

const dir = dirname(fileURLToPath(import.meta.url));

function memoryStore() {
  const db = politicianBucket({ models: {}, instruments: {} });
  const store = { db };
  for (const [name, fn] of Object.entries(memoryMethods)) {
    store[name] = (...args) => fn.apply({ db, persist() {} }, args);
  }
  store.getAlertSettings = async () => ({ alertEmail: 'owner@example.com' });
  return store;
}

function item(str, x, y) {
  return { str, x, y };
}

describe('annual value ranges', () => {
  it('uses the midpoint of a closed statutory range and the floor of an open one', () => {
    const closed = parseAssetValue('$1,001 - $15,000');
    expect(closed).toMatchObject({ kind: 'range', min: 1001, max: 15000, mid: 8001, label: '$1,001 - $15,000' });
    const open = parseAssetValue('Over $50,000,000');
    expect(open).toMatchObject({ kind: 'at_least', min: 50000000, max: null, mid: 50000000 });
    expect(parseAssetValue('None').kind).toBe('excluded');
    expect(parseAssetValue('Undetermined').kind).toBe('excluded');
    expect(parseAssetValue('--').kind).toBe('excluded');
    expect(parseAssetValue('$1 - $1,000')).toMatchObject({ kind: 'range', min: 1, max: 1000 });
    expect(parseAssetValue('$2 - $9').kind).toBe('unreadable');
    expect(parseAssetValue('Over $1,000,000').kind).toBe('unreadable');
  });

  it('does not invent a ceiling when any row is open-ended', () => {
    const totals = sumHoldingValues([
      { valueMin: 1001, valueMax: 15000, valueMid: 8001, valueBound: 'range' },
      { valueMin: 50000000, valueMax: null, valueMid: 50000000, valueBound: 'at_least' },
    ]);
    expect(totals.openEnded).toBe(true);
    expect(totals.max).toBeNull();
    expect(totals.min).toBe(50001001);
  });
});

describe('House annual Schedule A', () => {
  it('reads the index originals and amendments, not periodic reports', () => {
    const xml = `
      <Member><FilingType>P</FilingType><DocID>2001</DocID><Year>2025</Year><Last>Pelosi</Last><First>Nancy</First><FilingDate>1/2/2025</FilingDate></Member>
      <Member><FilingType>O</FilingType><DocID>10075701</DocID><Year>2025</Year><Last>Pelosi</Last><First>Nancy</First><StateDst>CA11</StateDst><FilingDate>5/15/2026</FilingDate></Member>
      <Member><FilingType>A</FilingType><DocID>10075799</DocID><Year>2025</Year><Last>Pelosi</Last><First>Nancy</First><FilingDate>6/1/2026</FilingDate></Member>
    `;
    const rows = parseHouseAnnualIndexXml(xml);
    expect(rows.map((row) => row.filingKind)).toEqual(['original', 'amendment']);
    expect(rows[0].sourceUrl).toBe('https://disclosures-clerk.house.gov/public_disc/financial-pdfs/2025/10075701.pdf');
  });

  it('joins a wrapped value, keeps a printed ticker, and drops None', () => {
    const state = createHouseAnnualParse();
    const items = [
      item('Asset', 25, 10), item('Owner', 241, 10), item('Value of Asset', 280, 10),
      item('Apple Inc. (AAPL)', 25, 40), item('[ST]', 140, 40), item('SP', 241, 40), item('$5,000,001 -', 280, 40),
      item('$25,000,000', 280, 52),
      item('Bank of America - Checking Account', 25, 80), item('[BA]', 180, 80), item('SP', 241, 80), item('None', 280, 80),
      item('11 Zinfandel Lane - Home & Vineyard', 25, 110), item('[RP]', 190, 110), item('JT', 241, 110), item('$5,000,001 -', 280, 110),
      item('$25,000,000', 280, 122),
    ];
    consumeHouseAnnualPage(state, items);
    const parsed = houseAnnualResult(state);
    expect(parsed.excludedCount).toBe(1);
    expect(parsed.holdings).toHaveLength(2);
    const apple = parsed.holdings[0];
    expect(apple).toMatchObject({
      ticker: 'AAPL', owner: 'spouse', assetClass: 'stock', valueRange: '$5,000,001 - $25,000,000', valueMid: 15000001,
    });
    expect(parsed.holdings[1]).toMatchObject({ owner: 'joint', assetClass: 'real_estate', ticker: null });
    const filing = buildAnnualFiling({
      source: 'house', filingKey: '2025:1', first: 'Nancy', last: 'Pelosi', office: 'house',
      reportYear: 2025, filedDate: '2026-05-15', sourceUrl: 'https://example.test/pelosi', parsed,
    });
    const catalog = buildCatalog({
      rows: [[320193, 'Apple Inc.', 'AAPL', 'Nasdaq']],
      fetchedAt: '2026-11-14T00:00:00.000Z',
    });
    const [row] = buildHoldingRows(filing, parsed, catalog);
    expect(row.ticker).toBe('AAPL');
    expect(row.tickerSource).toBe('filing');
  });

  it('parses Nancy Pelosi’s 2025 annual report', async () => {
    const parsed = await parseHouseAnnualPdf(readFileSync(join(dir, 'fixtures/pelosi-2025-annual.pdf')));
    expect(parsed.status).toBe('parsed');
    expect(parsed.unreadableCount).toBe(0);
    expect(parsed.excludedCount).toBe(8);
    expect(parsed.holdings.length).toBe(60);
    const apple = parsed.holdings.find((row) => row.ticker === 'AAPL' && row.assetClass === 'stock');
    expect(apple).toMatchObject({
      owner: 'spouse',
      valueRange: '$5,000,001 - $25,000,000',
      valueBound: 'range',
    });
    const home = parsed.holdings.find((row) => /Zinfandel/.test(row.asset));
    expect(home).toMatchObject({ owner: 'joint', assetClass: 'real_estate' });
    expect(parsed.holdings.some((row) => row.valueRange === 'None')).toBe(false);
  });
});

describe('Senate and OGE annual holdings', () => {
  const senateHtml = `
    <table><thead><tr>
      <th></th><th>Asset</th><th>Asset Type</th><th>Owner</th><th>Value</th><th>Income Type</th><th>Income</th>
    </tr></thead><tbody>
      <tr><td>1</td>
        <td><strong><a href="http://finance.yahoo.com/q?s=CAT">CAT</a> - Caterpillar, Inc. Common Stock</strong></td>
        <td>Corporate Securities<div class="muted">Stock</div></td>
        <td>Self</td><td>$100,001 - $250,000</td><td>Dividends</td><td>$1,001 - $2,500</td></tr>
      <tr><td>2</td>
        <td><strong>Komatsu</strong></td>
        <td>Corporate Securities<div class="muted">Stock</div></td>
        <td>Spouse</td><td>$15,001 - $50,000</td><td>Dividends</td><td>None</td></tr>
      <tr><td>3</td>
        <td><strong>Bank of Monroe</strong></td>
        <td>Bank Deposit</td>
        <td>Joint</td><td>None (or less than $1,001)</td><td>None</td><td>None</td></tr>
      <tr><td>4</td>
        <td><strong>Family LLC</strong></td>
        <td>Business Entity<div class="muted">Limited Liability Company (LLC)</div></td>
        <td>Dependent Child</td><td>$15,001 - $50,000</td><td>None</td><td>None</td></tr>
    </tbody></table>`;

  it('reads Part 3 and does not treat a PTR link as an annual report', () => {
    expect(parseSenateAnnualSearchRow([
      'James', 'Justice', 'Senator',
      '<a href="/search/view/ptr/5a069df5-928e-4ce3-b505-e0b2312823c8/">PTR</a>',
      '09/08/2026',
    ])).toBeNull();
    const row = parseSenateAnnualSearchRow([
      'James', 'Justice', 'Senator',
      '<a href="/search/view/annual/5a069df5-928e-4ce3-b505-e0b2312823c8/">Annual Report for CY 2025 (Amendment 1)</a>',
      '09/08/2026',
    ]);
    expect(row).toMatchObject({ filingKind: 'amendment', reportYear: 2025, kind: 'annual' });
    const parsed = parseSenateAnnualHtml(senateHtml);
    expect(parsed.excludedCount).toBe(1);
    expect(parsed.holdings).toHaveLength(3);
    expect(parsed.holdings[0]).toMatchObject({ ticker: 'CAT', owner: 'self', assetClass: 'stock' });
    expect(parsed.holdings[1]).toMatchObject({ ticker: null, owner: 'spouse', asset: 'Komatsu' });
    expect(parsed.holdings[2]).toMatchObject({ owner: 'dependent', assetClass: 'private' });
  });

  it('reads a 278e Part 6 value column and ignores income', () => {
    const api = parseOgeAnnualApiRow({
      type: "<a href='https://extapps2.oge.gov/201/Presiden.nsf/PAS+Index/69AEAA9D7455ACD585258E27002DDEE1/$FILE/Donald-J-Trump-2026-278ANNUAL.pdf'>Annual (2026)</a>",
      name: 'Trump, Donald J',
      title: 'President',
      docDate: '2026-07-01T04:21:01',
    });
    expect(api.office).toBe('president');
    expect(api.filingKey).toBe('69AEAA9D7455ACD585258E27002DDEE1');
    expect(parseOgeAnnualApiRow({
      type: '<a href="https://example.test/t.pdf">278 Transaction</a>',
      name: 'Trump, Donald J', title: 'President', docDate: '2026-07-01',
    })).toBeNull();

    const state = createOgeAnnualParse();
    consumeOgeAnnualPage(state, [
      item('Year (Annual Report only):', 20, 20), item('2025', 180, 20),
      item('Part 6: Other Assets and Income', 16, 40),
      item('Description', 38, 60), item('EIF', 452, 60), item('Value', 477, 60), item('Income Type', 562, 60), item('Income Amount', 640, 60),
      item('***CARNIVAL CORP', 38, 90), item('N/A', 452, 90), item('$1,000,001 - $5,000,000', 477, 90), item('None (or less than $201)', 640, 90),
      item('***NETFLIX INC REG S DUE 11/15/2029 5.375', 38, 120), item('N/A', 452, 120), item('$1,000,001 - $5,000,000', 477, 120), item('INTEREST', 562, 120),
      item('SPDR PORTFOLIO HIGH YIELD BOND ETF', 38, 150), item('Yes', 452, 150), item('None (or less than $1,001)', 477, 150),
    ]);
    const parsed = ogeAnnualResult(state);
    expect(parsed.reportYear).toBe(2025);
    expect(parsed.excludedCount).toBe(1);
    expect(parsed.holdings).toHaveLength(2);
    expect(parsed.holdings[0]).toMatchObject({ owner: 'unknown', assetClass: 'other', valueRange: '$1,000,001 - $5,000,000' });
    expect(parsed.holdings[1]).toMatchObject({ assetClass: 'bond', ticker: null });
  });
});

describe('versioning and the chart', () => {
  it('lets a parsed amendment supersede, and does not hide a readable original behind an unreadable one', () => {
    const original = { id: 'a', reportYear: 2025, filedDate: '2026-05-15', filingKind: 'original', parseStatus: 'parsed', filingKey: '1' };
    const amendment = { id: 'b', reportYear: 2025, filedDate: '2026-08-01', filingKind: 'amendment', parseStatus: 'parsed', filingKey: '2' };
    expect(selectCurrentAnnual([original, amendment]).current.id).toBe('b');
    const broken = { ...amendment, id: 'c', parseStatus: 'needs_manual_review' };
    const picked = selectCurrentAnnual([original, broken]);
    expect(picked.current.id).toBe('a');
    expect(picked.newerUnreadable.id).toBe('c');
    const older = { id: 'd', reportYear: 2024, filedDate: '2025-05-15', filingKind: 'original', parseStatus: 'parsed', filingKey: '0' };
    const unreadNew = { id: 'e', reportYear: 2025, filedDate: '2026-05-15', filingKind: 'original', parseStatus: 'needs_manual_review', filingKey: '9' };
    expect(selectCurrentAnnual([older, unreadNew]).current.id).toBe('e');
  });

  it('rolls up past the top 12 and labels the total as an estimate', () => {
    const rows = Array.from({ length: 14 }, (_, i) => ({
      id: `h${i}`,
      filingId: 'f',
      asset: `Asset ${i}`,
      ticker: i === 0 ? 'AAPL' : null,
      tickerNorm: i === 0 ? 'AAPL' : null,
      assetClass: i === 0 || i % 2 ? 'stock' : 'bond',
      owner: 'self',
      valueRange: '$1,001 - $15,000',
      valueMin: 1001,
      valueMax: 15000,
      valueMid: i === 0 ? 90000 : 8001,
      valueBound: 'range',
    }));
    const slices = positionSlices(rows, 12);
    expect(slices).toHaveLength(13);
    expect(slices.at(-1).kind).toBe('other');
    expect(slices.at(-1).count).toBe(2);
    expect(slices.reduce((sum, slice) => sum + slice.pct, 0)).toBeCloseTo(100, 5);
    const view = presentHoldings({
      filings: [{
        id: 'f', reportYear: 2025, filedDate: '2026-05-15', filingKind: 'original',
        parseStatus: 'parsed', sourceUrl: 'https://example.test/fd', excludedCount: 3,
      }],
      holdings: rows,
      held: new Map([['AAPL', [{ key: 'growth', name: 'Growth' }]]]),
    });
    expect(view.filing.year).toBe(2025);
    expect(view.totals.label).toBe('$14,014 – $210,000');
    expect(view.positions[0].heldModels).toEqual([{ key: 'growth', name: 'Growth' }]);
    expect(view.classes.length).toBeGreaterThan(1);
  });

  it('matches a missing ticker from the name and does not replace a printed one', () => {
    const catalog = buildCatalog({
      rows: [[789019, 'MICROSOFT CORP', 'MSFT', 'Nasdaq']],
      fetchedAt: '2026-11-14T00:00:00.000Z',
    });
    const matched = annotateHolding({
      asset: 'Microsoft Corp', ticker: null, assetClass: 'stock',
    }, catalog);
    expect(matched.ticker).toBe('MSFT');
    expect(matched.tickerSource).toBe('name_match');
    const printed = annotateHolding({
      asset: 'Microsoft Corp', ticker: 'MSFT', assetClass: 'stock',
    }, catalog);
    expect(printed.tickerSource).toBe('filing');
    const bond = annotateHolding({
      asset: 'Netflix Inc due 11/15/2029 5.375', ticker: null, assetClass: 'bond',
    }, catalog);
    expect(bond.ticker).toBeNull();
  });

  it('stores a filing once and does not email holdings', async () => {
    const store = memoryStore();
    const filing = buildAnnualFiling({
      source: 'house', filingKey: '2025:10075701', first: 'Nancy', last: 'Pelosi', office: 'house',
      reportYear: 2025, filedDate: '2026-05-15', filingKind: 'original',
      sourceUrl: 'https://disclosures-clerk.house.gov/pelosi',
      parsed: { status: 'parsed', excludedCount: 1 },
    });
    const rows = buildHoldingRows(filing, {
      holdings: [{
        asset: 'Apple Inc.', ticker: 'AAPL', assetClass: 'stock', owner: 'spouse',
        valueRange: '$5,000,001 - $25,000,000', valueMin: 5000001, valueMax: 25000000,
        valueMid: 15000001, valueBound: 'range',
      }],
    });
    expect((await store.insertAnnualBundle(filing, rows)).created).toBe(true);
    expect((await store.insertAnnualBundle(filing, rows)).created).toBe(false);
    expect(store.db.politicianHoldings).toHaveLength(1);
    const digest = buildPoliticianDigest({
      trades: [{
        personName: 'Nancy Pelosi', office: 'house', ticker: 'AAPL', tickerNorm: 'AAPL',
        assetClass: 'stock', asset: 'Apple Inc.', owner: 'self', txType: 'buy',
        txDate: '2026-01-02', disclosedDate: '2026-02-02', amountRange: '$1,001 - $15,000',
        sourceUrl: 'https://example.test/ptr',
      }],
    });
    expect(digest.text).not.toContain('annual report');
    expect(digest.text).not.toContain('$5,000,001');
    const email = { send: vi.fn(async () => ({ ok: true, id: 'm1' })) };
    await store.savePoliticianAlertSettings({ politicianAlertsEnabled: true });
    await store.setPoliticianPollState({ backfillComplete: true, alertsArmed: true, lastSuccessAt: '2020-01-01T00:00:00.000Z' });
    await runPoliticianPoll({
      store,
      fetchImpl: async () => ({
        status: 503, ok: false,
        headers: { get: () => null, getSetCookie: () => [] },
        text: async () => '', arrayBuffer: async () => Buffer.alloc(0),
      }),
      email,
      now: () => new Date('2026-11-14T18:00:00Z'),
      sleep: async () => {},
      logger: { log() {}, warn() {}, error() {} },
      env: { ...process.env, POLITICIAN_FETCH_DELAY_MS: '0' },
      ocrTools: async () => false,
      force: true,
    });
    const sent = email.send.mock.calls.map((call) => `${call[0].subject}\n${call[0].text}`).join('\n');
    expect(sent).not.toContain('Zinfandel');
    expect(sent).not.toContain('$5,000,001 - $25,000,000');
    expect(ANNUAL_HOLDINGS_SCHEMA).toContain('politician_holdings');
    expect(ANNUAL_HOLDINGS_SCHEMA).toContain('politician_annual_filings');
  });
});
