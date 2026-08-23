// api.js — thin fetch wrappers + shared helpers used across views.

async function j(url, opts) {
  const res = await fetch(url, opts);
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`);
  return res.json();
}

export const api = {
  models: () => j('/api/models'),
  model: (key) => j(`/api/models/${key}`),
  history: (symbol, range = '1y') => j(`/api/history/${encodeURIComponent(symbol)}?range=${range}`),
  addVersion: (key, body) =>
    j(`/api/models/${key}/versions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
};

// ---- formatting ----
export const pct = (x, d = 1) => (x == null ? '—' : `${(x * 100).toFixed(d)}%`);
export const money = (x, ccy = 'CAD') =>
  x == null ? '—' : new Intl.NumberFormat('en-CA', { style: 'currency', currency: ccy, maximumFractionDigits: 2 }).format(x);
export const num = (x, d = 2) => (x == null ? '—' : Number(x).toFixed(d));

// A tangible reference basis: show every model as if $10,000 were invested.
export const BASIS = 10000;

// ---- aggregation helpers (weighted by model target weight) ----
export function aggregateBy(holdings, field) {
  const map = new Map();
  for (const h of holdings) {
    const k = h[field] || 'Unclassified';
    map.set(k, (map.get(k) || 0) + h.weight);
  }
  return [...map.entries()].map(([label, weight]) => ({ label, weight })).sort((a, b) => b.weight - a.weight);
}

const TYPE_LABELS = { stock: 'Individual Stocks', etf: 'ETFs', mutualfund: 'Mutual Funds', alt: 'Alternatives' };
export const typeLabel = (t) => TYPE_LABELS[t] || t;

// Blended MER: weight-average of instrument MERs where known.
export function blendedMer(holdings) {
  let w = 0, sum = 0;
  for (const h of holdings) if (h.mer != null) { sum += h.weight * h.mer; w += h.weight; }
  return w > 0 ? sum / w : null;
}
