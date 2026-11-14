// compareRisk.js — side-by-side risk for every model's current version.
//
// All books are scored on one shared run of months: the longest stretch where
// every priced holding of every compared model, and each benchmark sleeve,
// has its own month-end close in that month and the month before. Max common
// starts at the latest of those first months. A name that cannot be priced
// monthly (manual fund, private/alt, cash) does not move that start. It is
// left out of the figure and reported as coverage, the same idea as blended
// MER ignoring holdings with no MER. A priced name with no cached months is
// left out the same way. It does not collapse the window to empty.
//
// Prices come from the stored cache (month-end rows only). A listed stock or
// ETF uses the cache when that series has more monthly support than its NAV
// points, so one typed price does not hide a backfilled history. This module
// does not call a quote provider.

import { decidePricePath } from './navPrice.js';
import { isMonthlyPriceableInstrument } from './listing.js';
import { monthEndCloses, monthEndDate } from './perf.js';
import { shortName } from './compare.js';
import { riskMetrics, staticPortfolioMonthly } from './risk.js';

export const PERIOD_MONTHS = { '1y': 12, '3y': 36, '5y': 60 };
export const METRIC_KEYS = [
  'annualizedReturn', 'volatility', 'sharpe', 'sortino', 'maxDrawdown',
  'beta', 'trackingError', 'informationRatio',
];

const PERIODS = ['1y', '3y', '5y', 'max'];

export function addMonths(ym, delta) {
  let y = Number(String(ym).slice(0, 4));
  let m = Number(String(ym).slice(5, 7)) + delta;
  while (m > 12) { m -= 12; y += 1; }
  while (m < 1) { m += 12; y -= 1; }
  return `${y}-${String(m).padStart(2, '0')}`;
}

// Last month whose month-end is on or before asOf. A mid-month close is not
// treated as a finished monthly return.
export function lastCompleteMonth(asOf) {
  const day = String(asOf || '').slice(0, 10);
  const ym = day.slice(0, 7);
  if (!/^\d{4}-\d{2}$/.test(ym)) return null;
  return day >= monthEndDate(ym) ? ym : addMonths(ym, -1);
}

export function parseRfPercent(q) {
  if (q == null || q === '') return 0.04;
  const v = parseFloat(q);
  return Number.isFinite(v) ? v / 100 : 0.04;
}

function formatWeightPct(w) {
  const p = Math.round(Number(w) * 1000) / 10;
  if (!Number.isFinite(p)) return '';
  return Number.isInteger(p) ? `${p}%` : `${p.toFixed(1)}%`;
}

export function benchmarkLabel(benchmark) {
  const parts = (benchmark || []).filter((b) => b && b.weight > 0 && b.symbol);
  if (!parts.length) return null;
  return parts.map((b) => `${b.symbol} ${formatWeightPct(b.weight)}`).join(' · ');
}

function blankReasons(text) {
  return Object.fromEntries(METRIC_KEYS.map((k) => [k, text]));
}

function toYmMap(series, lastYm) {
  const map = new Map();
  for (const p of monthEndCloses(series)) {
    const ym = p.date.slice(0, 7);
    if (lastYm && ym > lastYm) continue;
    map.set(ym, p.close);
  }
  return map;
}

// Months whose return is a real close-to-close: this month and the one
// before both have their own observation. A carried-forward level does not
// qualify, so a quarterly NAV cannot pose as a monthly series.
export function supportMonths(byYm) {
  const yms = [...byYm.keys()].sort();
  const set = new Set();
  for (let i = 1; i < yms.length; i++) {
    if (addMonths(yms[i - 1], 1) === yms[i]) set.add(yms[i]);
  }
  return set;
}

export function monthlySupportCount(series, lastYm) {
  return supportMonths(toYmMap(series, lastYm)).size;
}

function returnOn(byYm, ym) {
  const prev = byYm.get(addMonths(ym, -1));
  const cur = byYm.get(ym);
  if (prev == null || cur == null || prev === 0) return null;
  return cur / prev - 1;
}

function returnMapFor(byYm, months) {
  const map = {};
  for (const ym of months) map[ym] = returnOn(byYm, ym);
  return map;
}

function latestRun(sorted) {
  if (!sorted.length) return [];
  let cur = [sorted[0]];
  let latest = cur;
  for (let i = 1; i < sorted.length; i++) {
    if (addMonths(sorted[i - 1], 1) === sorted[i]) cur.push(sorted[i]);
    else { latest = cur; cur = [sorted[i]]; }
  }
  return cur.length ? cur : latest;
}

// Longest contiguous run where every set has a real month-to-month return.
// Empty sets are ignored so a name with no cache does not wipe the window.
function intersectRun(sets) {
  let acc = null;
  for (const set of sets) {
    if (!set || !set.size) continue;
    if (!acc) {
      acc = new Set(set);
      continue;
    }
    for (const ym of [...acc]) if (!set.has(ym)) acc.delete(ym);
  }
  if (!acc || !acc.size) return [];
  return latestRun([...acc].sort());
}

export function availablePeriods(monthCount) {
  const out = [];
  if (monthCount >= PERIOD_MONTHS['1y']) out.push('1y');
  if (monthCount >= PERIOD_MONTHS['3y']) out.push('3y');
  if (monthCount >= PERIOD_MONTHS['5y']) out.push('5y');
  if (monthCount >= 2) out.push('max');
  return out;
}

export function resolvePeriod(requested, available) {
  const raw = requested == null ? '' : String(requested).trim().toLowerCase();
  if (!raw) {
    if (available.includes('3y')) return { period: '3y' };
    if (available.includes('5y')) return { period: '5y' };
    if (available.includes('1y')) return { period: '1y' };
    if (available.includes('max')) return { period: 'max' };
    return { period: null };
  }
  if (!PERIODS.includes(raw)) {
    return { error: 'period must be 1y, 3y, 5y, or max', status: 400 };
  }
  if (!available.includes(raw)) return { period: null, requestedPeriod: raw };
  return { period: raw, requestedPeriod: raw };
}

function sliceRun(run, period) {
  if (!period) return null;
  if (period === 'max') return run.slice();
  const n = PERIOD_MONTHS[period];
  if (!n || run.length < n) return null;
  return run.slice(-n);
}

function periodNeed(period) {
  if (period === 'max') return 2;
  return PERIOD_MONTHS[period] || 2;
}

function consolidate(holdings) {
  const map = new Map();
  for (const h of holdings || []) {
    const weight = Number(h?.weight);
    if (!h?.instrumentId || !(weight > 0)) continue;
    const prev = map.get(h.instrumentId);
    if (prev) prev.weight += weight;
    else map.set(h.instrumentId, { ...h, weight });
  }
  return [...map.values()];
}

function covers(byYm, months) {
  if (!months.length) return false;
  const support = supportMonths(byYm);
  return months.every((ym) => support.has(ym));
}

function blend(refs, mapsByRef, months) {
  const grid = [addMonths(months[0], -1), ...months];
  const returnsByRef = {};
  for (const ref of refs) returnsByRef[ref.ref] = returnMapFor(mapsByRef.get(ref.ref) || new Map(), months);
  const series = staticPortfolioMonthly(refs, returnsByRef, grid);
  const aligned = series.months.length === months.length
    && series.months.every((ym, i) => ym === months[i]);
  return aligned ? series.rets : null;
}

function metricReasons(metrics, benchStatus) {
  const reasons = blankReasons(null);
  if (!metrics) return reasons;
  if (metrics.sharpe == null) reasons.sharpe = metrics.volatility === 0 ? 'Zero volatility' : 'Fewer than 2 months';
  if (metrics.sortino == null) {
    reasons.sortino = metrics.n < 2 ? 'Fewer than 2 months' : 'No downside deviation';
  }
  if (benchStatus === 'none') {
    reasons.beta = 'No benchmark';
    reasons.trackingError = 'No benchmark';
    reasons.informationRatio = 'No benchmark';
  } else if (benchStatus === 'gap') {
    reasons.beta = 'Benchmark gap';
    reasons.trackingError = 'Benchmark gap';
    reasons.informationRatio = 'Benchmark gap';
  } else {
    if (metrics.beta == null) reasons.beta = 'Benchmark variance is zero';
    if (metrics.trackingError == null) reasons.trackingError = 'Benchmark gap';
    if (metrics.informationRatio == null && reasons.informationRatio == null) {
      reasons.informationRatio = 'Tracking error is zero';
    }
  }
  return reasons;
}

function rowShell(book, extra) {
  return {
    key: book.key,
    name: book.name,
    shortName: shortName(book.name),
    riskRank: book.riskRank ?? null,
    versionId: book.versionId ?? null,
    effectiveDate: book.effectiveDate ?? null,
    benchmark: (book.benchmark || [])
      .filter((b) => b && b.symbol)
      .map((b) => ({ symbol: b.symbol, weight: Number(b.weight) || 0 })),
    benchmarkLabel: benchmarkLabel(book.benchmark),
    coverage: null,
    partial: false,
    leftOut: [],
    metrics: null,
    ...extra,
  };
}

function unavailableText(requested, commonMonths) {
  if (!commonMonths) return 'No common date range across models with monthly history.';
  const label = requested === 'max' ? 'Max' : requested;
  return `Common history is ${commonMonths} months; ${label} needs ${periodNeed(requested)}.`;
}

export function buildCompareRisk(books, seriesByRef, seriesBySymbol, { period, rf = 0.04, asOf } = {}) {
  const today = String(asOf || new Date().toISOString().slice(0, 10)).slice(0, 10);
  const lastComplete = lastCompleteMonth(today);
  const ordered = [...(books || [])].sort((a, b) => (a.riskRank ?? 0) - (b.riskRank ?? 0) || String(a.name).localeCompare(String(b.name)));

  const byRef = new Map();
  for (const [id, series] of Object.entries(seriesByRef || {})) {
    byRef.set(id, toYmMap(series, lastComplete));
  }
  const bySymbol = new Map();
  for (const [symbol, series] of Object.entries(seriesBySymbol || {})) {
    bySymbol.set(String(symbol).toUpperCase(), toYmMap(series, lastComplete));
  }

  const prepared = ordered.map((book) => {
    const holdings = consolidate(book.holdings);
    if (!book.versionId && !holdings.length) {
      return { book, holdings, support: new Set(), participate: false, status: 'empty', reason: 'No current version' };
    }
    if (!holdings.length) {
      return { book, holdings, support: new Set(), participate: false, status: 'empty', reason: book.versionId ? 'No current holdings' : 'No current version' };
    }
    const support = new Set();
    let anyPoint = false;
    for (const h of holdings) {
      const map = byRef.get(h.instrumentId) || new Map();
      if (map.size) anyPoint = true;
      for (const ym of supportMonths(map)) support.add(ym);
    }
    if (!support.size) {
      return {
        book, holdings, support, participate: false, status: 'sparse',
        reason: anyPoint ? 'No continuous monthly history' : 'No cached monthly prices',
      };
    }
    return { book, holdings, support, participate: true, status: 'ok', reason: null };
  });

  const windowSets = [];
  const seenBench = new Set();
  for (const p of prepared) {
    if (!p.participate) continue;
    for (const h of p.holdings) {
      if (h.monthlyPriceable === false) continue;
      const support = supportMonths(byRef.get(h.instrumentId) || new Map());
      if (support.size) windowSets.push(support);
    }
    for (const b of p.book.benchmark || []) {
      if (!b?.symbol || !(Number(b.weight) > 0)) continue;
      const symbol = String(b.symbol).toUpperCase();
      if (seenBench.has(symbol)) continue;
      seenBench.add(symbol);
      const support = supportMonths(bySymbol.get(symbol) || new Map());
      if (support.size) windowSets.push(support);
    }
  }
  const run = intersectRun(windowSets);
  const available = availablePeriods(run.length);
  const resolved = resolvePeriod(period, available);
  if (resolved.error) return { error: resolved.error, status: resolved.status || 400 };

  const slice = sliceRun(run, resolved.period);
  const common = run.length ? { start: run[0], end: run[run.length - 1], months: run.length } : null;
  let unavailableReason = null;
  if (!resolved.period) {
    const asked = resolved.requestedPeriod;
    if (asked) unavailableReason = unavailableText(asked, run.length);
    else if (!run.length) unavailableReason = 'No common date range across models with monthly history.';
    else unavailableReason = 'Fewer than 2 months in common.';
  }

  const models = prepared.map((p) => {
    if (!p.participate) {
      return rowShell(p.book, {
        status: p.status,
        reason: p.reason,
        metricReasons: blankReasons(p.reason),
      });
    }
    if (!slice) {
      const reason = unavailableReason || (run.length ? 'Fewer than 2 months in common' : 'No common date range');
      return rowShell(p.book, {
        status: run.length ? 'short' : 'gap',
        reason,
        metricReasons: blankReasons(reason),
      });
    }
    const covered = [];
    const leftOut = [];
    for (const h of p.holdings) {
      const map = byRef.get(h.instrumentId) || new Map();
      if (covers(map, slice)) covered.push(h);
      else leftOut.push({ symbol: h.symbol || h.instrumentId, weight: h.weight });
    }
    leftOut.sort((a, b) => b.weight - a.weight || String(a.symbol).localeCompare(String(b.symbol)));
    const total = p.holdings.reduce((s, h) => s + h.weight, 0);
    const coveredW = covered.reduce((s, h) => s + h.weight, 0);
    const coverage = total > 0 ? coveredW / total : 0;
    const partial = coveredW < total - 1e-9;
    const label = benchmarkLabel(p.book.benchmark);

    if (!covered.length) {
      const reason = 'No full monthly series';
      return rowShell(p.book, {
        status: 'uncovered',
        reason,
        coverage,
        partial: true,
        leftOut,
        benchmarkLabel: label,
        metricReasons: blankReasons(reason),
      });
    }

    const sleeves = (p.book.benchmark || []).filter((b) => b && b.weight > 0 && b.symbol);
    let benchStatus = 'none';
    let benchRets = null;
    if (sleeves.length) {
      const ok = sleeves.every((b) => covers(bySymbol.get(String(b.symbol).toUpperCase()) || new Map(), slice));
      if (!ok) benchStatus = 'gap';
      else {
        const refs = sleeves.map((b) => ({ ref: String(b.symbol).toUpperCase(), weight: Number(b.weight) }));
        benchRets = blend(refs, bySymbol, slice);
        benchStatus = benchRets ? 'ok' : 'gap';
      }
    }
    const modelRets = blend(
      covered.map((h) => ({ ref: h.instrumentId, weight: h.weight })),
      byRef,
      slice,
    );
    if (!modelRets) {
      const reason = 'Could not align months';
      return rowShell(p.book, {
        status: 'gap',
        reason,
        coverage,
        partial,
        leftOut,
        benchmarkLabel: label,
        metricReasons: blankReasons(reason),
      });
    }
    const metrics = riskMetrics(modelRets, benchStatus === 'ok' ? benchRets : slice.map(() => null), rf);
    return rowShell(p.book, {
      status: 'ok',
      reason: null,
      coverage,
      partial,
      leftOut,
      benchmarkLabel: label,
      metrics,
      metricReasons: metricReasons(metrics, benchStatus),
    });
  });

  return {
    rf,
    asOf: today,
    lastCompleteMonth: lastComplete,
    period: resolved.period,
    requestedPeriod: resolved.requestedPeriod ?? (period ? String(period).trim().toLowerCase() : null),
    availablePeriods: available,
    unavailableReason,
    common,
    range: slice ? { start: slice[0], end: slice[slice.length - 1], months: slice.length } : null,
    months: slice || [],
    staleEnd: !!(common && lastComplete && common.end < lastComplete),
    models,
  };
}

async function readInstrument(store, id) {
  if (typeof store.getInstrumentCore === 'function') {
    const core = await store.getInstrumentCore(id);
    if (core) return core;
  }
  if (typeof store.getInstrument === 'function') return store.getInstrument(id);
  return null;
}

async function readNav(store, id) {
  if (typeof store.getMonthEndNav === 'function') {
    const rows = await store.getMonthEndNav(id);
    return rows || [];
  }
  if (typeof store.getNavSeries === 'function') return store.getNavSeries(id);
  return [];
}

async function readPrices(store, symbol) {
  if (typeof store.getMonthEndPrices === 'function') {
    const rec = await store.getMonthEndPrices(symbol);
    if (!rec) return [];
    return rec.series || [];
  }
  if (typeof store.getPriceHistory === 'function') {
    const rec = await store.getPriceHistory(symbol);
    return rec?.series || [];
  }
  return [];
}

// Same rule as currentVersionOf, pinned to the as-of date the window uses.
function versionOn(model, day) {
  const versions = model?.versions || [];
  if (!versions.length) return null;
  const applicable = versions
    .filter((v) => v.effectiveDate <= day)
    .sort((a, b) => a.effectiveDate.localeCompare(b.effectiveDate));
  if (applicable.length) return applicable[applicable.length - 1];
  return [...versions].sort((a, b) => a.effectiveDate.localeCompare(b.effectiveDate))[0];
}

export async function loadCompareRisk(store, { period, rf = 0.04, asOf } = {}) {
  const rawPeriod = period == null ? '' : String(period).trim().toLowerCase();
  if (rawPeriod && !PERIODS.includes(rawPeriod)) {
    return { error: 'period must be 1y, 3y, 5y, or max', status: 400 };
  }
  const day = String(asOf || new Date().toISOString().slice(0, 10)).slice(0, 10);
  const models = await store.listModels();
  const drafts = [];
  const navIds = new Set();
  for (const m of models) {
    const cv = versionOn(m, day);
    const holdings = [];
    for (const h of cv?.holdings || []) {
      if (!(Number(h.weight) > 0) || !h.instrumentId) continue;
      holdings.push({ instrumentId: h.instrumentId, weight: Number(h.weight) });
      navIds.add(h.instrumentId);
    }
    drafts.push({
      key: m.key,
      name: m.name,
      riskRank: m.riskRank,
      benchmark: m.benchmark || [],
      versionId: cv?.id ?? null,
      effectiveDate: cv?.effectiveDate ?? null,
      holdings,
    });
  }

  const instById = new Map();
  const navById = new Map();
  for (const id of navIds) {
    instById.set(id, await readInstrument(store, id));
    navById.set(id, await readNav(store, id));
  }

  const priceSymbols = new Set();
  for (const book of drafts) {
    if (!book.holdings.length) continue;
    for (const b of book.benchmark || []) {
      if (b?.symbol) priceSymbols.add(String(b.symbol).trim().toUpperCase());
    }
    for (const h of book.holdings) {
      const inst = instById.get(h.instrumentId);
      const nav = navById.get(h.instrumentId) || [];
      const decision = decidePricePath(
        inst || { source: 'manual' },
        nav.map((p) => ({ date: p.date, nav: p.nav ?? p.close ?? p.value })),
      );
      h.symbol = inst?.symbol || null;
      h.path = decision.path;
      h.monthlyPriceable = isMonthlyPriceableInstrument(inst);
      if (h.monthlyPriceable && h.symbol) priceSymbols.add(String(h.symbol).trim().toUpperCase());
    }
  }

  const seriesBySymbol = {};
  for (const symbol of priceSymbols) {
    seriesBySymbol[symbol] = await readPrices(store, symbol);
  }
  const lastYm = lastCompleteMonth(day);
  const seriesByRef = {};
  for (const book of drafts) {
    for (const h of book.holdings) {
      if (seriesByRef[h.instrumentId]) continue;
      const navSeries = navById.get(h.instrumentId) || [];
      const priceSeries = seriesBySymbol[String(h.symbol || '').toUpperCase()] || [];
      if (!h.monthlyPriceable) {
        seriesByRef[h.instrumentId] = navSeries;
        continue;
      }
      // One typed NAV must not hide a backfilled month-end cache. A real
      // uploaded NAV still wins when it has the longer monthly run.
      const priceN = monthlySupportCount(priceSeries, lastYm);
      const navN = monthlySupportCount(navSeries, lastYm);
      seriesByRef[h.instrumentId] = priceN >= navN ? priceSeries : navSeries;
    }
  }
  return buildCompareRisk(drafts, seriesByRef, seriesBySymbol, { period, rf, asOf });
}

export function createCompareRiskHandler(store, { today } = {}) {
  return async (req, res) => {
    try {
      const asOf = String(today ? today() : new Date().toISOString()).slice(0, 10);
      const payload = await loadCompareRisk(store, {
        period: req.query.period,
        rf: parseRfPercent(req.query.rf),
        asOf,
      });
      if (payload.error) return res.status(payload.status || 400).json({ error: payload.error });
      res.json(payload);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  };
}
