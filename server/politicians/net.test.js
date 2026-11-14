import { describe, expect, it } from 'vitest';
import { buildFilingRecord, buildTradeRows } from './records.js';
import { memoryMethods, politicianBucket } from './memoryStore.js';
import {
  OVER_50M,
  aggregateSummary,
  normalizeSummaryQuery,
  rollupFromRows,
} from './summary.js';
import {
  digestNetLines,
  formatCompactDollars,
  formatNetEstimate,
  rangeMidpoint,
  rollupByTicker,
} from './net.js';

const AS_OF = '2026-11-13';

function trade(ticker, extra = {}) {
  return {
    ticker,
    tickerNorm: ticker || null,
    assetClass: extra.assetClass || (ticker ? 'stock' : 'other'),
    txType: extra.txType || 'buy',
    amountRange: extra.amountRange,
    disclosedDate: extra.disclosedDate || AS_OF,
    personKey: extra.personKey || 'house:alpha:ann',
  };
}

describe('range midpoints', () => {
  it('uses the midpoint of a closed statutory range', () => {
    expect(rangeMidpoint('$1,001 - $15,000')).toEqual({ value: 8000.5, open: false });
    expect(rangeMidpoint('$15,001 - $50,000')).toEqual({ value: 32500.5, open: false });
    expect(rangeMidpoint('$1,000,001 - $5,000,000')).toEqual({ value: 3000000.5, open: false });
    expect(formatCompactDollars(1_200_000)).toBe('+$1.2M');
    expect(formatCompactDollars(8000.5)).toBe('+$8K');
    expect(formatCompactDollars(-24500)).toBe('-$24.5K');
    expect(formatCompactDollars(0)).toBe('$0');
  });

  it('uses the lower bound of an open-ended range and marks the estimate as a minimum', () => {
    expect(rangeMidpoint(OVER_50M)).toEqual({ value: 50_000_000, open: true });
    expect(rangeMidpoint('Over $50,000,000')).toEqual({ value: 50_000_000, open: true });
    const label = formatNetEstimate({ estimatedNet: 50_000_000, minimum: true });
    expect(label).toBe('Est. net at least +$50M');
    expect(formatNetEstimate({ estimatedNet: -8000.5, minimum: false })).toBe('Est. net -$8K');
  });

  it('drops a row with no parseable amount', () => {
    expect(rangeMidpoint(null)).toBeNull();
    expect(rangeMidpoint('')).toBeNull();
    expect(rangeMidpoint('$12,000')).toBeNull();
    expect(rangeMidpoint('see filing')).toBeNull();
    expect(formatNetEstimate({ estimatedNet: null, minimum: false })).toBeNull();
  });
});

describe('mixed buy, sell, and exchange', () => {
  const trades = [
    trade('NVDA', { amountRange: '$1,001 - $15,000' }),
    trade('NVDA', { txType: 'buy', amountRange: OVER_50M, personKey: 'senate:beta:bea' }),
    trade('NVDA', { txType: 'sell', amountRange: '$15,001 - $50,000' }),
    trade('NVDA', { txType: 'exchange', amountRange: '$50,001 - $100,000' }),
    trade('AAPL', { amountRange: 'unknown' }),
    trade('AAPL', { txType: 'sell', amountRange: '$1,001 - $15,000' }),
    trade('MSFT', { txType: 'exchange', amountRange: '$1,001 - $15,000' }),
    trade(null, { assetClass: 'other', amountRange: '$1,001 - $15,000', txType: 'buy' }),
    trade('QQQ', { txType: 'buy', amountRange: null }),
  ];

  it('nets counts and midpoint dollars, and keeps exchanges out of both', () => {
    const body = aggregateSummary({
      trades: trades.map((row, index) => ({
        ...row,
        id: `t${index}`,
        disclosedDate: AS_OF,
        filerStatus: 'member',
      })),
      filings: [],
      query: { asOf: AS_OF, limit: 'all' },
    });
    const nvda = body.bought.find((row) => row.ticker === 'NVDA');
    expect(nvda.net).toEqual({
      buys: 2,
      sells: 1,
      exchanges: 1,
      netCount: 1,
      estimatedNet: 49_975_500,
      minimum: true,
      excluded: 0,
      countLabel: 'Net +1',
      estimateLabel: 'Est. net at least +$50M',
    });
    expect(nvda.net.estimateLabel).toMatch(/^Est\. net at least /);
    const aapl = body.sold.find((row) => row.ticker === 'AAPL');
    expect(aapl.net).toMatchObject({
      buys: 1,
      sells: 1,
      exchanges: 0,
      netCount: 0,
      estimatedNet: -8000.5,
      minimum: false,
      excluded: 1,
      countLabel: 'Net 0',
      estimateLabel: 'Est. net -$8K',
    });
    expect(body.nets.map((row) => row.ticker).sort()).toEqual(['AAPL', 'NVDA']);
    expect(body.netTotal).toBe(2);
    expect(body.bought.find((row) => row.ticker === 'MSFT')).toBeUndefined();
    expect(body.sold.find((row) => row.ticker === 'MSFT')).toBeUndefined();
    expect(body.nets.find((row) => row.ticker === 'MSFT')).toBeUndefined();
    expect(body.bought.find((row) => !row.ticker)).toBeUndefined();
    const qqq = body.bought.find((row) => row.ticker === 'QQQ');
    expect(qqq.net).toMatchObject({ buys: 1, sells: 0, netCount: 1, estimatedNet: null, excluded: 1 });
    expect(qqq.net.estimateLabel).toBeNull();
  });

  it('puts the same net on the cluster row and on the full sold list', () => {
    const people = ['ann', 'bea', 'cy'].map((name, index) => trade('NVDA', {
      personKey: `house:${name}:${name}`,
      amountRange: '$1,001 - $15,000',
      disclosedDate: AS_OF,
    }));
    const sell = trade('NVDA', { txType: 'sell', amountRange: '$15,001 - $50,000' });
    const body = aggregateSummary({
      trades: [...people, sell].map((row, index) => ({
        ...row,
        id: `c${index}`,
        filerStatus: 'member',
        assetClass: 'stock',
      })),
      query: { asOf: AS_OF },
    });
    expect(body.clusters[0].ticker).toBe('NVDA');
    expect(body.clusters[0].net).toMatchObject({
      buys: 3,
      sells: 1,
      netCount: 2,
      estimatedNet: (8000.5 * 3) - 32500.5,
      minimum: false,
      excluded: 0,
    });
    expect(body.sold[0].net.netCount).toBe(2);
  });
});

describe('show all ranks', () => {
  it('caps the default lists at 10 and returns every ticker for limit=all', () => {
    const trades = [];
    for (let i = 1; i <= 11; i += 1) {
      trades.push(trade(`S${String(i).padStart(2, '0')}`, { txType: 'sell' }));
    }
    trades.push(trade('S00', { txType: 'sell' }), trade('S00', { txType: 'sell' }));
    for (let i = 1; i <= 12; i += 1) {
      trades.push(trade(`B${String(i).padStart(2, '0')}`, { txType: 'buy' }));
    }
    const rows = trades.map((row, index) => ({
      ...row,
      id: `r${index}`,
      filerStatus: 'member',
      amountRange: row.amountRange || '$1,001 - $15,000',
    }));
    const capped = aggregateSummary({ trades: rows, query: { asOf: AS_OF } });
    expect(capped.rankLimit).toBe(10);
    expect(capped.sold).toHaveLength(10);
    expect(capped.soldTotal).toBe(12);
    expect(capped.bought).toHaveLength(10);
    expect(capped.boughtTotal).toBe(12);
    expect(capped.sold.map((row) => row.ticker)).not.toContain('S11');
    expect(capped.sold[0].net).toMatchObject({ sells: 2, buys: 0, netCount: -2 });
    const all = aggregateSummary({ trades: rows, query: { asOf: AS_OF, limit: 'all' } });
    expect(all.rankLimit).toBeNull();
    expect(all.sold).toHaveLength(12);
    expect(all.bought).toHaveLength(12);
    expect(all.sold.map((row) => row.ticker)).toContain('S11');
    expect(all.bought.every((row) => row.net && row.net.countLabel && 'estimatedNet' in row.net)).toBe(true);
    expect(all.sold.every((row) => row.net.estimateLabel)).toBeTruthy();
  });
});

describe('person roll-up', () => {
  it('nets one filer inside the disclosure window and leaves older and untickered rows out', () => {
    const bounds = normalizeSummaryQuery({ asOf: AS_OF, window: 7 });
    const ann = 'house:alpha:ann';
    const trades = [
      trade('NVDA', { personKey: ann, disclosedDate: '2026-11-10', amountRange: '$1,001 - $15,000' }),
      trade('NVDA', { personKey: ann, txType: 'sell', disclosedDate: '2026-11-12', amountRange: '$1,001 - $15,000' }),
      trade('NVDA', { personKey: ann, txType: 'exchange', disclosedDate: '2026-11-12', amountRange: null }),
      trade('AAPL', { personKey: ann, disclosedDate: '2026-11-01', amountRange: '$1,001 - $15,000' }),
      trade(null, { personKey: ann, disclosedDate: '2026-11-12', amountRange: '$15,001 - $50,000' }),
    ];
    const rollup = rollupByTicker(trades, bounds);
    expect(rollup.window).toBe(7);
    expect(rollup.from).toBe('2026-11-07');
    expect(rollup.tickers.map((row) => row.ticker)).toEqual(['NVDA']);
    expect(rollup.tickers[0].net).toMatchObject({
      buys: 1,
      sells: 1,
      exchanges: 1,
      netCount: 0,
      estimatedNet: 0,
      minimum: false,
      excluded: 0,
      estimateLabel: 'Est. net $0',
    });
  });

  it('reads the same shape from grouped SQL columns', () => {
    const rollup = rollupFromRows([
      {
        ticker: 'NVDA',
        net_buys: 1,
        net_sells: 2,
        net_exchanges: 0,
        net_buy_mid: 8000.5,
        net_sell_mid: 50_000_000,
        net_known: 2,
        net_excluded: 1,
        net_open: 1,
      },
    ], { asOf: AS_OF, window: 30 });
    expect(rollup.tickers[0].net).toMatchObject({
      netCount: -1,
      estimatedNet: 8000.5 - 50_000_000,
      minimum: true,
      excluded: 1,
      estimateLabel: 'Est. net at least -$50M',
    });
  });

  it('is returned on the person page for that filer only', async () => {
    const db = politicianBucket({});
    const store = { db };
    for (const [name, fn] of Object.entries(memoryMethods)) {
      store[name] = (...args) => fn.apply({ db, persist() {} }, args);
    }
    const filing = buildFilingRecord({
      source: 'house',
      filingKey: 'ann',
      first: 'Ann',
      last: 'Alpha',
      office: 'house',
      filedDate: AS_OF,
      sourceUrl: 'https://example.test/ann',
      parsed: { status: 'parsed' },
    });
    await store.insertPoliticianBundle(filing, buildTradeRows(filing, {
      trades: [
        { owner: 'self', ticker: 'NVDA', asset: 'NVIDIA', assetClass: 'stock', txType: 'buy', txDate: '2026-11-01', amountRange: '$1,001 - $15,000' },
        { owner: 'self', ticker: 'NVDA', asset: 'NVIDIA', assetClass: 'stock', txType: 'sell', txDate: '2026-11-02', amountRange: 'unknown' },
        { owner: 'self', ticker: null, asset: 'Municipal bond', assetClass: 'other', txType: 'buy', txDate: '2026-11-02', amountRange: '$15,001 - $50,000' },
      ],
    }));
    const person = await store.getPolitician(filing.personKey, { asOf: AS_OF, window: 30 });
    expect(person.counts.buy).toBe(2);
    expect(person.tickerRollup.tickers).toHaveLength(1);
    expect(person.tickerRollup.tickers[0]).toMatchObject({
      ticker: 'NVDA',
      net: {
        buys: 1,
        sells: 1,
        netCount: 0,
        estimatedNet: 8000.5,
        excluded: 1,
        minimum: false,
      },
    });
    expect(person.items.some((item) => item.asset === 'Municipal bond')).toBe(true);
  });
});

describe('digest net lines', () => {
  it('mentions a ticker only when the batch has both a buy and a sell', () => {
    const lines = digestNetLines([
      trade('AAPL', { txType: 'buy', amountRange: '$1,001 - $15,000' }),
      trade('AAPL', { txType: 'sell', amountRange: '$15,001 - $50,000' }),
      trade('AAPL', { txType: 'exchange', amountRange: '$1,001 - $15,000' }),
      trade('MSFT', { txType: 'buy', amountRange: '$1,001 - $15,000' }),
      { ticker: null, tickerNorm: null, txType: 'sell', amountRange: '$1,001 - $15,000', asset: 'Municipal bond' },
    ]);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^AAPL · Net 0 · Est\. net -\$24\.5K · 1 buy · 1 sell · 1 exchange$/);
    expect(lines[0]).not.toMatch(/MSFT|Municipal/);
  });
});
