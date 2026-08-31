// riskFormat.js — how each risk metric is displayed and which direction is "better".
export const asRatio = (x, d = 2) => (x == null ? '—' : x.toFixed(d));
export const asPct = (x, d = 1) => (x == null ? '—' : `${(x * 100).toFixed(d)}%`);
export const asPctSigned = (x, d = 1) => (x == null ? '—' : `${x >= 0 ? '+' : ''}${(x * 100).toFixed(d)}%`);

// good: +1 → higher is better, -1 → lower is better, 0 → neutral
export const METRIC_DEFS = {
  sharpe: { label: 'Sharpe', fmt: asRatio, good: 1 },
  sortino: { label: 'Sortino', fmt: asRatio, good: 1 },
  informationRatio: { label: 'Info ratio', fmt: asRatio, good: 1 },
  volatility: { label: 'Volatility', fmt: asPct, good: -1 },
  maxDrawdown: { label: 'Max drawdown', fmt: asPct, good: 1 }, // less negative is better
  beta: { label: 'Beta', fmt: asRatio, good: 0 },
  alpha: { label: 'Alpha (ann.)', fmt: asPctSigned, good: 1 },
  trackingError: { label: 'Tracking error', fmt: asPct, good: 0 },
  upCapture: { label: 'Up capture', fmt: asPct, good: 1 },
  downCapture: { label: 'Down capture', fmt: asPct, good: -1 },
  correlation: { label: 'Correlation', fmt: asRatio, good: 0 },
  annualizedReturn: { label: 'Return (ann.)', fmt: asPctSigned, good: 1 },
};

// class for a delta given the metric's good-direction
export function deltaClass(key, delta) {
  if (delta == null) return 'muted';
  const g = METRIC_DEFS[key]?.good ?? 0;
  if (g === 0 || Math.abs(delta) < 1e-9) return 'muted';
  return (g > 0) === (delta > 0) ? 'pos' : 'neg';
}
