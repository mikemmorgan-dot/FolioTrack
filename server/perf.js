// perf.js — return & attribution engine.
// The core (computeCore) is pure and deterministic: it takes monthly return
// matrices and returns the full payload, so it can be unit-tested without any
// network. runPerformance() wires live data (Yahoo history + manual NAVs) into it.

import { currentVersionOf } from './util.js';

// ---------- date / grid helpers ----------
export const ymOf = (dateStr) => dateStr.slice(0, 7);

export function monthEndDate(ym) {
  const [y, m] = ym.split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
}
const firstDayOf = (ym) => `${ym}-01`;

export function monthGrid(startYm, endYm) {
  const out = [];
  let [y, m] = startYm.split('-').map(Number);
  const [ey, em] = endYm.split('-').map(Number);
  while (y < ey || (y === ey && m <= em)) {
    out.push(`${y}-${String(m).padStart(2, '0')}`);
    m++; if (m > 12) { m = 1; y++; }
  }
  return out;
}

// Level on each grid month = last observation with date <= that month-end
// (forward-fill). Handles daily closes and sparse NAVs uniformly. null before
// the first observation.
export function levelsOnGrid(observations, grid) {
  const obs = [...observations].sort((a, b) => a.date.localeCompare(b.date));
  const levels = {};
  let idx = 0, last = null;
  for (const ym of grid) {
    const end = monthEndDate(ym);
    while (idx < obs.length && obs[idx].date <= end) { last = obs[idx].value; idx++; }
    levels[ym] = last; // null until first obs
  }
  return levels;
}

export function monthlyReturnsFromLevels(levels, grid) {
  const r = {};
  for (let i = 1; i < grid.length; i++) {
    const a = levels[grid[i - 1]], b = levels[grid[i]];
    r[grid[i]] = a != null && b != null && a !== 0 ? b / a - 1 : null;
  }
  return r;
}

const cumProduct = (rets) => rets.reduce((acc, x) => acc * (1 + (x || 0)), 1) - 1;
const annualize = (totalRet, nMonths) => (nMonths >= 12 ? Math.pow(1 + totalRet, 12 / nMonths) - 1 : null);

function pickVersion(versionsAsc, dayStr) {
  let chosen = null;
  for (const v of versionsAsc) if (v.effectiveDate <= dayStr) chosen = v;
  return chosen;
}

// Weighted monthly return over a version's holdings for month `ym`, renormalized
// to the holdings that actually have data that month. Returns {ret, coverage}.
function versionReturnForMonth(version, ym, instReturns, totalWeight) {
  let num = 0, wsum = 0;
  for (const h of version.holdings) {
    const r = instReturns[h.instrumentId]?.[ym];
    if (r == null) continue;
    num += h.weight * r; wsum += h.weight;
  }
  return { ret: wsum > 0 ? num / wsum : null, coverage: totalWeight > 0 ? wsum / totalWeight : 0 };
}

const sumWeights = (v) => v.holdings.reduce((s, h) => s + h.weight, 0);

// ---------- pure core ----------
export function computeCore({ grid, versions, instReturns, benchMonthly, instMeta = {}, basis = 10000, today }) {
  const versionsAsc = [...versions].sort((a, b) => a.effectiveDate.localeCompare(b.effectiveDate));
  const nowYm = ymOf(today || new Date().toISOString().slice(0, 10));

  // ---- model monthly series ----
  const modelR = {}, coverage = {};
  for (let i = 1; i < grid.length; i++) {
    const ym = grid[i];
    const v = pickVersion(versionsAsc, firstDayOf(ym));
    if (!v) { modelR[ym] = null; coverage[ym] = 0; continue; }
    const { ret, coverage: cov } = versionReturnForMonth(v, ym, instReturns, sumWeights(v));
    modelR[ym] = ret; coverage[ym] = cov;
  }

  // cumulative growth-of-basis, starting at first month with a model return
  const startIdx = grid.findIndex((ym) => modelR[ym] != null);
  const seriesMonths = startIdx > 0 ? grid.slice(startIdx - 1) : [];
  const build = (retFn) => {
    const pts = []; let lvl = basis;
    for (let i = 0; i < seriesMonths.length; i++) {
      const ym = seriesMonths[i];
      if (i === 0) { pts.push({ ym, value: basis, ret: 0 }); continue; }
      const r = retFn(ym) || 0; lvl *= 1 + r;
      pts.push({ ym, value: +lvl.toFixed(2), ret: r });
    }
    return pts;
  };
  const modelCum = build((ym) => modelR[ym]);
  const benchCum = build((ym) => benchMonthly[ym]);

  const monthsElapsed = Math.max(0, seriesMonths.length - 1);
  const modelTotal = modelCum.length ? modelCum[modelCum.length - 1].value / basis - 1 : 0;
  const benchTotal = benchCum.length ? benchCum[benchCum.length - 1].value / basis - 1 : 0;

  // ---- period returns (inception / 1Y / YTD) ----
  const retsIn = (months, fn) => cumProduct(months.map(fn));
  const period = (months) => ({
    model: retsIn(months, (ym) => modelR[ym]),
    benchmark: retsIn(months, (ym) => benchMonthly[ym]),
  });
  const activeMonths = seriesMonths.slice(1);
  const last12 = activeMonths.slice(-12);
  const ytd = activeMonths.filter((ym) => ym.slice(0, 4) === nowYm.slice(0, 4));
  const mk = (label, months, annual) => {
    const p = period(months);
    return {
      label, months: months.length,
      model: p.model, benchmark: p.benchmark, active: p.model - p.benchmark,
      modelAnnualized: annual ? annualize(p.model, months.length) : null,
    };
  };
  const periods = [
    mk('Since inception', activeMonths, true),
    ...(last12.length === 12 ? [mk('1 year', last12, false)] : []),
    ...(ytd.length ? [mk('YTD', ytd, false)] : []),
  ];

  // ---- change attribution ----
  // For each version after the first: return of the new mix over its window vs.
  // holding the PRIOR version's weights over the same window.
  const changes = [];
  for (let i = 1; i < versionsAsc.length; i++) {
    const cur = versionsAsc[i], prev = versionsAsc[i - 1];
    const nextEff = versionsAsc[i + 1]?.effectiveDate ?? '9999-12-31';
    const windowMonths = activeMonths.filter((ym) => {
      const d = firstDayOf(ym);
      return d >= cur.effectiveDate && d < nextEff;
    });
    if (!windowMonths.length) continue;
    const actual = cumProduct(windowMonths.map((ym) => versionReturnForMonth(cur, ym, instReturns, sumWeights(cur)).ret));
    const counter = cumProduct(windowMonths.map((ym) => versionReturnForMonth(prev, ym, instReturns, sumWeights(prev)).ret));
    changes.push({
      effectiveDate: cur.effectiveDate, note: cur.note || 'Model change',
      months: windowMonths.length, actual, counterfactual: counter, valueAdded: actual - counter,
    });
  }
  const totalValueAdded = changes.reduce((s, c) => s + c.valueAdded, 0);

  // ---- contribution over the current version's window ----
  const curV = currentVersionOf({ versions: versionsAsc });
  let contribution = null;
  if (curV) {
    const from = curV.effectiveDate;
    const windowMonths = activeMonths.filter((ym) => firstDayOf(ym) >= from);
    const items = curV.holdings.map((h) => {
      let c = 0, rTot = 1, seen = false;
      for (const ym of windowMonths) {
        const r = instReturns[h.instrumentId]?.[ym];
        if (r == null) continue;
        c += h.weight * r; rTot *= 1 + r; seen = true;
      }
      const meta = instMeta[h.instrumentId] || {};
      return {
        instrumentId: h.instrumentId, symbol: meta.symbol, name: meta.name, type: meta.type,
        weight: h.weight, ret: seen ? rTot - 1 : null, contribution: c,
      };
    }).sort((a, b) => b.contribution - a.contribution);
    contribution = { from, to: nowYm, items, total: items.reduce((s, x) => s + x.contribution, 0) };
  }

  const coverageMin = seriesMonths.slice(1).reduce((m, ym) => Math.min(m, coverage[ym] ?? 0), 1);

  return {
    grid: seriesMonths,
    basis,
    model: { cumulative: modelCum, totalReturn: modelTotal, annualized: annualize(modelTotal, monthsElapsed), months: monthsElapsed },
    benchmark: { cumulative: benchCum, totalReturn: benchTotal, annualized: annualize(benchTotal, monthsElapsed) },
    active: { totalReturn: modelTotal - benchTotal },
    periods,
    changes,
    totalValueAdded,
    contribution,
    coverageMin,
  };
}

// ---------- live data gathering (shared by performance, risk, simulate) ----------
function monthlyForObs(obs, grid) {
  return monthlyReturnsFromLevels(levelsOnGrid(obs, grid), grid);
}

// Gather everything the engines need for a saved model: month grid, per-instrument
// monthly returns (by instrumentId), blended benchmark monthly returns, metadata.
export async function gatherReturns(model, { getInstrument, getNavSeries, getHistory }) {
  const versions = model.versions || [];
  const ids = [...new Set(versions.flatMap((v) => v.holdings.map((h) => h.instrumentId)))];

  const obsByInst = {}; const instMeta = {}; const missing = [];
  let earliest = null;

  for (const id of ids) {
    const inst = await getInstrument(id);
    if (!inst) { missing.push({ id, reason: 'unknown instrument' }); continue; }
    instMeta[id] = { symbol: inst.symbol, name: inst.name, type: inst.type, source: inst.source };
    try {
      let obs;
      if (inst.source === 'auto') {
        obs = (await getHistory(inst.symbol, '5y')).series.map((p) => ({ date: p.date, value: p.close }));
      } else {
        obs = (await getNavSeries(id)).map((p) => ({ date: p.date, value: p.nav }));
      }
      if (!obs.length) { missing.push({ id, symbol: inst.symbol, reason: 'no history' }); continue; }
      obsByInst[id] = obs;
      const first = obs[0].date.slice(0, 7);
      if (!earliest || first < earliest) earliest = first;
    } catch (e) {
      missing.push({ id, symbol: inst.symbol, reason: e.message });
    }
  }

  const benchObs = {}; const benchMissing = [];
  for (const s of model.benchmark || []) {
    try {
      benchObs[s.symbol] = (await getHistory(s.symbol, '5y')).series.map((p) => ({ date: p.date, value: p.close }));
      const first = benchObs[s.symbol][0]?.date.slice(0, 7);
      if (first && (!earliest || first < earliest)) earliest = first;
    } catch (e) {
      benchMissing.push({ symbol: s.symbol, reason: e.message });
    }
  }

  const startYm = earliest || versions[0]?.effectiveDate.slice(0, 7) || new Date().toISOString().slice(0, 7);
  const grid = monthGrid(startYm, new Date().toISOString().slice(0, 7));

  const instReturns = {};
  for (const [id, obs] of Object.entries(obsByInst)) instReturns[id] = monthlyForObs(obs, grid);

  const benchLevels = {};
  for (const [s, obs] of Object.entries(benchObs)) benchLevels[s] = monthlyForObs(obs, grid);
  const benchMonthly = {};
  for (const ym of grid) {
    let num = 0, wsum = 0;
    for (const b of model.benchmark || []) {
      const r = benchLevels[b.symbol]?.[ym];
      if (r == null) continue;
      num += b.weight * r; wsum += b.weight;
    }
    benchMonthly[ym] = wsum > 0 ? num / wsum : null;
  }

  const dataNotes = {
    missingHoldings: missing,
    missingBenchmarkSleeves: benchMissing,
    benchmarkComplete: benchMissing.length === 0 && (model.benchmark || []).length > 0,
  };
  return { grid, instReturns, instMeta, benchMonthly, dataNotes };
}

// Build monthly returns for arbitrary refs (used by the pre-trade simulator, which
// may include brand-new tickers not yet saved). auto → Yahoo history by symbol,
// manual → NAV series by instrumentId (new manual holdings have no series yet).
export async function returnsForRefs(refs, { getNavSeries, getHistory }, grid) {
  const out = {};
  for (const r of refs) {
    if (out[r.ref]) continue;
    try {
      let obs;
      if (r.source === 'auto') {
        obs = (await getHistory(r.symbol, '5y')).series.map((p) => ({ date: p.date, value: p.close }));
      } else if (r.instrumentId) {
        obs = (await getNavSeries(r.instrumentId)).map((p) => ({ date: p.date, value: p.nav }));
      } else {
        obs = [];
      }
      if (obs.length) out[r.ref] = monthlyForObs(obs, grid);
    } catch { /* leave ref uncovered */ }
  }
  return out;
}

export async function runPerformance(model, fetchers) {
  const { grid, instReturns, instMeta, benchMonthly, dataNotes } = await gatherReturns(model, fetchers);
  const core = computeCore({ grid, versions: model.versions, instReturns, benchMonthly, instMeta });
  return { ...core, dataNotes };
}
