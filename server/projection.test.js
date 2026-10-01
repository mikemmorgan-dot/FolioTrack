import { describe, it, expect, vi } from 'vitest';
import { monthGrid, returnsForRefs } from './perf.js';
import {
  compareStaticRisk,
  newHoldingProjectionStatus,
  projectionCoverage,
} from './projection.js';

const grid = [
  '2023-01', '2023-02', '2023-03', '2023-04', '2023-05', '2023-06',
  '2023-07', '2023-08', '2023-09', '2023-10', '2023-11', '2023-12', '2024-01',
];

function monthly(vals) {
  const o = {};
  vals.forEach((v, i) => { o[grid[i + 1]] = v; });
  return o;
}

const steady = monthly([0.01, 0.012, 0.009, 0.011, 0.01, 0.013, 0.008, 0.01, 0.011, 0.009, 0.012, 0.01]);
const wild = monthly([0.08, -0.06, 0.07, -0.05, 0.09, -0.04, 0.06, -0.07, 0.05, -0.03, 0.08, -0.02]);

describe('projectionCoverage', () => {
  it('reports the share of weight that has usable history', () => {
    const holdings = [
      { ref: 'A', symbol: 'VFV', weight: 0.5 },
      { ref: 'B', symbol: 'AVGO', weight: 0.3 },
      { ref: 'C', symbol: 'RBF608', weight: 0.2 },
    ];
    const cov = projectionCoverage(holdings, { A: steady, B: wild });
    expect(cov.coverage).toBeCloseTo(0.8, 10);
    expect(cov.missing).toEqual(['RBF608']);
    expect(Math.round(cov.coverage * 100)).toBe(80);
  });

  it('does not count a single-point series as covered', () => {
    const thin = monthGrid('2024-01', '2024-06');
    const onlyNulls = {};
    for (let i = 1; i < thin.length; i++) onlyNulls[thin[i]] = null;
    const cov = projectionCoverage(
      [{ ref: 'AVGO', symbol: 'AVGO', weight: 1 }],
      { AVGO: onlyNulls },
    );
    expect(cov.coverage).toBe(0);
    expect(cov.missing).toEqual(['AVGO']);
  });
});

describe('compareStaticRisk with a hypothetical holding', () => {
  it('moves sharpe when the new holding has a different history', () => {
    const out = compareStaticRisk({
      baseline: [{ ref: 'A', symbol: 'VFV', weight: 1 }],
      proposed: [
        { ref: 'A', symbol: 'VFV', weight: 0.7 },
        { ref: 'AVGO', symbol: 'AVGO', weight: 0.3, hypothetical: true },
      ],
      returnsByRef: { A: steady, AVGO: wild },
      grid,
      rf: 0.04,
    });
    expect(out.deltas.sharpe).not.toBe(0);
    expect(out.deltas.sharpe).not.toBeNull();
    expect(out.deltas.volatility).not.toBe(0);
    expect(out.coverage).toBeCloseTo(1, 10);
    expect(out.unresolved).toEqual([]);
    expect(newHoldingProjectionStatus(
      { ref: 'AVGO', symbol: 'AVGO', hypothetical: true },
      { AVGO: wild },
    ).covered).toBe(true);
  });

  it('leaves a zero delta and an uncovered new name when that name has no history', () => {
    const out = compareStaticRisk({
      baseline: [{ ref: 'A', symbol: 'VFV', weight: 1 }],
      proposed: [
        { ref: 'A', symbol: 'VFV', weight: 0.8 },
        { ref: 'AVGO', symbol: 'AVGO', weight: 0.2, hypothetical: true },
      ],
      returnsByRef: { A: steady },
      grid,
      rf: 0.04,
    });
    expect(out.deltas.sharpe).toBe(0);
    expect(out.coverage).toBeCloseTo(0.8, 10);
    expect(out.unresolved).toEqual(['AVGO']);
    const status = newHoldingProjectionStatus(
      { ref: 'AVGO', symbol: 'AVGO', hypothetical: true },
      {},
    );
    expect(status).toEqual({ symbol: 'AVGO', covered: false, reason: 'no-history' });
  });

  it('calls a single entered NAV insufficient rather than a real history', () => {
    const status = newHoldingProjectionStatus(
      { ref: 'AVGO', symbol: 'AVGO', hypothetical: true, initialNav: { date: '2026-10-01', nav: 348 } },
      {},
    );
    expect(status.covered).toBe(false);
    expect(status.reason).toBe('insufficient');
  });
});

describe('returnsForRefs hypothetical history', () => {
  it('pulls a new auto ticker through getHistory and keeps a series that has returns', async () => {
    const g = monthGrid('2024-01', '2024-04');
    const getHistory = vi.fn(async () => ({
      series: [
        { date: '2024-01-31', close: 100 },
        { date: '2024-02-29', close: 110 },
        { date: '2024-03-29', close: 105 },
      ],
    }));
    const out = await returnsForRefs(
      [{ ref: 'AVGO', symbol: 'AVGO', source: 'auto' }],
      { getHistory, getNavSeries: async () => [] },
      g,
    );
    expect(getHistory).toHaveBeenCalledWith('AVGO', '5y');
    expect(out.AVGO).toBeTruthy();
    expect(Object.values(out.AVGO).some((r) => r != null)).toBe(true);
  });

  it('does not call the live history path for a single manual NAV, and leaves it uncovered', async () => {
    const g = monthGrid('2024-01', '2024-06');
    const getHistory = vi.fn(async () => ({
      series: [
        { date: '2024-01-31', close: 100 },
        { date: '2024-03-29', close: 110 },
      ],
    }));
    const out = await returnsForRefs(
      [{
        ref: 'AVGO',
        symbol: 'AVGO',
        source: 'manual',
        initialNav: { date: '2026-10-01', nav: 348 },
      }],
      { getHistory, getNavSeries: async () => [] },
      g,
    );
    expect(getHistory).not.toHaveBeenCalled();
    expect(out.AVGO).toBeUndefined();
  });
});
