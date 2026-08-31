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
  };
}
