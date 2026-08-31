// optimize.js — ex-ante mean-variance optimization (max-Sharpe, long-only,
// optional per-holding cap). Pure math is separated from live data gathering
// so it can be reasoned about and tested without a network, same pattern as
// perf.js/risk.js.
//
// Expected returns and covariances are estimated from each instrument's own
// trailing monthly return history (arithmetic mean and sample covariance,
// annualized ×12) — these are historical estimates, NOT a forecast. Callers
// must say so; this module doesn't invent capital-market assumptions.
//
// Sharpe(w) = (w·c) / sqrt(w'Σw), where c = μ − rf, is not globally concave,
// but IS quasi-concave wherever w·c > 0 (a linear function divided by the
// square root of a positive-definite quadratic form). For a quasi-concave
// objective over a convex feasible set, every stationary point reached by a
// strictly-ascending method is the GLOBAL maximum — there are no bad local
// optima to get stuck in. That's what justifies using Frank-Wolfe here
// instead of a from-scratch QP/matrix-inversion solver: Frank-Wolfe only
// needs a linear-minimization step at each iteration (trivial to get right
// over a capped simplex — see capSimplexLMO), so it's far less likely to
// hide a subtle bug than hand-rolled KKT/matrix-inversion code, which
// matters for something feeding real investment decisions.

const PPY = 12;
const MIN_OBS = 3; // fewer monthly observations than this → mean/covariance is noise, exclude

function mean(a) {
  return a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0;
}

// Sample covariance over the months where BOTH series have data (pairwise-
// complete). Different instrument pairs may use different month sets when
// history lengths differ — a known, accepted limitation of pairwise-complete
// covariance estimation, not something this module tries to fully correct.
function pairwiseCov(retsA, retsB, months) {
  const xs = [], ys = [];
  for (const ym of months) {
    const a = retsA[ym], b = retsB[ym];
    if (a != null && b != null) { xs.push(a); ys.push(b); }
  }
  if (xs.length < 2) return { cov: null, n: xs.length };
  const mx = mean(xs), my = mean(ys);
  let s = 0;
  for (let i = 0; i < xs.length; i++) s += (xs[i] - mx) * (ys[i] - my);
  return { cov: s / (xs.length - 1), n: xs.length };
}

// Build annualized mu (expected return vector) and Sigma (covariance matrix)
// from per-instrument monthly return series. Instruments with fewer than
// MIN_OBS observations are excluded and reported separately.
export function buildMuSigma(ids, instReturns, grid) {
  const usable = [];
  const excluded = [];
  for (const id of ids) {
    const series = instReturns[id] || {};
    const n = grid.filter((ym) => series[ym] != null).length;
    if (n >= MIN_OBS) usable.push(id);
    else excluded.push({ id, reason: `only ${n} monthly observation${n === 1 ? '' : 's'} (need ${MIN_OBS}+)` });
  }

  const mu = {};
  for (const id of usable) {
    const rets = grid.map((ym) => instReturns[id][ym]).filter((r) => r != null);
    mu[id] = mean(rets) * PPY;
  }

  const sigma = {};
  for (const a of usable) {
    sigma[a] = {};
    for (const b of usable) {
      const { cov } = pairwiseCov(instReturns[a], instReturns[b], grid);
      sigma[a][b] = (cov ?? 0) * PPY;
    }
  }

  return { usable, excluded, mu, sigma };
}

function portfolioStats(w, ids, mu, sigma, rf) {
  const expectedReturn = ids.reduce((s, id) => s + w[id] * mu[id], 0);
  let variance = 0;
  for (const a of ids) for (const b of ids) variance += w[a] * sigma[a][b] * w[b];
  const volatility = Math.sqrt(Math.max(0, variance));
  const sharpe = volatility > 0 ? (expectedReturn - rf) / volatility : null;
  return { expectedReturn, volatility, sharpe };
}

// Linear-minimization oracle for a "capped simplex": maximize g·w subject to
// 0 <= w_i <= caps[id], sum(w) = 1. Greedy water-filling — give weight to the
// highest-g assets first, each up to its cap, until the budget of 1 is used.
// This is the textbook LMO for this feasible set: correct by a straightforward
// exchange argument (swapping any unit of weight from a lower-g asset to a
// higher-g one with spare capacity can only improve g·w).
function capSimplexLMO(g, ids, caps) {
  const order = [...ids].sort((a, b) => g[b] - g[a]);
  let remaining = 1;
  const w = {};
  for (const id of ids) w[id] = 0;
  for (const id of order) {
    if (remaining <= 1e-12) break;
    const take = Math.min(caps[id], remaining);
    w[id] = take;
    remaining -= take;
  }
  return w;
}

// Long-only, fully-invested max-Sharpe via Frank-Wolfe. `caps` optionally
// bounds each weight (default 1 = no effective cap beyond long-only+sum-to-1).
export function maxSharpePortfolio({ ids, mu, sigma, rf, caps, iterations = 1500 }) {
  if (!ids.length) throw new Error('No instruments with enough history to optimize');
  const cap = {};
  for (const id of ids) cap[id] = caps?.[id] ?? 1;
  const capSum = ids.reduce((s, id) => s + cap[id], 0);
  if (capSum < 1 - 1e-9) {
    throw new Error(`Weight caps too restrictive to reach 100% invested (caps sum to ${(capSum * 100).toFixed(1)}%)`);
  }

  // Start from the cap-respecting fill in id order — any feasible point works
  // as a Frank-Wolfe start; this one is cheap and deterministic.
  const zeroGrad = {}; for (const id of ids) zeroGrad[id] = 0;
  let w = capSimplexLMO(zeroGrad, ids, cap);

  for (let t = 1; t <= iterations; t++) {
    let variance = 0;
    const sigmaW = {};
    for (const a of ids) {
      let s = 0;
      for (const b of ids) s += sigma[a][b] * w[b];
      sigmaW[a] = s;
      variance += w[a] * s;
    }
    const sigmaVol = Math.sqrt(Math.max(1e-18, variance));
    const excessReturn = ids.reduce((s, id) => s + w[id] * (mu[id] - rf), 0);

    // Gradient of Sharpe(w) = (w·c)/sqrt(w'Σw) via the quotient rule, c = μ-rf.
    const grad = {};
    for (const id of ids) {
      grad[id] = (mu[id] - rf) / sigmaVol - (excessReturn * sigmaW[id]) / (sigmaVol ** 3);
    }

    const s = capSimplexLMO(grad, ids, cap);
    const gamma = 2 / (t + 2);
    const next = {};
    for (const id of ids) next[id] = w[id] + gamma * (s[id] - w[id]);
    w = next;
  }

  const stats = portfolioStats(w, ids, mu, sigma, rf);
  return { weights: w, ...stats };
}

// ---------- live orchestration ----------
export async function runOptimize(model, { getInstrument, getNavSeries, getHistory }, { gatherReturns, currentVersionOf }, opts = {}) {
  const rf = opts.rf ?? 0.04;
  const maxWeight = opts.maxWeight ?? null;

  const { grid, instReturns, instMeta, dataNotes } = await gatherReturns(model, { getInstrument, getNavSeries, getHistory });
  const cur = currentVersionOf(model);
  if (!cur) throw new Error('Model has no current version to optimize');

  const allIds = cur.holdings.map((h) => h.instrumentId);
  const { usable, excluded, mu, sigma } = buildMuSigma(allIds, instReturns, grid);

  if (usable.length < 2) {
    throw new Error('Not enough holdings with sufficient history to optimize (need at least 2)');
  }

  const caps = maxWeight != null ? Object.fromEntries(usable.map((id) => [id, maxWeight])) : null;
  const suggested = maxSharpePortfolio({ ids: usable, mu, sigma, rf, caps: caps || undefined });

  // "Current" portfolio, renormalized to the same usable universe so the
  // comparison is apples-to-apples with the suggestion.
  const curWByAll = Object.fromEntries(cur.holdings.map((h) => [h.instrumentId, h.weight]));
  const usedWeightSum = usable.reduce((s, id) => s + (curWByAll[id] || 0), 0);
  const curW = {};
  for (const id of usable) curW[id] = usedWeightSum > 0 ? (curWByAll[id] || 0) / usedWeightSum : 0;
  const current = portfolioStats(curW, usable, mu, sigma, rf);

  const holdings = usable.map((id) => {
    const meta = instMeta[id] || {};
    return {
      instrumentId: id, symbol: meta.symbol, name: meta.name, type: meta.type,
      expectedReturn: mu[id],
      currentWeight: curW[id],
      suggestedWeight: suggested.weights[id],
    };
  }).sort((a, b) => b.suggestedWeight - a.suggestedWeight);

  const excludedHoldings = excluded.map((e) => ({ ...e, symbol: instMeta[e.id]?.symbol }));

  return {
    key: model.key, rf, maxWeight,
    current: { weights: curW, ...current },
    suggested,
    holdings,
    excludedHoldings,
    excludedWeight: 1 - usedWeightSum,
    dataNotes,
  };
}
