// lookThrough.test.js — coverage / chip copy. Pure; imports the client helper.
import { describe, it, expect } from 'vitest';
import { lookThroughCoverage, lookThroughChip } from '../client/src/lookThrough.js';

const fund = (over) => ({
  symbol: 'VFV.TO', type: 'etf', weight: 0.4,
  sectorBreakdown: [{ label: 'Information Technology', weight: 35 }],
  breakdownAsOf: '2026-06-30',
  ...over,
});

describe('lookThroughChip', () => {
  it('shows as-of when dated', () => {
    expect(lookThroughChip(fund())).toBe('look-through · 2026-06-30');
  });
  it('flags incomplete instead of a clean set when as-of is missing', () => {
    expect(lookThroughChip(fund({ breakdownAsOf: null }))).toBe('look-through incomplete');
  });
  it('is empty when there is no breakdown', () => {
    expect(lookThroughChip({ type: 'stock', sectorBreakdown: null })).toBe('');
  });
});

describe('lookThroughCoverage', () => {
  it('nags missing fund look-through and missing as-of; stocks do not nag', () => {
    const c = lookThroughCoverage([
      fund({ symbol: 'VFV.TO', weight: 0.5, breakdownAsOf: null }),
      { symbol: 'XBB.TO', type: 'etf', weight: 0.3, sectorBreakdown: null },
      { symbol: 'RY.TO', type: 'stock', weight: 0.2, sectorBreakdown: null },
    ]);
    expect(c.lookThroughPct).toBeCloseTo(0.5);
    expect(c.singleBucketCount).toBe(2);
    expect(c.issues).toBe(true);
    expect(c.oldestAsOf).toBeNull();
    expect(c.missingAsOf.map((h) => h.symbol)).toEqual(['VFV.TO']);
    expect(c.missingFundBreakdown.map((h) => h.symbol)).toEqual(['XBB.TO']);
  });

  it('is quiet when funds are dated and stocks are single-bucket', () => {
    const c = lookThroughCoverage([
      fund({ symbol: 'VFV.TO', weight: 0.7, breakdownAsOf: '2026-06-30' }),
      fund({ symbol: 'XEF.TO', weight: 0.1, breakdownAsOf: '2025-06-30',
        sectorBreakdown: [{ label: 'Financials', weight: 20 }] }),
      { symbol: 'RY.TO', type: 'stock', weight: 0.2, sectorBreakdown: null },
    ]);
    expect(c.issues).toBe(false);
    expect(c.lookThroughPct).toBeCloseTo(0.8);
    expect(c.singleBucketCount).toBe(1);
    expect(c.oldestAsOf).toBe('2025-06-30');
    expect(c.missingFundBreakdown).toEqual([]);
    expect(c.missingAsOf).toEqual([]);
  });
});
