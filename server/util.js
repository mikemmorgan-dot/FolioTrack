// util.js — pure helpers shared across storage backends and routes.

export function uid(prefix) {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36).slice(-4)}`;
}

export function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

// Given a model with versions[], return the one in effect today (latest
// effective_date <= today), falling back to the earliest if all are future.
export function currentVersionOf(model) {
  if (!model || !model.versions?.length) return null;
  const today = todayISO();
  const applicable = model.versions
    .filter((v) => v.effectiveDate <= today)
    .sort((a, b) => a.effectiveDate.localeCompare(b.effectiveDate));
  if (applicable.length) return applicable[applicable.length - 1];
  return [...model.versions].sort((a, b) => a.effectiveDate.localeCompare(b.effectiveDate))[0];
}

// Normalize a holding spec into an instrument shape for upsert.
export function instrumentFromSpec(spec) {
  return {
    symbol: (spec.symbol || '').trim(),
    name: spec.name || spec.symbol || 'Unnamed',
    type: spec.type || 'stock',
    source: spec.source || 'auto',
    currency: spec.currency || 'CAD',
    sector: spec.sector || null,
    country: spec.country || null,
    mer: spec.mer ?? null,
    sectorBreakdown: spec.sectorBreakdown || null,
    countryBreakdown: spec.countryBreakdown || null,
  };
}

// True if two holdings lists reference the same instruments at the same
// weights (order-independent, small float tolerance for the /100 and *100
// round-trip the client does on every save). Used to reject a save that
// wouldn't actually change anything — see addVersion in both stores.
export function holdingsEqual(a, b, eps = 1e-6) {
  if (a.length !== b.length) return false;
  const remaining = new Map(a.map((h) => [h.instrumentId, h.weight]));
  for (const h of b) {
    if (!remaining.has(h.instrumentId)) return false;
    if (Math.abs(remaining.get(h.instrumentId) - h.weight) > eps) return false;
    remaining.delete(h.instrumentId);
  }
  return remaining.size === 0;
}

// A breakdown is a list of {label, weight} entered from a fund's factsheet.
// Weights don't have to sum to 1 — callers normalize by the actual sum so a
// slightly-stale or rounded factsheet entry still distributes sensibly.
export function normalizeBreakdown(list) {
  if (!Array.isArray(list)) return null;
  const rows = list
    .map((r) => ({ label: String(r?.label || '').trim(), weight: Number(r?.weight) }))
    .filter((r) => r.label && Number.isFinite(r.weight) && r.weight > 0);
  return rows.length ? rows : null;
}
