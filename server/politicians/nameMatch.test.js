import { describe, expect, it } from 'vitest';
import { memoryMethods, politicianBucket } from './memoryStore.js';
import {
  annotateTrade,
  backfillNullTickers,
  buildCatalog,
  classifyDescribedAsset,
  matchAssetName,
  normalizeAssetName,
} from './nameMatch.js';
import { buildFilingRecord, buildTradeRows } from './records.js';
import { aggregateSummary } from './summary.js';

const FETCHED = '2026-11-01T00:00:00.000Z';

const SEC_ROWS = [
  [320193, 'Apple Inc.', 'AAPL', 'Nasdaq'],
  [723125, 'MICRON TECHNOLOGY INC', 'MU', 'Nasdaq'],
  [1065280, 'NETFLIX INC', 'NFLX', 'Nasdaq'],
  [354950, 'HOME DEPOT, INC.', 'HD', 'NYSE'],
  [200406, 'JOHNSON & JOHNSON', 'JNJ', 'NYSE'],
  [1067983, 'BERKSHIRE HATHAWAY INC', 'BRK-B', 'NYSE'],
  [1067983, 'BERKSHIRE HATHAWAY INC', 'BRK-A', 'NYSE'],
  [14693, 'BROWN FORMAN CORP', 'BF-B', 'NYSE'],
  [14693, 'BROWN FORMAN CORP', 'BF-A', 'NYSE'],
  [320187, 'NIKE, Inc.', 'NKE', 'NYSE'],
  [1652044, 'Alphabet Inc.', 'GOOGL', 'Nasdaq'],
  [1652044, 'Alphabet Inc.', 'GOOG', 'Nasdaq'],
  [1652044, 'Alphabet Inc.', 'GOOGM', 'Nasdaq'],
  [1326801, 'Meta Platforms, Inc.', 'META', 'Nasdaq'],
  [1326801, 'Meta Platforms, Inc.', 'METAM', 'Nasdaq'],
  [72971, 'WELLS FARGO & COMPANY/MN', 'WFC', 'NYSE'],
  [72971, 'WELLS FARGO & COMPANY/MN', 'WFC-PY', 'NYSE'],
  [24545, 'MOLSON COORS BEVERAGE CO', 'TAP', 'NYSE'],
  [24545, 'MOLSON COORS BEVERAGE CO', 'TAP-A', 'NYSE'],
  [1094517, 'TOYOTA MOTOR CORP/', 'TM', 'NYSE'],
  [1094517, 'TOYOTA MOTOR CORP/', 'TOYOF', 'OTC'],
  [789019, 'MICROSOFT CORP', 'MSFT', 'Nasdaq'],
  [884394, 'SPDR S&P 500 ETF TRUST', 'SPY', 'NYSE'],
];

function catalog() {
  return buildCatalog({ rows: SEC_ROWS, fetchedAt: FETCHED });
}

function memoryStore() {
  const db = politicianBucket({ models: {}, instruments: {} });
  const store = { db };
  for (const [name, fn] of Object.entries(memoryMethods)) {
    store[name] = (...args) => fn.apply({ db, persist() {} }, args);
  }
  return store;
}

describe('asset name normalization', () => {
  it('folds case, punctuation, and company suffixes', () => {
    expect(normalizeAssetName('Micron Technology Inc').stem).toBe('micron technology');
    expect(normalizeAssetName('MICRON TECHNOLOGY, INC.').stem).toBe('micron technology');
    expect(normalizeAssetName('Johnson & Johnson').stem).toBe('johnson and johnson');
    expect(normalizeAssetName('The Home Depot, Inc.').stem).toBe('home depot');
    expect(normalizeAssetName('Wells Fargo & Company/MN').stem).toBe('wells fargo');
    expect(normalizeAssetName('AT&T Inc.').stem).toBe('at and t');
    expect(normalizeAssetName('Microsoft Coro').stem).toBe('microsoft');
    expect(normalizeAssetName('iShares Core S&P 500 ETF').stem).toBe('ishares core s and p 500');
  });

  it('turns Class B into a share-class key and leaves the company stem', () => {
    const berkshire = normalizeAssetName('Berkshire Hathaway Class B');
    expect(berkshire).toMatchObject({ stem: 'berkshire hathaway', shareClass: 'b' });
    expect(normalizeAssetName('Nike Inc Class B').shareClass).toBe('b');
    expect(normalizeAssetName('Brown-Forman Corp Class A').shareClass).toBe('a');
  });
});

describe('debt is not an option and gets no ticker', () => {
  const book = catalog();

  it('classes notes, coupons, due dates, and munis as debt', () => {
    expect(classifyDescribedAsset('Toyota Motor Credit note')).toBe('bond');
    expect(classifyDescribedAsset('Toyota Motor Credit 3.375% Note due 04/01/2027 Call')).toBe('bond');
    expect(classifyDescribedAsset('Toyota Motor Credit Callable Note')).toBe('bond');
    expect(classifyDescribedAsset('City of Chicago municipal bond')).toBe('bond');
    expect(classifyDescribedAsset('U S Treasury Note 2.00% Due May 31, 2024')).toBe('bond');
    expect(classifyDescribedAsset('KENTUCKY PUB ENERGY AUTH 4.00 % Due Dec 1, 2050')).toBe('bond');
    expect(classifyDescribedAsset('AAPL Jan 2026 $200 Call')).toBe('option');
  });

  it('does not assign a stock ticker to a note that shares the issuer name', () => {
    const note = matchAssetName('Toyota Motor Credit 2.650% Note due 04/01/2027', book);
    expect(note.ticker).toBeNull();
    expect(note.assetClass).toBe('bond');
    const homeDepotBond = matchAssetName('Home Depot 2.95% Due 06/15/29', book);
    expect(homeDepotBond.ticker).toBeNull();
    expect(homeDepotBond.reason).toBe('debt');
    const muni = matchAssetName('CENTRAL BROWN CNTY WTR AUTH 5.00 % Due Nov 1, 2025', book);
    expect(muni.ticker).toBeNull();
  });

  it('does not assign a ticker to a private fund', () => {
    const hit = matchAssetName('Sequoia Private Equity Fund', book);
    expect(hit.ticker).toBeNull();
    expect(hit.reason).toBe('private');
  });
});

describe('high-confidence name matches', () => {
  const book = catalog();

  it('matches exact company names and an unambiguous Class B line', () => {
    expect(matchAssetName('Micron Technology Inc', book)).toMatchObject({ ticker: 'MU', confidence: 100, assetClass: 'stock' });
    expect(matchAssetName('Netflix', book).ticker).toBe('NFLX');
    expect(matchAssetName('Home Depot', book).ticker).toBe('HD');
    expect(matchAssetName('Johnson & Johnson', book).ticker).toBe('JNJ');
    expect(matchAssetName('Berkshire Hathaway Class B', book)).toMatchObject({
      ticker: 'BRK.B', confidence: 100, assetClass: 'stock',
    });
    expect(matchAssetName('Brown Forman Corp Class B', book).ticker).toBe('BF.B');
    expect(matchAssetName('Nike Inc Class B', book).ticker).toBe('NKE');
    expect(matchAssetName('Wells Fargo', book).ticker).toBe('WFC');
    expect(matchAssetName('Meta Platforms Inc Class A', book).ticker).toBe('META');
  });

  it('refuses an ambiguous name and a bare dual-class company', () => {
    expect(matchAssetName('Alphabet Inc', book).ticker).toBeNull();
    expect(matchAssetName('Berkshire Hathaway', book).ticker).toBeNull();
    expect(matchAssetName('Berkshire Hathaway Class C', book).ticker).toBeNull();
    expect(matchAssetName('Molson Coors Beverage Co Class B', book).ticker).toBeNull();
  });

  it('accepts one close spelling and rejects a short garbled name', () => {
    const close = matchAssetName('Micron Technlogy Inc', book);
    expect(close.ticker).toBe('MU');
    expect(close.reason).toBe('fuzzy');
    expect(close.confidence).toBeGreaterThanOrEqual(94);
    expect(matchAssetName('Berkshire Hathway Class B', book).ticker).toBe('BRK.B');
    expect(matchAssetName('Netflx', book).ticker).toBeNull();
  });

  it('maps a curated ETF and keeps a bond ETF as an ETF', () => {
    expect(matchAssetName('Vanguard FTSE Europe ETF', book)).toMatchObject({
      ticker: 'VGK', assetClass: 'etf', confidence: 100, reason: 'curated',
    });
    expect(matchAssetName('iShares 1-3 Year Treasury Bond ETF', book)).toMatchObject({
      ticker: 'SHY', assetClass: 'etf',
    });
    expect(matchAssetName('SPDR S&P 500 ETF', book).ticker).toBe('SPY');
    expect(matchAssetName('iShares Core S&P 500 ETF', book).ticker).toBe('IVV');
    expect(matchAssetName('Microsoft Coro', book).ticker).toBe('MSFT');
  });
});

describe('backfill', () => {
  it('is idempotent, leaves a filing ticker alone, and does not re-arm the digest', async () => {
    const store = memoryStore();
    const filing = buildFilingRecord({
      source: 'oge', filingKey: 'ABC', first: 'Donald', last: 'Trump', office: 'president',
      filedDate: '2026-10-08', sourceUrl: 'https://example.test/278t', parsed: { status: 'parsed' },
    });
    const trades = buildTradeRows(filing, {
      trades: [
        {
          owner: 'self', ticker: 'T', asset: 'Micron Technology Inc', assetClass: 'stock',
          txType: 'buy', txDate: '2026-09-01', amountRange: '$1,001 - $15,000',
        },
        {
          owner: 'self', ticker: null, asset: 'Micron Technology Inc', assetClass: 'other',
          txType: 'buy', txDate: '2026-09-02', amountRange: '$1,001 - $15,000',
          digestPending: false,
        },
        {
          owner: 'self', ticker: null, asset: 'Toyota Motor Credit 3.375% Note due 04/01/2027 Call', assetClass: 'option',
          txType: 'buy', txDate: '2026-09-03', amountRange: '$15,001 - $50,000',
          digestPending: false,
        },
        {
          owner: 'self', ticker: null, asset: 'Vanguard FTSE Europe ETF', assetClass: 'other',
          txType: 'sell', txDate: '2026-09-04', amountRange: '$15,001 - $50,000',
          digestPending: true,
        },
      ],
    });
    await store.insertPoliticianBundle(filing, trades);
    store.db.tickerNameCatalog = null;
    const book = catalog();
    const first = await backfillNullTickers({ store, catalog: book });
    expect(first.matched).toBe(2);
    const rows = store.db.politicianTrades;
    const filingTicker = rows.find((row) => row.asset === 'Micron Technology Inc' && row.tickerSource === 'filing');
    expect(filingTicker.ticker).toBe('T');
    expect(filingTicker.tickerNorm).toBe('T');
    const matched = rows.find((row) => row.ticker === 'MU');
    expect(matched.tickerSource).toBe('name_match');
    expect(matched.tickerMatchConfidence).toBeGreaterThanOrEqual(94);
    expect(matched.digestPending).toBe(false);
    const note = rows.find((row) => row.asset.startsWith('Toyota'));
    expect(note.ticker).toBeNull();
    expect(note.assetClass).toBe('bond');
    expect(note.digestPending).toBe(false);
    const etf = rows.find((row) => row.asset.startsWith('Vanguard'));
    expect(etf.ticker).toBe('VGK');
    expect(etf.digestPending).toBe(true);

    const pending = await store.listDigestPendingTrades();
    expect(pending.map((row) => row.ticker)).toEqual(['VGK']);
    const second = await backfillNullTickers({ store, catalog: book });
    expect(second.examined).toBe(0);
    expect(second.matched).toBe(0);
    expect(rows.find((row) => row.tickerSource === 'filing').ticker).toBe('T');
    expect(rows.filter((row) => row.ticker === 'MU')).toHaveLength(1);
  });

  it('does not overwrite a filing ticker when the name points somewhere else', () => {
    const book = catalog();
    const next = annotateTrade({
      ticker: 'T',
      tickerNorm: 'T',
      tickerSource: 'filing',
      asset: 'Micron Technology Inc',
      assetClass: 'stock',
      digestPending: false,
    }, book);
    expect(next.ticker).toBe('T');
    expect(next.tickerSource).toBe('filing');
    expect(next.digestPending).toBe(false);
  });

  it('counts a matched equity in the summary and on a held ticker', async () => {
    const store = memoryStore();
    const filing = buildFilingRecord({
      source: 'house', filingKey: '2026:1', first: 'Ann', last: 'Example', office: 'house',
      filedDate: '2026-11-01', sourceUrl: 'https://example.test/ptr', parsed: { status: 'parsed' },
    });
    const book = catalog();
    const [trade] = buildTradeRows(filing, {
      trades: [{
        owner: 'self', ticker: null, asset: 'Microsoft Corp', assetClass: 'other',
        txType: 'buy', txDate: '2026-10-01', amountRange: '$1,001 - $15,000',
      }],
    }, book);
    expect(trade.ticker).toBe('MSFT');
    expect(trade.tickerSource).toBe('name_match');
    await store.insertPoliticianBundle(filing, [trade]);
    store.db.instruments = { msft: { id: 'msft', symbol: 'MSFT' } };
    store.db.models = {
      growth: {
        key: 'growth', name: 'Growth',
        versions: [{ id: 'v1', effectiveDate: '2020-01-01', holdings: [{ instrumentId: 'msft' }] }],
      },
    };
    const summary = aggregateSummary({
      trades: store.db.politicianTrades,
      filings: Object.values(store.db.politicianFilings),
      query: { window: 30, asOf: '2026-11-13' },
    });
    expect(summary.bought.map((row) => row.ticker)).toContain('MSFT');
    const held = await store.summarizeHeldTrades(['MSFT']);
    expect(held).toEqual([{ tickerNorm: 'MSFT', count: 1, latest: '2026-11-01' }]);
  });
});
