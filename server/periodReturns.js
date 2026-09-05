// periodReturns.js — standard holding-level period returns from a price/NAV series.
//
// Rule: P_start / P_end are the closest available EOD points ON OR BEFORE the
// window start and end. No interpolation, no look-ahead. If the visible series
// has no point on or before the start, the period is null (not 0%).
//
// Windows (asOf = last visible observation, not wall-clock "today"):
//   MTD     last calendar day of the previous month → asOf   (total return)
//   QTD     last calendar day of the previous quarter → asOf (total return)
//   YTD     Dec 31 of the previous year → asOf               (total return)
//   1Y      calendar date 1 year before asOf → asOf          (total return)
//   3/5/10/15/20Y  same, annualized: (P_end/P_start)^(1/years) − 1
//                  years = actual year-fraction between the two observation
//                  dates (day count / 365.25).
//
// Callers pass the *visible* series (full history or since-added already
// sliced). A 10y figure therefore cannot predate a since-added clip.

export const RETURNS_RULE =
  'Closest available EOD on or before each window start/end. Multi-year figures are annualized from the actual observation span (day count / 365.25).';

export const PERIOD_KEYS = ['mtd', 'qtd', 'ytd', 'y1', 'y3ann', 'y5ann', 'y10ann', 'y15ann', 'y20ann'];

const ANN_KEYS = new Set(['y3ann', 'y5ann', 'y10ann', 'y15ann', 'y20ann']);

export const PERIOD_NEED = {
  mtd: 'need a prior month-end close in the visible series',
  qtd: 'need a prior quarter-end close in the visible series',
  ytd: 'need a prior year-end close in the visible series',
  y1: 'need ≥1y history',
  y3ann: 'need ≥3y history',
  y5ann: 'need ≥5y history',
  y10ann: 'need ≥10y history',
  y15ann: 'need ≥15y history',
  y20ann: 'need ≥20y history',
};

const TRADING_DAYS_PER_YEAR = 252;
const DAYS_PER_YEAR = 365.25;
const THIN_COVERAGE = 0.9;
// Don't flag coverage on a handful of sessions (MTD in the first few days).
const THIN_MIN_EXPECTED = 3;

const pad = (n) => String(n).padStart(2, '0');

export function isoFromUtc(d) {
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

export function parseIso(iso) {
  const [y, m, d] = String(iso).slice(0, 10).split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

export function addCalendarYears(iso, years) {
  const [y, m, d] = String(iso).slice(0, 10).split('-').map(Number);
  const targetY = y + years;
  const lastDay = new Date(Date.UTC(targetY, m, 0)).getUTCDate();
  return `${targetY}-${pad(m)}-${pad(Math.min(d, lastDay))}`;
}

export function lastDayOfPreviousMonth(iso) {
  const [y, m] = String(iso).slice(0, 10).split('-').map(Number);
  return isoFromUtc(new Date(Date.UTC(y, m - 1, 0)));
}

export function lastDayOfPreviousQuarter(iso) {
  const [y, m] = String(iso).slice(0, 10).split('-').map(Number);
  const quarterStartMonth = Math.floor((m - 1) / 3) * 3; // 0, 3, 6, 9
  return isoFromUtc(new Date(Date.UTC(y, quarterStartMonth, 0)));
}

export function lastDayOfPreviousYear(iso) {
  return `${Number(String(iso).slice(0, 4)) - 1}-12-31`;
}

export function yearFraction(fromIso, toIso) {
  const ms = parseIso(toIso) - parseIso(fromIso);
  return ms / (DAYS_PER_YEAR * 24 * 60 * 60 * 1000);
}

export function windowStarts(asOf) {
  return {
    mtd: lastDayOfPreviousMonth(asOf),
    qtd: lastDayOfPreviousQuarter(asOf),
    ytd: lastDayOfPreviousYear(asOf),
    y1: addCalendarYears(asOf, -1),
    y3ann: addCalendarYears(asOf, -3),
    y5ann: addCalendarYears(asOf, -5),
    y10ann: addCalendarYears(asOf, -10),
    y15ann: addCalendarYears(asOf, -15),
    y20ann: addCalendarYears(asOf, -20),
  };
}

function priceOf(p) {
  const x = Number(p?.price ?? p?.value ?? p?.close ?? p?.nav);
  return Number.isFinite(x) ? x : null;
}

export function normalizeReturnSeries(series) {
  const pts = [];
  for (const p of series || []) {
    const date = String(p?.date || '').slice(0, 10);
    const price = priceOf(p);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || price == null) continue;
    pts.push({ date, price });
  }
  pts.sort((a, b) => a.date.localeCompare(b.date));
  return pts;
}

export function lastOnOrBefore(sorted, dateStr) {
  let found = null;
  for (const p of sorted) {
    if (p.date <= dateStr) found = p;
    else break;
  }
  return found;
}

function countPointsAfterThrough(sorted, fromDate, toDate) {
  let n = 0;
  for (const p of sorted) {
    if (p.date > fromDate && p.date <= toDate) n++;
  }
  return n;
}

export function isThinSample(sorted, fromDate, toDate) {
  const days = yearFraction(fromDate, toDate) * DAYS_PER_YEAR;
  const expected = days * (TRADING_DAYS_PER_YEAR / DAYS_PER_YEAR);
  if (expected < THIN_MIN_EXPECTED) return false;
  const actual = countPointsAfterThrough(sorted, fromDate, toDate);
  return actual < THIN_COVERAGE * expected;
}

function emptyMeta(annualized) {
  return { estimate: false, from: null, to: null, years: null, annualized };
}

export function emptyReturns(asOf = null) {
  const out = { asOf, rule: RETURNS_RULE, meta: {} };
  for (const k of PERIOD_KEYS) {
    out[k] = null;
    out.meta[k] = emptyMeta(ANN_KEYS.has(k));
  }
  return out;
}

function computeWindow(sorted, startDate, endDate, { annualize }) {
  const startPt = lastOnOrBefore(sorted, startDate);
  const endPt = lastOnOrBefore(sorted, endDate);
  if (!startPt || !endPt) return null;
  if (endPt.date <= startPt.date) return null;
  if (startPt.price === 0) return null;
  const total = endPt.price / startPt.price - 1;
  if (!Number.isFinite(total)) return null;
  const years = yearFraction(startPt.date, endPt.date);
  if (years <= 0) return null;
  let value = total;
  if (annualize) {
    if (1 + total < 0) return null;
    value = Math.pow(1 + total, 1 / years) - 1;
    if (!Number.isFinite(value)) return null;
  }
  return {
    value,
    estimate: isThinSample(sorted, startPt.date, endPt.date),
    from: startPt.date,
    to: endPt.date,
    years,
    annualized: annualize,
  };
}

export function periodReturnsFromSeries(series, { asOf } = {}) {
  const pts = normalizeReturnSeries(series);
  const end = asOf || pts[pts.length - 1]?.date || null;
  if (!end || pts.length < 2) return emptyReturns(end);

  const starts = windowStarts(end);
  const out = emptyReturns(end);
  for (const key of PERIOD_KEYS) {
    const computed = computeWindow(pts, starts[key], end, { annualize: ANN_KEYS.has(key) });
    if (!computed) continue;
    out[key] = computed.value;
    out.meta[key] = {
      estimate: computed.estimate,
      from: computed.from,
      to: computed.to,
      years: computed.years,
      annualized: computed.annualized,
    };
  }
  return out;
}
