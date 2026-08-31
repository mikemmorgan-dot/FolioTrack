// optimize.test.js — see perf.test.js's header note on verification method.
// portfolioStats is re-derived locally (not imported) as an intentionally
// independent cross-check, rather than importing the module's own private
// helper, which would just be circular.
import { describe, it, expect } from 'vitest';
import { buildMuSigma, maxSharpePortfolio } from './optimize.js';

function recomputeStats(w, ids, mu, sigma, rf) {
  const expectedReturn = ids.reduce((s, id) => s + w[id] * mu[id], 0);
  let variance = 0;
  for (const a of ids) for (const b of ids) variance += w[a] * sigma[a][b] * w[b];
  const volatility = Math.sqrt(Math.max(0, variance));
  return { expectedReturn, volatility, sharpe: volatility > 0 ? (expectedReturn - rf) / volatility : null };
}

describe('buildMuSigma', () => {
  it('annualizes mean and sample covariance from monthly return series', () => {
    const grid = ['2024-01', '2024-02', '2024-03', '2024-04'];
    const instReturns = {
      X: { '2024-02': 0.02, '2024-03': 0.04, '2024-04': 0.00 },
      Y: { '2024-02': 0.01, '2024-03': -0.01, '2024-04': 0.02 },
    };
    const { usable, mu, sigma } = buildMuSigma(['X', 'Y'], instReturns, grid);
    expect(usable).toEqual(['X', 'Y']);

    const mx = (0.02 + 0.04 + 0.00) / 3, my = (0.01 - 0.01 + 0.02) / 3;
    expect(mu.X).toBeCloseTo(mx * 12, 9);
    expect(mu.Y).toBeCloseTo(my * 12, 9);

    const xs = [0.02, 0.04, 0.00], ys = [0.01, -0.01, 0.02];
    const sampleCov = xs.reduce((s, x, i) => s + (x - mx) * (ys[i] - my), 0) / (3 - 1);
    expect(sigma.X.Y).toBeCloseTo(sampleCov * 12, 9);
    expect(sigma.X.Y).toBeCloseTo(sigma.Y.X, 12); // symmetric
  });

  it('excludes instruments with fewer than 3 monthly observations', () => {
    const grid = ['2024-01', '2024-02', '2024-03'];
    const instReturns = { X: { '2024-02': 0.02 } }; // only 1 observation
    const { usable, excluded } = buildMuSigma(['X'], instReturns, grid);
    expect(usable).toEqual([]);
    expect(excluded[0].id).toBe('X');
  });
});

describe('maxSharpePortfolio', () => {
  const mu = { A: 0.10, B: 0.02 };
  const sigma = { A: { A: 0.04, B: 0.01 }, B: { A: 0.01, B: 0.02 } };

  it('puts long-only weight on the asset with positive excess return, ~0 on the one without', () => {
    // rf=0.04: A's excess return is +0.06, B's is -0.02 -- a long-only optimizer
    // can't short B to exploit that, so it should hold none of it.
    const res = maxSharpePortfolio({ ids: ['A', 'B'], mu, sigma, rf: 0.04 });
    expect(res.weights.A + res.weights.B).toBeCloseTo(1, 6);
    expect(res.weights.B).toBeLessThan(1e-3);
  });

  it('reported stats match an independent recomputation from the returned weights', () => {
    const res = maxSharpePortfolio({ ids: ['A', 'B'], mu, sigma, rf: 0.04 });
    const recompute = recomputeStats(res.weights, ['A', 'B'], mu, sigma, 0.04);
    expect(res.sharpe).toBeCloseTo(recompute.sharpe, 9);
    expect(res.volatility).toBeCloseTo(recompute.volatility, 9);
  });

  it('the optimum is never worse than an arbitrary feasible point (50/50)', () => {
    // Weak but important sanity property: since 50/50 is itself feasible, the
    // true optimum's Sharpe can't be lower than it, whatever the exact solver does.
    const res = maxSharpePortfolio({ ids: ['A', 'B'], mu, sigma, rf: 0.04 });
    const fiftyFifty = recomputeStats({ A: 0.5, B: 0.5 }, ['A', 'B'], mu, sigma, 0.04);
    expect(res.sharpe).toBeGreaterThanOrEqual(fiftyFifty.sharpe - 1e-9);
  });

  it('respects a per-holding weight cap exactly, forcing the remainder elsewhere', () => {
    const res = maxSharpePortfolio({ ids: ['A', 'B'], mu, sigma, rf: 0.04, caps: { A: 0.3, B: 1 } });
    expect(res.weights.A).toBeCloseTo(0.3, 6);
    expect(res.weights.B).toBeCloseTo(0.7, 6);
  });

  it('throws a clear error when caps cannot reach 100% invested', () => {
    expect(() => maxSharpePortfolio({
      ids: ['A', 'B'],
      mu: { A: 0.1, B: 0.1 },
      sigma: { A: { A: 0.01, B: 0 }, B: { A: 0, B: 0.01 } },
      rf: 0.04,
      caps: { A: 0.2, B: 0.2 },
    })).toThrow(/too restrictive/);
  });
});
