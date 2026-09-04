// sources.js — ticker → public issuer factsheet URL.
//
// How to add a mapping
// --------------------
// 1. Prefer the issuer's own product page (HTML allocation table) or, when
//    the page is a JS shell, the public factsheet PDF.
// 2. Add one entry to FACTSHEET_SOURCES keyed by the Yahoo-style symbol
//    (TSX = TICKER.TO, US = bare ticker). lookupSource() also accepts the
//    bare TSX ticker (VFV → VFV.TO).
// 3. Set `parser` to one of: 'html' | 'pdf' | 'html-or-pdf'.
//    html       — product page tables and/or embedded JS allocation arrays
//    pdf        — issuer factsheet PDF (Vanguard Canada)
//    html-or-pdf — try the page, then follow a Factsheet PDF link
// 4. Skip stocks, alts, and cash. Do not add login-walled URLs.
//
// Fragility / ToS
// ---------------
// These are public marketing pages and PDFs, fetched server-side with a
// short timeout. Layout changes will break parsers. This is not a licensed
// holdings feed and must never auto-save over a user's ClassifyPanel edits.
// A parse miss or HTTP failure returns an error; existing instrument data
// is left untouched. Manual entry stays the fallback.

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
};

export function canonicalSymbol(symbol) {
  return String(symbol || '').trim().toUpperCase();
}

export function lookupSource(symbol) {
  const s = canonicalSymbol(symbol);
  if (!s) return null;
  if (FACTSHEET_SOURCES[s]) return { symbol: s, ...FACTSHEET_SOURCES[s] };
  const bare = s.replace(/\.TO$/, '');
  if (FACTSHEET_SOURCES[bare]) return { symbol: bare, ...FACTSHEET_SOURCES[bare] };
  if (FACTSHEET_SOURCES[`${bare}.TO`]) {
    return { symbol: `${bare}.TO`, ...FACTSHEET_SOURCES[`${bare}.TO`] };
  }
  return null;
}

export function listMappedSymbols() {
  return Object.keys(FACTSHEET_SOURCES).sort();
}
