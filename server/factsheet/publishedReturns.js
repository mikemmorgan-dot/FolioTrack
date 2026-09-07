// publishedReturns.js — manufacturer calendar-year / annualized figures.
// These are copied from an issuer Fund Facts / FundPulse / product page.
// They are not reconstructed from NAV and must not be expanded into a
// daily nav_series.

import { PERIOD_KEYS } from '../periodReturns.js';

export const PUBLISHED_PERIOD_KEYS = [
  'm1', 'm3', 'm6', 'ytd', 'y1', 'y2ann', 'y3ann', 'y5ann',
  'y10ann', 'y15ann', 'y20ann', 'inceptionAnn',
];

const ANN = new Set(['y2ann', 'y3ann', 'y5ann', 'y10ann', 'y15ann', 'y20ann', 'inceptionAnn']);

export function pctToDecimal(raw) {
  if (raw == null || raw === '' || raw === '-' || raw === '—') return null;
  const n = Number(String(raw).replace(/[%\s,]/g, ''));
  if (!Number.isFinite(n)) return null;
  return n / 100;
}

export function hasPublishedReturns(pub) {
  if (!pub || typeof pub !== 'object') return false;
  if (PUBLISHED_PERIOD_KEYS.some((k) => Number.isFinite(pub[k]))) return true;
  return Array.isArray(pub.calendarYears) && pub.calendarYears.some((r) => Number.isFinite(r?.value));
}

function numOrNull(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export function normalizeCalendarYears(list) {
  if (!Array.isArray(list)) return [];
  const map = new Map();
  for (const row of list) {
    const year = Number(row?.year);
    const value = numOrNull(row?.value);
    if (!Number.isInteger(year) || year < 1990 || year > 2100 || value == null) continue;
    const ytd = !!row.ytd;
    map.set(`${year}:${ytd ? 'ytd' : 'cy'}`, { year, value, ytd });
  }
  return [...map.values()].sort((a, b) => b.year - a.year || (a.ytd === b.ytd ? 0 : a.ytd ? -1 : 1));
}

export function normalizePublishedReturns(value) {
  if (!value || typeof value !== 'object') return null;
  const out = {
    kind: 'published',
    asOf: value.asOf ? String(value.asOf).slice(0, 10) : null,
    source: value.source ? String(value.source).slice(0, 160) : null,
    document: value.document ? String(value.document).slice(0, 400) : null,
    series: value.series ? String(value.series).slice(0, 8) : null,
    scrapedAt: value.scrapedAt ? String(value.scrapedAt).slice(0, 10) : null,
  };
  if (out.asOf && !/^\d{4}-\d{2}-\d{2}$/.test(out.asOf)) out.asOf = null;
  for (const k of PUBLISHED_PERIOD_KEYS) {
    const n = numOrNull(value[k]);
    if (n != null) out[k] = n;
  }
  const years = normalizeCalendarYears(value.calendarYears);
  if (years.length) out.calendarYears = years;
  return hasPublishedReturns(out) ? out : null;
}

// preferred wins on overlapping keys; calendar years union (preferred year wins).
export function mergePublishedReturns(preferred, fallback) {
  const a = normalizePublishedReturns(preferred);
  const b = normalizePublishedReturns(fallback);
  if (!a && !b) return null;
  if (!a) return b;
  if (!b) return a;
  const out = { ...b, ...a, kind: 'published' };
  out.calendarYears = normalizeCalendarYears([
    ...(b.calendarYears || []),
    ...(a.calendarYears || []),
  ]);
  if (!out.calendarYears.length) delete out.calendarYears;
  if (!out.source) out.source = b.source;
  if (!out.document) out.document = b.document;
  if (!out.asOf) out.asOf = b.asOf;
  if (!out.series) out.series = b.series;
  return out;
}

// Shape PeriodReturnsRow already understands. Missing windows stay null —
// never fill MTD from a 1-month published figure.
export function publishedToPeriodRow(pub) {
  const p = normalizePublishedReturns(pub);
  if (!p) return null;
  const out = { asOf: p.asOf, rule: 'Manufacturer published returns — not reconstructed from NAV.', meta: {}, published: true };
  for (const k of PERIOD_KEYS) {
    const v = p[k];
    const missing = v == null || !Number.isFinite(v);
    out[k] = missing ? null : v;
    out.meta[k] = {
      estimate: false,
      published: !missing,
      from: null,
      to: p.asOf,
      years: null,
      annualized: ANN.has(k),
    };
  }
  return out;
}
