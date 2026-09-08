// navPrice.js — user-entered NAV is authoritative whenever it exists.
//
// Instruments keep source 'auto' | 'manual' as a default *intent*, but a
// non-empty nav_series always wins for quotes and history. That is the
// live-app failure: RY.TO stayed source=auto, providers 429/cooldown, and
// entered NAV points were ignored because every read path branched on
// source === 'manual' only.

export function seriesFromNav(navSeries) {
  return (navSeries || [])
    .filter((p) => p && p.date && Number.isFinite(Number(p.nav)))
    .map((p) => ({ date: String(p.date).slice(0, 10), price: Number(p.nav) }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

export function latestFromSeries(series) {
  if (!series?.length) return null;
  return series[series.length - 1];
}

export function quoteFromNav(inst, latest) {
  if (!inst || !latest) return null;
  const price = Number(latest.nav ?? latest.price);
  if (!Number.isFinite(price)) return null;
  const asOf = latest.date ? String(latest.date).slice(0, 10) : null;
  return { price, asOf, currency: inst.currency || null };
}

export function quoteFieldsFromLatestNav(latest, navSource) {
  if (!latest || !Number.isFinite(Number(latest.nav))) return null;
  return {
    price: Number(latest.nav),
    priceAsOf: latest.date ? String(latest.date).slice(0, 10) : null,
    priceSource: navSource || 'manual',
  };
}

// path: 'nav_series' | 'auto'
// nav_series wins whenever there is at least one usable point — including
// on source=auto. Empty manual names still report nav_series (no providers).
export function decidePricePath(inst, navSeries) {
  const series = seriesFromNav(navSeries);
  if (series.length) return { path: 'nav_series', series };
  if (inst?.source === 'auto') return { path: 'auto', series: [] };
  return { path: 'nav_series', series: [] };
}

export async function loadNavMarket(store, inst) {
  const navSeries = store.getNavSeries ? await store.getNavSeries(inst.id) : [];
  const decision = decidePricePath(inst, navSeries);
  let series = decision.series;
  let latest = latestFromSeries(series);
  if (!latest && store.latestNav) {
    const row = await store.latestNav(inst.id);
    if (row && Number.isFinite(Number(row.nav))) {
      latest = { date: String(row.date).slice(0, 10), price: Number(row.nav) };
      series = [latest];
    }
  }
  return {
    hasNav: series.length > 0,
    path: series.length ? 'nav_series' : decision.path,
    series,
    quote: quoteFromNav(inst, latest ? { date: latest.date, nav: latest.price } : null),
  };
}
