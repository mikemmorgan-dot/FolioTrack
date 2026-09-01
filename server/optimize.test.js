// optimize.test.js — see perf.test.js's header note on verification method.
// portfolioStats is re-derived locally (not imported) as an intentionally
// independent cross-check, rather than importing the module's own private
// helper, which would just be circular.
import { describe, it, expect } from 'vitest';
import { buildMuSigma, maxSharpePortfolio } from './optimize.js';

// Matches optimize.js's own portfolioStats: unallocated weight (1-sum(w)) is
// idle cash earning rf, not 0% — see that function's header comment for why
// this specific correction matters (a real bug, caught by testing, is
// documented there: the naive `expectedReturn - rf` formula silently worked
// while sum(w) was always 1, then produced a nonsensical negative Sharpe the
// moment caps could leave weight unallocated).
function recomputeStats(w, ids, mu, sigma, rf) {
  const investedReturn = ids.reduce((s, id) => s + w[id] * mu[id], 0);
  const totalW = ids.reduce((s, id) => s + w[id], 0);
  const expectedReturn = investedReturn + rf * Math.max(0, 1 - totalW);
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

  it('respects a per-holding weight cap, and leaves the rest as cash rather than forcing it into a negative-excess-return asset', () => {
    // B has negative excess return (mu=0.02 < rf=0.04) -- capping A at 30%
    // should NOT force the other 70% into B just to reach 100%; it should
    // sit uninvested (implicit cash, earning rf) instead.
    const res = maxSharpePortfolio({ ids: ['A', 'B'], mu, sigma, rf: 0.04, caps: { A: 0.3, B: 1 } });
    expect(res.weights.A).toBeCloseTo(0.3, 6);
    expect(res.weights.B).toBeLessThan(1e-3);
    expect(res.cashWeight).toBeCloseTo(0.7, 6);
  });

  it('a restrictive cap across many positive-excess assets invests what it can and leaves cash, instead of erroring', () => {
    // Regression test for a real bug: 8 assets, all positive excess return,
    // each capped at 10% (so caps sum to only 80%). The naive portfolioStats
    // formula (expectedReturn - rf, ignoring that only part of the portfolio
    // is invested) produced a nonsensical NEGATIVE Sharpe here before the
    // fix -- verified in a real JS engine outside this repo, matching
    // perf.test.js's header note -- even though every single asset has
    // mu > rf. Fixed formula gives Sharpe ~0.89, genuinely better than the
    // best single-asset alternative (holding just the top asset at its 10%
    // cap alone gives Sharpe 0.65) -- confirming this isn't just "no longer
    // negative" but actually a good, verifiably-superior answer.
    const ids = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'];
    const mu8 = {}; const sigma8 = {};
    ids.forEach((id, i) => { mu8[id] = 0.10 + i * 0.01; sigma8[id] = {}; }); // 0.10..0.17, rf=0.04 -> all positive excess
    ids.forEach((a) => ids.forEach((b) => { sigma8[a][b] = a === b ? 0.04 : 0.01; }));
    const caps8 = Object.fromEntries(ids.map((id) => [id, 0.10]));

    const res = maxSharpePortfolio({ ids, mu: mu8, sigma: sigma8, rf: 0.04, caps: caps8 });
    expect(res.sharpe).not.toBeNull();
    expect(res.sharpe).toBeGreaterThan(0);

    const totalW = ids.reduce((s, id) => s + res.weights[id], 0);
    expect(totalW).toBeLessThanOrEqual(0.80 + 1e-6); // never exceeds what the caps allow
    ids.forEach((id) => expect(res.weights[id]).toBeLessThanOrEqual(0.10 + 1e-6));

    // beats the best single-asset alternative (H alone, at its cap, rest cash)
    const altW = Object.fromEntries(ids.map((id) => [id, 0])); altW.H = 0.10;
    const altStats = recomputeStats(altW, ids, mu8, sigma8, 0.04);
    expect(res.sharpe).toBeGreaterThan(altStats.sharpe);
  });
});
