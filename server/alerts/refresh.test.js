import { describe, it, expect } from 'vitest';
import {
  isRefreshableAutoHolding,
  planAutoPriceRefresh,
  sortOldestFirst,
  BREACH_PENDING_FRESH,
} from './refresh.js';

describe('isRefreshableAutoHolding', () => {
  it('allows auto stock/ETF without NAV and rejects manual, cash, alt, and NAV-backed', () => {
    expect(isRefreshableAutoHolding({ source: 'auto', type: 'stock', symbol: 'TSLA' }, [])).toBe(true);
    expect(isRefreshableAutoHolding({ source: 'auto', type: 'etf', symbol: 'VFV.TO' }, [])).toBe(true);
    expect(isRefreshableAutoHolding({ source: 'manual', type: 'stock', symbol: 'RY.TO' }, [])).toBe(false);
    expect(isRefreshableAutoHolding({ source: 'auto', type: 'cash', symbol: 'CASH' }, [])).toBe(false);
    expect(isRefreshableAutoHolding({ source: 'manual', type: 'alt', symbol: 'OCIC' }, [{ date: '2026-01-01', nav: 10 }])).toBe(false);
    expect(isRefreshableAutoHolding(
      { source: 'auto', type: 'stock', symbol: 'RY.TO' },
      [{ date: '2026-09-01', nav: 100 }],
    )).toBe(false);
  });
});

describe('planAutoPriceRefresh', () => {
  it('orders oldest last-close first and respects the cap', () => {
    const plan = planAutoPriceRefresh([
      {
        instrumentId: 'a', symbol: 'AAPL', refreshable: true,
        historySeries: [{ date: '2026-09-20', close: 1 }],
      },
      {
        instrumentId: 't', symbol: 'TSLA', refreshable: true,
        historySeries: [{ date: '2026-09-04', close: 1 }],
      },
      {
        instrumentId: 'm', symbol: 'MSFT', refreshable: true,
        historySeries: [{ date: '2026-09-28', close: 1 }],
      },
      {
        instrumentId: 'c', symbol: 'CASH', refreshable: false,
        historySeries: [],
      },
      {
        instrumentId: 'f', symbol: 'FRESH', refreshable: true,
        historySeries: [{ date: '2026-10-01', close: 1 }],
      },
    ], { today: '2026-10-01', cap: 2 });

    expect(plan.map((p) => p.symbol)).toEqual(['TSLA', 'AAPL']);
  });

  it('sortOldestFirst puts missing closes first', () => {
    const sorted = sortOldestFirst([
      { symbol: 'B', lastClose: '2026-09-10' },
      { symbol: 'A', lastClose: null },
      { symbol: 'C', lastClose: '2026-09-01' },
    ]);
    expect(sorted.map((s) => s.symbol)).toEqual(['A', 'C', 'B']);
  });
});

describe('constants', () => {
  it('exports the pending-fresh detail string', () => {
    expect(BREACH_PENDING_FRESH).toBe('breach pending fresh data');
  });
});
