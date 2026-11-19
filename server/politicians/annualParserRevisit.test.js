import { describe, expect, it } from 'vitest';
import express from 'express';
import { ANNUAL_HOLDINGS_SCHEMA } from '../db.js';
import { buildAnnualFiling, buildHoldingRows } from './annualRecords.js';
import { buildPoliticianDigest } from './digest.js';
import { createPoliticianRouter } from './http.js';
import { memoryMethods, politicianBucket } from './memoryStore.js';
import { nextAnnualIngestDelay, startAnnualIngest } from './annualSchedule.js';
import {
  runParserRevisitSlice,
  withParserRevisitStatus,
} from './annualParserRevisit.js';
import {
  ANNUAL_PARSER_REVISIT_INTERVAL_MS,
  ANNUAL_PARSER_VERSION,
  isSenatePaperAnnual,
  isStaleParserFiling,
  shouldRefetchStaleParserFiling,
} from './annualParserVersion.js';

function memoryStore() {
  const db = politicianBucket({ models: {}, instruments: {} });
  const store = { db };
  for (const [name, fn] of Object.entries(memoryMethods)) {
    store[name] = (...args) => fn.apply({ db, persist() {} }, args);
  }
  return store;
}

function staleFiling(overrides = {}, parsedOverrides = {}) {
  const filing = buildAnnualFiling({
    source: 'house',
    filingKey: '2025:1',
    first: 'Brian',
    last: 'Fitzpatrick',
    office: 'house',
    reportYear: 2025,
    filedDate: '2026-05-15',
    sourceUrl: 'https://example.test/fitzpatrick.pdf',
    parsed: {
      status: 'needs_manual_review',
      note: 'Schedule A was present, but no value range could be read. Those rows were not guessed.',
      parserVersion: 0,
      ...parsedOverrides,
    },
    ...overrides,
  });
  filing.parserVersion = parsedOverrides.parserVersion ?? 0;
  return filing;
}

describe('annual parser version revisit', () => {
  it('treats a missing or older version as stale and never refetches Senate paper', () => {
    expect(isStaleParserFiling({ parseStatus: 'needs_manual_review' }, 1)).toBe(true);
    expect(isStaleParserFiling({ parseStatus: 'partial', parserVersion: 0 }, 1)).toBe(true);
    expect(isStaleParserFiling({ parseStatus: 'parsed', parserVersion: 0 }, 1)).toBe(false);
    expect(isStaleParserFiling({ parseStatus: 'pending_ocr', parserVersion: 0 }, 1)).toBe(false);
    expect(isStaleParserFiling({ parseStatus: 'needs_manual_review', parserVersion: 1 }, 1)).toBe(false);

    const paper = {
      source: 'senate',
      sourceUrl: 'https://efdsearch.senate.gov/search/view/paper/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee/',
      parseStatus: 'needs_manual_review',
      parseNote: 'Paper annual report. The Senate publishes this as a scanned image, so the holdings were not guessed.',
      parserVersion: 0,
    };
    expect(isSenatePaperAnnual(paper)).toBe(true);
    expect(shouldRefetchStaleParserFiling(paper)).toBe(false);
    expect(shouldRefetchStaleParserFiling({
      source: 'house',
      sourceUrl: 'https://example.test/a.pdf',
      ocrDone: true,
    })).toBe(false);
  });

  it('adds parser_version to the annual schema', () => {
    expect(ANNUAL_HOLDINGS_SCHEMA).toContain('parser_version');
    expect(ANNUAL_HOLDINGS_SCHEMA).toContain('ADD COLUMN IF NOT EXISTS parser_version');
  });

  it('stamps new parses with the current parser version', () => {
    const filing = buildAnnualFiling({
      source: 'house', filingKey: '2025:2', first: 'Lauren', last: 'Boebert', office: 'house',
      reportYear: 2025, filedDate: '2026-09-24', sourceUrl: 'https://example.test/boebert.pdf',
      parsed: { status: 'parsed', note: 'Schedule A reported none disclosed.' },
    });
    expect(filing.parserVersion).toBe(ANNUAL_PARSER_VERSION);
  });

  it('re-parses stale House filings in a bounded slice and leaves Senate paper alone', async () => {
    const store = memoryStore();
    const houseScan = staleFiling({
      filingKey: '2025:9116401',
      first: 'Keith',
      last: 'Self',
      sourceUrl: 'https://example.test/self.pdf',
    }, {
      note: 'No Schedule A text layer. The annual report looks scanned, so no holdings were guessed.',
    });
    const houseText = staleFiling({
      filingKey: '2025:10074614',
      first: 'Brian',
      last: 'Fitzpatrick',
      sourceUrl: 'https://example.test/fitzpatrick.pdf',
    });
    const paper = buildAnnualFiling({
      source: 'senate',
      filingKey: 'paper:1',
      first: 'Maria',
      last: 'Cantwell',
      office: 'senate',
      reportYear: 2025,
      filedDate: '2026-05-15',
      sourceUrl: 'https://efdsearch.senate.gov/search/view/paper/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee/',
      parsed: {
        status: 'needs_manual_review',
        note: 'Paper annual report. The Senate publishes this as a scanned image, so the holdings were not guessed.',
        parserVersion: 0,
      },
    });
    paper.parserVersion = 0;
    const current = staleFiling({
      filingKey: '2025:already',
      first: 'Ada',
      last: 'Lovelace',
      sourceUrl: 'https://example.test/ada.pdf',
    }, { parserVersion: ANNUAL_PARSER_VERSION, status: 'needs_manual_review' });
    current.parserVersion = ANNUAL_PARSER_VERSION;
    const finishedOcr = staleFiling({
      filingKey: '2025:ocrdone',
      first: 'Jamie',
      last: 'Raskin',
      sourceUrl: 'https://example.test/raskin.pdf',
    }, { parserVersion: 0, status: 'needs_manual_review', ocrDone: true });
    finishedOcr.parserVersion = 0;
    finishedOcr.ocrDone = true;

    await store.insertAnnualBundle(houseScan, []);
    await store.insertAnnualBundle(houseText, []);
    await store.insertAnnualBundle(paper, []);
    await store.insertAnnualBundle(current, []);
    await store.insertAnnualBundle(finishedOcr, []);

    expect(await store.countStaleParserAnnualFilings()).toBe(4);
    expect((await store.listRevisitableAnnualFilings({ source: 'house' })).map((row) => row.filingKey).sort())
      .toEqual(['2025:10074614', '2025:9116401']);

    const fetched = [];
    const summary = await runParserRevisitSlice({
      store,
      delayMs: 0,
      sleep: async () => {},
      deadline: Date.now() + 5_000,
      cap: 5,
      logger: { log() {}, warn() {}, error() {} },
      fetchImpl: async (url) => {
        fetched.push(String(url));
        return { status: 200, arrayBuffer: async () => Buffer.from('pdf') };
      },
      parseFiling: async (filing) => {
        if (filing.filingKey === '2025:9116401') {
          return {
            status: 'pending_ocr',
            holdings: [],
            excludedCount: 0,
            note: 'No Schedule A text layer. The annual report looks scanned and will be read by the House OCR job. No holdings were guessed.',
          };
        }
        return {
          status: 'parsed',
          holdings: [{
            asset: 'USAA Savings',
            owner: 'self',
            valueRange: '$1,001 - $15,000',
            valueMin: 1001,
            valueMax: 15000,
            valueMid: 8000,
            valueBound: 'range',
          }],
          excludedCount: 0,
        };
      },
    });

    expect(fetched.sort()).toEqual([
      'https://example.test/fitzpatrick.pdf',
      'https://example.test/self.pdf',
    ]);
    expect(summary).toMatchObject({
      downloaded: 2,
      revisited: 2,
      stamped: 2,
      failed: 0,
      parsed: 1,
      pendingOcr: 1,
      remaining: 0,
      done: true,
      version: ANNUAL_PARSER_VERSION,
    });

    const self = (await store.listAnnualFilingsForPerson('house:self:keith'))[0];
    expect(self.parseStatus).toBe('pending_ocr');
    expect(self.parserVersion).toBe(ANNUAL_PARSER_VERSION);

    const fitz = (await store.listAnnualFilingsForPerson('house:fitzpatrick:brian'))[0];
    expect(fitz.parseStatus).toBe('parsed');
    expect(fitz.parserVersion).toBe(ANNUAL_PARSER_VERSION);
    expect((await store.listHoldingsForFiling(fitz.id))).toHaveLength(1);

    const senate = (await store.listAnnualFilingsForPerson('senate:cantwell:maria'))[0];
    expect(senate.parseStatus).toBe('needs_manual_review');
    expect(senate.parserVersion).toBe(ANNUAL_PARSER_VERSION);
    expect(senate.parseNote).toMatch(/Paper annual report/);

    const ocr = (await store.listAnnualFilingsForPerson('house:raskin:jamie'))[0];
    expect(ocr.parseStatus).toBe('needs_manual_review');
    expect(ocr.ocrDone).toBe(true);
    expect(ocr.parserVersion).toBe(ANNUAL_PARSER_VERSION);

    expect(store.db.politicianTrades).toEqual([]);
    expect(await store.countStaleParserAnnualFilings()).toBe(0);
    expect(await store.listRevisitableAnnualFilings({ source: 'house' })).toEqual([]);

    fetched.length = 0;
    const again = await runParserRevisitSlice({
      store,
      delayMs: 0,
      sleep: async () => {},
      cap: 5,
      logger: { log() {}, warn() {}, error() {} },
      fetchImpl: async (url) => {
        fetched.push(String(url));
        return { status: 200, arrayBuffer: async () => Buffer.from('pdf') };
      },
      parseFiling: async () => ({ status: 'parsed', holdings: [] }),
    });
    expect(fetched).toEqual([]);
    expect(again).toMatchObject({ downloaded: 0, revisited: 0, stamped: 0, remaining: 0, done: true });
  });

  it('replaces a stale partial filing and does not write trade rows or digest lines', async () => {
    const store = memoryStore();
    const filing = staleFiling({
      filingKey: '2025:partial',
      first: 'Nancy',
      last: 'Pelosi',
    }, { status: 'partial', note: 'Some rows were unreadable.', parserVersion: 0 });
    filing.parseStatus = 'partial';
    filing.parserVersion = 0;
    const oldRows = buildHoldingRows(filing, {
      holdings: [{
        asset: 'Cash', owner: 'self', valueRange: '$1,001 - $15,000',
        valueMin: 1001, valueMax: 15000, valueMid: 8000, valueBound: 'range',
      }],
    });
    await store.insertAnnualBundle(filing, oldRows);
    expect((await store.listStaleParserAnnualFilings()).map((row) => row.filingKey)).toEqual(['2025:partial']);

    await runParserRevisitSlice({
      store,
      delayMs: 0,
      sleep: async () => {},
      cap: 5,
      logger: { log() {}, warn() {}, error() {} },
      fetchImpl: async () => ({ status: 200, arrayBuffer: async () => Buffer.from('pdf') }),
      parseFiling: async () => ({
        status: 'parsed',
        holdings: [
          {
            asset: 'Cash', owner: 'self', valueRange: '$1,001 - $15,000',
            valueMin: 1001, valueMax: 15000, valueMid: 8000, valueBound: 'range',
          },
          {
            asset: 'USAA Savings', owner: 'self', valueRange: '$1,001 - $15,000',
            valueMin: 1001, valueMax: 15000, valueMid: 8000, valueBound: 'range',
          },
        ],
      }),
    });

    const [row] = await store.listAnnualFilingsForPerson('house:pelosi:nancy');
    expect(row.parseStatus).toBe('parsed');
    expect(row.parserVersion).toBe(ANNUAL_PARSER_VERSION);
    expect(await store.listHoldingsForFiling(row.id)).toHaveLength(2);
    expect(store.db.politicianTrades).toEqual([]);

    // Holdings never enter the digest. With no trade rows the digest is omitted.
    expect(buildPoliticianDigest({ trades: [] })).toBeNull();
    expect(store.db.politicianTrades).toEqual([]);
  });

  it('requeues a still-unreadable filing only after the parser version is bumped', async () => {
    const store = memoryStore();
    const filing = staleFiling();
    await store.insertAnnualBundle(filing, []);
    await runParserRevisitSlice({
      store,
      parserVersion: 1,
      delayMs: 0,
      sleep: async () => {},
      cap: 5,
      logger: { log() {}, warn() {}, error() {} },
      fetchImpl: async () => ({ status: 200, arrayBuffer: async () => Buffer.from('pdf') }),
      parseFiling: async () => ({
        status: 'needs_manual_review',
        holdings: [],
        note: 'Still unreadable.',
      }),
    });
    expect(await store.countStaleParserAnnualFilings({ parserVersion: 1 })).toBe(0);
    expect(await store.countStaleParserAnnualFilings({ parserVersion: 2 })).toBe(1);
  });

  it('keeps the annual scheduler running after backfill when stale parses remain', async () => {
    expect(nextAnnualIngestDelay({ backfillComplete: true, boot: true })).toBeNull();
    expect(nextAnnualIngestDelay({
      backfillComplete: true,
      parserRevisitPending: true,
      boot: true,
      initialDelayMs: 20_000,
    })).toBe(20_000);
    expect(nextAnnualIngestDelay({
      backfillComplete: true,
      parserRevisitPending: true,
      boot: false,
    })).toBe(ANNUAL_PARSER_REVISIT_INTERVAL_MS);

    let calls = 0;
    let pending = true;
    const stop = startAnnualIngest({
      run: async () => { calls += 1; pending = false; },
      getState: async () => ({ backfillComplete: true, parserRevisitPending: pending }),
      intervalMs: 30,
      initialDelayMs: 0,
      logger: { log() {}, error() {} },
    });
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(calls).toBe(1);
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(calls).toBe(1);
    stop();
  });

  it('exposes parser revisit progress on the status endpoint', async () => {
    const store = memoryStore();
    await store.insertAnnualBundle(staleFiling(), []);
    await store.setAnnualState({ backfillComplete: true, coverage: { unreadable: 1 } });

    const app = express();
    app.use('/api/politician-trades', createPoliticianRouter({ store }));
    const server = await new Promise((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    const { port } = server.address();
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/politician-trades/status`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.annual.parserVersion).toBe(ANNUAL_PARSER_VERSION);
      expect(body.annual.parserRevisit).toMatchObject({
        version: ANNUAL_PARSER_VERSION,
        remaining: 1,
        done: false,
      });
      expect(body.annual.backfillComplete).toBe(true);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }

    const empty = await withParserRevisitStatus(memoryStore(), {});
    expect(empty.parserRevisit).toMatchObject({ remaining: 0, done: true, version: ANNUAL_PARSER_VERSION });
  });
});
