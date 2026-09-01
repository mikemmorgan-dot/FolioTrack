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

// Unallocated weight (1 - sum(w)) is idle cash — the standard Sharpe-ratio
// assumption is that it earns the risk-free rate, not 0%, so it's added into
// expectedReturn here. This makes `expectedReturn - rf` correctly scale by
// how much is actually AT RISK: expectedReturn - rf = investedReturn -
// rf*sum(w), not investedReturn - rf outright — critical once sum(w) can be
// < 1 (a capped optimization that can't fully deploy). Caught by testing:
// with sum(w)=1 always (true before caps could leave weight unallocated),
// rf and rf*sum(w) were identical, so this was silently correct by
// coincidence until the cap relaxation made the difference matter — an
// 8-holding, 10%-capped, fully-positive-excess-return test case produced a
// nonsensical negative Sharpe before this fix, positive 0.89 after, and
// verified better than the single-best-asset alternative (0.65).
function portfolioStats(w, ids, mu, sigma, rf) {
  const investedReturn = ids.reduce((s, id) => s + w[id] * mu[id], 0);
  const totalW = ids.reduce((s, id) => s + w[id], 0);
  const cashWeight = Math.max(0, 1 - totalW);
  const expectedReturn = investedReturn + rf * cashWeight;
  let variance = 0;
  for (const a of ids) for (const b of ids) variance += w[a] * sigma[a][b] * w[b]; // cash: 0 variance, 0 covariance
  const volatility = Math.sqrt(Math.max(0, variance));
  const sharpe = volatility > 0 ? (expectedReturn - rf) / volatility : null;
  return { expectedReturn, volatility, sharpe, cashWeight };
}

// Linear-minimization oracle for a "capped simplex": maximize g·w subject to
// 0 <= w_i <= caps[id], sum(w) <= 1 (NOT '='  — see below). Greedy water-
// filling — give weight to the highest-g assets first, each up to its cap,
// until the budget of 1 is used. Correct by a straightforward exchange
// argument (swapping any unit of weight from a lower-g asset to a higher-g
// one with spare capacity can only improve g·w).
//
// sum(w) <= 1 rather than = 1: leaving weight unallocated is exactly
// equivalent to holding it in a zero-return, zero-variance cash position —
// it drops out of both w·mu and w'Σw the same way either way. So when
// `stopAtNonPositive` is set, the fill stops as soon as the next-best asset's
// gradient turns non-positive, rather than being forced into it just to
// reach 100%. This is what lets a restrictive cap (e.g. a 10% cap across
// fewer than 10 holdings) degrade to "invest what the caps allow, leave the
// rest as cash" instead of failing outright.
function capSimplexLMO(g, ids, caps, stopAtNonPositive) {
  const order = [...ids].sort((a, b) => g[b] - g[a]);
  let remaining = 1;
  const w = {};
  for (const id of ids) w[id] = 0;
  for (const id of order) {
    if (remaining <= 1e-12) break;
    if (stopAtNonPositive && g[id] <= 0) break;
    const take = Math.min(caps[id], remaining);
    w[id] = take;
    remaining -= take;
  }
  return w;
}

// Long-only max-Sharpe via Frank-Wolfe, up to fully invested. `caps`
// optionally bounds each weight (default 1 = no effective cap). Any capacity
// caps can't place into a positive-excess-return asset is left unallocated
// (implicit cash) rather than erroring — see capSimplexLMO.
export function maxSharpePortfolio({ ids, mu, sigma, rf, caps, iterations = 1500 }) {
  if (!ids.length) throw new Error('No instruments with enough history to optimize');
  const cap = {};
  for (const id of ids) cap[id] = caps?.[id] ?? 1;

  // Start fully invested in id order regardless of gradient sign — any
  // feasible point works as a Frank-Wolfe start, and starting from an
  // all-zero point (which stopAtNonPositive would give from a flat initial
  // gradient) makes the first real gradient numerically degenerate.
  const zeroGrad = {}; for (const id of ids) zeroGrad[id] = 0;
  let w = capSimplexLMO(zeroGrad, ids, cap, false);

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

    const s = capSimplexLMO(grad, ids, cap, true);
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
    suggested, // suggested.cashWeight is already set by maxSharpePortfolio -> portfolioStats
    holdings,
    excludedHoldings,
    excludedWeight: 1 - usedWeightSum,
    dataNotes,
  };
}
