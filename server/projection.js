// projection.js — pre-trade comparison of two static weight vectors.
// Pure: the route gathers history, then this computes metrics, deltas, and
// how much of the proposed weight the history actually covers.

import { hasUsableReturns, riskMetrics, staticPortfolioMonthly } from './risk.js';

export { hasUsableReturns };

const DELTA_KEYS = ['sharpe', 'sortino', 'informationRatio', 'volatility', 'maxDrawdown', 'beta', 'trackingError', 'annualizedReturn'];

// Share of proposed weight whose history contributes at least one monthly return.
// Names with a single price point are not covered.
export function projectionCoverage(holdings, returnsByRef) {
  const list = holdings || [];
  const total = list.reduce((s, h) => s + (Number(h.weight) || 0), 0);
  let covered = 0;
  const missing = [];
  for (const h of list) {
    const w = Number(h.weight) || 0;
    if (hasUsableReturns(returnsByRef?.[h.ref])) covered += w;
    else missing.push(h.symbol || h.ref);
  }
  return {
    coveredWeight: covered,
    totalWeight: total,
    coverage: total > 0 ? covered / total : 0,
    missing,
  };
}

export function newHoldingProjectionStatus(holding, returnsByRef) {
  if (!holding) return null;
  const covered = hasUsableReturns(returnsByRef?.[holding.ref]);
  let reason = 'ok';
  if (!covered) {
    const nav = Number(holding.initialNav?.nav);
    reason = Number.isFinite(nav) ? 'insufficient' : 'no-history';
  }
  return {
    symbol: holding.symbol || holding.ref,
    covered,
    reason,
  };
}

export function compareStaticRisk({
  baseline,
  proposed,
  returnsByRef,
  grid,
  benchMonthly = {},
  rf = 0.04,
}) {
  const baseSeries = staticPortfolioMonthly(baseline || [], returnsByRef || {}, grid || []);
  const propSeries = staticPortfolioMonthly(proposed || [], returnsByRef || {}, grid || []);
  const alignBench = (months) => months.map((ym) => (benchMonthly[ym] ?? null));
  const baseMetrics = riskMetrics(baseSeries.rets, alignBench(baseSeries.months), rf);
  const propMetrics = riskMetrics(propSeries.rets, alignBench(propSeries.months), rf);
  const deltas = {};
  for (const k of DELTA_KEYS) {
    const a = baseMetrics[k];
    const b = propMetrics[k];
    deltas[k] = a != null && b != null ? b - a : null;
  }
  const coverage = projectionCoverage(proposed, returnsByRef);
  return {
    baseline: { metrics: baseMetrics, coverageMin: baseSeries.coverageMin },
    proposed: { metrics: propMetrics, coverageMin: propSeries.coverageMin },
    deltas,
    coverage: coverage.coverage,
    coverageDetail: coverage,
    unresolved: coverage.missing,
  };
}
