// risk.test.js — a mix of hand-computable cases (constant series, self-vs-self
// benchmark) and cross-checks against an independent reimplementation of the
// same formula, rather than hand-typed decimal expectations that are easy to
// get subtly wrong. See perf.test.js's header note on how these were verified.
import { describe, it, expect } from 'vitest';
import { riskMetrics, staticPortfolioMonthly } from './risk.js';

describe('riskMetrics', () => {
  it('guards divide-by-zero: a zero-volatility series has null sharpe/sortino, not NaN or Infinity', () => {
    const flat = [0.01, 0.01, 0.01, 0.01, 0.01, 0.01];
    const m = riskMetrics(flat, flat.map(() => null), 0.04);
    expect(m.volatility).toBe(0);
    expect(m.sharpe).toBeNull();
  });

  it('annualizes geometrically: 6 months at a steady 1% compounds to the same total as 12 months at 1%', () => {
    const flat = [0.01, 0.01, 0.01, 0.01, 0.01, 0.01];
    const m = riskMetrics(flat, flat.map(() => null), 0.04);
    // growth over the 6 input months is 1.01^6; annualizing by ^(12/6) gives 1.01^12 overall.
    expect(m.annualizedReturn).toBeCloseTo(Math.pow(1.01, 12) - 1, 9);
  });

  it('sharpe/sortino are internally consistent with the other reported fields', () => {
    const rets = [0.02, -0.01, 0.03, 0.01, -0.02, 0.04];
    const m = riskMetrics(rets, rets.map(() => null), 0.04);
    expect(m.sharpe).toBeCloseTo((m.annualizedReturn - 0.04) / m.volatility, 9);

    const rfM = Math.pow(1.04, 1 / 12) - 1;
    const downs = rets.map((r) => Math.min(0, r - rfM));
    const dd = Math.sqrt(downs.reduce((s, d) => s + d * d, 0) / downs.length) * Math.sqrt(12);
    expect(m.downsideDeviation).toBeCloseTo(dd, 9);
  });

  it('reduces to textbook values when the benchmark equals the model itself', () => {
    const rets = [0.02, -0.01, 0.03, 0.01, -0.02, 0.04];
    const m = riskMetrics(rets, rets, 0.04);
    expect(m.beta).toBeCloseTo(1, 9);
    expect(m.correlation).toBeCloseTo(1, 9);
    expect(m.alpha).toBeCloseTo(0, 9);
    expect(m.trackingError).toBeCloseTo(0, 9);
  });

  it('max drawdown matches a hand-traced level path', () => {
    // returns +10%, -30%, +5% -> levels 1 -> 1.10 -> 0.77 -> 0.8085; peak 1.10, trough 0.77
    const m = riskMetrics([0.10, -0.30, 0.05], [null, null, null], 0.04);
    expect(m.maxDrawdown).toBeCloseTo(0.77 / 1.10 - 1, 9);
  });
});

describe('staticPortfolioMonthly', () => {
  it('renormalizes to whichever holdings have data that month', () => {
    const holdings = [{ ref: 'X', weight: 0.5 }, { ref: 'Y', weight: 0.5 }];
    const instReturnsByRef = {
      X: { '2024-02': 0.02, '2024-03': 0.04 },
      Y: { '2024-02': 0.00 }, // missing 2024-03 -> that month renormalizes to X alone
    };
    const grid = ['2024-01', '2024-02', '2024-03'];
    const out = staticPortfolioMonthly(holdings, instReturnsByRef, grid);
    expect(out.rets[0]).toBeCloseTo(0.5 * 0.02 + 0.5 * 0.00, 9); // both present
    expect(out.rets[1]).toBeCloseTo(0.04, 9); // only X present -> full weight on X
    expect(out.coverageMin).toBeCloseTo(0.5, 9); // worst month only had half the weight covered
  });
});
