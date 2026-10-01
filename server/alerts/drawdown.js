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
 * Reference = highest cached close in the trailing 52 weeks ending on the
 * latest close. If that history is missing, reference = the peak of the
 * saved NAV series (the whole series, not a 52-week slice) and current =
 * the latest NAV.
 */
export function resolveDrawdown({ historySeries, navSeries, today, historyFetchedAt = null } = {}) {
  const history = pointsOf(historySeries);
  if (history.length) {
    const latest = history[history.length - 1];
    const cutoff = addDaysISO(latest.date, -WEEKS_52_DAYS);
    const peak = peakSince(history, cutoff);
    if (peak) {
      const covers52w = history[0].date <= cutoff;
      const basisLabel = covers52w
        ? `from 52-week high, using cached closes as of ${latest.date}`
        : `from the high of cached closes since ${history[0].date} (shorter than 52 weeks), as of ${latest.date}`;
      return {
        basis: '52w',
        covers52w,
        basisLabel,
        currentPrice: latest.price,
        priceAsOf: latest.date,
        referencePrice: peak.price,
        referenceDate: peak.date,
        drawdown: drawdownRatio(latest.price, peak.price),
        stale: isPriceStale(latest.date, today),
        historyFetchedAt: historyFetchedAt || null,
      };
    }
  }

  const nav = pointsOf(navSeries);
  if (!nav.length) return null;
  const latest = nav[nav.length - 1];
  const peak = peakSince(nav, null);
  if (!peak) return null;
  return {
    basis: 'nav',
    covers52w: false,
    basisLabel: `from saved NAV series peak, using NAV as of ${latest.date}`,
    currentPrice: latest.price,
    priceAsOf: latest.date,
    referencePrice: peak.price,
    referenceDate: peak.date,
    drawdown: drawdownRatio(latest.price, peak.price),
    stale: isPriceStale(latest.date, today),
    historyFetchedAt: null,
  };
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

export function evaluateHolding({ inst, models, historySeries, navSeries, today, historyFetchedAt = null }) {
  const skip = skipReason(inst);
  if (skip) return { skip, instrumentId: inst?.id || null, symbol: inst?.symbol || null };
  const resolved = resolveDrawdown({ historySeries, navSeries, today, historyFetchedAt });
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
