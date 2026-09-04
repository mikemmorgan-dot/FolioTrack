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
    breakdownAsOf: normalizeAsOf(spec.breakdownAsOf),
    breakdownNote: normalizeNote(spec.breakdownNote),
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

const AS_OF_RE = /^\d{4}-\d{2}-\d{2}$/;

// Factsheet effective date — what Mike cares about for "is this still good".
// Distinct from breakdownUpdatedAt (when FolioTrack last saved the rows).
export function normalizeAsOf(value) {
  if (value == null || value === '') return null;
  const s = String(value).trim().slice(0, 10);
  return AS_OF_RE.test(s) ? s : null;
}

// Short free-text (e.g. "VFV factsheet Aug 2026" or "estimate — verify").
// Trim; empty → null. Cap so a paste doesn't become an essay.
export function normalizeNote(value) {
  if (value == null) return null;
  const s = String(value).trim().slice(0, 200);
  return s || null;
}

export function breakdownPatchPresent(patch) {
  return patch.sectorBreakdown !== undefined
    || patch.countryBreakdown !== undefined
    || patch.breakdownAsOf !== undefined
    || patch.breakdownNote !== undefined;
}

function hasRows(list) {
  return Array.isArray(list) && list.length > 0;
}

// Merge a classify/look-through patch onto the current instrument fields.
// When both breakdowns end up empty, as-of AND note are cleared: a leftover
// factsheet date or "VFV factsheet Aug 2026" on a single-bucket holding is
// noise. Clearing as-of is the load-bearing part; note follows so the two
// stay in lockstep. Throws 400 if rows remain but as-of is missing — a
// confident Geo/Sector without a date is the bug this field exists to fix.
export function nextBreakdownFields(current, patch) {
  const sectorBreakdown = patch.sectorBreakdown !== undefined
    ? normalizeBreakdown(patch.sectorBreakdown)
    : (current.sectorBreakdown ?? null);
  const countryBreakdown = patch.countryBreakdown !== undefined
    ? normalizeBreakdown(patch.countryBreakdown)
    : (current.countryBreakdown ?? null);

  const anyBreakdown = hasRows(sectorBreakdown) || hasRows(countryBreakdown);
  const rowsTouched = patch.sectorBreakdown !== undefined || patch.countryBreakdown !== undefined;

  let breakdownAsOf = current.breakdownAsOf ?? null;
  let breakdownNote = current.breakdownNote ?? null;
  if (patch.breakdownAsOf !== undefined) breakdownAsOf = normalizeAsOf(patch.breakdownAsOf);
  if (patch.breakdownNote !== undefined) breakdownNote = normalizeNote(patch.breakdownNote);

  if (!anyBreakdown) {
    breakdownAsOf = null;
    breakdownNote = null;
  } else if (rowsTouched && !breakdownAsOf) {
    const err = new Error('A factsheet as-of date (YYYY-MM-DD) is required when a look-through breakdown is set.');
    err.status = 400;
    throw err;
  }

  return { sectorBreakdown, countryBreakdown, breakdownAsOf, breakdownNote, rowsTouched };
}
