import { describe, it, expect } from 'vitest';
import {
  blendedMer,
  merKnownWeight,
  weightByInstrument,
  intersectionWeight,
  sharedTickerCount,
  fixedIncomeWeight,
  buildCompare,
} from './compare.js';

const H = (id, symbol, weight, extra = {}) => ({
  id, symbol, name: symbol, type: extra.type || 'etf', weight, ...extra,
});

describe('blendedMer', () => {
  it('weight-averages known MERs and ignores nulls', () => {
    const holdings = [
      H('a', 'XBB.TO', 0.55, { mer: 0.10 }),
      H('b', 'VDY.TO', 0.15, { mer: 0.22 }),
      H('c', 'VFV.TO', 0.15, { mer: 0.09 }),
      H('d', 'RBF1005', 0.05, { mer: 1.83 }),
      H('e', 'OCIC', 0.05, { mer: null }),
      H('f', 'AAPL', 0.05),
    ];
    // known weight 0.90; (0.55*0.10 + 0.15*0.22 + 0.15*0.09 + 0.05*1.83) / 0.90
    expect(blendedMer(holdings)).toBeCloseTo(0.193 / 0.90, 10);
    expect(merKnownWeight(holdings)).toBeCloseTo(0.90, 10);
  });

  it('returns null when no MER is known', () => {
    expect(blendedMer([H('a', 'AAPL', 1)])).toBeNull();
    expect(merKnownWeight([H('a', 'AAPL', 1)])).toBe(0);
  });

  it('skips zero-weight rows', () => {
    expect(blendedMer([H('a', 'SPY', 0, { mer: 0.09 }), H('b', 'XBB.TO', 1, { mer: 0.10 })])).toBeCloseTo(0.10, 10);
  });
});

describe('intersectionWeight', () => {
  it('is the sum of min weights on shared tickers', () => {
    const a = weightByInstrument([H('x', 'X', 0.60), H('y', 'Y', 0.40)]);
    const b = weightByInstrument([H('x', 'X', 0.30), H('y', 'Y', 0.20), H('z', 'Z', 0.50)]);
    expect(intersectionWeight(a, b)).toBeCloseTo(0.50, 10);
    expect(sharedTickerCount(a, b)).toBe(2);
  });

  it('is 1 for identical fully-invested books', () => {
    const a = weightByInstrument([H('x', 'X', 0.7), H('y', 'Y', 0.3)]);
    const b = weightByInstrument([H('y', 'Y', 0.3), H('x', 'X', 0.7)]);
    expect(intersectionWeight(a, b)).toBeCloseTo(1, 10);
  });

  it('is 0 for disjoint books', () => {
    const a = weightByInstrument([H('x', 'X', 1)]);
    const b = weightByInstrument([H('y', 'Y', 1)]);
    expect(intersectionWeight(a, b)).toBe(0);
    expect(sharedTickerCount(a, b)).toBe(0);
  });

  it('ignores zero-weight rows', () => {
    const a = weightByInstrument([H('x', 'X', 1), H('z', 'Z', 0)]);
    const b = weightByInstrument([H('z', 'Z', 0.4), H('y', 'Y', 0.6)]);
    expect(intersectionWeight(a, b)).toBe(0);
  });
});

describe('buildCompare', () => {
  const snap = (key, name, riskRank, holdings, extra = {}) => ({
    key, name, riskRank, holdings, versionCount: extra.versionCount ?? 1,
    currentVersion: extra.empty
      ? null
      : { id: `ver_${key}`, effectiveDate: extra.effectiveDate || '2026-01-01' },
  });

  const cons = [
    H('xbb', 'XBB.TO', 0.55, { mer: 0.10, sector: 'Fixed Income' }),
    H('vfv', 'VFV.TO', 0.25, { mer: 0.09, sector: 'Equity' }),
    H('ocic', 'OCIC', 0.20, { mer: null, sector: 'Private Credit' }),
  ];
  const bal = [
    H('xbb', 'XBB.TO', 0.30, { mer: 0.10, sector: 'Fixed Income' }),
    H('vfv', 'VFV.TO', 0.40, { mer: 0.09, sector: 'Equity' }),
    H('xef', 'XEF.TO', 0.30, { mer: 0.22, sector: 'Equity' }),
  ];
  const gro = [
    H('vfv', 'VFV.TO', 0.70, { mer: 0.09, sector: 'Equity' }),
    H('nvda', 'NVDA', 0.30, { type: 'stock', mer: null }),
  ];

  it('sorts models by risk rank and uses current holdings only', () => {
    const out = buildCompare([
      snap('growth', 'Growth', 4, gro),
      snap('conservative', 'Conservative', 1, cons),
      snap('balanced', 'Balanced', 2, bal),
    ]);
    expect(out.models.map((m) => m.key)).toEqual(['conservative', 'balanced', 'growth']);
    expect(out.models[0].shortName).toBe('Cons');
    expect(out.models[0].holdingCount).toBe(3);
    expect(out.models[0].effectiveDate).toBe('2026-01-01');
  });

  it('computes unique vs shared weight from presence across current models', () => {
    const out = buildCompare([
      snap('conservative', 'Conservative', 1, cons),
      snap('balanced', 'Balanced', 2, bal),
      snap('growth', 'Growth', 4, gro),
    ]);
    const c = out.models[0];
    // OCIC only in Conservative → 0.20 unique; XBB+VFV shared
    expect(c.uniqueWeight).toBeCloseTo(0.20, 10);
    expect(c.sharedWeight).toBeCloseTo(0.80, 10);
    const g = out.models[2];
    expect(g.uniqueWeight).toBeCloseTo(0.30, 10); // NVDA
    expect(g.sharedWeight).toBeCloseTo(0.70, 10);
  });

  it('reports pairwise intersection and marks adjacent risk-ladder pairs', () => {
    const out = buildCompare([
      snap('conservative', 'Conservative', 1, cons),
      snap('balanced', 'Balanced', 2, bal),
      snap('growth', 'Growth', 4, gro),
    ]);
    // Cons∩Bal = min(0.55,0.30)+min(0.25,0.40) = 0.55
    const consBal = out.pairs.find((p) => p.a === 'conservative' && p.b === 'balanced');
    expect(consBal.intersectionWeight).toBeCloseTo(0.55, 10);
    expect(consBal.sharedTickers).toBe(2);
    expect(consBal.adjacent).toBe(true);

    // Cons∩Gro = min(0.25,0.70) VFV = 0.25
    const consGro = out.pairs.find((p) => p.a === 'conservative' && p.b === 'growth');
    expect(consGro.intersectionWeight).toBeCloseTo(0.25, 10);
    expect(consGro.adjacent).toBe(false);

    expect(out.models[0].neighbors).toEqual([
      { key: 'balanced', name: 'Balanced', intersectionWeight: 0.55 },
    ]);
  });

  it('aligns the universe so the same instrument is one row', () => {
    const out = buildCompare([
      snap('conservative', 'Conservative', 1, cons),
      snap('balanced', 'Balanced', 2, bal),
    ]);
    const xbb = out.universe.find((r) => r.id === 'xbb');
    expect(xbb.modelCount).toBe(2);
    expect(xbb.weights.conservative).toBeCloseTo(0.55, 10);
    expect(xbb.weights.balanced).toBeCloseTo(0.30, 10);
    expect(xbb.weights).not.toHaveProperty('growth');
    const ocic = out.universe.find((r) => r.id === 'ocic');
    expect(ocic.modelCount).toBe(1);
    expect(ocic.weights.balanced).toBeNull();
    expect(out.universe[0].modelCount).toBeGreaterThanOrEqual(out.universe.at(-1).modelCount);
  });

  it('handles an empty model without inventing overlap or MER', () => {
    const out = buildCompare([
      snap('conservative', 'Conservative', 1, cons),
      snap('balanced-growth', 'Balanced Growth', 3, [], { empty: true, versionCount: 0 }),
    ]);
    const empty = out.models[1];
    expect(empty.holdingCount).toBe(0);
    expect(empty.blendedMer).toBeNull();
    expect(empty.uniqueWeight).toBe(0);
    expect(empty.sharedWeight).toBe(0);
    expect(empty.effectiveDate).toBeNull();
    const pair = out.pairs[0];
    expect(pair.intersectionWeight).toBe(0);
    expect(pair.sharedTickers).toBe(0);
  });

  it('exposes blended MER and fixed-income weight per model', () => {
    const out = buildCompare([snap('conservative', 'Conservative', 1, cons)]);
    expect(out.models[0].blendedMer).toBeCloseTo((0.55 * 0.10 + 0.25 * 0.09) / 0.80, 10);
    expect(out.models[0].merKnownWeight).toBeCloseTo(0.80, 10);
    expect(out.models[0].fixedIncomeWeight).toBeCloseTo(0.55, 10);
  });
});

describe('fixedIncomeWeight', () => {
  it('sums only Fixed Income sector rows', () => {
    expect(fixedIncomeWeight([
      H('a', 'XBB.TO', 0.4, { sector: 'Fixed Income' }),
      H('b', 'VFV.TO', 0.6, { sector: 'Equity' }),
    ])).toBeCloseTo(0.4, 10);
  });
});
