import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { POLITICIAN_OCR_SCHEMA } from '../db.js';
import { runPoliticianPoll } from './ingest.js';
import { memoryMethods, politicianBucket } from './memoryStore.js';
import { backfillNullTickers, buildCatalog } from './nameMatch.js';
import { buildFilingRecord, buildTradeRows } from './records.js';
import {
  DIGEST_ALREADY_SENT_BEFORE,
  HISTORICAL_DIGEST_SQL,
  markHistoricalTradesEmailed,
} from './emailed.js';

const dir = dirname(fileURLToPath(import.meta.url));
const quiet = { log() {}, warn() {}, error() {} };
const NOW = () => new Date('2026-11-14T02:30:00.000Z');

function memoryStore() {
  const db = politicianBucket({
    models: {
      growth: {
        key: 'growth',
        name: 'Growth',
        versions: [{ id: 'v1', effectiveDate: '2020-01-01', holdings: [{ instrumentId: 'aapl' }] }],
      },
    },
    instruments: { aapl: { id: 'aapl', symbol: 'AAPL' } },
  });
  const store = { db };
  for (const [name, fn] of Object.entries(memoryMethods)) {
    store[name] = (...args) => fn.apply({ db, persist() {} }, args);
  }
  store.getAlertSettings = async () => ({ alertEmail: 'owner@example.com' });
  return store;
}

function cloneStore(store) {
  const db = structuredClone(store.db);
  const next = { db };
  for (const [name, fn] of Object.entries(memoryMethods)) {
    next[name] = (...args) => fn.apply({ db, persist() {} }, args);
  }
  next.getAlertSettings = async () => ({ alertEmail: 'owner@example.com' });
  return next;
}

function down() {
  return {
    status: 503,
    ok: false,
    headers: { get: () => null, getSetCookie: () => [] },
    text: async () => '',
    arrayBuffer: async () => Buffer.alloc(0),
  };
}

function tradeRow(extra = {}) {
  return {
    owner: 'self',
    ticker: 'AAPL',
    asset: 'Apple Inc',
    assetClass: 'stock',
    txType: 'buy',
    partial: false,
    txDate: '2026-11-01',
    amountRange: '$1,001 - $15,000',
    digestPending: true,
    ...extra,
  };
}

async function arm(store) {
  await store.setPoliticianPollState({
    backfillComplete: true,
    alertsArmed: true,
    lastSuccessAt: '2026-11-01T00:00:00.000Z',
  });
}

async function seedTrade(store, extra = {}, filingKey = 'house-1') {
  const filing = buildFilingRecord({
    source: 'house',
    filingKey,
    first: 'Nancy',
    last: 'Pelosi',
    office: 'house',
    filedDate: '2026-11-06',
    sourceUrl: 'https://example.test/ptr',
    parsed: { status: 'parsed' },
  });
  const [trade] = buildTradeRows(filing, { trades: [tradeRow(extra)] });
  if (extra.createdAt) trade.createdAt = extra.createdAt;
  await store.insertPoliticianBundle(filing, [trade]);
  return trade;
}

function poll(store, email, extra = {}) {
  return runPoliticianPoll({
    store,
    fetchImpl: async () => down(),
    email,
    now: NOW,
    sleep: async () => {},
    logger: quiet,
    env: { ...process.env, POLITICIAN_FETCH_DELAY_MS: '0', POLITICIAN_BACKFILL_YEARS: '1' },
    ocrTools: async () => false,
    force: true,
    ...extra,
  });
}

describe('politician digest is sent once', () => {
  it('sends on the first armed poll and not on the next one', async () => {
    const store = memoryStore();
    await arm(store);
    const trade = await seedTrade(store);
    const email = { send: vi.fn(async () => ({ ok: true, id: 'email-1' })) };
    await poll(store, email);
    expect(email.send).toHaveBeenCalledTimes(1);
    expect(email.send.mock.calls[0][0].subject).toMatch(/1 new politician trade/);
    expect(trade.emailedAt).toBeTruthy();
    expect(trade.digestPending).toBe(false);

    await poll(store, email);
    expect(email.send).toHaveBeenCalledTimes(1);
    expect(trade.digestPending).toBe(false);
  });

  it('does not send again after a name-match backfill or an OCR re-run', async () => {
    const store = memoryStore();
    await arm(store);
    const trade = await seedTrade(store, {
      ticker: null,
      asset: 'Microsoft Corp',
      assetClass: 'other',
    });
    const email = { send: vi.fn(async () => ({ ok: true, id: 'email-1' })) };
    await poll(store, email);
    expect(email.send).toHaveBeenCalledTimes(1);
    const emailedAt = trade.emailedAt;
    expect(emailedAt).toBeTruthy();

    const book = buildCatalog({
      rows: [[789019, 'MICROSOFT CORP', 'MSFT', 'Nasdaq']],
      fetchedAt: '2026-11-14T02:00:00.000Z',
    });
    const filled = await backfillNullTickers({ store, catalog: book });
    expect(filled.matched).toBe(1);
    expect(trade.ticker).toBe('MSFT');
    expect(trade.tickerSource).toBe('name_match');
    expect(trade.digestPending).toBe(false);
    expect(trade.emailedAt).toBe(emailedAt);

    await store.insertPoliticianTrades([{
      ...trade,
      ticker: 'AAPL',
      digestPending: true,
      emailedAt: null,
    }]);
    expect(trade.emailedAt).toBe(emailedAt);
    expect(trade.digestPending).toBe(false);
    expect(await store.markDigestPending([trade.id])).toEqual([]);

    trade.digestPending = true;
    await poll(store, email);
    expect(email.send).toHaveBeenCalledTimes(1);
    expect(trade.emailedAt).toBe(emailedAt);
    expect(await store.listDigestPendingTrades()).toEqual([]);
  });

  it('leaves the trade eligible when Resend does not accept it, then sends once', async () => {
    const store = memoryStore();
    await arm(store);
    const trade = await seedTrade(store);
    let attempt = 0;
    const email = {
      send: vi.fn(async () => {
        attempt += 1;
        if (attempt === 1) return { ok: false, reason: 'resend down' };
        return { ok: true, id: 'email-2' };
      }),
    };
    await poll(store, email);
    expect(email.send).toHaveBeenCalledTimes(1);
    expect(trade.emailedAt).toBeFalsy();
    expect(trade.digestPending).toBe(true);

    await poll(store, email);
    expect(email.send).toHaveBeenCalledTimes(2);
    expect(trade.emailedAt).toBeTruthy();
    expect(trade.digestPending).toBe(false);

    await poll(store, email);
    expect(email.send).toHaveBeenCalledTimes(2);
  });

  it('does not send again from a new process that only has the saved rows', async () => {
    const store = memoryStore();
    await arm(store);
    const trade = await seedTrade(store);
    const email = { send: vi.fn(async () => ({ ok: true, id: 'email-1' })) };
    await poll(store, email);
    expect(email.send).toHaveBeenCalledTimes(1);

    const restarted = cloneStore(store);
    const again = { send: vi.fn(async () => ({ ok: true, id: 'email-2' })) };
    await poll(restarted, again);
    expect(again.send).not.toHaveBeenCalled();

    const saved = restarted.db.politicianTrades[0];
    const emailedAt = saved.emailedAt;
    saved.digestPending = true;
    saved.ticker = 'MSFT';
    saved.tickerNorm = 'MSFT';
    saved.tickerSource = 'name_match';
    await poll(restarted, again);
    expect(again.send).not.toHaveBeenCalled();
    expect(saved.emailedAt).toBe(emailedAt);
    expect(trade.id).toBe(saved.id);
  });

  it('marks trades first seen before the second Nov 13 digest and does not mail them', async () => {
    const rows = [
      { id: 'old', createdAt: '2026-11-13T00:54:24.000Z', digestPending: true },
      { id: 'at-cutoff', createdAt: DIGEST_ALREADY_SENT_BEFORE, digestPending: true },
      { id: 'after', createdAt: '2026-11-14T01:57:37.000Z', digestPending: true },
      { id: 'already', createdAt: '2026-11-01T00:00:00.000Z', emailedAt: '2026-11-13T20:00:00.000Z', digestPending: true },
      { id: 'undated', digestPending: true },
    ];
    expect(markHistoricalTradesEmailed(rows)).toBe(1);
    expect(rows[0]).toMatchObject({ emailedAt: '2026-11-13T00:54:24.000Z', digestPending: false });
    expect(rows[1].emailedAt).toBeUndefined();
    expect(rows[1].digestPending).toBe(true);
    expect(rows[2].digestPending).toBe(true);
    expect(rows[3].emailedAt).toBe('2026-11-13T20:00:00.000Z');
    expect(rows[3].digestPending).toBe(true);
    expect(rows[4].digestPending).toBe(true);
    expect(markHistoricalTradesEmailed(rows)).toBe(0);
    expect(rows[0].emailedAt).toBe('2026-11-13T00:54:24.000Z');

    const store = memoryStore();
    await arm(store);
    const trade = await seedTrade(store, { createdAt: '2026-11-14T00:54:24.000Z' });
    expect(markHistoricalTradesEmailed(store.db.politicianTrades)).toBe(1);
    expect(trade.digestPending).toBe(false);
    const email = { send: vi.fn(async () => ({ ok: true, id: 'should-not-send' })) };
    await poll(store, email);
    expect(email.send).not.toHaveBeenCalled();
  });

  it('runs the historical update on boot and from the OCR schema', () => {
    expect(HISTORICAL_DIGEST_SQL).toMatch(/emailed_at timestamptz/);
    expect(HISTORICAL_DIGEST_SQL).toMatch(/SET emailed_at = created_at/);
    expect(HISTORICAL_DIGEST_SQL).toMatch(/digest_pending = false/);
    expect(HISTORICAL_DIGEST_SQL).toMatch(/emailed_at IS NULL/);
    expect(HISTORICAL_DIGEST_SQL).toMatch(/created_at < TIMESTAMPTZ '2026-11-14 01:57:36\+00'/);
    const dbSrc = readFileSync(join(dir, '../db.js'), 'utf8');
    expect(dbSrc).toContain("import { HISTORICAL_DIGEST_SQL } from './politicians/emailed.js'");
    expect(dbSrc.match(/\$\{HISTORICAL_DIGEST_SQL\}/g)).toHaveLength(2);
    expect(POLITICIAN_OCR_SCHEMA).toContain(HISTORICAL_DIGEST_SQL.trim());
    const pg = readFileSync(join(dir, 'pgStore.js'), 'utf8');
    const nameMatch = pg.slice(pg.indexOf('applyPoliticianNameMatches'), pg.indexOf('listHeldPoliticianSymbols'));
    expect(nameMatch).not.toMatch(/emailed_at/);
    expect(nameMatch).not.toMatch(/digest_pending/);
    expect(pg).toMatch(/ON CONFLICT \(filing_id, row_index\) DO NOTHING/);
    expect(pg).not.toMatch(/ON CONFLICT \(filing_id, row_index\) DO UPDATE/);
    expect(pg).toMatch(/digest_pending\s+AND emailed_at IS NULL/);
  });
});
