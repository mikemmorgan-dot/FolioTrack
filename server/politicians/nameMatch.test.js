import { describe, expect, it } from 'vitest';
import { memoryMethods, politicianBucket } from './memoryStore.js';
import {
  annotateTrade,
  backfillNullTickers,
  buildCatalog,
  classifyDescribedAsset,
  FUZZY_MIN_SIMILARITY,
  matchAssetName,
  MATCHER_VERSION,
  normalizeAssetName,
  repairJoinedSuffix,
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
    expect(matchAssetName('Molson Coors Beverage Co Class C', book).ticker).toBeNull();
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

  it('rechecks a null ticker the previous resolver already saw, without re-arming the digest', async () => {
    const store = memoryStore();
    const filing = buildFilingRecord({
      source: 'oge', filingKey: 'OLD', first: 'Donald', last: 'Trump', office: 'president',
      filedDate: '2026-09-18', sourceUrl: 'https://example.test/278t', parsed: { status: 'parsed' },
    });
    const trades = buildTradeRows(filing, {
      trades: [
        {
          owner: 'self', ticker: null, asset: 'NETFLIXINC', assetClass: 'other',
          txType: 'buy', txDate: '2026-07-17', amountRange: '$1,001 - $15,000',
          digestPending: false,
        },
        {
          owner: 'self', ticker: 'T', asset: 'AT&T Inc', assetClass: 'stock',
          txType: 'buy', txDate: '2026-07-17', amountRange: '$1,001 - $15,000',
          digestPending: false, tickerSource: 'filing',
        },
      ],
    });
    await store.insertPoliticianBundle(filing, trades);
    const missed = store.db.politicianTrades.find((row) => row.asset === 'NETFLIXINC');
    missed.nameMatchAt = FETCHED;
    missed.nameMatchVersion = MATCHER_VERSION - 1;
    const book = catalog();
    const first = await backfillNullTickers({ store, catalog: book });
    expect(first.matched).toBe(1);
    expect(missed.ticker).toBe('NFLX');
    expect(missed.tickerSource).toBe('name_match');
    expect(missed.digestPending).toBe(false);
    expect(missed.nameMatchVersion).toBe(MATCHER_VERSION);
    const filingRow = store.db.politicianTrades.find((row) => row.tickerSource === 'filing');
    expect(filingRow.ticker).toBe('T');
    const second = await backfillNullTickers({ store, catalog: book });
    expect(second.examined).toBe(0);
    expect(second.matched).toBe(0);
    const pending = await store.listDigestPendingTrades();
    expect(pending).toEqual([]);
  });
});

const EXTRA_ROWS = [
  ['Philip Morris International Inc.', 'PM', 'NYSE'],
  ['Philip Morris Local Co', 'PML', 'NYSE'],
  ['Booking Holdings Inc.', 'BKNG', 'Nasdaq'],
  ['T-Mobile US, Inc.', 'TMUS', 'Nasdaq'],
  ['T-Mobile US, Inc.', 'TMUSI', 'Nasdaq'],
  ['T-Mobile US, Inc.', 'TMUSL', 'Nasdaq'],
  ['T-Mobile US, Inc.', 'TMUSZ', 'Nasdaq'],
  ['Fox Corp', 'FOXA', 'Nasdaq'],
  ['Fox Corp', 'FOX', 'Nasdaq'],
  ['News Corp', 'NWSA', 'Nasdaq'],
  ['News Corp', 'NWS', 'Nasdaq'],
  ['COMCAST CORP', 'CMCSA', 'Nasdaq'],
  ['COMCAST CORP', 'CCZ', 'NYSE'],
  ['Under Armour, Inc.', 'UAA', 'NYSE'],
  ['Under Armour, Inc.', 'UA', 'NYSE'],
  ['LENNAR CORP /NEW/', 'LEN', 'NYSE'],
  ['LENNAR CORP /NEW/', 'LEN-B', 'NYSE'],
  ['CrowdStrike Holdings, Inc.', 'CRWD', 'Nasdaq'],
  ['HONEYWELL INTERNATIONAL INC', 'HON', 'Nasdaq'],
  ['PPG INDUSTRIES INC', 'PPG', 'NYSE'],
  ['AbbVie Inc.', 'ABBV', 'NYSE'],
  ['Walmart Inc.', 'WMT', 'NYSE'],
  ['COSTCO WHOLESALE CORP', 'COST', 'Nasdaq'],
  ['COST INC', 'COSTX', 'NYSE'],
  ['CISCO SYSTEMS, INC.', 'CSCO', 'Nasdaq'],
  ['GEI Inc.', 'GEI', 'NYSE'],
  ['Acme Technology Inc.', 'ACMT', 'NYSE'],
  ['Acme Technologies Inc.', 'ACMTS', 'Nasdaq'],
  ['Apex National Bank', 'ANB', 'NYSE'],
  ['Apex Natural Bank', 'ANX', 'NYSE'],
  ['Sony Group Corp', 'SONY', 'NYSE'],
  ['ASML Holding NV', 'ASML', 'Nasdaq'],
  ['ExxonMobil Holdings Corp', 'XOM', 'NYSE'],
  ['Schneider National, Inc.', 'SNDR', 'NYSE'],
  ['LCI INDUSTRIES', 'LCII', 'NYSE'],
  ['BrightSpring Health Services, Inc.', 'BTSG', 'Nasdaq'],
  ['ESSENTIAL PROPERTIES REALTY TRUST, INC.', 'EPRT', 'NYSE'],
  ['Public Storage', 'PSA', 'NYSE'],
  ['OFG BANCORP', 'OFG', 'NYSE'],
  ['Medtronic plc', 'MDT', 'NYSE'],
  ['LINDE PLC', 'LIN', 'Nasdaq'],
  ['ZILLOW GROUP, INC.', 'ZG', 'Nasdaq'],
  ['ZILLOW GROUP, INC.', 'Z', 'Nasdaq'],
  ['HEICO CORP', 'HEI', 'NYSE'],
  ['HEICO CORP', 'HEI-A', 'NYSE'],
  ['PNC FINANCIAL SERVICES GROUP, INC.', 'PNC', 'NYSE'],
  ['Bar Manufacturing Inc', 'BARM', 'NYSE'],
  ['Baz Systems Inc', 'BAZS', 'NYSE'],
  ['Qux Pharmaceuticals Inc', 'QUX', 'NYSE'],
  ['National Grid plc', 'NGG', 'NYSE'],
  ['American Express Co', 'AXP', 'NYSE'],
  ['Warner Entertainment Inc', 'WENT', 'NYSE'],
  ['Summit Development Inc', 'SUMD', 'NYSE'],
  ['Apex Management Inc', 'APXM', 'NYSE'],
  ['Harbor Realty Inc', 'HRLY', 'NYSE'],
  ['Metro Properties Inc', 'MPRP', 'NYSE'],
  ['Echo Communications Inc', 'ECHO', 'Nasdaq'],
  ['First Bancorp', 'FBNC', 'Nasdaq'],
  ['TKO Group Holdings, Inc.', 'TKO', 'NYSE'],
  ['PTC INC.', 'PTC', 'Nasdaq'],
  ['RXO, Inc.', 'RXO', 'NYSE'],
  ['SLB LIMITED', 'SLB', 'NYSE'],
  ['WATSCO INC', 'WSO', 'NYSE'],
  ['WATSCO INC', 'WSO-B', 'NYSE'],
  ['WILLIAMS COMPANIES, INC.', 'WMB', 'NYSE'],
  ['WILLIAMS SONOMA INC', 'WSM', 'NYSE'],
  ['LOWES COMPANIES INC', 'LOW', 'NYSE'],
];

function wideCatalog() {
  return buildCatalog({ rows: [...SEC_ROWS, ...EXTRA_ROWS], fetchedAt: FETCHED });
}

describe('abbreviations, joined suffixes, and share classes', () => {
  const book = wideCatalog();

  it('expands each abbreviation family the same way on both sides', () => {
    const pairs = [
      ['Philip Morris INTL INC', 'Philip Morris International Inc.'],
      ['Booking HLDGS INC', 'Booking Holdings Inc.'],
      ['Booking HLDG INC', 'Booking Holding Inc.'],
      ['Acme CORP', 'Acme Corporation'],
      ['American Express CO', 'American Express Company'],
      ['Summit GRP', 'Summit Group'],
      ['Acme TECH INC', 'Acme Technology Inc.'],
      ['Acme TECHS INC', 'Acme Technologies Inc.'],
      ['Bar MFG INC', 'Bar Manufacturing Inc'],
      ['BrightSpring Health SVCS', 'BrightSpring Health Services'],
      ['Baz SYS INC', 'Baz Systems Inc'],
      ['Qux PHARMA INC', 'Qux Pharmaceuticals Inc'],
      ['Qux PHARMS INC', 'Qux Pharmaceutical Inc'],
      ['PNC FINL Services', 'PNC Financial Services'],
      ['Schneider NATL Inc', 'Schneider National Inc'],
      ['AMER Express Co', 'American Express Company'],
      ['Echo COMMUN INC', 'Echo Communications Inc'],
      ['Warner ENTMT INC', 'Warner Entertainment Inc'],
      ['LCI INDS', 'LCI Industries'],
      ['Metro PPTYS INC', 'Metro Properties Inc'],
      ['Harbor RLTY INC', 'Harbor Realty Inc'],
      ['Essential RLTY TR', 'Essential Realty Trust'],
      ['Apex MGMT INC', 'Apex Management Inc'],
      ['Summit DEV INC', 'Summit Development Inc'],
      ['Williams COS INC', 'Williams Companies Inc'],
      ['Lowes COS INC', 'Lowes Companies Inc'],
    ];
    for (const [abbrev, full] of pairs) {
      expect(normalizeAssetName(abbrev).stem, abbrev).toBe(normalizeAssetName(full).stem);
    }
    expect(normalizeAssetName('The Home Depot, Inc.').stem).toBe('home depot');
    expect(normalizeAssetName('Johnson & Johnson').stem).toBe('johnson and johnson');
    expect(normalizeAssetName('OFG BANCORP').stem).toBe('ofg bancorp');
    expect(normalizeAssetName('FIRST BANCORP').stem).toBe(normalizeAssetName('First Bancorp').stem);
  });

  it('keeps TECH and TECHS on different companies', () => {
    expect(matchAssetName('Acme TECH INC', book).ticker).toBe('ACMT');
    expect(matchAssetName('Acme TECHS INC', book).ticker).toBe('ACMTS');
    expect(matchAssetName('Acme Technology Inc', book).ticker).toBe('ACMT');
    expect(matchAssetName('Acme Technologies Inc', book).ticker).toBe('ACMTS');
    expect(matchAssetName('Acme TECH INC', book).ticker).not.toBe('ACMTS');
  });

  it('matches abbreviated filing names and refuses a lookalike stem', () => {
    expect(FUZZY_MIN_SIMILARITY).toBe(0.94);
    expect(matchAssetName('PHILIP MORRIS INTL INC', book)).toMatchObject({ ticker: 'PM', reason: 'exact' });
    expect(matchAssetName('Philip Morris Local', book).ticker).toBe('PML');
    expect(matchAssetName('Philip Morris', book).ticker).toBeNull();
    expect(matchAssetName('BOOKING HLDGS INC', book).ticker).toBe('BKNG');
    expect(matchAssetName('HONEYWELL INTL INC', book).ticker).toBe('HON');
    expect(matchAssetName('LCI INDS', book).ticker).toBe('LCII');
    expect(matchAssetName('BRIGHTSPRING HEALTH SVCS INC', book).ticker).toBe('BTSG');
    expect(matchAssetName('EXXONMOBIL HLDGS CORP', book).ticker).toBe('XOM');
    expect(matchAssetName('PNC FINL SERVICES GROUP INC', book).ticker).toBe('PNC');
    expect(matchAssetName('SCHNEIDER NATL INC WIS CLASS B', book).ticker).toBe('SNDR');
    expect(matchAssetName('Apex NATL Bank', book).ticker).toBe('ANB');
    expect(matchAssetName('Apex Natural Bank', book).ticker).toBe('ANX');
    expect(matchAssetName('AMER Express', book).ticker).toBe('AXP');
    expect(matchAssetName('OFG BANCORP', book).ticker).toBe('OFG');
    expect(matchAssetName('T-MOBILE US INC', book).ticker).toBe('TMUS');
    expect(matchAssetName('T-Mobile U.S. Inc', book).ticker).toBe('TMUS');
  });

  it('splits a glued known suffix and does not split lookalike endings', () => {
    expect(repairJoinedSuffix('NETFLIXINC')).toBe('NETFLIX INC');
    expect(repairJoinedSuffix('WALMARTINC')).toBe('WALMART INC');
    expect(repairJoinedSuffix('BOOKINGHLDGS')).toBe('BOOKING HLDGS');
    expect(repairJoinedSuffix('PPG INDSINC')).toBe('PPG INDS INC');
    expect(repairJoinedSuffix('ABBVIEINC')).toBe('ABBVIE INC');
    expect(repairJoinedSuffix('EQtCorp')).toBe('EQt Corp');
    expect(repairJoinedSuffix('COSTCO')).toBe('COSTCO');
    expect(repairJoinedSuffix('GEICO')).toBe('GEICO');
    expect(repairJoinedSuffix('CISCO')).toBe('CISCO');
    expect(repairJoinedSuffix('SUNOCO')).toBe('SUNOCO');
    expect(repairJoinedSuffix('BANCORP')).toBe('BANCORP');
    expect(repairJoinedSuffix('PTCINC')).toBe('PTC INC');
    expect(repairJoinedSuffix('SLBLTD')).toBe('SLB LTD');
    expect(repairJoinedSuffix('CrhPlc')).toBe('Crh Plc');
    expect(repairJoinedSuffix('ZINC')).toBe('ZINC');
    expect(matchAssetName('PTCINC', book).ticker).toBe('PTC');
    expect(matchAssetName('RXOINC', book).ticker).toBe('RXO');
    expect(matchAssetName('SLBLTD', book).ticker).toBe('SLB');
    expect(matchAssetName('WILLIAMS COS INC DEL', book).ticker).toBe('WMB');
    expect(matchAssetName('WILLIAMS SONOMA INC', book).ticker).toBe('WSM');
    expect(matchAssetName('LOWES COS INC', book).ticker).toBe('LOW');
    expect(matchAssetName('NETFLIXINC', book).ticker).toBe('NFLX');
    expect(matchAssetName('WALMARTINC', book).ticker).toBe('WMT');
    expect(matchAssetName('BOOKINGHLDGS', book).ticker).toBe('BKNG');
    expect(matchAssetName('PPG INDSINC', book).ticker).toBe('PPG');
    expect(matchAssetName('ABBVIEINC', book).ticker).toBe('ABBV');
    expect(matchAssetName('COSTCO', book).ticker).toBeNull();
    expect(matchAssetName('COSTCOINC', book).ticker).toBeNull();
    expect(matchAssetName('GEICO', book).ticker).toBeNull();
    expect(matchAssetName('CISCO SYSTEMS INC', book).ticker).toBe('CSCO');
    expect(matchAssetName('NOTFLIXINC', book).ticker).toBeNull();
  });

  it('maps share-class letters onto the listed ticker and leaves the others blank', () => {
    expect(normalizeAssetName('ALPHABET INC CL A').shareClass).toBe('a');
    expect(normalizeAssetName('ALPHABET INC CL.A').shareClass).toBe('a');
    expect(normalizeAssetName('ALPHABET INC CLASS C').shareClass).toBe('c');
    expect(matchAssetName('ALPHABET INC CL A', book).ticker).toBe('GOOGL');
    expect(matchAssetName('ALPHABET INC CLASS C', book).ticker).toBe('GOOG');
    expect(matchAssetName('Alphabet Inc', book).ticker).toBeNull();
    expect(matchAssetName('Alphabet Inc Class B', book).ticker).toBeNull();
    expect(matchAssetName('BERKSHIRE HATHAWAY CLASS B', book).ticker).toBe('BRK.B');
    expect(matchAssetName('Berkshire Hathaway Class A', book).ticker).toBe('BRK.A');
    expect(matchAssetName('FOX CORP CL A', book).ticker).toBe('FOXA');
    expect(matchAssetName('FOX CORP CLASS B', book).ticker).toBe('FOX');
    expect(matchAssetName('Fox Corp', book).ticker).toBeNull();
    expect(matchAssetName('NEWS CORP CL A', book).ticker).toBe('NWSA');
    expect(matchAssetName('NEWS CORP CL B', book).ticker).toBe('NWS');
    expect(matchAssetName('COMCAST CORP CL A', book).ticker).toBe('CMCSA');
    expect(matchAssetName('Comcast Corp', book).ticker).toBeNull();
    expect(matchAssetName('COMCAST CORP CL B', book).ticker).toBeNull();
    expect(matchAssetName('UNDER ARMOUR INC CL A', book).ticker).toBe('UAA');
    expect(matchAssetName('UNDER ARMOUR INC CLASS C', book).ticker).toBe('UA');
    expect(matchAssetName('Under Armour Inc', book).ticker).toBeNull();
    expect(matchAssetName('MOLSON COORS BEVERAGE CO CLASS B', book).ticker).toBe('TAP');
    expect(matchAssetName('Molson Coors Beverage Co Class A', book).ticker).toBe('TAP.A');
    expect(matchAssetName('LENNAR CORP CL A', book).ticker).toBe('LEN');
    expect(matchAssetName('LENNAR CORP CLASS B', book).ticker).toBe('LEN.B');
    expect(matchAssetName('HEICO CORP CL A', book).ticker).toBe('HEI.A');
    expect(matchAssetName('ZILLOW GROUP INC CL A', book).ticker).toBe('ZG');
    expect(matchAssetName('ZILLOW GROUP INC CLASS C', book).ticker).toBe('Z');
    expect(matchAssetName('Zillow Group Inc', book).ticker).toBeNull();
    expect(matchAssetName('CROWDSTRIKE HLDGS INC CL A', book).ticker).toBe('CRWD');
    expect(matchAssetName('TKO GROUP HLDGS INC CL A', book).ticker).toBe('TKO');
    expect(matchAssetName('Meta Platforms Inc Class A', book).ticker).toBe('META');
    expect(matchAssetName('NIKE INC CLASS CLASS B', book).ticker).toBe('NKE');
    expect(matchAssetName('WATSCO INC CLASS A', book).ticker).toBe('WSO');
    expect(matchAssetName('WATSCO INC CLASS B', book).ticker).toBe('WSO.B');
  });

  it('strips ADR and ADS suffixes and still refuses debt and private funds', () => {
    expect(normalizeAssetName('Sony Group Corp Sponsored ADR').stem).toBe('sony group');
    expect(normalizeAssetName('ASML Holding N.V. ADR').stem).toBe(normalizeAssetName('ASML Holding NV').stem);
    expect(matchAssetName('Sony Group Corporation Sponsored ADR', book).ticker).toBe('SONY');
    expect(matchAssetName('ASML Holding NV ADR', book).ticker).toBe('ASML');
    expect(matchAssetName('LINDE PLC F', book).ticker).toBe('LIN');
    expect(matchAssetName('MEDTRONIC PLC F', book).ticker).toBe('MDT');
    expect(matchAssetName('OFG BANCORP F', book).ticker).toBe('OFG');
    expect(matchAssetName('PUBLIC STORAGE REIT', book).ticker).toBe('PSA');
    expect(matchAssetName('ESSENTIAL PPTYS RLTY TR REIT', book).ticker).toBe('EPRT');
    const note = matchAssetName('Philip Morris INTL 3.375% Note due 04/01/2027', book);
    expect(note.ticker).toBeNull();
    expect(note.reason).toBe('debt');
    expect(matchAssetName('T-Mobile US Inc 5.500% Senior Notes due 06/01/2070', book).ticker).toBeNull();
    expect(matchAssetName('Home Depot 2.95% Due 06/15/29', book).reason).toBe('debt');
    expect(matchAssetName('Sequoia Private Equity Fund', book).reason).toBe('private');
    expect(matchAssetName('Huntington Bancshares Preferred Series B', book).ticker).toBeNull();
    const filing = annotateTrade({
      ticker: 'T', tickerNorm: 'T', tickerSource: 'filing', asset: 'NETFLIXINC', assetClass: 'stock',
    }, book);
    expect(filing.ticker).toBe('T');
    expect(filing.tickerSource).toBe('filing');
  });
});
