// historyBackfill.js — fill month-end history for listed holdings.
//
// A listed stock or ETF that was saved with one typed price is source=manual.
// Alert refresh only walks source=auto, so the price cache never receives a
// series and compare has no month-end rows. This job asks the existing
// history cache (provider chain, cooldown, merge) for max history.
//
// It is safe to run on boot and on a timer: symbols that already have a
// continuous month-end run through the last finished month are skipped, a
// recent total miss is not retried, and each run stops after a small cap.
// Cash, private/alt sleeves, mutual funds, and Fundserv codes are never
// fetched. Nothing here writes a model version or invents a price.

import { currentVersionOf } from './util.js';
import { isFundservCode, isMonthlyPriceableInstrument } from './listing.js';
import { addMonths, lastCompleteMonth, supportMonths } from './compareRisk.js';
import { providersForSymbol } from './providers.js';
import { isCoolingDown } from './providerCooldown.js';
import { classifyAttempts } from './failureClass.js';
import { nextMissState } from './alerts/missBackoff.js';

export const BACKFILL_CAP = 4;
export const BACKFILL_INTERVAL_MS = 30 * 60 * 1000;

export function monthlyHistoryComplete({
  monthEnds,
  pointCount = 0,
  range = 'max',
  lastComplete,
} = {}) {
  const byYm = new Map();
  for (const p of monthEnds || []) {
    const ym = String(p?.date || '').slice(0, 7);
    if (!/^\d{4}-\d{2}$/.test(ym)) continue;
    if (lastComplete && ym > lastComplete) continue;
    byYm.set(ym, p.close ?? p.nav ?? true);
  }
  const support = [...supportMonths(byYm)].sort();
  if (support.length < 2) return false;
  const first = support[0];
  const last = support[support.length - 1];
  if (lastComplete && last < lastComplete) return false;
  const set = new Set(support);
  let ym = first;
  while (ym <= last) {
    if (!set.has(ym)) return false;
    if (ym === last) break;
    ym = addMonths(ym, 1);
  }
  const span = support.length;
  const points = Number(pointCount) || 0;
  if (span >= 24 && points >= span) return true;
  // A real max fetch of a short listing (or a dense recent window the
  // provider returned in full). A one-day quote does not get here.
  if ((range || 'max') === 'max' && points >= 40 && span >= 2) return true;
  return false;
}

function benchmarkWorthFetching(symbol) {
  const s = String(symbol || '').trim().toUpperCase();
  if (!s || s === 'CASH') return false;
  if (isFundservCode(s)) return false;
  return true;
}

export function planHistoryBackfill(rows, { cap = BACKFILL_CAP, isCooling = () => false } = {}) {
  const pending = [];
  const skipped = [];
  const cooling = [];
  for (const row of rows || []) {
    if (!row?.symbol) continue;
    if (row.complete) {
      skipped.push(row.symbol);
      continue;
    }
    if (isCooling(row)) {
      cooling.push(row.symbol);
      continue;
    }
    pending.push(row);
  }
  pending.sort((a, b) => {
    const sa = Number(a.supportMonths) || 0;
    const sb = Number(b.supportMonths) || 0;
    if (sa !== sb) return sa - sb;
    const la = a.lastMonth || '';
    const lb = b.lastMonth || '';
    if (la !== lb) return la < lb ? -1 : 1;
    return String(a.symbol).localeCompare(String(b.symbol));
  });
  const limit = Math.max(0, Number(cap) || 0);
  return {
    fetch: pending.slice(0, limit),
    deferred: pending.slice(limit).map((r) => r.symbol),
    skipped,
    cooling,
  };
}

function chainCooling(symbol) {
  const hops = providersForSymbol(symbol).filter((p) => !p.supports || p.supports(symbol));
  return hops.length > 0 && hops.every((p) => isCoolingDown(p.id));
}

function supportCount(monthEnds, lastComplete) {
  const byYm = new Map();
  for (const p of monthEnds || []) {
    const ym = String(p?.date || '').slice(0, 7);
    if (!/^\d{4}-\d{2}$/.test(ym)) continue;
    if (lastComplete && ym > lastComplete) continue;
    byYm.set(ym, true);
  }
  return supportMonths(byYm).size;
}

function lastSupportMonth(monthEnds, lastComplete) {
  let last = '';
  for (const p of monthEnds || []) {
    const ym = String(p?.date || '').slice(0, 7);
    if (!/^\d{4}-\d{2}$/.test(ym)) continue;
    if (lastComplete && ym > lastComplete) continue;
    if (ym > last) last = ym;
  }
  return last;
}

async function readInstrument(store, id) {
  if (typeof store.getInstrumentCore === 'function') {
    const core = await store.getInstrumentCore(id);
    if (core) return core;
  }
  if (typeof store.getInstrument === 'function') return store.getInstrument(id);
  return null;
}

async function readMonthEnds(store, symbol) {
  if (typeof store.getMonthEndPrices === 'function') {
    const rec = await store.getMonthEndPrices(symbol);
    return rec?.series || [];
  }
  if (typeof store.getPriceHistory === 'function') {
    const rec = await store.getPriceHistory(symbol);
    return rec?.series || [];
  }
  return [];
}

export async function collectBackfillRows(store, { asOf, lastComplete } = {}) {
  const models = await store.listModels();
  const bySymbol = new Map();
  for (const model of models || []) {
    const version = currentVersionOf(model);
    for (const h of version?.holdings || []) {
      if (!(Number(h.weight) > 0) || !h.instrumentId) continue;
      const inst = await readInstrument(store, h.instrumentId);
      if (!isMonthlyPriceableInstrument(inst)) continue;
      const symbol = String(inst.symbol || '').trim().toUpperCase();
      if (!symbol || bySymbol.has(symbol)) continue;
      bySymbol.set(symbol, inst);
    }
    for (const b of model?.benchmark || []) {
      if (!(Number(b?.weight) > 0) || !benchmarkWorthFetching(b.symbol)) continue;
      const symbol = String(b.symbol).trim().toUpperCase();
      if (bySymbol.has(symbol)) continue;
      bySymbol.set(symbol, { symbol, type: 'etf', source: 'auto' });
    }
  }

  const rows = [];
  for (const [symbol, inst] of bySymbol) {
    const monthEnds = await readMonthEnds(store, symbol);
    const meta = typeof store.getPriceHistoryMeta === 'function'
      ? await store.getPriceHistoryMeta(symbol)
      : null;
    const pointCount = meta?.pointCount != null ? Number(meta.pointCount) : monthEnds.length;
    const range = meta?.range || 'max';
    rows.push({
      symbol,
      instrumentId: inst.id || null,
      supportMonths: supportCount(monthEnds, lastComplete),
      lastMonth: lastSupportMonth(monthEnds, lastComplete),
      complete: monthlyHistoryComplete({ monthEnds, pointCount, range, lastComplete }),
    });
  }
  return { rows, asOf: asOf || null, lastComplete };
}

function missReason(err) {
  const classified = err?.classified || classifyAttempts(err?.attempts || []);
  if (classified.allNotFound || err?.notFound) return 'not-found';
  if (classified.anyRateLimit) return 'rate-limit';
  const msg = String(err?.message || '');
  if (/429|403|rate limit|cooldown|cooling down/i.test(msg)) return 'rate-limit';
  return 'total-miss';
}

export function createHistoryBackfill({
  store,
  getHistory,
  cap = BACKFILL_CAP,
  now = () => Date.now(),
  today = () => new Date().toISOString().slice(0, 10),
  chainIsCooling = chainCooling,
} = {}) {
  if (!store) throw new Error('createHistoryBackfill requires a store');
  if (typeof getHistory !== 'function') throw new Error('createHistoryBackfill requires getHistory');
  const missUntil = new Map();

  async function run() {
    const asOf = String(today()).slice(0, 10);
    const lastComplete = lastCompleteMonth(asOf);
    const { rows } = await collectBackfillRows(store, { asOf, lastComplete });
    const nowMs = now();
    const plan = planHistoryBackfill(rows, {
      cap,
      isCooling: (row) => {
        const rec = missUntil.get(row.symbol);
        if (rec && nowMs < rec.until) return true;
        return chainIsCooling(row.symbol);
      },
    });
    const results = [];
    for (const row of plan.fetch) {
      if (chainIsCooling(row.symbol)) {
        results.push({ symbol: row.symbol, status: 'cooldown' });
        continue;
      }
      try {
        const got = await getHistory(row.symbol, 'max', { bypassFresh: true, omitSeries: true });
        const staleMiss = !!(got?.stale && got?.fromCache);
        if (staleMiss) {
          const prev = missUntil.get(row.symbol);
          missUntil.set(row.symbol, nextMissState(prev, {
            nowMs,
            hasHistory: (row.supportMonths || 0) > 0,
            reason: 'rate-limit',
          }));
          results.push({ symbol: row.symbol, status: 'failed', error: got.error || 'Cached series is still short' });
          continue;
        }
        missUntil.delete(row.symbol);
        results.push({
          symbol: row.symbol,
          status: 'fetched',
          pointCount: got?.pointCount ?? got?.series?.length ?? null,
        });
      } catch (err) {
        const prev = missUntil.get(row.symbol);
        missUntil.set(row.symbol, nextMissState(prev, {
          nowMs,
          hasHistory: (row.supportMonths || 0) > 0,
          reason: missReason(err),
        }));
        results.push({ symbol: row.symbol, status: 'failed', error: err?.message || 'Price history failed' });
      }
    }
    return {
      asOf,
      lastComplete,
      checked: rows.length,
      fetched: results.filter((r) => r.status === 'fetched').length,
      failed: results.filter((r) => r.status === 'failed').length,
      skipped: plan.skipped.length,
      deferred: plan.deferred.length,
      cooling: plan.cooling.length + results.filter((r) => r.status === 'cooldown').length,
      results,
    };
  }

  return { run };
}

export function startHistoryBackfill({
  run,
  intervalMs = BACKFILL_INTERVAL_MS,
  logger = console,
} = {}) {
  if (typeof run !== 'function') throw new Error('startHistoryBackfill requires run()');
  let inflight = null;
  const tick = () => {
    if (inflight) {
      logger.log('[history] backfill already running');
      return;
    }
    inflight = Promise.resolve()
      .then(() => run())
      .then((summary) => {
        if (!summary) return;
        logger.log(
          `[history] backfill checked ${summary.checked ?? 0}, fetched ${summary.fetched ?? 0}, skipped ${summary.skipped ?? 0}, failed ${summary.failed ?? 0}`,
        );
      })
      .catch((e) => logger.error(`[history] backfill failed: ${e.message}`))
      .finally(() => { inflight = null; });
  };
  tick();
  const interval = setInterval(tick, intervalMs);
  if (typeof interval.unref === 'function') interval.unref();
  return () => clearInterval(interval);
}
