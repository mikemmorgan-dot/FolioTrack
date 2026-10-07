// alerts/drawdown.js — peak-to-current drawdown from cached closes.
// Pure. The check runner decides where the series came from; this file
// only turns points into a drawdown and dedupes current-version holdings.

import { currentVersionOf } from '../util.js';
import { calendarDaysBetween, isCashInstrument } from '../nav.js';

// 52 weeks × 7 days. The window ends on the latest cached close, not "today",
// so a stale series is measured against its own peak.
export const WEEKS_52_DAYS = 52 * 7;
export const STALE_PRICE_DAYS = 5;

export function addDaysISO(iso, days) {
  const d = new Date(`${String(iso).slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return null;
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function drawdownRatio(currentPrice, referencePrice) {
  const current = Number(currentPrice);
  const reference = Number(referencePrice);
  if (!Number.isFinite(current) || !Number.isFinite(reference) || reference <= 0 || current <= 0) return null;
  return current / reference - 1;
}

export function isPriceStale(asOf, today) {
  if (!asOf || !today) return false;
  const age = calendarDaysBetween(asOf, today);
  return age != null && age > STALE_PRICE_DAYS;
}

function pointsOf(series) {
  const out = [];
  const seen = new Set();
  for (const p of series || []) {
    const date = String(p?.date || '').slice(0, 10);
    const price = Number(p?.close ?? p?.nav ?? p?.price);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(price) || price <= 0) continue;
    if (seen.has(date)) continue;
    seen.add(date);
    out.push({ date, price });
  }
  out.sort((a, b) => a.date.localeCompare(b.date));
  return out;
}

// Highest price on or after cutoff. Ties take the later date.
export function peakSince(points, cutoff) {
  let best = null;
  for (const p of points) {
    if (cutoff && p.date < cutoff) continue;
    if (!best || p.price > best.price || (p.price === best.price && p.date > best.date)) best = p;
  }
  return best;
}

/**
 * Latest close, 52-week high, and (for NAV) the series peak.
 * The alert check stores this instead of the daily rows. Same rules as
 * walking the series: first point on a duplicate date wins, ties on the
 * high take the later date, NAV is the whole series (not a 52-week slice).
 */
export function snapshotFromSeries({ historySeries, navSeries, historyFetchedAt = null } = {}) {
  const history = pointsOf(historySeries);
  const nav = pointsOf(navSeries);
  let price = null;
  if (history.length) {
    const latest = history[history.length - 1];
    const cutoff = addDaysISO(latest.date, -WEEKS_52_DAYS);
    const peak = peakSince(history, cutoff);
    if (peak) {
      price = {
        n: history.length,
        firstDate: history[0].date,
        latestDate: latest.date,
        latestClose: latest.price,
        peakDate: peak.date,
        peakClose: peak.price,
        fetchedAt: historyFetchedAt || null,
      };
    }
  }
  let navSnap = null;
  if (nav.length) {
    const latest = nav[nav.length - 1];
    const peak = peakSince(nav, null);
    if (peak) {
      navSnap = {
        n: nav.length,
        firstDate: nav[0].date,
        latestDate: latest.date,
        latestNav: latest.price,
        peakDate: peak.date,
        peakNav: peak.price,
      };
    }
  }
  return {
    navCount: navSnap?.n || 0,
    priceCount: price?.n || 0,
    priceLastClose: price?.latestDate || null,
    historyFetchedAt: price?.fetchedAt || null,
    price,
    nav: navSnap,
  };
}

export function resolveDrawdownFromSnapshot(snap, { today, historyFetchedAt = null } = {}) {
  const price = snap?.price;
  if (price?.n > 0 && price.latestDate && price.peakDate) {
    const cutoff = addDaysISO(price.latestDate, -WEEKS_52_DAYS);
    const covers52w = price.firstDate <= cutoff;
    const basisLabel = covers52w
      ? `from 52-week high, using cached closes as of ${price.latestDate}`
      : `from the high of cached closes since ${price.firstDate} (shorter than 52 weeks), as of ${price.latestDate}`;
    return {
      basis: '52w',
      covers52w,
      basisLabel,
      currentPrice: price.latestClose,
      priceAsOf: price.latestDate,
      referencePrice: price.peakClose,
      referenceDate: price.peakDate,
      drawdown: drawdownRatio(price.latestClose, price.peakClose),
      stale: isPriceStale(price.latestDate, today),
      historyFetchedAt: historyFetchedAt || price.fetchedAt || snap?.historyFetchedAt || null,
    };
  }

  const nav = snap?.nav;
  if (!nav?.n || !nav.latestDate || !nav.peakDate) return null;
  return {
    basis: 'nav',
    covers52w: false,
    basisLabel: `from saved NAV series peak, using NAV as of ${nav.latestDate}`,
    currentPrice: nav.latestNav,
    priceAsOf: nav.latestDate,
    referencePrice: nav.peakNav,
    referenceDate: nav.peakDate,
    drawdown: drawdownRatio(nav.latestNav, nav.peakNav),
    stale: isPriceStale(nav.latestDate, today),
    historyFetchedAt: null,
  };
}

/**
 * Reference = highest cached close in the trailing 52 weeks ending on the
 * latest close. If that history is missing, reference = the peak of the
 * saved NAV series (the whole series, not a 52-week slice) and current =
 * the latest NAV.
 */
export function resolveDrawdown({ historySeries, navSeries, today, historyFetchedAt = null } = {}) {
  return resolveDrawdownFromSnapshot(
    snapshotFromSeries({ historySeries, navSeries, historyFetchedAt }),
    { today, historyFetchedAt },
  );
}

// Current version of every model, deduped by instrument id. Older versions
// are ignored. Each row lists the models that currently hold it.
export function collectCurrentHoldings(models) {
  const map = new Map();
  for (const m of models || []) {
    const cv = currentVersionOf(m);
    if (!cv) continue;
    for (const h of cv.holdings || []) {
      if (!h?.instrumentId) continue;
      if (!map.has(h.instrumentId)) {
        map.set(h.instrumentId, { instrumentId: h.instrumentId, models: [] });
      }
      const row = map.get(h.instrumentId);
      if (!row.models.some((x) => x.key === m.key)) {
        row.models.push({ key: m.key, name: m.name, weight: Number(h.weight) });
      }
    }
  }
  return [...map.values()];
}

export function skipReason(inst) {
  if (!inst) return 'missing';
  if (isCashInstrument(inst)) return 'cash';
  return null;
}

function holdingFromResolved(inst, models, resolved) {
  if (!resolved || resolved.drawdown == null || resolved.currentPrice == null) {
    return { skip: 'no-price', instrumentId: inst.id, symbol: inst.symbol, name: inst.name, models: models || [] };
  }
  return {
    skip: null,
    instrumentId: inst.id,
    symbol: inst.symbol,
    name: inst.name,
    currency: inst.currency || null,
    type: inst.type,
    models: models || [],
    ...resolved,
  };
}

export function evaluateHolding({ inst, models, historySeries, navSeries, today, historyFetchedAt = null }) {
  const skip = skipReason(inst);
  if (skip) return { skip, instrumentId: inst?.id || null, symbol: inst?.symbol || null };
  const resolved = resolveDrawdown({ historySeries, navSeries, today, historyFetchedAt });
  return holdingFromResolved(inst, models, resolved);
}

// NAV points win over a leftover price history, matching the check runner.
export function evaluateFromSnapshot({ inst, models, snap, today, historyFetchedAt = null }) {
  const skip = skipReason(inst);
  if (skip) return { skip, instrumentId: inst?.id || null, symbol: inst?.symbol || null };
  const preferNav = (snap?.navCount || 0) > 0;
  const view = preferNav ? { ...snap, price: null, priceCount: 0, priceLastClose: null } : snap;
  const resolved = resolveDrawdownFromSnapshot(view, {
    today,
    historyFetchedAt: historyFetchedAt || snap?.historyFetchedAt || null,
  });
  return holdingFromResolved(inst, models, resolved);
}
