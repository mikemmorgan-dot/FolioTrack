import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { AMOUNT_RANGES } from './normalize.js';
import {
  memoryMethods,
  politicianBucket,
} from './memoryStore.js';
import { buildFilingRecord, buildTradeRows } from './records.js';
import { attachHeldModels } from './summary.js';
import {
  OVER_50M,
  OVER_50M_MIN,
  SUMMARY_CLUSTER_SQL,
  SUMMARY_EXCLUDED_SQL,
  SUMMARY_NET_SQL,
  SUMMARY_RANK_SQL,
  aggregateSummary,
  amountSpan,
  emptyAmounts,
  addAmount,
  normalizeClusterMin,
  normalizeSummaryQuery,
  summaryBounds,
  summaryFromSql,
} from './summary.js';

const AS_OF = '2026-11-13';

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
            { instrumentId: 'brk', weight: 0.1 },
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
  return store;
}

function trade(ticker, extra = {}) {
  return {
    owner: 'self',
    ticker,
    asset: extra.asset || ticker || 'Municipal bond',
    assetClass: extra.assetClass || (ticker ? 'stock' : 'other'),
    txType: extra.txType || 'buy',
    partial: false,
    txDate: extra.txDate || '2026-10-01',
    amountRange: extra.amountRange || '$1,001 - $15,000',
  };
}

async function addFiling(store, opts) {
  const filing = buildFilingRecord({
    source: opts.source || 'house',
    filingKey: opts.key,
    first: opts.first,
    last: opts.last,
    office: opts.office || 'house',
    party: opts.party === undefined ? 'D' : opts.party,
    filerStatus: opts.filerStatus || 'member',
    filedDate: opts.filedDate || AS_OF,
    sourceUrl: `https://example.test/${opts.key}`,
    parsed: { status: opts.status || 'parsed' },
  });
  const rows = opts.trades?.length ? buildTradeRows(filing, { trades: opts.trades }) : [];
  await store.insertPoliticianBundle(filing, rows);
  return filing;
}

function summary(store, query = {}) {
  return store.summarizePoliticianTrades({ asOf: AS_OF, ...query });
}

describe('summary window', () => {
  it('uses an inclusive disclosure window ending on the as-of date', () => {
    expect(summaryBounds(7, AS_OF)).toEqual({ from: '2026-11-07', to: AS_OF });
    expect(summaryBounds(30, AS_OF)).toEqual({ from: '2026-10-15', to: AS_OF });
    expect(summaryBounds(90, AS_OF)).toEqual({ from: '2026-08-16', to: AS_OF });
    expect(summaryBounds(7, '2026-03-01')).toEqual({ from: '2026-02-23', to: '2026-03-01' });
    expect(summaryBounds(7, '2026-01-03')).toEqual({ from: '2025-12-28', to: '2026-01-03' });
    expect(normalizeSummaryQuery({ window: 14, asOf: AS_OF }).windowDays).toBe(30);
    expect(normalizeSummaryQuery({ asOf: AS_OF }).windowDays).toBe(30);
  });

  it('keeps the boundary day and drops the day outside each window', async () => {
    const store = memoryStore();
    const rows = [
      ['before90', '2026-08-15', 'OLD'],
      ['start90', '2026-08-16', 'D90'],
      ['before30', '2026-10-14', 'D30'],
      ['start30', '2026-10-15', 'M30'],
      ['before7', '2026-11-06', 'W7'],
      ['start7', '2026-11-07', 'IN7'],
      ['end', AS_OF, 'END'],
      ['after', '2026-11-14', 'FUT'],
    ];
    for (const [key, filedDate, ticker] of rows) {
      await addFiling(store, {
        key, filedDate, first: 'Ann', last: key, ticker,
        trades: [trade(ticker)],
      });
    }
    const week = await summary(store, { window: 7 });
    expect(week.bought.map((row) => row.ticker).sort()).toEqual(['END', 'IN7']);
    const month = await summary(store, { window: 30 });
    expect(month.bought.map((row) => row.ticker).sort()).toEqual(['END', 'IN7', 'M30', 'W7']);
    const quarter = await summary(store, { window: 90 });
    expect(quarter.bought.map((row) => row.ticker).sort()).toEqual(['D30', 'D90', 'END', 'IN7', 'M30', 'W7']);
    expect(quarter.bought.find((row) => row.ticker === 'OLD')).toBeUndefined();
    expect(quarter.bought.find((row) => row.ticker === 'FUT')).toBeUndefined();
  });
});

describe('summary aggregation', () => {
  it('sums range endpoints and leaves an open bucket without a ceiling', () => {
    const closed = emptyAmounts();
    addAmount(closed, '$1,001 - $15,000');
    addAmount(closed, '$15,001 - $50,000');
    expect(amountSpan(closed)).toEqual({
      amountMin: 16002,
      amountMax: 65000,
      amountLabel: '$16,002 - $65,000',
    });
    const open = emptyAmounts();
    addAmount(open, OVER_50M);
    addAmount(open, '$1,001 - $15,000');
    expect(amountSpan(open)).toEqual({
      amountMin: OVER_50M_MIN + 1001,
      amountMax: null,
      amountLabel: 'Over $50,001,001',
    });
    const unknown = emptyAmounts();
    addAmount(unknown, '$1,001 - $15,000');
    addAmount(unknown, '$12,000');
    expect(amountSpan(unknown).amountMax).toBeNull();
    expect(amountSpan(unknown).amountLabel).toMatch(/^Over /);
  });

  it('ranks buys and sells by trade count and sums the reported ranges', async () => {
    const store = memoryStore();
    await addFiling(store, {
      key: 'nvda-a', first: 'Ann', last: 'Alpha', filedDate: '2026-11-01',
      trades: [
        trade('NVDA', { amountRange: '$1,001 - $15,000' }),
        trade('NVDA', { amountRange: '$15,001 - $50,000' }),
        trade('AAPL', { txType: 'sell', amountRange: '$1,001 - $15,000' }),
        trade('AAPL', { txType: 'sell', amountRange: OVER_50M }),
        trade('MSFT', { txType: 'exchange' }),
      ],
    });
    await addFiling(store, {
      key: 'nvda-b', first: 'Bea', last: 'Beta', filedDate: '2026-11-02',
      trades: [trade('NVDA', { amountRange: '$50,001 - $100,000' })],
    });
    await addFiling(store, {
      key: 'nvda-c', first: 'Cy', last: 'Gamma', filedDate: '2026-11-03', party: 'R', office: 'senate',
      trades: [trade('NVDA', { amountRange: '$1,001 - $15,000' })],
    });
    const body = await summary(store);
    const nvda = body.bought.find((row) => row.ticker === 'NVDA');
    expect(nvda).toMatchObject({
      trades: 4,
      politicians: 3,
      amountMin: 67004,
      amountMax: 180000,
      amountLabel: '$67,004 - $180,000',
    });
    expect(body.bought.map((row) => row.ticker)).toEqual(['NVDA']);
    expect(body.sold).toEqual([
      expect.objectContaining({
        ticker: 'AAPL',
        trades: 2,
        politicians: 1,
        amountMin: 50001001,
        amountMax: null,
        amountLabel: 'Over $50,001,001',
      }),
    ]);
    expect(body.bought.find((row) => row.ticker === 'MSFT')).toBeUndefined();
    expect(body.sold.find((row) => row.ticker === 'MSFT')).toBeUndefined();
    expect(body.excludedFilings).toBe(0);
  });

  it('clusters buys at the threshold and lists who bought', async () => {
    const store = memoryStore();
    const people = [
      ['a', 'Ann', 'Alpha', '2026-11-01', 'D', 'house', 'member'],
      ['b', 'Bea', 'Beta', '2026-11-03', 'R', 'senate', 'member'],
      ['c', 'Cy', 'Gamma', '2026-11-02', 'I', 'house', 'candidate'],
      ['d', 'Dee', 'Delta', '2026-11-04', 'D', 'house', 'member'],
    ];
    for (const [key, first, last, filedDate, party, office, filerStatus] of people) {
      const tickers = key === 'd' ? ['NVDA'] : ['NVDA', 'MSFT'];
      await addFiling(store, {
        key, first, last, filedDate, party, office, filerStatus,
        trades: tickers.map((ticker) => trade(ticker, {
          amountRange: ticker === 'NVDA' && key === 'a' ? '$15,001 - $50,000' : '$1,001 - $15,000',
        })),
      });
    }
    await addFiling(store, {
      key: 'a2', first: 'Ann', last: 'Alpha', filedDate: '2026-11-08',
      trades: [trade('NVDA', { amountRange: '$1,001 - $15,000' })],
    });
    const body = await summary(store);
    expect(body.clusterMin).toBe(3);
    expect(body.clusters.map((row) => row.ticker)).toEqual(['NVDA', 'MSFT']);
    expect(body.clusters[0]).toMatchObject({ politicians: 4, trades: 5 });
    expect(body.clusters[1]).toMatchObject({ politicians: 3, trades: 3 });
    const buyers = body.clusters[0].buyers;
    expect(buyers.map((buyer) => buyer.name)).toEqual(['Ann Alpha', 'Cy Gamma', 'Bea Beta', 'Dee Delta']);
    expect(buyers[0]).toMatchObject({
      dates: ['2026-11-01', '2026-11-08'],
      trades: 2,
      amountLabel: '$16,002 - $65,000',
      office: 'house',
      party: 'D',
    });
    expect(buyers[1].filerStatus).toBe('candidate');
    const wider = await summary(store, { clusterMin: 4 });
    expect(wider.clusters.map((row) => row.ticker)).toEqual(['NVDA']);
    const pair = await summary(store, { clusterMin: 2 });
    expect(pair.clusters.map((row) => row.ticker)).toEqual(['NVDA', 'MSFT']);
    const none = await summary(store, { clusterMin: 5 });
    expect(none.clusters).toEqual([]);
    expect(none.clusterTotal).toBe(0);
  });

  it('includes candidates by default and follows the filer filter', async () => {
    const store = memoryStore();
    await addFiling(store, {
      key: 'm1', first: 'Ann', last: 'Alpha', filerStatus: 'member',
      trades: [trade('AAPL')],
    });
    await addFiling(store, {
      key: 'm2', first: 'Bea', last: 'Beta', filerStatus: 'member',
      trades: [trade('AAPL')],
    });
    await addFiling(store, {
      key: 'c1', first: 'Cy', last: 'Gamma', filerStatus: 'candidate',
      trades: [trade('AAPL')],
    });
    const all = await summary(store);
    expect(all.bought[0]).toMatchObject({ ticker: 'AAPL', politicians: 3, trades: 3 });
    expect(all.clusters[0].buyers.map((buyer) => buyer.filerStatus).sort()).toEqual([
      'candidate', 'member', 'member',
    ]);
    const members = await summary(store, { filer: 'member' });
    expect(members.bought[0]).toMatchObject({ politicians: 2, trades: 2 });
    expect(members.clusters).toEqual([]);
    const candidates = await summary(store, { filer: 'candidate' });
    expect(candidates.bought[0]).toMatchObject({ politicians: 1, trades: 1 });
    expect(candidates.clusters[0]).toBeUndefined();
    expect(candidates.bought[0].ticker).toBe('AAPL');
  });

  it('counts filings with no parsed ticker and leaves them out of the ranks', async () => {
    const store = memoryStore();
    await addFiling(store, {
      key: 'review', first: 'Ann', last: 'Alpha', status: 'needs_manual_review',
    });
    await addFiling(store, {
      key: 'review-out', first: 'Out', last: 'Side', filedDate: '2026-08-01', status: 'needs_manual_review',
    });
    await addFiling(store, {
      key: 'candidate-review', first: 'Cy', last: 'Gamma', filerStatus: 'candidate', status: 'needs_manual_review',
    });
    await addFiling(store, {
      key: 'bond', first: 'Bea', last: 'Beta',
      trades: [trade(null, { asset: 'Municipal bond', assetClass: 'other' })],
    });
    await addFiling(store, {
      key: 'mixed', first: 'Dee', last: 'Delta',
      trades: [
        trade(null, { asset: 'Treasury', assetClass: 'other' }),
        trade('AAPL'),
      ],
    });
    const body = await summary(store);
    expect(body.excludedFilings).toBe(3);
    expect(body.bought.map((row) => row.ticker)).toEqual(['AAPL']);
    expect(body.bought[0].trades).toBe(1);
    const members = await summary(store, { filer: 'member' });
    expect(members.excludedFilings).toBe(2);
    const candidates = await summary(store, { filer: 'candidate' });
    expect(candidates.excludedFilings).toBe(1);
    expect(candidates.bought).toEqual([]);
  });

  it('keeps the top 10 tickers and the top 20 clusters', async () => {
    const store = memoryStore();
    const sells = [];
    for (let i = 1; i <= 11; i += 1) {
      const ticker = `S${String(i).padStart(2, '0')}`;
      sells.push(trade(ticker, { txType: 'sell' }));
    }
    sells.push(trade('S00', { txType: 'sell' }), trade('S00', { txType: 'sell' }));
    await addFiling(store, { key: 'sells', first: 'Ann', last: 'Alpha', trades: sells });
    const buys = [];
    for (let i = 1; i <= 21; i += 1) buys.push(trade(`T${String(i).padStart(2, '0')}`));
    for (const [key, first, last] of [['p1', 'Ann', 'Alpha'], ['p2', 'Bea', 'Beta'], ['p3', 'Cy', 'Gamma']]) {
      await addFiling(store, { key, first, last, trades: buys });
    }
    const body = await summary(store);
    expect(body.sold).toHaveLength(10);
    expect(body.sold[0].ticker).toBe('S00');
    expect(body.sold.map((row) => row.ticker)).not.toContain('S11');
    expect(body.clusterTotal).toBe(21);
    expect(body.clusters).toHaveLength(20);
    expect(body.clusters.map((row) => row.ticker)).not.toContain('T21');
    expect(body.clusters[0].politicians).toBe(3);
  });

  it('flags a held stock or class share and not an option or a Canadian listing', async () => {
    const store = memoryStore();
    await addFiling(store, {
      key: 'a', first: 'Ann', last: 'Alpha',
      trades: [trade('AAPL'), trade('BRK/B'), trade('RY'), trade('QQQ', { assetClass: 'option', asset: 'QQQ call' })],
    });
    await addFiling(store, { key: 'b', first: 'Bea', last: 'Beta', trades: [trade('AAPL'), trade('BRK/B'), trade('RY'), trade('QQQ', { assetClass: 'option' })] });
    await addFiling(store, { key: 'c', first: 'Cy', last: 'Gamma', trades: [trade('AAPL'), trade('BRK/B'), trade('RY'), trade('QQQ', { assetClass: 'option' })] });
    await addFiling(store, { key: 'd', first: 'Dee', last: 'Delta', office: 'senate', trades: [trade('RY.TO')] });
    await addFiling(store, { key: 'e', first: 'Eve', last: 'Epsilon', office: 'senate', trades: [trade('RY.TO')] });
    await addFiling(store, { key: 'f', first: 'Fay', last: 'Zeta', office: 'senate', trades: [trade('RY.TO')] });
    const raw = await summary(store);
    const flagged = attachHeldModels(raw, await store.listHeldPoliticianSymbols());
    const byTicker = Object.fromEntries(flagged.clusters.map((row) => [row.ticker, row]));
    expect(byTicker.AAPL).toMatchObject({ held: true, models: ['Growth'] });
    expect(byTicker['BRK.B']).toMatchObject({ held: true, models: ['Growth'] });
    expect(byTicker.RY.held).toBe(false);
    expect(byTicker.RY.models).toBeUndefined();
    expect(byTicker.QQQ.held).toBe(false);
    expect(byTicker['RY.TO']).toMatchObject({ held: true, models: ['Growth'] });
    expect(flagged.clusters[0].matchable).toBeUndefined();
  });
});

describe('summary SQL shape', () => {
  it('aggregates in SQL and does not read trade text columns', () => {
    for (const sql of [SUMMARY_RANK_SQL, SUMMARY_CLUSTER_SQL]) {
      expect(sql).toMatch(/GROUP BY/);
      expect(sql).toMatch(/sum\(amount_min\)/);
      expect(sql).toMatch(/count\(DISTINCT person_key\)|count\(\*\)::int AS politicians/);
      expect(sql).not.toMatch(/source_url|parse_note|\basset\b/);
    }
    expect(SUMMARY_RANK_SQL).toMatch(/GROUP BY tx_type, ticker_norm/);
    expect(SUMMARY_RANK_SQL).toMatch(/count\(DISTINCT person_key\)/);
    expect(SUMMARY_RANK_SQL).toMatch(/\$4::int IS NULL OR r\.rn <= \$4::int/);
    expect(SUMMARY_RANK_SQL).toContain('THEN 8000.5');
    expect(SUMMARY_RANK_SQL).toMatch(/side_total/);
    expect(SUMMARY_NET_SQL).toMatch(/\$4::int IS NULL OR rn <= \$4::int/);
    expect(SUMMARY_NET_SQL).toMatch(/tx_type = 'buy'\) > 0/);
    expect(SUMMARY_NET_SQL).toMatch(/tx_type = 'sell'\) > 0/);
    expect(SUMMARY_NET_SQL).toContain('THEN 8000.5');
    expect(SUMMARY_CLUSTER_SQL).toMatch(/net_buys/);
    expect(SUMMARY_RANK_SQL).toMatch(/disclosed_date >= \$1::date/);
    expect(SUMMARY_RANK_SQL).toMatch(/disclosed_date <= \$2::date/);
    expect(SUMMARY_RANK_SQL).toMatch(/ticker_norm IS NOT NULL/);
    expect(SUMMARY_CLUSTER_SQL).toMatch(/tx_type = 'buy'/);
    expect(SUMMARY_CLUSTER_SQL).toMatch(/HAVING count\(\*\) >= \$4::int/);
    expect(SUMMARY_CLUSTER_SQL).toMatch(/GROUP BY ticker_norm, person_key/);
    expect(SUMMARY_CLUSTER_SQL).toMatch(/LIMIT 20/);
    expect(SUMMARY_EXCLUDED_SQL).toMatch(/ticker_norm IS NOT NULL/);
    expect(SUMMARY_EXCLUDED_SQL).toMatch(/NOT EXISTS/);
    for (const [min, max, label] of AMOUNT_RANGES) {
      expect(SUMMARY_RANK_SQL).toContain(`WHEN '${label}' THEN ${min}`);
      expect(SUMMARY_RANK_SQL).toContain(`WHEN '${label}' THEN ${max}`);
    }
    expect(SUMMARY_RANK_SQL).toContain(`WHEN '${OVER_50M}' THEN ${OVER_50M_MIN}`);
    expect(SUMMARY_RANK_SQL).not.toContain(`WHEN '${OVER_50M}' THEN 50000001`);
    const dbSrc = readFileSync(new URL('../db.js', import.meta.url), 'utf8');
    expect(dbSrc).toMatch(/CREATE INDEX IF NOT EXISTS politician_trades_window/);
    expect(dbSrc).toMatch(/ON politician_trades \(disclosed_date, tx_type\)/);
    expect(dbSrc).toMatch(/CREATE INDEX IF NOT EXISTS politician_filings_filed/);
  });

  it('reads grouped bigint sums the same way the memory totals do', () => {
    const body = summaryFromSql({
      query: { window: 30, asOf: AS_OF, filer: 'member', clusterMin: 3 },
      excluded: '2',
      rankRows: [{
        tx_type: 'buy',
        ticker_norm: 'NVDA',
        trades: 4,
        politicians: 3,
        amount_min: '67004',
        amount_max: '180000',
        open_rows: 0,
        known_amounts: 4,
        matchable: true,
      }],
      clusterRows: [{
        cluster_total: '1',
        politicians: 2,
        cluster_trades: 2,
        cluster_min: '50000000',
        cluster_max: null,
        cluster_open: 1,
        cluster_known: 2,
        cluster_matchable: true,
        ticker_norm: 'NVDA',
        person_key: 'house:alpha:ann',
        person_name: 'Ann Alpha',
        office: 'house',
        party: 'D',
        filer_status: 'candidate',
        trades: 1,
        dates: ['2026-11-01'],
        amount_min: '1001',
        amount_max: '15000',
        open_rows: 0,
        known_amounts: 1,
      }],
    });
    expect(body).toMatchObject({
      window: 30,
      from: '2026-10-15',
      to: AS_OF,
      filer: 'member',
      clusterMin: 3,
      excludedFilings: 2,
    });
    expect(body.bought[0].amountLabel).toBe('$67,004 - $180,000');
    expect(body.clusters[0].amountLabel).toBe('Over $50,000,000');
    expect(body.clusters[0].buyers[0]).toMatchObject({
      filerStatus: 'candidate',
      amountLabel: '$1,001 - $15,000',
      dates: ['2026-11-01'],
    });
  });

  it('maps net columns, side totals, and the both-sides list', () => {
    const body = summaryFromSql({
      query: { window: 30, asOf: AS_OF, limit: 'all' },
      rankRows: [{
        tx_type: 'buy',
        ticker_norm: 'NVDA',
        trades: 2,
        politicians: 2,
        amount_min: '50001001',
        amount_max: null,
        open_rows: 1,
        known_amounts: 2,
        matchable: true,
        side_total: '61',
        net_buys: 2,
        net_sells: 1,
        net_exchanges: 1,
        net_buy_mid: 50008000.5,
        net_sell_mid: 32500.5,
        net_known: 3,
        net_excluded: 0,
        net_open: 1,
      }],
      netRows: [{
        ticker_norm: 'NVDA',
        net_buys: 2,
        net_sells: 1,
        net_exchanges: 1,
        net_buy_mid: 50008000.5,
        net_sell_mid: 32500.5,
        net_known: 3,
        net_excluded: 0,
        net_open: 1,
        matchable: true,
        net_total: '4',
      }],
    });
    expect(body.rankLimit).toBeNull();
    expect(body.boughtTotal).toBe(61);
    expect(body.soldTotal).toBe(0);
    expect(body.bought[0].net).toMatchObject({
      buys: 2,
      sells: 1,
      exchanges: 1,
      netCount: 1,
      estimatedNet: 49_975_500,
      minimum: true,
      estimateLabel: 'Est. net at least +$50M',
    });
    expect(body.netTotal).toBe(4);
    expect(body.nets[0].ticker).toBe('NVDA');
    expect(body.nets[0].net.countLabel).toBe('Net +1');
  });

  it('clamps the cluster threshold', () => {
    expect(normalizeClusterMin(undefined, {})).toBe(3);
    expect(normalizeClusterMin('', { POLITICIAN_CLUSTER_MIN: '4' })).toBe(4);
    expect(normalizeClusterMin(1, {})).toBe(2);
    expect(normalizeClusterMin(50, {})).toBe(10);
    expect(aggregateSummary({ query: { asOf: AS_OF, clusterMin: 1 } }).clusterMin).toBe(2);
  });
});
