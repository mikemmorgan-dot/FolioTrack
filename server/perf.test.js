// perf.test.js — hand-verified against the pure functions themselves (see the
// commit message for how these expected values were checked: run once in a
// real JS engine outside this repo before being written here, since no local
// Node was available in the environment that wrote this suite).
import { describe, it, expect } from 'vitest';
import { monthGrid, levelsOnGrid, monthlyReturnsFromLevels, computeCore } from './perf.js';

describe('monthGrid', () => {
  it('lists every YYYY-MM from start to end inclusive, across a year boundary', () => {
    expect(monthGrid('2024-11', '2025-02')).toEqual(['2024-11', '2024-12', '2025-01', '2025-02']);
  });
});

describe('levelsOnGrid + monthlyReturnsFromLevels', () => {
  it('forward-fills the last observation onto each grid month', () => {
    const obs = [{ date: '2024-01-15', value: 100 }, { date: '2024-03-10', value: 110 }];
    const grid = monthGrid('2024-01', '2024-04');
    const levels = levelsOnGrid(obs, grid);
    expect(levels).toEqual({ '2024-01': 100, '2024-02': 100, '2024-03': 110, '2024-04': 110 });

    const rets = monthlyReturnsFromLevels(levels, grid);
    expect(rets['2024-02']).toBeCloseTo(0, 9);
    expect(rets['2024-03']).toBeCloseTo(0.10, 9);
    expect(rets['2024-04']).toBeCloseTo(0, 9);
  });
});

describe('computeCore', () => {
  // Two versions: v1 holds A from 2024-01, v2 switches to B from 2024-03.
  // Return grid starts once the model has any return (Feb, since Jan is the
  // basis month with no prior level to compare against).
  const versions = [
    { effectiveDate: '2024-01-01', holdings: [{ instrumentId: 'A', weight: 1 }] },
    { effectiveDate: '2024-03-01', holdings: [{ instrumentId: 'B', weight: 1 }] },
  ];
  const instReturns = {
    A: { '2024-02': 0.02, '2024-03': 0.01, '2024-04': 0.03 },
    B: { '2024-02': -0.01, '2024-03': 0.05, '2024-04': 0.02 },
  };
  const grid = monthGrid('2024-01', '2024-04');
  const core = computeCore({
    grid, versions, instReturns, benchMonthly: {},
    instMeta: { B: { symbol: 'B', name: 'Instrument B', type: 'stock' } },
    basis: 10000, today: '2024-04-15',
  });

  it('chains returns across a version switch (holds A through Feb, B from Mar)', () => {
    const expectedTotal = 1.02 * 1.05 * 1.02 - 1; // Feb under v1(A), Mar+Apr under v2(B)
    expect(core.model.totalReturn).toBeCloseTo(expectedTotal, 9);
  });

  it('does not annualize under a full 12 months of data', () => {
    expect(core.model.annualized).toBeNull();
  });

  it('computes change attribution as actual (new mix) vs counterfactual (prior mix), same window', () => {
    const expectedActual = 1.05 * 1.02 - 1; // B held Mar+Apr
    const expectedCounter = 1.01 * 1.03 - 1; // A held over the same window
    expect(core.changes[0].actual).toBeCloseTo(expectedActual, 9);
    expect(core.changes[0].counterfactual).toBeCloseTo(expectedCounter, 9);
    expect(core.changes[0].valueAdded).toBeCloseTo(expectedActual - expectedCounter, 9);
  });

  it('computes contribution as weight-scaled arithmetic sum over the current window', () => {
    expect(core.contribution.total).toBeCloseTo(0.07, 9); // 1*0.05 + 1*0.02
    expect(core.contribution.items[0].ret).toBeCloseTo(1.05 * 1.02 - 1, 9); // compounded, not arithmetic
  });
});
