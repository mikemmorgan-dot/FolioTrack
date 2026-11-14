import { readFileSync } from 'node:fs';
import { once } from 'node:events';
import express from 'express';
import { describe, expect, it } from 'vitest';
import { createPoliticianRouter } from './http.js';
import { memoryMethods, politicianBucket } from './memoryStore.js';
import { buildPeopleSearchSql, peopleSearchQuery, personNameMatches } from './peopleSearch.js';
import { buildFilingRecord, buildTradeRows } from './records.js';

function memoryStore() {
  const db = politicianBucket({ models: {}, instruments: {} });
  const store = { db };
  for (const [name, fn] of Object.entries(memoryMethods)) {
    store[name] = (...args) => fn.apply({ db, persist() {} }, args);
  }
  store.listHeldPoliticianSymbols = async () => [];
  return store;
}

function trade(ticker, extra = {}) {
  return {
    owner: 'self',
    ticker,
    asset: extra.asset || ticker,
    assetClass: 'stock',
    txType: extra.txType || 'buy',
    partial: false,
    txDate: extra.txDate || '2026-10-01',
    amountRange: '$1,001 - $15,000',
  };
}

async function addPerson(store, opts) {
  const filing = buildFilingRecord({
    source: opts.source || 'house',
    filingKey: opts.key,
    first: opts.first,
    last: opts.last,
    office: opts.office || 'house',
    party: opts.party === undefined ? 'D' : opts.party,
    filerStatus: opts.filerStatus || 'member',
    state: opts.state || null,
    filedDate: opts.filedDate || '2026-11-06',
    sourceUrl: `https://example.test/${opts.key}`,
    parsed: { status: 'parsed' },
  });
  const rows = buildTradeRows(filing, { trades: opts.trades || [trade('AAPL')] });
  await store.insertPoliticianBundle(filing, rows);
  return filing;
}

async function seed(store) {
  await addPerson(store, {
    key: 'pelosi', first: 'Nancy', last: 'Pelosi', party: 'D', state: 'CA', filedDate: '2026-11-06',
    trades: [trade('AAPL'), trade('MSFT'), trade('NVDA', { txType: 'sell' })],
  });
  await addPerson(store, {
    key: 'mace', first: 'Nancy', last: 'Mace', party: 'R', state: 'SC', filedDate: '2026-11-02',
    trades: [trade('TSLA')],
  });
  await addPerson(store, {
    key: 'trump', first: 'Donald', last: 'Trump', office: 'president', party: 'R', state: null,
    source: 'oge', filedDate: '2026-10-08', trades: [trade('DJT', { asset: 'Trump Media' })],
  });
  await addPerson(store, {
    key: 'vance', first: 'JD', last: 'Vance', office: 'vice-president', party: 'R', state: null,
    source: 'oge', filedDate: '2026-11-01', trades: [trade('AAPL'), trade('MSFT')],
  });
}

describe('politician name matching', () => {
  it('matches a first name, a last name, a full name, and a prefix', () => {
    const tokens = (q) => peopleSearchQuery(q).tokens;
    expect(personNameMatches('Nancy Pelosi', 'house:pelosi:nancy', tokens('nancy'))).toBe(true);
    expect(personNameMatches('Nancy Pelosi', 'house:pelosi:nancy', tokens('pelosi'))).toBe(true);
    expect(personNameMatches('Nancy Pelosi', 'house:pelosi:nancy', tokens('Nancy Pelosi'))).toBe(true);
    expect(personNameMatches('Nancy Pelosi', 'house:pelosi:nancy', tokens('PELO'))).toBe(true);
    expect(personNameMatches('Donald Trump', 'president:trump:donald', tokens('trump'))).toBe(true);
    expect(personNameMatches('Nancy Mace', 'house:mace:nancy', tokens('pelosi'))).toBe(false);
    expect(peopleSearchQuery('a')).toBeNull();
    expect(peopleSearchQuery('')).toBeNull();
  });
});

describe('politician people search', () => {
  it('returns distinct people with office, party, state, and trade counts', async () => {
    const store = memoryStore();
    await seed(store);

    const pelosi = await store.searchPoliticianPeople({ q: 'pelosi' });
    expect(pelosi.people).toEqual([
      expect.objectContaining({
        personKey: 'house:pelosi:nancy',
        personName: 'Nancy Pelosi',
        office: 'house',
        party: 'D',
        state: 'CA',
        tradeCount: 3,
      }),
    ]);

    const nancy = await store.searchPoliticianPeople({ q: 'Nancy' });
    expect(nancy.people.map((p) => p.personName)).toEqual(['Nancy Pelosi', 'Nancy Mace']);
    expect(nancy.people[0].tradeCount).toBeGreaterThan(nancy.people[1].tradeCount);

    const full = await store.searchPoliticianPeople({ q: 'Nancy Pelosi' });
    expect(full.people.map((p) => p.personKey)).toEqual(['house:pelosi:nancy']);

    const trump = await store.searchPoliticianPeople({ q: 'trump' });
    expect(trump.people).toEqual([
      expect.objectContaining({
        personName: 'Donald Trump',
        office: 'president',
        party: 'R',
        state: null,
        tradeCount: 1,
        latestDisclosure: '2026-10-08',
      }),
    ]);

    const vance = await store.searchPoliticianPeople({ q: 'vance' });
    expect(vance.people[0]).toMatchObject({ office: 'vice-president', tradeCount: 2 });

    expect((await store.searchPoliticianPeople({ q: 'a' })).people).toEqual([]);
    expect((await store.searchPoliticianPeople({ q: 'zzzz' })).people).toEqual([]);
  });

  it('caps the list at 10 and ranks by trade count', async () => {
    const store = memoryStore();
    for (let i = 0; i < 12; i += 1) {
      const trades = Array.from({ length: i + 1 }, (_, n) => trade(`T${n}`));
      await addPerson(store, {
        key: `smith-${i}`, first: `Ann${i}`, last: 'Smith', state: 'TX', trades,
      });
    }
    const found = await store.searchPoliticianPeople({ q: 'smith' });
    expect(found.people).toHaveLength(10);
    expect(found.people[0]).toMatchObject({ personName: 'Ann11 Smith', tradeCount: 12 });
    expect(found.people[9].tradeCount).toBe(3);
    expect(found.people.map((p) => p.tradeCount)).toEqual([12, 11, 10, 9, 8, 7, 6, 5, 4, 3]);
  });

  it('keeps an empty 30-day window from hiding the latest disclosure', async () => {
    const store = memoryStore();
    await seed(store);
    const trump = await store.getPolitician('president:trump:donald', { window: 30, asOf: '2026-11-14' });
    expect(trump.window).toEqual({ days: 30, from: '2026-10-16', to: '2026-11-14' });
    expect(trump.total).toBe(0);
    expect(trump.items).toEqual([]);
    expect(trump.counts.trades).toBe(1);
    expect(trump.latestDisclosure).toBe('2026-10-08');
    expect(trump.tickerRollup).toMatchObject({ window: 30, from: '2026-10-16', to: '2026-11-14', tickers: [] });

    const all = await store.getPolitician('president:trump:donald', { window: 30, asOf: '2026-11-14', feed: 'all' });
    expect(all.window).toEqual({ days: 30, from: '2026-10-16', to: '2026-11-14' });
    expect(all.items.map((item) => item.disclosedDate)).toEqual(['2026-10-08']);
    expect(all.tickerRollup.tickers).toEqual([]);

    const widened = await store.getPolitician('president:trump:donald', { asOf: '2026-11-14' });
    expect(widened.window).toBeNull();
    expect(widened.items.map((item) => item.disclosedDate)).toEqual(['2026-10-08']);

    const pelosi = await store.getPolitician('house:pelosi:nancy', { window: 30, asOf: '2026-11-14' });
    expect(pelosi.total).toBe(3);
    expect(pelosi.latestDisclosure).toBe('2026-11-06');
    expect(pelosi.counts).toMatchObject({ buy: 2, sell: 1, trades: 3 });
    expect(pelosi.tickerRollup.tickers.map((row) => row.ticker).sort()).toEqual(['AAPL', 'MSFT', 'NVDA']);
  });
});

describe('people search SQL', () => {
  it('uses the name indexes and limits to 10', () => {
    const parsed = peopleSearchQuery('pelosi');
    const { sql, params } = buildPeopleSearchSql(parsed.tsquery);
    expect(params).toEqual(['pelosi:*']);
    expect(sql).toMatch(/to_tsvector\('simple', person_name\)/);
    expect(sql).toMatch(/to_tsvector\('simple', replace\(person_key, ':', ' '\)\)/);
    expect(sql).toMatch(/@@ to_tsquery\('simple', \$1\)/);
    expect(sql).toMatch(/count\(\*\)::int AS trade_count/);
    expect(sql).toMatch(/LIMIT 10/);
    expect(sql).not.toMatch(/\$\{|LIMIT \$/);
    const dbSrc = readFileSync(new URL('../db.js', import.meta.url), 'utf8');
    expect(dbSrc).toMatch(/CREATE INDEX IF NOT EXISTS politician_trades_person_name_fts/);
    expect(dbSrc).toMatch(/ON politician_trades USING gin \(to_tsvector\('simple', person_name\)\)/);
    expect(dbSrc).toMatch(/CREATE INDEX IF NOT EXISTS politician_filings_person_name_fts/);
    expect(dbSrc).toMatch(/CREATE INDEX IF NOT EXISTS politician_trades_person_key_fts/);
    expect(dbSrc).toMatch(/CREATE INDEX IF NOT EXISTS politician_filings_person_key_fts/);
  });
});

async function withServer(app, fn) {
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const { port } = server.address();
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    server.close();
    await once(server, 'close');
  }
}

describe('GET /api/politician-trades/people', () => {
  it('searches by name and still opens a person by key', async () => {
    const store = memoryStore();
    await seed(store);
    const app = express();
    app.use('/api/politician-trades', createPoliticianRouter({ store }));
    await withServer(app, async (base) => {
      const found = await fetch(`${base}/api/politician-trades/people?q=pelosi`);
      expect(found.status).toBe(200);
      const body = await found.json();
      expect(body.people).toHaveLength(1);
      expect(body.people[0]).toMatchObject({
        personName: 'Nancy Pelosi',
        office: 'house',
        party: 'D',
        state: 'CA',
        tradeCount: 3,
      });

      const empty = await fetch(`${base}/api/politician-trades/people?q=a`);
      expect((await empty.json()).people).toEqual([]);

      const person = await fetch(`${base}/api/politician-trades/people/${encodeURIComponent('house:pelosi:nancy')}`);
      expect(person.status).toBe(200);
      const page = await person.json();
      expect(page.person.personName).toBe('Nancy Pelosi');
      expect(page.counts.trades).toBe(3);
      expect(page.latestDisclosure).toBe('2026-11-06');
    });
  });
});
