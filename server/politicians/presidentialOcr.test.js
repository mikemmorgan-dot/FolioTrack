import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { runPoliticianPoll } from './ingest.js';
import { memoryMethods, politicianBucket } from './memoryStore.js';
import { rowsFromOcrWords } from './ocrRows.js';
import { TOOLS_MISSING_NOTE, ocrSettled } from './ocrPending.js';
import { buildFilingRecord, buildTradeRows } from './records.js';
import {
  assertDatabaseUrl,
  missingDatabaseUrlMessage,
  normalizeFilingKey,
  redactSecrets,
  runPresidentialOcr,
} from './presidentialOcr.js';

const dir = dirname(fileURLToPath(import.meta.url));
const fixture = (name) => readFileSync(join(dir, '../fixtures/politicians', name), 'utf8');
const KEY = '0BDCCCE7DE13AEFA85258E8A002DE2B5';
const NOW = new Date('2026-11-13T15:00:00Z');
const quiet = { log() {}, warn() {}, error() {} };

function memoryStore() {
  const db = politicianBucket({ models: {}, instruments: {} });
  const store = { db };
  for (const [name, fn] of Object.entries(memoryMethods)) {
    store[name] = (...args) => fn.apply({ db, persist() {} }, args);
  }
  store.getAlertSettings = async () => ({ alertEmail: 'owner@example.com' });
  return store;
}

function ogeRow(key = KEY, title = 'President') {
  return {
    type: `<a href='https://extapps2.oge.gov/201/Presiden.nsf/PAS+Index/${key}/$FILE/sample-278T.pdf'>278 Transaction</a>`,
    name: 'Trump, Donald J',
    title,
    docDate: '2026-10-08T04:21:11',
  };
}

function respond(status, body, extra = {}) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: {
      get: (name) => extra[String(name).toLowerCase()] ?? null,
      getSetCookie: () => [],
    },
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
    arrayBuffer: async () => Buffer.from(typeof body === 'string' ? body : JSON.stringify(body)),
  };
}

function indexFetch(rows) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const method = init.method || 'GET';
    calls.push(`${method} ${url}`);
    const u = String(url);
    if (u.includes('API.xsp')) {
      return respond(200, { recordsFiltered: rows.length, recordsTotal: rows.length, data: rows });
    }
    if (method === 'HEAD') return respond(200, '', { 'content-length': '1200' });
    if (u.includes('$FILE') || u.includes('278T')) return respond(200, 'pdf-bytes');
    return respond(404, '');
  };
  return { fetchImpl, calls };
}

function validatedRead(calls) {
  return async () => {
    calls.push('ocr');
    const words = JSON.parse(fixture('oge-278t-page2-words.json'));
    const page = rowsFromOcrWords(words, { now: NOW });
    const status = page.trades.length && page.rejected ? 'partial' : page.trades.length ? 'parsed' : 'needs_manual_review';
    return {
      status,
      trades: page.trades,
      note: page.trades.length
        ? `OCR read ${page.trades.length} rows`
        : 'OCR could not validate any transaction row. Open the filing to review it.',
      ocrDone: true,
      ocrPage: 1,
      pageCount: 1,
      rejected: page.rejected,
    };
  };
}

function jobEnv() {
  return { ...process.env, POLITICIAN_FETCH_DELAY_MS: '0', POLITICIAN_BACKFILL_YEARS: '1' };
}

describe('presidential OCR job', () => {
  it('tells the owner how to add DATABASE_URL and does not echo a URL', () => {
    const secret = 'postgresql://user:supersecret@ep-example.neon.tech/neondb?sslmode=require';
    const message = missingDatabaseUrlMessage();
    expect(message).toMatch(/Settings → Secrets and variables → Actions → New repository secret/);
    expect(message).toMatch(/Name: DATABASE_URL/);
    expect(message).not.toContain('postgresql://');
    expect(message).not.toContain(secret);
    expect(() => assertDatabaseUrl({ DATABASE_URL: '  ' })).toThrow(/DATABASE_URL is not set/);
    expect(assertDatabaseUrl({ DATABASE_URL: secret })).toBe(secret);
    expect(redactSecrets(`failed ${secret} again`, { DATABASE_URL: secret })).toBe('failed [redacted] again');
    expect(normalizeFilingKey(`oge:${KEY.toLowerCase()}`)).toBe(KEY);
    expect(() => normalizeFilingKey('not a key')).toThrow(/hex id/);
  });

  it('stores only validated rows from the fixture and does not OCR them again', async () => {
    const store = memoryStore();
    const ocrCalls = [];
    const { fetchImpl } = indexFetch([ogeRow()]);
    const words = JSON.parse(fixture('oge-278t-page2-words.json'));
    const page = rowsFromOcrWords(words, { now: NOW });
    expect(page.rejected).toBeGreaterThan(0);
    expect(page.trades.length).toBeGreaterThan(15);

    const first = await runPresidentialOcr({
      store,
      fetchImpl,
      readPdf: validatedRead(ocrCalls),
      now: NOW,
      sleep: async () => {},
      logger: quiet,
      env: jobEnv(),
    });
    expect(first.filings).toEqual([
      expect.objectContaining({ filingKey: KEY, action: 'ocr', status: 'partial', trades: page.trades.length }),
    ]);
    expect(ocrCalls).toHaveLength(1);
    expect(store.db.politicianTrades).toHaveLength(page.trades.length);
    for (const trade of store.db.politicianTrades) {
      expect(trade.digestPending).toBe(true);
      expect(trade.ocr).toBe(true);
      expect(trade.ocrConfidence).toBeGreaterThanOrEqual(60);
      expect(['buy', 'sell', 'exchange']).toContain(trade.txType);
      expect(trade.amountRange).toMatch(/^\$[\d,]+ - \$[\d,]+$/);
      expect(trade.txDate).toMatch(/^2025-/);
    }
    const filing = store.db.politicianFilings[`oge:${KEY}`];
    expect(filing.ocrDone).toBe(true);
    expect(filing.parseStatus).toBe('partial');

    await runPresidentialOcr({
      store,
      fetchImpl,
      readPdf: validatedRead(ocrCalls),
      now: NOW,
      sleep: async () => {},
      logger: quiet,
      env: jobEnv(),
    });
    expect(ocrCalls).toHaveLength(1);
    expect(store.db.politicianTrades).toHaveLength(page.trades.length);
  });

  it('re-runs one filing from the dispatch key without duplicating trades', async () => {
    const store = memoryStore();
    const ocrCalls = [];
    const { fetchImpl } = indexFetch([ogeRow()]);
    const opts = {
      store,
      fetchImpl,
      readPdf: validatedRead(ocrCalls),
      now: NOW,
      sleep: async () => {},
      logger: quiet,
      env: jobEnv(),
    };
    await runPresidentialOcr(opts);
    const count = store.db.politicianTrades.length;
    const again = await runPresidentialOcr({ ...opts, filingKey: KEY });
    expect(again.filings[0].action).toBe('ocr');
    expect(ocrCalls).toHaveLength(2);
    expect(store.db.politicianTrades).toHaveLength(count);
  });

  it('OCRs a pending filing that is not on the current index page', async () => {
    const store = memoryStore();
    const filing = buildFilingRecord({
      source: 'oge',
      filingKey: KEY,
      first: 'Donald J',
      last: 'Trump',
      office: 'president',
      filedDate: '2026-08-15',
      sourceUrl: `https://extapps2.oge.gov/201/Presiden.nsf/PAS+Index/${KEY}/$FILE/sample-278T.pdf`,
      parsed: { status: 'pending_ocr', note: 'Pending OCR.', ocrDone: false },
    });
    await store.insertPoliticianBundle(filing, []);
    const ocrCalls = [];
    const { fetchImpl } = indexFetch([]);
    const result = await runPresidentialOcr({
      store,
      fetchImpl,
      readPdf: validatedRead(ocrCalls),
      now: NOW,
      sleep: async () => {},
      logger: quiet,
      env: jobEnv(),
    });
    expect(result.filings[0]).toMatchObject({ filingKey: KEY, action: 'ocr' });
    expect(ocrCalls).toHaveLength(1);
    expect(store.db.politicianTrades.length).toBeGreaterThan(0);
  });

  it('OCRs a legacy needs-review row left when tesseract was missing', async () => {
    const store = memoryStore();
    const filing = buildFilingRecord({
      source: 'oge',
      filingKey: KEY,
      first: 'Donald J',
      last: 'Trump',
      office: 'president',
      filedDate: '2026-08-15',
      sourceUrl: `https://extapps2.oge.gov/201/Presiden.nsf/PAS+Index/${KEY}/$FILE/sample-278T.pdf`,
      parsed: { status: 'needs_manual_review', note: TOOLS_MISSING_NOTE, ocrDone: true },
    });
    await store.insertPoliticianBundle(filing, []);
    const ocrCalls = [];
    const { fetchImpl } = indexFetch([]);
    await runPresidentialOcr({
      store,
      fetchImpl,
      readPdf: validatedRead(ocrCalls),
      now: NOW,
      sleep: async () => {},
      logger: quiet,
      env: jobEnv(),
    });
    expect(ocrCalls).toHaveLength(1);
    expect(store.db.politicianFilings[`oge:${KEY}`].parseStatus).toBe('partial');
  });

  it('does not guess a low-confidence row, and does not retry that filing', async () => {
    const store = memoryStore();
    const ocrCalls = [];
    const { fetchImpl } = indexFetch([ogeRow()]);
    const readPdf = async () => {
      ocrCalls.push('ocr');
      const page = rowsFromOcrWords([
        { text: 'Apple', confidence: 90, bbox: { x0: 10, y0: 10, x1: 50, y1: 22 } },
        { text: 'Inc', confidence: 90, bbox: { x0: 54, y0: 10, x1: 80, y1: 22 } },
        { text: 'purchase', confidence: 40, bbox: { x0: 100, y0: 10, x1: 170, y1: 22 } },
        { text: '8/1/2025', confidence: 90, bbox: { x0: 180, y0: 10, x1: 240, y1: 22 } },
        { text: '$1,001', confidence: 90, bbox: { x0: 250, y0: 10, x1: 300, y1: 22 } },
        { text: '$15,000', confidence: 90, bbox: { x0: 310, y0: 10, x1: 370, y1: 22 } },
      ], { now: NOW });
      expect(page.trades).toEqual([]);
      expect(page.rejected).toBe(1);
      return {
        status: 'needs_manual_review',
        trades: page.trades,
        note: 'OCR could not validate any transaction row. Open the filing to review it.',
        ocrDone: true,
        ocrPage: 1,
        pageCount: 1,
      };
    };
    await runPresidentialOcr({
      store, fetchImpl, readPdf, now: NOW, sleep: async () => {}, logger: quiet, env: jobEnv(),
    });
    expect(store.db.politicianTrades).toHaveLength(0);
    expect(store.db.politicianFilings[`oge:${KEY}`].parseStatus).toBe('needs_manual_review');
    await runPresidentialOcr({
      store, fetchImpl, readPdf, now: NOW, sleep: async () => {}, logger: quiet, env: jobEnv(),
    });
    expect(ocrCalls).toHaveLength(1);
  });

  it('skips a filing another worker has already claimed', async () => {
    const store = memoryStore();
    const filing = buildFilingRecord({
      source: 'oge',
      filingKey: KEY,
      first: 'Donald J',
      last: 'Trump',
      office: 'president',
      filedDate: '2026-10-08',
      sourceUrl: `https://extapps2.oge.gov/201/Presiden.nsf/PAS+Index/${KEY}/$FILE/sample-278T.pdf`,
      parsed: { status: 'pending_ocr', ocrDone: false },
    });
    const first = await store.claimPoliticianOcr(filing, { now: NOW });
    const second = await store.claimPoliticianOcr(filing, { now: NOW });
    expect(first.claimed).toBe(true);
    expect(second.claimed).toBe(false);
    expect(ocrSettled(store.db.politicianFilings[filing.id], true, NOW.getTime())).toBe(true);
  });

  it('leaves a scanned 278-T pending on a host with no tesseract, and OCRs it when the tools exist', async () => {
    const row = ogeRow();
    const { fetchImpl, calls } = indexFetch([row]);
    const env = jobEnv();
    const now = () => NOW;
    const store = memoryStore();
    await runPoliticianPoll({
      store, fetchImpl, now, sleep: async () => {}, logger: quiet, env,
      ocrTools: async () => false,
    });
    const pending = store.db.politicianFilings[`oge:${KEY}`];
    expect(pending.parseStatus).toBe('pending_ocr');
    expect(pending.ocrDone).toBe(false);
    expect(calls.some((line) => line.includes('278T'))).toBe(false);

    const docker = memoryStore();
    const ocrCalls = [];
    await runPoliticianPoll({
      store: docker,
      fetchImpl,
      now,
      sleep: async () => {},
      logger: quiet,
      env,
      ocrTools: async () => true,
      readPdf: async () => {
        ocrCalls.push('ocr');
        return {
          status: 'parsed',
          trades: [{
            owner: 'self', ticker: 'AAPL', asset: 'Apple Inc', assetClass: 'stock',
            txType: 'buy', partial: false, txDate: '2026-08-01', amountRange: '$1,001 - $15,000',
            ocr: true, ocrConfidence: 88,
          }],
          note: 'OCR read 1 row',
          ocrDone: true,
          ocrPage: 1,
          pageCount: 1,
        };
      },
    });
    expect(ocrCalls).toHaveLength(1);
    expect(docker.db.politicianFilings[`oge:${KEY}`].parseStatus).toBe('parsed');
    expect(docker.db.politicianTrades).toHaveLength(1);
    expect(docker.db.politicianTrades[0].digestPending).toBe(false);
    await runPoliticianPoll({
      store: docker, fetchImpl, now, sleep: async () => {}, logger: quiet, env,
      ocrTools: async () => true,
      readPdf: async () => { ocrCalls.push('ocr'); return { status: 'parsed', trades: [], ocrDone: true }; },
    });
    expect(ocrCalls).toHaveLength(1);
    expect(docker.db.politicianTrades).toHaveLength(1);
  });

  it('emails workflow trades on the next digest once', async () => {
    const store = memoryStore();
    const { fetchImpl } = indexFetch([ogeRow()]);
    await runPresidentialOcr({
      store,
      fetchImpl,
      readPdf: validatedRead([]),
      now: NOW,
      sleep: async () => {},
      logger: quiet,
      env: jobEnv(),
    });
    expect(store.db.politicianTrades.some((trade) => trade.digestPending)).toBe(true);
    await store.setPoliticianPollState({
      backfillComplete: true,
      alertsArmed: true,
      lastSuccessAt: '2026-11-01T00:00:00.000Z',
    });
    const email = { send: vi.fn(async () => ({ ok: true, id: 'email-1' })) };
    const down = async () => respond(503, '');
    await runPoliticianPoll({
      store, fetchImpl: down, email, now: () => NOW, sleep: async () => {}, logger: quiet, env: jobEnv(),
      ocrTools: async () => false,
    });
    expect(email.send).toHaveBeenCalledTimes(1);
    expect(email.send.mock.calls[0][0].text).toContain('Donald J Trump');
    expect(store.db.politicianTrades.every((trade) => trade.digestPending === false)).toBe(true);

    await runPoliticianPoll({
      store, fetchImpl: down, email, now: () => NOW, sleep: async () => {}, logger: quiet, env: jobEnv(),
      ocrTools: async () => false,
      force: true,
    });
    expect(email.send).toHaveBeenCalledTimes(1);
  });

  it('holds unheld workflow trades when the digest is limited to held tickers', async () => {
    const store = memoryStore();
    store.db.models = {
      growth: {
        key: 'growth',
        name: 'Growth',
        versions: [{
          id: 'v1',
          effectiveDate: '2020-01-01',
          holdings: [{ instrumentId: 'aapl' }],
        }],
      },
    };
    store.db.instruments = { aapl: { id: 'aapl', symbol: 'AAPL' } };
    const filing = buildFilingRecord({
      source: 'oge',
      filingKey: KEY,
      first: 'Donald J',
      last: 'Trump',
      office: 'president',
      filedDate: '2026-10-08',
      sourceUrl: `https://extapps2.oge.gov/201/Presiden.nsf/PAS+Index/${KEY}/$FILE/sample-278T.pdf`,
      parsed: { status: 'parsed', ocrDone: true },
    });
    await store.insertPoliticianBundle(filing, buildTradeRows(filing, {
      status: 'parsed',
      trades: [
        {
          owner: 'self', ticker: 'AAPL', asset: 'Apple Inc', assetClass: 'stock',
          txType: 'buy', partial: false, txDate: '2026-08-01', amountRange: '$1,001 - $15,000',
          ocr: true, ocrConfidence: 90, digestPending: true,
        },
        {
          owner: 'self', ticker: null, asset: 'City water bond', assetClass: 'bond',
          txType: 'buy', partial: false, txDate: '2026-08-02', amountRange: '$15,001 - $50,000',
          ocr: true, ocrConfidence: 90, digestPending: true,
        },
      ],
    }));
    await store.setPoliticianPollState({
      backfillComplete: true,
      alertsArmed: true,
      lastSuccessAt: '2026-11-01T00:00:00.000Z',
    });
    await store.savePoliticianAlertSettings({ politicianAlertsHeldOnly: true });
    const email = { send: vi.fn(async () => ({ ok: true, id: 'email-1' })) };
    const down = async () => respond(503, '');
    const poll = (extra = {}) => runPoliticianPoll({
      store, fetchImpl: down, email, now: () => NOW, sleep: async () => {}, logger: quiet, env: jobEnv(),
      ocrTools: async () => false,
      ...extra,
    });
    await poll();
    expect(email.send).toHaveBeenCalledTimes(1);
    expect(email.send.mock.calls[0][0].text).toContain('AAPL');
    expect(email.send.mock.calls[0][0].text).not.toContain('City water bond');
    const rows = store.db.politicianTrades;
    expect(rows.find((trade) => trade.ticker === 'AAPL').digestPending).toBe(false);
    expect(rows.find((trade) => trade.asset === 'City water bond').digestPending).toBe(true);

    await store.savePoliticianAlertSettings({ politicianAlertsHeldOnly: false });
    await poll({ force: true });
    expect(email.send).toHaveBeenCalledTimes(2);
    expect(email.send.mock.calls[1][0].text).toContain('City water bond');
    expect(email.send.mock.calls[1][0].text).not.toContain('AAPL');
    expect(rows.every((trade) => trade.digestPending === false)).toBe(true);
  });
});
