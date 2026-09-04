// holdingHistory.js — first-added date from model versions + range filter.
// Pure: no network. The route fetches prices, then these helpers slice the
// series to "full history" or "since first appearance in this model".

export function firstAddedToModel(versions, instrumentId) {
  if (!instrumentId || !Array.isArray(versions) || !versions.length) return null;
  const sorted = [...versions].sort((a, b) => {
    const d = String(a.effectiveDate || '').localeCompare(String(b.effectiveDate || ''));
    if (d !== 0) return d;
    return String(a.createdAt || '').localeCompare(String(b.createdAt || ''));
  });
  for (const v of sorted) {
    if ((v.holdings || []).some((h) => h.instrumentId === instrumentId)) {
      return { addedAt: v.effectiveDate, versionId: v.id || null };
    }
  }
  return null;
}

// Since-added includes the last close on or before the add date as the
// starting level so the first return after the add is actually measured.
export function filterSeriesByRange(series, { mode, addedAt } = {}) {
  const pts = [...(series || [])]
    .filter((p) => p && p.date && Number.isFinite(p.price))
    .sort((a, b) => a.date.localeCompare(b.date));
  if (mode !== 'since-added' || !addedAt) return pts;
  const later = pts.filter((p) => p.date >= addedAt);
  const prior = pts.filter((p) => p.date < addedAt);
  if (!prior.length) return later;
  if (later.length && later[0].date === prior[prior.length - 1].date) return later;
  return [prior[prior.length - 1], ...later];
}

export function periodReturnFromSeries(series) {
  if (!series || series.length < 2) return null;
  const first = series[0].price;
  const last = series[series.length - 1].price;
  if (!Number.isFinite(first) || first === 0 || !Number.isFinite(last)) return null;
  return last / first - 1;
}

export function rangeBounds(series) {
  if (!series?.length) return { from: null, to: null };
  return { from: series[0].date, to: series[series.length - 1].date };
}
