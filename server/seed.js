// seed.js
// A working starter dataset so the app boots with something real to look at.
// Auto instruments use live Yahoo symbols; manual instruments (Canadian MF code,
// private alts) carry a seeded NAV so the hybrid path is exercised end to end.

export const seedData = {
  instruments: {
    // ---- auto (Yahoo) ----
    'inst_xbb': { id: 'inst_xbb', symbol: 'XBB.TO', name: 'iShares Core Cdn Universe Bond', type: 'etf', source: 'auto', currency: 'CAD', sector: 'Fixed Income', country: 'Canada', mer: 0.10 },
    'inst_vfv': { id: 'inst_vfv', symbol: 'VFV.TO', name: 'Vanguard S&P 500 (CAD)', type: 'etf', source: 'auto', currency: 'CAD', sector: 'Equity', country: 'United States', mer: 0.09 },
    'inst_vdy': { id: 'inst_vdy', symbol: 'VDY.TO', name: 'Vanguard Cdn High Dividend', type: 'etf', source: 'auto', currency: 'CAD', sector: 'Equity', country: 'Canada', mer: 0.22 },
    'inst_xef': { id: 'inst_xef', symbol: 'XEF.TO', name: 'iShares Core MSCI EAFE IMI', type: 'etf', source: 'auto', currency: 'CAD', sector: 'Equity', country: 'International', mer: 0.22 },
    'inst_ry':  { id: 'inst_ry',  symbol: 'RY.TO',  name: 'Royal Bank of Canada', type: 'stock', source: 'auto', currency: 'CAD', sector: 'Financials', country: 'Canada', mer: null },
    'inst_enb': { id: 'inst_enb', symbol: 'ENB.TO', name: 'Enbridge Inc.', type: 'stock', source: 'auto', currency: 'CAD', sector: 'Energy', country: 'Canada', mer: null },
    'inst_tou': { id: 'inst_tou', symbol: 'TOU.TO', name: 'Tourmaline Oil Corp.', type: 'stock', source: 'auto', currency: 'CAD', sector: 'Energy', country: 'Canada', mer: null },

    // ---- manual (no free data source) ----
    'inst_rbf': { id: 'inst_rbf', symbol: 'RBF1005', name: 'RBC Canadian Equity Fund (example FundServ)', type: 'mutualfund', source: 'manual', currency: 'CAD', sector: 'Equity', country: 'Canada', mer: 1.83 },
    'inst_ocic': { id: 'inst_ocic', symbol: 'OCIC', name: 'Blue Owl Credit Income Corp.', type: 'alt', source: 'manual', currency: 'USD', sector: 'Private Credit', country: 'United States', mer: null },
    'inst_cvc': { id: 'inst_cvc', symbol: 'CVC-EU', name: 'CVC European Buyout (via iCapital)', type: 'alt', source: 'manual', currency: 'EUR', sector: 'Private Equity', country: 'International', mer: null },
  },

  // Manual NAV points. In production you'd add these from statements each period.
  navSeries: {
    'inst_rbf': [
      { date: '2025-01-02', nav: 42.15 },
      { date: '2025-06-30', nav: 44.90 },
      { date: '2025-12-31', nav: 46.32 },
    ],
    'inst_ocic': [
      { date: '2025-01-02', nav: 8.94 },
      { date: '2025-06-30', nav: 9.08 },
      { date: '2025-12-31', nav: 9.21 },
    ],
    'inst_cvc': [
      { date: '2025-01-02', nav: 100.0 },
      { date: '2025-06-30', nav: 107.5 },
      { date: '2025-12-31', nav: 113.2 },
    ],
  },

  models: {
    conservative: {
      key: 'conservative', name: 'Conservative', riskRank: 1,
      benchmark: [{ symbol: 'XBB.TO', weight: 0.70 }, { symbol: 'VFV.TO', weight: 0.20 }, { symbol: 'XEF.TO', weight: 0.10 }],
      versions: [
        {
          id: 'ver_cons_1', effectiveDate: '2025-01-01', note: 'Initial model',
          holdings: [
            { instrumentId: 'inst_xbb', weight: 0.55 },
            { instrumentId: 'inst_vdy', weight: 0.15 },
            { instrumentId: 'inst_vfv', weight: 0.15 },
            { instrumentId: 'inst_rbf', weight: 0.10 },
            { instrumentId: 'inst_ocic', weight: 0.05 },
          ],
          createdAt: '2025-01-01T00:00:00.000Z',
        },
      ],
    },

    balanced: {
      key: 'balanced', name: 'Balanced', riskRank: 2,
      benchmark: [{ symbol: 'XBB.TO', weight: 0.40 }, { symbol: 'VFV.TO', weight: 0.35 }, { symbol: 'XEF.TO', weight: 0.25 }],
      versions: [
        {
          id: 'ver_bal_1', effectiveDate: '2025-01-01', note: 'Initial model',
          holdings: [
            { instrumentId: 'inst_xbb', weight: 0.35 },
            { instrumentId: 'inst_vfv', weight: 0.20 },
            { instrumentId: 'inst_vdy', weight: 0.15 },
            { instrumentId: 'inst_xef', weight: 0.10 },
            { instrumentId: 'inst_rbf', weight: 0.10 },
            { instrumentId: 'inst_ocic', weight: 0.06 },
            { instrumentId: 'inst_cvc', weight: 0.04 },
          ],
          createdAt: '2025-01-01T00:00:00.000Z',
        },
        {
          id: 'ver_bal_2', effectiveDate: '2025-07-01', note: 'Trimmed bonds, added energy on rate outlook',
          holdings: [
            { instrumentId: 'inst_xbb', weight: 0.28 },
            { instrumentId: 'inst_vfv', weight: 0.22 },
            { instrumentId: 'inst_vdy', weight: 0.15 },
            { instrumentId: 'inst_xef', weight: 0.10 },
            { instrumentId: 'inst_enb', weight: 0.05 },
            { instrumentId: 'inst_rbf', weight: 0.10 },
            { instrumentId: 'inst_ocic', weight: 0.06 },
            { instrumentId: 'inst_cvc', weight: 0.04 },
          ],
          createdAt: '2025-07-01T00:00:00.000Z',
        },
      ],
    },

    'balanced-growth': {
      key: 'balanced-growth', name: 'Balanced Growth', riskRank: 3,
      benchmark: [{ symbol: 'XBB.TO', weight: 0.25 }, { symbol: 'VFV.TO', weight: 0.45 }, { symbol: 'XEF.TO', weight: 0.30 }],
      versions: [], // empty on purpose — exercises the empty-state UX
    },

    growth: {
      key: 'growth', name: 'Growth', riskRank: 4,
      benchmark: [{ symbol: 'XBB.TO', weight: 0.15 }, { symbol: 'VFV.TO', weight: 0.55 }, { symbol: 'XEF.TO', weight: 0.30 }],
      versions: [
        {
          id: 'ver_gro_1', effectiveDate: '2025-01-01', note: 'Initial model',
          holdings: [
            { instrumentId: 'inst_xbb', weight: 0.15 },
            { instrumentId: 'inst_vfv', weight: 0.30 },
            { instrumentId: 'inst_vdy', weight: 0.15 },
            { instrumentId: 'inst_xef', weight: 0.15 },
            { instrumentId: 'inst_enb', weight: 0.07 },
            { instrumentId: 'inst_tou', weight: 0.06 },
            { instrumentId: 'inst_cvc', weight: 0.07 },
            { instrumentId: 'inst_ocic', weight: 0.05 },
          ],
          createdAt: '2025-01-01T00:00:00.000Z',
        },
      ],
    },

    'aggressive-growth': {
      key: 'aggressive-growth', name: 'Aggressive Growth', riskRank: 5,
      benchmark: [{ symbol: 'VFV.TO', weight: 0.65 }, { symbol: 'XEF.TO', weight: 0.35 }],
      versions: [], // empty on purpose
    },
  },
};
