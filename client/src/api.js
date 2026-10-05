// api.js — thin fetch wrappers + shared helpers used across views.
import { getSettings, saveSettings } from './settings.js';

async function j(url, opts) {
  let res;
  try {
    res = await fetch(url, opts);
  } catch (e) {
    if (e?.name === 'AbortError') throw e;
    throw new Error(e?.message || 'Network error');
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    const err = new Error(body.error || `HTTP ${res.status}`);
    if (body.code) err.code = body.code;
    if (body.retryAfterMs != null) err.retryAfterMs = body.retryAfterMs;
    if (body.needsTickerConfirm) err.needsTickerConfirm = true;
    if (body.detectedTicker) err.detectedTicker = body.detectedTicker;
    throw err;
  }
  return res.json();
}

export const api = {
  models: () => j('/api/models'),
  compare: () => j('/api/compare'),
  model: (key) => j(`/api/models/${key}`),
  modelQuotes: (key) => j(`/api/models/${key}/quotes`),
  performance: (key) => j(`/api/models/${key}/performance`),
  risk: (key, rf) => j(`/api/models/${key}/risk?rf=${rf}`),
  optimize: (key, { rf, maxWeight } = {}) =>
    j(`/api/models/${key}/optimize?rf=${rf}${maxWeight != null ? `&maxWeight=${maxWeight}` : ''}`),
  simulate: (key, body, opts = {}) => j(`/api/models/${key}/simulate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: opts.signal,
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
  instrumentDetail: (id, { range = '1y', rf = 4, refresh = false } = {}) =>
    j(`/api/instruments/${id}/detail?range=${range}&rf=${rf}${refresh ? '&refresh=1' : ''}`),
  factsheetSource: (id) => j(`/api/instruments/${id}/factsheet-source`),
  fetchBreakdown: (id) =>
    j(`/api/instruments/${id}/fetch-breakdown`, { method: 'POST' }),
  yahooSource: (id) => j(`/api/instruments/${id}/yahoo-source`),
  fetchYahooHistory: (id) =>
    j(`/api/instruments/${id}/fetch-yahoo-history`, { method: 'POST' }),
  applyYahooHistory: (id, body) =>
    j(`/api/instruments/${id}/apply-yahoo-history`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
    }),
  parsePriceText: (text, { instrumentId } = {}) =>
    j('/api/prices/parse-pdf', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, ...(instrumentId ? { instrumentId } : {}) }),
    }),
  parsePriceFile: async (file, { instrumentId } = {}) => {
    const fd = new FormData();
    fd.append('file', file, file.name || 'history.pdf');
    if (instrumentId) fd.append('instrumentId', instrumentId);
    const res = await fetch('/api/prices/parse-pdf', { method: 'POST', body: fd });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      const err = new Error(body.error || `HTTP ${res.status}`);
      if (body.needsTickerConfirm) err.needsTickerConfirm = true;
      throw err;
    }
    return res.json();
  },
  applyUploadedHistory: (id, body) =>
    j(`/api/instruments/${id}/apply-uploaded-history`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
    }),
  holdingHistory: (modelKey, id, { mode = 'since-added', rf = 4, refresh = false } = {}) =>
    j(`/api/models/${encodeURIComponent(modelKey)}/instruments/${id}/history?mode=${encodeURIComponent(mode)}&rf=${rf}${refresh ? '&refresh=1' : ''}`),
  // In-use non-cash names (manual + auto) with latest NAV + which models use them.
  manualInstruments: () => j('/api/instruments?inUse=1'),
  addNavBatch: (body) =>
    j('/api/nav/batch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  alerts: () => j('/api/alerts'),
  saveAlertSettings: (body) =>
    j('/api/alerts/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  runAlerts: () => j('/api/alerts/run', { method: 'POST' }),
  refreshAlertPrices: () => j('/api/alerts/refresh-prices', { method: 'POST' }),
  alertStatus: () => j('/api/alerts/status'),
  testAlertEmail: async () => {
    const res = await fetch('/api/alerts/test-email', { method: 'POST' });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || body.ok === false) {
      return { ok: false, error: body.error || body.message || `HTTP ${res.status}` };
    }
    return { ok: true, id: body.id || null };
  },
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

// Merge a /quotes payload onto a model already on screen. Returns the previous
// model unchanged when the payload is for a different key (stale response).
export function applyHoldingPrices(model, payload) {
  if (!model || !payload || model.key !== payload.key) return model;
  const byId = new Map((payload.holdings || []).map((h) => [h.id, h]));
  return {
    ...model,
    holdings: model.holdings.map((h) => {
      const q = byId.get(h.id);
      if (!q) return h;
      return {
        ...h,
        price: q.price,
        priceAsOf: q.priceAsOf,
        priceSource: q.priceSource,
        ...(q.metadataUpdated ? {
          name: q.name ?? h.name,
          sector: q.sector ?? h.sector,
          country: q.country ?? h.country,
        } : {}),
      };
    }),
  };
}

// Blended MER: weight-average of instrument MERs where known.
export function blendedMer(holdings) {
  let w = 0, sum = 0;
  for (const h of holdings) if (h.mer != null) { sum += h.weight * h.mer; w += h.weight; }
  return w > 0 ? sum / w : null;
}
