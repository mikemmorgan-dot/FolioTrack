import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildPoliticianDigest } from './digest.js';
import { runPoliticianPoll } from './ingest.js';
import {
  memoryMethods,
  normalizeFeedQuery,
  pageFeed,
  politicianBucket,
} from './memoryStore.js';
import { canonicalTicker, tickersMatch } from './normalize.js';
import { parseHouseFilerStatus, parseHouseIndexXml, parseHousePtrText } from './parseHouse.js';
import { parseOge278Text, parseOgeApiRow } from './parseOge.js';
import { parseSenatePtrHtml, parseSenateSearchRow } from './parseSenate.js';
import { buildFeedFilter } from './pgStore.js';
import { buildFilingRecord, buildTradeRows } from './records.js';
import { classifyHouseFiler, matchHouseParty, parseHouseRoster } from './roster.js';
import { nextPollDelayMs, politicianRunDelayMs, startPoliticianScheduler } from './schedule.js';
import { ocrTransactionType, rowsFromOcrWords } from './ocrRows.js';
import { readZipEntries, zipText } from './zip.js';

const dir = dirname(fileURLToPath(import.meta.url));
const fixture = (name) => readFileSync(join(dir, '../fixtures/politicians', name), 'utf8');
const fixtureBuf = (name) => readFileSync(join(dir, '../fixtures/politicians', name));

function memoryStore() {
  const db = politicianBucket({
    models: {
      growth: {
        key: 'growth',
        name: 'Growth',
        riskRank: 4,
        versions: [{
          id: 'v1',
          effectiveDate: '2020-01-01',
          holdings: [
            { instrumentId: 'aapl', weight: 0.1 },
            { instrumentId: 'ry', weight: 0.1 },
          ],
        }],
      },
    },
    instruments: {
      aapl: { id: 'aapl', symbol: 'AAPL' },
      ry: { id: 'ry', symbol: 'RY.TO' },
      brk: { id: 'brk', symbol: 'BRK.B' },
    },
  });
  const store = { db };
  for (const [name, fn] of Object.entries(memoryMethods)) {
    store[name] = (...args) => fn.apply({ db, persist() {} }, args);
  }
  store.getAlertSettings = async () => ({ alertEmail: 'mikemmorgan@gmail.com' });
  return store;
}

describe('house filings', () => {
  it('keeps periodic reports from the clerk XML and ignores other filing types', () => {
    const filings = parseHouseIndexXml(fixture('house-index.xml'));
    expect(filings.map((f) => f.docId)).toEqual(['20035780', '9116403']);
    expect(filings[0]).toMatchObject({
      filingKey: '2026:20035780',
      last: 'Pelosi',
      stateDst: 'CA11',
      filedDate: '2026-11-06',
      sourceUrl: 'https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2026/20035780.pdf',
    });
  });

  it('reads the same index out of the yearly zip', () => {
    const entries = readZipEntries(fixtureBuf('house-index.zip'));
    const xml = zipText(entries, '.xml');
    expect(parseHouseIndexXml(xml)).toHaveLength(2);
  });

  it('parses a machine-generated PTR, including a wrapped amount', () => {
    const parsed = parseHousePtrText(fixture('house-ptr-pelosi.txt'));
    expect(parsed.status).toBe('parsed');
    expect(parsed.trades).toEqual([
      expect.objectContaining({
        owner: 'spouse',
        ticker: 'WBD',
        assetClass: 'stock',
        txType: 'sell',
        partial: false,
        txDate: '2026-10-07',
        amountRange: '$50,001 - $100,000',
      }),
    ]);
    expect(parsed.trades[0].asset).toMatch(/Warner Bros/);
    expect(parsed.trades[0].asset).not.toMatch(/Cash proceeds/);
    expect(parsed.filerStatus).toBe('member');
  });

  it('does not treat a wrapped description as part of the asset, and leaves a non-equity without a ticker', () => {
    const parsed = parseHousePtrText(fixture('house-ptr-llc.txt'));
    expect(parsed.status).toBe('parsed');
    expect(parsed.trades[0]).toMatchObject({
      owner: 'spouse',
      ticker: null,
      assetClass: 'bond',
      txType: 'buy',
      amountRange: '$500,001 - $1,000,000',
    });
    expect(parsed.trades[0].asset).toBe('REOF XXX, LLC');
    expect(parsed.trades[0].asset).not.toMatch(/Francisco/);
  });

  it('marks a scan for review instead of inventing rows', () => {
    expect(parseHousePtrText('')).toMatchObject({ status: 'needs_manual_review', trades: [] });
    expect(parseHousePtrText('Digitally Signed: someone\nno table here').status).toBe('needs_manual_review');
  });
});

describe('senate filings', () => {
  it('splits electronic and paper report links', () => {
    const electronic = parseSenateSearchRow([
      'Shelley M', 'Capito', 'Capito, Shelley Moore (Senator)',
      '<a href="/search/view/ptr/a89c0c6b-4c12-4955-98f9-3a54ca52d8a3/" target="_blank">Periodic Transaction Report for 11/04/2026</a>',
      '11/04/2026',
    ]);
    expect(electronic).toMatchObject({ kind: 'ptr', filingKey: 'a89c0c6b-4c12-4955-98f9-3a54ca52d8a3', filedDate: '2026-11-04' });
    const paper = parseSenateSearchRow([
      'RICHARD ', 'BLUMENTHAL', 'Senator',
      '<a href="/search/view/paper/929216d5-5dbd-429c-858c-1e9332924627/">Periodic Transaction Report for 08/31/2026</a>',
      '08/31/2026',
    ]);
    expect(paper.kind).toBe('paper');
  });

  it('parses the electronic transaction table', () => {
    const parsed = parseSenatePtrHtml(fixture('senate-ptr-capito.html'));
    expect(parsed.status).toBe('parsed');
    expect(parsed.trades).toHaveLength(4);
    expect(parsed.trades[0]).toMatchObject({
      owner: 'spouse',
      ticker: 'AAPL',
      assetClass: 'stock',
      txType: 'sell',
      partial: true,
      txDate: '2026-10-21',
      amountRange: '$1,001 - $15,000',
    });
  });
});

describe('presidential 278-T', () => {
  it('keeps a posted PDF and a request-only row', () => {
    const posted = parseOgeApiRow({
      type: "<a href='https://extapps2.oge.gov/201/Presiden.nsf/PAS+Index/0BDCCCE7DE13AEFA85258E8A002DE2B5/$FILE/Donald-J-Trump.09.17.2026-278T.pdf'>278 Transaction</a>",
      name: 'Trump, Donald J',
      title: 'President',
      docDate: '2026-10-08T04:21:11',
    });
    expect(posted).toMatchObject({
      office: 'president',
      request: false,
      filingKey: '0BDCCCE7DE13AEFA85258E8A002DE2B5',
      filedDate: '2026-10-08',
    });
    const requested = parseOgeApiRow({
      type: "<a href='https://extapps2.oge.gov/201/Presiden.nsf/201%20Request?OpenForm&Filer=Abbott'>278 Transaction (Request this Document)</a>",
      name: 'Abbott, James',
      title: 'Member',
      docDate: '2020-12-15T03:15:54',
    });
    expect(requested.request).toBe(true);
    expect(requested.office).toBeNull();
  });

  it('refuses the OCR text layer from a scanned 278-T', () => {
    const parsed = parseOge278Text(fixture('oge-278t-ocr.txt'));
    expect(parsed.status).toBe('needs_manual_review');
    expect(parsed.trades).toEqual([]);
  });

  it('parses a text-layer 278-T without inventing a ticker that was not printed', () => {
    const parsed = parseOge278Text(fixture('oge-278t-text.txt'));
    expect(parsed.status).toBe('parsed');
    expect(parsed.trades.map((t) => [t.ticker, t.txType, t.owner, t.amountRange])).toEqual([
      ['AAPL', 'buy', 'unknown', '$1,001 - $15,000'],
      ['V', 'sell', 'unknown', '$50,001 - $100,000'],
      ['IVV', 'buy', 'spouse', '$15,001 - $50,000'],
    ]);
    expect(parsed.trades[2].assetClass).toBe('etf');
  });
});

describe('feed sql', () => {
  it('binds one placeholder per value and keeps the page on LIMIT/OFFSET', () => {
    const { whereSql, params } = buildFeedFilter(normalizeFeedQuery({
      q: '100%',
      office: 'president',
      party: 'D',
      side: 'buy',
      ticker: 'brk/b',
      from: '2026-01-01',
      to: '2026-11-13',
      heldOnly: '1',
    }), ['AAPL']);
    const marks = whereSql.match(/\$\d+/g);
    expect(marks).toEqual(params.map((_, i) => `$${i + 1}`));
    expect(params).toContain('D');
    expect(params).toContain('BRK.B');
    expect(params.some((p) => String(p).includes('\\%'))).toBe(true);
    expect(whereSql).toMatch(/office IN \('president', 'vice-president'\)/);
    expect(whereSql).toMatch(/asset_class IN \('stock', 'etf', 'fund'\)/);
    const members = buildFeedFilter(normalizeFeedQuery({ filer: 'member' }), []);
    expect(members.whereSql).toMatch(/filer_status IS DISTINCT FROM 'candidate'/);
    const candidates = buildFeedFilter(normalizeFeedQuery({ filer: 'candidate' }), []);
    expect(candidates.whereSql).toBe(`WHERE filer_status = 'candidate'`);
    expect(buildFeedFilter(normalizeFeedQuery({}), []).whereSql).not.toMatch(/filer_status/);
  });
});

describe('ticker matching', () => {
  it('matches a US ticker and a class share, and not a Canadian listing', () => {
    expect(tickersMatch('AAPL', 'aapl')).toBe(true);
    expect(tickersMatch('BRK.B', 'BRK/B')).toBe(true);
    expect(tickersMatch('BRK.B', 'BRK-B')).toBe(true);
    expect(tickersMatch('RY.TO', 'RY')).toBe(false);
    expect(tickersMatch('RY.TO', 'RY.TO')).toBe(true);
    expect(canonicalTicker('SHOP.TO')).toBe('SHOP.TO');
    expect(tickersMatch('AAPL', null)).toBe(false);
  });

  it('does not badge an option on a held stock', async () => {
    const store = memoryStore();
    const filing = buildFilingRecord({
      source: 'senate', filingKey: 'opt', first: 'Pat', last: 'Example', office: 'senate',
      filedDate: '2026-11-01', sourceUrl: 'https://efdsearch.senate.gov/x', parsed: { status: 'parsed' },
    });
    const trades = buildTradeRows(filing, {
      status: 'parsed',
      trades: [{
        owner: 'self', ticker: 'AAPL', asset: 'AAPL call', assetClass: 'option',
        txType: 'buy', partial: false, txDate: '2026-10-01', amountRange: '$1,001 - $15,000',
      }],
    });
    await store.insertPoliticianBundle(filing, trades);
    const feed = await store.listPoliticianFeed({ heldOnly: '1' });
    expect(feed.total).toBe(0);
    const summary = await store.summarizeHeldTrades(['AAPL']);
    expect(summary).toEqual([]);
  });
});

describe('dedupe and feed', () => {
  it('stores one filing when the same bundle is inserted twice', async () => {
    const store = memoryStore();
    const filing = buildFilingRecord({
      source: 'house', filingKey: '2026:20035780', first: 'Nancy', last: 'Pelosi', office: 'house',
      party: 'D', state: 'CA', filedDate: '2026-11-06',
      sourceUrl: 'https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2026/20035780.pdf',
      parsed: { status: 'parsed' },
    });
    const parsed = parseHousePtrText(fixture('house-ptr-pelosi.txt'));
    const trades = buildTradeRows(filing, parsed);
    expect(trades[0].id).toBe('house:2026:20035780:1');
    expect(trades[0].lagDays).toBe(30);
    const first = await store.insertPoliticianBundle(filing, trades);
    const second = await store.insertPoliticianBundle(filing, trades);
    expect(first).toEqual({ created: true, trades: 1 });
    expect(second).toEqual({ created: false, trades: 0 });
    expect(store.db.politicianTrades).toHaveLength(1);
  });

  it('filters and pages without returning the whole set', async () => {
    const store = memoryStore();
    for (const [key, date, side] of [['a', '2026-11-01', 'buy'], ['b', '2026-10-01', 'sell']]) {
      const filing = buildFilingRecord({
        source: 'senate', filingKey: key, first: 'Ada', last: 'Lovelace', office: 'senate',
        party: 'D', filedDate: date, sourceUrl: `https://example.test/${key}`, parsed: { status: 'parsed' },
      });
      await store.insertPoliticianBundle(filing, buildTradeRows(filing, {
        status: 'parsed',
        trades: [{
          owner: 'self', ticker: 'AAPL', asset: 'Apple', assetClass: 'stock',
          txType: side, txDate: date, amountRange: '$1,001 - $15,000',
        }],
      }));
    }
    const sell = await store.listPoliticianFeed({ side: 'sell', limit: 1, offset: 0 });
    expect(sell.total).toBe(1);
    expect(sell.items[0].txType).toBe('sell');
    const newest = await store.listPoliticianFeed({});
    expect(newest.items.map((row) => row.disclosedDate)).toEqual(['2026-11-01', '2026-10-01']);
    const held = await store.listPoliticianFeed({ heldOnly: '1' });
    expect(held.total).toBe(2);
    const query = normalizeFeedQuery({ limit: 1, offset: 0 });
    expect(pageFeed(newest.items, query).items).toHaveLength(1);
  });

  it('matches a house filer to the clerk roster only when the name is unique', () => {
    const roster = parseHouseRoster(`
      <member><lastname>Pelosi</lastname><firstname>Nancy</firstname><party>D</party>
        <state postal-code="CA"></state><district>11</district></member>
      <member><lastname>Smith</lastname><firstname>Ann</firstname><party>D</party>
        <state postal-code="CA"></state><district>11</district></member>
      <member><lastname>Smith</lastname><firstname>Bob</firstname><party>R</party>
        <state postal-code="CA"></state><district>11</district></member>
    `);
    expect(matchHouseParty({ last: 'Pelosi', first: 'Nancy', stateDst: 'CA11' }, roster).party).toBe('D');
    expect(matchHouseParty({ last: 'Smith', first: 'Pat', stateDst: 'CA11' }, roster).party).toBeNull();
  });

  it('keeps House candidate PTRs and labels them from the form or the roster', () => {
    expect(parseHouseFilerStatus('Status: Candidate')).toBe('candidate');
    expect(parseHouseFilerStatus('Status: Member')).toBe('member');
    const roster = parseHouseRoster(`
      <member><lastname>Pelosi</lastname><firstname>Nancy</firstname><party>D</party>
        <state postal-code="CA"></state><district>11</district></member>
    `);
    const seat = matchHouseParty({ last: 'Pelosi', first: 'Nancy', stateDst: 'CA11' }, roster);
    expect(classifyHouseFiler({
      pdfStatus: 'candidate',
      filing: { prefix: 'Hon.' },
      matched: seat.matched,
    })).toBe('candidate');
    expect(classifyHouseFiler({ pdfStatus: 'member', matched: false, filing: { prefix: '' } })).toBe('member');
    expect(classifyHouseFiler({ matched: seat.matched, filing: { prefix: '' } })).toBe('member');
    expect(classifyHouseFiler({ matched: false, filing: { prefix: 'Hon.' } })).toBe('member');
    expect(classifyHouseFiler({ matched: false, filing: { prefix: '' } })).toBe('candidate');
  });

  it('filters the feed to members or candidates and defaults to all', async () => {
    const store = memoryStore();
    const member = buildFilingRecord({
      source: 'house', filingKey: '2026:1', first: 'Nancy', last: 'Pelosi', office: 'house',
      filerStatus: 'member', filedDate: '2026-11-06', sourceUrl: 'https://example.test/member',
      parsed: { status: 'parsed' },
    });
    const candidate = buildFilingRecord({
      source: 'house', filingKey: '2026:2', first: 'Ada', last: 'Lovelace', office: 'house',
      filerStatus: 'candidate', filedDate: '2026-11-01', sourceUrl: 'https://example.test/candidate',
      parsed: { status: 'parsed' },
    });
    const row = {
      owner: 'self', ticker: 'AAPL', asset: 'Apple', assetClass: 'stock',
      txType: 'buy', txDate: '2026-10-01', amountRange: '$1,001 - $15,000',
    };
    await store.insertPoliticianBundle(member, buildTradeRows(member, { trades: [row] }));
    await store.insertPoliticianBundle(candidate, buildTradeRows(candidate, { trades: [{ ...row, txDate: '2026-09-01' }] }));
    const all = await store.listPoliticianFeed({});
    expect(all.total).toBe(2);
    const members = await store.listPoliticianFeed({ filer: 'member' });
    expect(members.items.map((item) => item.personName)).toEqual(['Nancy Pelosi']);
    const candidates = await store.listPoliticianFeed({ filer: 'candidate' });
    expect(candidates.items.map((item) => item.filerStatus)).toEqual(['candidate']);
    const person = await store.getPolitician(candidate.personKey);
    expect(person.person.filerStatus).toBe('candidate');
  });
});

describe('digest email', () => {
  const held = new Map([['AAPL', [{ key: 'growth', name: 'Growth' }]]]);
  const trades = [
    {
      personName: 'Shelley Capito', office: 'senate', party: 'R', ticker: 'MSFT', tickerNorm: 'MSFT',
      assetClass: 'stock', asset: 'Microsoft', owner: 'spouse', txType: 'sell', partial: true,
      txDate: '2026-10-21', disclosedDate: '2026-11-04', lagDays: 14,
      amountRange: '$1,001 - $15,000', sourceUrl: 'https://efdsearch.senate.gov/msft',
    },
    {
      personName: 'Shelley Capito', office: 'senate', party: 'R', ticker: 'AAPL', tickerNorm: 'AAPL',
      assetClass: 'stock', asset: 'Apple', owner: 'spouse', txType: 'sell', partial: true,
      txDate: '2026-10-21', disclosedDate: '2026-11-04', lagDays: 14,
      amountRange: '$1,001 - $15,000', sourceUrl: 'https://efdsearch.senate.gov/aapl',
    },
  ];

  it('puts held tickers first and sends one body for the whole batch', () => {
    const message = buildPoliticianDigest({ trades, heldByNorm: held });
    expect(message.subject).toMatch(/2 new politician trades \(1 in your models\)/);
    expect(message.text.indexOf('AAPL')).toBeLessThan(message.text.indexOf('MSFT'));
    expect(message.text).toMatch(/Growth/);
    expect(message.text).not.toMatch(/account/i);
    expect(message.html.match(/Source filing/g)).toHaveLength(2);
  });

  it('labels a House candidate in the digest', () => {
    const message = buildPoliticianDigest({
      trades: [{ ...trades[1], office: 'house', filerStatus: 'candidate', personName: 'Ada Lovelace' }],
      heldByNorm: held,
    });
    expect(message.text).toMatch(/Ada Lovelace \(House, Candidate, Republican\)/);
    expect(message.html).toMatch(/Candidate/);
  });

  it('shows an estimated net when one ticker was both bought and sold', () => {
    const message = buildPoliticianDigest({
      trades: [
        { ...trades[1], txType: 'buy', amountRange: '$1,001 - $15,000' },
        { ...trades[1], txType: 'sell', amountRange: '$15,001 - $50,000' },
        { ...trades[1], txType: 'exchange', amountRange: '$1,001 - $15,000' },
        { ...trades[0], ticker: null, tickerNorm: null, asset: 'Municipal bond', assetClass: 'other' },
      ],
      heldByNorm: held,
    });
    expect(message.text).toMatch(/Net by ticker/);
    expect(message.text).toMatch(/AAPL · Net 0 · Est\. net -\$24\.5K · 1 buy · 1 sell · 1 exchange/);
    expect(message.text).not.toMatch(/Municipal bond · Net/);
    expect(message.html).toMatch(/Estimated from the midpoint/);
    expect(message.html).toMatch(/AAPL · Net 0/);
  });

  it('drops other tickers when held-only is on, and skips an empty digest', () => {
    const message = buildPoliticianDigest({ trades, heldByNorm: held, heldOnly: true });
    expect(message.text).toMatch(/AAPL/);
    expect(message.text).not.toMatch(/MSFT/);
    expect(buildPoliticianDigest({ trades: [], reviews: [], heldByNorm: held, heldOnly: true })).toBeNull();
  });
});

describe('scheduler', () => {
  afterEach(() => vi.useRealTimers());

  it('does not run during the boot delay while the backfill is unfinished', async () => {
    vi.useFakeTimers();
    const run = vi.fn(async () => {});
    const stop = startPoliticianScheduler({
      run,
      getState: async () => ({ backfillComplete: false }),
      now: () => 0,
      initialDelayMs: 45_000,
      intervalMs: 24 * 60 * 60 * 1000,
      logger: { log() {}, error() {} },
    });
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(44_000);
    expect(run).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(run).toHaveBeenCalledTimes(1);
    stop();
  });

  it('waits out the rest of the day after a successful daily run', () => {
    const delay = nextPollDelayMs({
      backfillComplete: true,
      lastSuccessAt: '2026-11-13T12:00:00Z',
      nowMs: Date.parse('2026-11-13T14:00:00Z'),
      intervalMs: 24 * 60 * 60 * 1000,
      boot: false,
    });
    expect(delay).toBe(22 * 60 * 60 * 1000);
    expect(politicianRunDelayMs('2026-11-13T12:00:00Z', Date.parse('2026-11-14T12:00:00Z'), 24 * 60 * 60 * 1000, 0)).toBe(0);
  });

  it('resumes an unfinished backfill on wake instead of waiting a day', () => {
    const delay = nextPollDelayMs({
      backfillComplete: false,
      lastSuccessAt: '2026-11-13T12:00:00Z',
      nowMs: Date.parse('2026-11-13T20:00:00Z'),
      boot: true,
      initialDelayMs: 45_000,
    });
    expect(delay).toBe(45_000);
  });
});

describe('278-T OCR rows', () => {
  it('accepts an unambiguous one-character slip and rejects a guessier type word', () => {
    expect(ocrTransactionType('purchase')).toBe('purchase');
    expect(ocrTransactionType('purchaso')).toBe('purchase');
    expect(ocrTransactionType('nurchasc')).toBeNull();
    expect(ocrTransactionType('sale')).toBe('sale');
  });

  it('keeps only validated rows from a real presidential 278-T page', () => {
    const words = JSON.parse(fixture('oge-278t-page2-words.json'));
    const { trades, rejected } = rowsFromOcrWords(words, { now: new Date('2026-11-13T00:00:00Z') });
    expect(words.length).toBeGreaterThan(100);
    expect(trades.length).toBeGreaterThan(15);
    expect(rejected).toBeGreaterThan(0);
    for (const trade of trades) {
      expect(trade.ocr).toBe(true);
      expect(trade.ocrConfidence).toBeGreaterThanOrEqual(60);
      expect(trade.txType).toBe('buy');
      expect(trade.amountRange).toMatch(/^\$[\d,]+ - \$[\d,]+$/);
      expect(trade.txDate.startsWith('2025-')).toBe(true);
      expect(trade.asset.length).toBeGreaterThan(8);
    }
  });
});

describe('poll dedupe', () => {
  it('imports a senate trade once and does not email the backfill', async () => {
    const store = memoryStore();
    const calls = [];
    const email = { send: vi.fn(async () => ({ ok: true, id: 'email-1' })) };
    const zip = fixtureBuf('house-index.zip');
    const capito = fixture('senate-ptr-capito.html');
    const fetchImpl = async (url, init = {}) => {
      const method = init.method || 'GET';
      calls.push(`${method} ${url}`);
      const u = String(url);
      const hdrs = (extra = {}) => ({
        get: (name) => extra[name.toLowerCase()] ?? null,
        getSetCookie: () => (extra['set-cookie'] ? [extra['set-cookie']] : []),
      });
      const respond = (status, body, extra = {}) => ({
        status,
        ok: status >= 200 && status < 300,
        headers: hdrs(extra),
        text: async () => body,
        arrayBuffer: async () => Buffer.from(body),
      });
      if (u.includes('MemberData')) {
        return respond(200, '<member><lastname>Capito</lastname><firstname>Shelley</firstname><party>R</party><state postal-code="WV"></state><district>2</district></member>');
      }
      if (u.includes('senators_cfm')) {
        return respond(200, '<member><last_name>Capito</last_name><first_name>Shelley</first_name><party>R</party><state>WV</state></member>');
      }
      if (u.includes('FD.zip')) return { ...respond(200, zip), arrayBuffer: async () => zip };
      if (u.includes('/ptr-pdfs/')) return respond(200, 'not-a-pdf');
      if (u.endsWith('/search/') && method === 'GET') {
        return respond(302, '', { location: 'https://efdsearch.senate.gov/search/home/' });
      }
      if (u.includes('/search/home/') && method === 'GET') {
        return respond(200, '<input type="hidden" name="csrfmiddlewaretoken" value="token-1">');
      }
      if (u.includes('/search/home/') && method === 'POST') {
        return respond(302, '', { 'set-cookie': 'csrftoken=csrf-1; Path=/' });
      }
      if (u.includes('/search/report/data/')) {
        return respond(200, JSON.stringify({
          recordsFiltered: 2,
          data: [
            ['Shelley M', 'Capito', 'Senator', '<a href="/search/view/ptr/a89c0c6b-4c12-4955-98f9-3a54ca52d8a3/">PTR</a>', '11/04/2026'],
            ['RICHARD ', 'BLUMENTHAL', 'Senator', '<a href="/search/view/paper/929216d5-5dbd-429c-858c-1e9332924627/">PTR</a>', '08/31/2026'],
          ],
        }));
      }
      if (u.includes('/search/view/ptr/')) return respond(200, capito);
      if (u.includes('API.xsp')) {
        return respond(200, JSON.stringify({
          recordsFiltered: 1,
          recordsTotal: 1,
          data: [{
            type: "<a href='https://extapps2.oge.gov/201/Presiden.nsf/PAS+Index/0BDCCCE7DE13AEFA85258E8A002DE2B5/$FILE/sample-278T.pdf'>278 Transaction</a>",
            name: 'Trump, Donald J',
            title: 'President',
            docDate: '2026-10-08T04:21:11',
          }],
        }));
      }
      if (u.includes('278T') && method === 'HEAD') return respond(200, '', { 'content-length': '9000000' });
      return respond(404, '');
    };

    const env = { ...process.env, POLITICIAN_FETCH_DELAY_MS: '0', POLITICIAN_DOCS_PER_RUN: '5', POLITICIAN_BACKFILL_YEARS: '1' };
    const now = () => new Date('2026-11-13T15:00:00Z');
    const quiet = { log() {}, warn() {}, error() {} };
    const first = await runPoliticianPoll({
      store, fetchImpl, email, now, sleep: async () => {}, logger: quiet, env,
      ocrTools: async () => false,
    });
    expect(first.digest.reason).toBe('backfill');
    expect(email.send).not.toHaveBeenCalled();
    const afterFirst = store.db.politicianTrades.length;
    expect(afterFirst).toBe(4);
    expect(store.db.politicianFilings['senate:929216d5-5dbd-429c-858c-1e9332924627'].parseStatus).toBe('needs_manual_review');
    const oge = store.db.politicianFilings['oge:0BDCCCE7DE13AEFA85258E8A002DE2B5'];
    expect(oge.parseStatus).toBe('pending_ocr');
    expect(oge.ocrDone).toBe(false);
    expect(calls.some((line) => line.includes('278T'))).toBe(false);

    await runPoliticianPoll({
      store, fetchImpl, email, now, sleep: async () => {}, logger: quiet, env,
      ocrTools: async () => false,
    });
    expect(store.db.politicianTrades).toHaveLength(afterFirst);
    expect(email.send).not.toHaveBeenCalled();
    const ptrGets = calls.filter((line) => line.startsWith('GET') && line.includes('/search/view/ptr/'));
    expect(ptrGets).toHaveLength(1);
  });
});
