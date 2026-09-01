// api.js — thin fetch wrappers + shared helpers used across views.
import { getSettings, saveSettings } from './settings.js';

async function j(url, opts) {
  const res = await fetch(url, opts);
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`);
  return res.json();
}

export const api = {
  models: () => j('/api/models'),
  model: (key) => j(`/api/models/${key}`),
  performance: (key) => j(`/api/models/${key}/performance`),
  risk: (key, rf) => j(`/api/models/${key}/risk?rf=${rf}`),
  optimize: (key, { rf, maxWeight } = {}) =>
    j(`/api/models/${key}/optimize?rf=${rf}${maxWeight != null ? `&maxWeight=${maxWeight}` : ''}`),
  simulate: (key, body) => j(`/api/models/${key}/simulate`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  }),
  lookup: (symbol) => j(`/api/lookup/${encodeURIComponent(symbol)}`),
  history: (symbol, range = '1y') => j(`/api/history/${encodeURIComponent(symbol)}?range=${range}`),
  addVersion: (key, body) =>
    j(`/api/models/${key}/versions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  updateInstrument: (id, patch) =>
    j(`/api/instruments/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    }),
  instrumentDetail: (id, { range = '1y', rf = 4 } = {}) =>
    j(`/api/instruments/${id}/detail?range=${range}&rf=${rf}`),
};

// ---- formatting ----
export const pct = (x, d = 1) => (x == null ? '—' : `${(x * 100).toFixed(d)}%`);
export const signedPct = (x, d = 1) => (x == null ? '—' : `${x >= 0 ? '+' : ''}${(x * 100).toFixed(d)}%`);
export const money = (x, ccy = 'CAD') =>
  x == null ? '—' : new Intl.NumberFormat('en-CA', { style: 'currency', currency: ccy, maximumFractionDigits: 2 }).format(x);
export const num = (x, d = 2) => (x == null ? '—' : Number(x).toFixed(d));

// A tangible reference basis: show every model as if this amount were
// invested. User-editable in Settings (persisted per device); `export let`
// keeps existing `import { BASIS }` call sites working — ES module bindings
// are live, so importers see the new value on their next render.
export let BASIS = getSettings().basis;
export function setBasis(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return BASIS;
  BASIS = n;
  saveSettings({ basis: n });
  return BASIS;
}

// ---- aggregation helpers (weighted by model target weight) ----
export function aggregateBy(holdings, field) {
  const map = new Map();
  for (const h of holdings) {
    const k = h[field] || 'Unclassified';
    map.set(k, (map.get(k) || 0) + h.weight);
  }
  return [...map.entries()].map(([label, weight]) => ({ label, weight })).sort((a, b) => b.weight - a.weight);
}

// Sector/country aggregation with fund look-through: a holding carrying a
// {label,weight}[] breakdown (entered from its factsheet — see HoldingsTab)
// distributes its model weight across that breakdown instead of counting as
// one bucket. Breakdown weights are normalized by their own sum, so a
// slightly-off-100% factsheet entry still distributes proportionally.
export function aggregateLookThrough(holdings, kind) {
  const breakdownField = kind === 'sector' ? 'sectorBreakdown' : 'countryBreakdown';
  const map = new Map();
  for (const h of holdings) {
    const bd = h[breakdownField];
    if (Array.isArray(bd) && bd.length) {
      const total = bd.reduce((s, r) => s + (Number(r.weight) || 0), 0) || 1;
      for (const r of bd) {
        const k = r.label || 'Unclassified';
        map.set(k, (map.get(k) || 0) + h.weight * ((Number(r.weight) || 0) / total));
      }
    } else {
      const k = h[kind] || 'Unclassified';
      map.set(k, (map.get(k) || 0) + h.weight);
    }
  }
  return [...map.entries()].map(([label, weight]) => ({ label, weight })).sort((a, b) => b.weight - a.weight);
}

const TYPE_LABELS = { stock: 'Individual Stocks', etf: 'ETFs', mutualfund: 'Mutual Funds', alt: 'Alternatives', cash: 'Cash' };
export const typeLabel = (t) => TYPE_LABELS[t] || t;

// Asset-type palette — drives circular icons and the allocation bar.
export const TYPE_COLORS = {
  stock: '#5B8DEF',
  etf: '#2DD4A7',
  mutualfund: '#E5A84B',
  alt: '#B98AF0',
  cash: '#8A8F98',
};
export const typeColor = (t) => TYPE_COLORS[t] || '#8A8F98';

// Blended MER: weight-average of instrument MERs where known.
export function blendedMer(holdings) {
  let w = 0, sum = 0;
  for (const h of holdings) if (h.mer != null) { sum += h.weight * h.mer; w += h.weight; }
  return w > 0 ? sum / w : null;
}
