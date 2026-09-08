// sources.js — ticker / Fundserv code → public issuer factsheet URL.
//
// How to add a mapping
// --------------------
// ETFs (Yahoo-style tickers)
//   1. Prefer the issuer's own product page (HTML allocation table) or, when
//      the page is a JS shell, the public factsheet PDF.
//   2. Add one entry to FACTSHEET_SOURCES keyed by the Yahoo-style symbol
//      (TSX = TICKER.TO, US = bare ticker). lookupSource() also accepts the
//      bare TSX ticker (VFV → VFV.TO) and class-share aliases (IDIV.B,
//      IDIV.B.TO, IDIVB, IDIVB.TO).
//   3. Set `parser` to one of: 'html' | 'pdf' | 'html-or-pdf'.
//      html        — product page tables and/or embedded JS allocation arrays
//      pdf         — issuer factsheet PDF (Vanguard / Manulife) or Fund Facts PDF
//      html-or-pdf — try the page, then follow a Factsheet PDF link
//
// Manulife ETFs (public factsheet PDFs)
//   URL pattern: https://funds.manulife.ca/en-us/etfs/{TICKER}/pdf
//   Example: IDIV.B → https://funds.manulife.ca/en-us/etfs/IDIV.B/pdf
//   1. Confirm the ticker on funds.manulife.ca. The class suffix is
//      load-bearing (IDIV.B unhedged CAD ≠ IDIV.U).
//   2. Add one entry keyed by the TSX class ticker (IDIV.B). lookupSource()
//      also accepts IDIV.B.TO, IDIVB, and IDIVB.TO.
//   3. Set parser: 'pdf', kind: 'manulife-etf', issuer: 'Manulife'.
//      parseManulifeEtf.js reads look-through, compound + calendar returns,
//      MER, and the sheet NAV point. Do not invent a daily NAV series.
//   4. Commit a text fixture of the pdf-parse output — no live network in CI.
//
// Canadian mutual funds (Fundserv)
//   1. Key the entry by the code stored on the instrument, usually ISSUER +
//      digits (FID5982, RBF1005, MFC1234). lookupSource() also accepts the
//      bare digits when `fundserv` is set (5982 → FID5982), and strips spaces
//      / hyphens (FID-5982).
//   2. Series letter matters. 5982 is Series F (CAD NL), not A/B. Map the
//      Fund Facts PDF for that exact series — do not reuse an A-series sheet.
//   3. Set parser: 'pdf'. Put the Fund Facts PDF on `url` (look-through + MER
//      + regulatory calendar years). Optionally add:
//        fundPulseUrl — manufacturer period returns (preferred for 1y/3y/5y)
//        monthlyUrl   — issuer monthly update PDF (RBC: trailing + calendar
//                       returns + sector/geo). Preferred over Fund Facts
//                       for published periods when present.
//        productUrl   — issuer product page (reference only; series tabs on
//                       fidelity.ca default to A/B, so we do not scrape it
//                       for FID5982 performance)
//        series, fundserv, documentLabel ('Fund Facts')
//   4. To add another RBC fund (RBF####): copy the RBF608 block, point
//      url at https://funds.rbcgam.com/pdf/fund-facts/funds/rbf####_e.pdf
//      and monthlyUrl at https://www.rbcgam.com/documents/fund-pages/monthly/rbf####_e.pdf
//      (Series F code is load-bearing — do not reuse an A-series sheet).
//      parseFundDocs.js already reads CSA Fund Facts + RBC monthly layout.
//      Commit a text fixture — no live network in CI.
//      Mackenzie / others: copy FID5982 or RBF608 and add a parser only if
//      the text layout differs. Public issuer PDFs only — no Morningstar.
//
// 5. Skip stocks, alts, and cash. Do not add login-walled URLs.
//    Stocks (and unmapped TSX ETFs) fetch EOD history from Yahoo — see
//    server/yahooSeries.js — not this table.
//
// Fragility / ToS
// ---------------
// These are public marketing pages and PDFs, fetched server-side with a
// short timeout. Layout changes will break parsers. This is not a licensed
// holdings feed and must never auto-save over a user's ClassifyPanel edits.
// A parse miss or HTTP failure returns an error; existing instrument data
// is left untouched. Manual entry stays the fallback.
// Do not invent daily NAV history from published annual returns.

export const FACTSHEET_SOURCES = {
  // ----- Vanguard Canada (factsheet PDFs — product pages are JS shells) -----
  'VFV.TO': {
    issuer: 'Vanguard Canada',
    parser: 'pdf',
    url: 'https://fund-docs.vanguard.com/VFV_SandP_500_Index_ETF_9563_FS_EN_CA.pdf',
  },
  'VDY.TO': {
    issuer: 'Vanguard Canada',
    parser: 'pdf',
    url: 'https://fund-docs.vanguard.com/VDY_FTSE_Canadian_High_Dividend_Yield_Index_ETF_9560_FS_EN_CA.pdf',
  },
  'VCN.TO': {
    issuer: 'Vanguard Canada',
    parser: 'pdf',
    url: 'https://fund-docs.vanguard.com/VCN_FTSE_Canada_All_Cap_Index_ETF_9561_FS_EN_CA.pdf',
  },
  'VAB.TO': {
    issuer: 'Vanguard Canada',
    parser: 'pdf',
    url: 'https://fund-docs.vanguard.com/VAB_Canadian_Aggregate_Bond_Index_ETF_9552_FS_EN_CA.pdf',
  },
  'VUN.TO': {
    issuer: 'Vanguard Canada',
    parser: 'pdf',
    url: 'https://fund-docs.vanguard.com/VUN_U.S._Total_Market_Index_ETF_9557_FS_EN_CA.pdf',
  },
  'VEQT.TO': {
    issuer: 'Vanguard Canada',
    parser: 'pdf',
    url: 'https://fund-docs.vanguard.com/VEQT_All_Equity_ETF_Portfolio_9692_FS_EN_CA.pdf',
  },
  'VGRO.TO': {
    issuer: 'Vanguard Canada',
    parser: 'pdf',
    url: 'https://fund-docs.vanguard.com/VGRO_Growth_ETF_Portfolio_9579_FS_EN_CA.pdf',
  },
  'VBAL.TO': {
    issuer: 'Vanguard Canada',
    parser: 'pdf',
    url: 'https://fund-docs.vanguard.com/VBAL_Balanced_ETF_Portfolio_9578_FS_EN_CA.pdf',
  },

  // ----- iShares / BlackRock Canada (product pages embed allocation JS) -----
  'XBB.TO': {
    issuer: 'iShares Canada',
    parser: 'html',
    url: 'https://www.blackrock.com/ca/investors/en/products/239493/ishares-canadian-universe-bond-index-etf',
  },
  'XEQT.TO': {
    issuer: 'iShares Canada',
    parser: 'html',
    url: 'https://www.blackrock.com/ca/investors/en/products/309480/ishares-core-equity-etf-portfolio',
  },
  'XEF.TO': {
    issuer: 'iShares Canada',
    parser: 'html',
    url: 'https://www.blackrock.com/ca/investors/en/products/251421/ishares-msci-eafe-imi-index-etf',
  },
  'XIC.TO': {
    issuer: 'iShares Canada',
    parser: 'html',
    url: 'https://www.blackrock.com/ca/investors/en/products/239837/ishares-sptsx-capped-composite-index-etf',
  },
  'XBAL.TO': {
    issuer: 'iShares Canada',
    parser: 'html',
    url: 'https://www.blackrock.com/ca/investors/en/products/239566/ishares-balanced-income-etf-portfolio',
  },
  'XGRO.TO': {
    issuer: 'iShares Canada',
    parser: 'html',
    url: 'https://www.blackrock.com/ca/investors/en/products/239567/ishares-growth-etf-portfolio',
  },
  'XUU.TO': {
    issuer: 'iShares Canada',
    parser: 'html',
    url: 'https://www.blackrock.com/ca/investors/en/products/239708/ishares-core-sp-us-total-market-index-etf',
  },
  'XEC.TO': {
    issuer: 'iShares Canada',
    parser: 'html',
    url: 'https://www.blackrock.com/ca/investors/en/products/239835/ishares-core-msci-emerging-markets-imi-index-etf',
  },

  // ----- BMO (product pages; layout is less stable than Vanguard/iShares) -----
  'ZSP.TO': {
    issuer: 'BMO',
    parser: 'html-or-pdf',
    url: 'https://www.bmogam.com/ca-en/products/exchange-traded-funds/zsp-bmo-s-p-500-index-etf/',
  },
  'ZCN.TO': {
    issuer: 'BMO',
    parser: 'html-or-pdf',
    url: 'https://www.bmogam.com/ca-en/products/exchange-traded-funds/zcn-bmo-s-p-tsx-capped-composite-index-etf/',
  },
  'ZAG.TO': {
    issuer: 'BMO',
    parser: 'html-or-pdf',
    url: 'https://www.bmogam.com/ca-en/products/exchange-traded-funds/zag-bmo-aggregate-bond-index-etf/',
  },
  'ZEQT.TO': {
    issuer: 'BMO',
    parser: 'html-or-pdf',
    url: 'https://www.bmogam.com/ca-en/products/exchange-traded-funds/zeqt-bmo-all-equity-etf/',
  },

  // ----- CI Global Asset Management (best-effort public product pages) -----
  'TXF.TO': {
    issuer: 'CI',
    parser: 'html-or-pdf',
    url: 'https://www.cifinancial.com/ci-gam/ca/en/fund-details.txf.html',
  },

  // ----- US listings that show up in models -----
  SPY: {
    issuer: 'State Street',
    parser: 'html',
    url: 'https://www.ssga.com/us/en/individual/etfs/funds/spdr-sp-500-etf-trust-spy',
  },
  IVV: {
    issuer: 'iShares US',
    parser: 'html',
    url: 'https://www.ishares.com/us/products/239726/ishares-core-sp-500-etf',
  },

  // ----- Manulife ETFs (public factsheet PDFs) -----
  // Add another ticker: copy this block and point url at
  // https://funds.manulife.ca/en-us/etfs/{TICKER}/pdf
  'IDIV.B': {
    issuer: 'Manulife',
    parser: 'pdf',
    kind: 'manulife-etf',
    documentLabel: 'factsheet',
    url: 'https://funds.manulife.ca/en-us/etfs/IDIV.B/pdf',
  },

  // ----- Canadian mutual funds (Fundserv). Series letter is load-bearing. -----
  FID5982: {
    issuer: 'Fidelity Canada',
    parser: 'pdf',
    kind: 'mutualfund',
    series: 'F',
    fundserv: '5982',
    documentLabel: 'Fund Facts',
    url: 'https://www.fidelity.ca/content/dam/fidelity/en/documents/fund-facts/uet/FF_UET_F_en.pdf',
    fundPulseUrl: 'https://www.fidelity.ca/content/dam/fidelity/en/documents/fund-pulse/uet/fp_fgic.pdf',
    productUrl: 'https://www.fidelity.ca/en/products/funds/uet/',
  },
  RBF608: {
    issuer: 'RBC GAM',
    parser: 'pdf',
    kind: 'mutualfund',
    series: 'F',
    fundserv: '608',
    documentLabel: 'Fund Facts',
    url: 'https://funds.rbcgam.com/pdf/fund-facts/funds/rbf608_e.pdf',
    monthlyUrl: 'https://www.rbcgam.com/documents/fund-pages/monthly/rbf608_e.pdf',
    productUrl: 'https://www.rbcgam.com/en/ca/products/mutual-funds/RBF608/detail',
  },
};

export function canonicalSymbol(symbol) {
  return String(symbol || '').trim().toUpperCase().replace(/[\s-]+/g, '');
}

// Class-share ETFs: IDIV.B / IDIV.B.TO / IDIVB / IDIVB.TO → IDIVB
export function tickerLookupKey(symbol) {
  return canonicalSymbol(symbol).replace(/\.TO$/, '').replace(/\./g, '');
}

function lookupByFundserv(digits) {
  const hits = Object.entries(FACTSHEET_SOURCES).filter(([, src]) => src.fundserv === digits);
  if (hits.length === 1) return { symbol: hits[0][0], ...hits[0][1] };
  return null;
}

function lookupByTickerKey(want) {
  if (!want) return null;
  const hits = Object.entries(FACTSHEET_SOURCES).filter(([key]) => tickerLookupKey(key) === want);
  if (hits.length === 1) return { symbol: hits[0][0], ...hits[0][1] };
  return null;
}

export function lookupSource(symbol) {
  const s = canonicalSymbol(symbol);
  if (!s) return null;
  if (FACTSHEET_SOURCES[s]) return { symbol: s, ...FACTSHEET_SOURCES[s] };
  if (/^\d{3,5}$/.test(s)) {
    const byCode = lookupByFundserv(s);
    if (byCode) return byCode;
  }
  const bare = s.replace(/\.TO$/, '');
  if (FACTSHEET_SOURCES[bare]) return { symbol: bare, ...FACTSHEET_SOURCES[bare] };
  if (FACTSHEET_SOURCES[`${bare}.TO`]) {
    return { symbol: `${bare}.TO`, ...FACTSHEET_SOURCES[`${bare}.TO`] };
  }
  return lookupByTickerKey(tickerLookupKey(s));
}

export function listMappedSymbols() {
  return Object.keys(FACTSHEET_SOURCES).sort();
}
