// alerts/refresh.js — refresh stale auto-priced closes for alert checks.
//
// Only current-model holdings that are source=auto stock/ETF with no NAV
// series. Manual NAV, Cash, private/alt, and anything already on nav_series
// are never touched. Oldest or missing last close first, then the per-run
// cap. Holdings already inside a total-miss backoff do not take a cap slot;
// the next run picks up the next oldest eligible name.
//
// A manual Check now / Refresh prices now passes bypassMissBackoff and
// force:true so the per-holding timer is skipped. Per-provider cooldowns
// still apply inside the provider chain.

import { decidePricePath } from '../navPrice.js';
import { isCashInstrument, todayToronto } from '../nav.js';
import { classifyAttempts } from '../failureClass.js';
import {
  lastCloseDate,
  lastCloseNeedsRefresh,
  normalizeSeries,
} from '../historyCache.js';
import {
  formatHoldingRefreshLine,
  formatRetryClock,
  nextMissState,
  reasonTextFor,
  skippedCooldownHops,
} from './missBackoff.js';

export const ALERT_REFRESH_CAP = 8;
export const BREACH_PENDING_FRESH = 'breach pending fresh data';

export function isAutoPricedMarket(inst) {
  if (!inst) return false;
  if (isCashInstrument(inst)) return false;
  if (inst.source !== 'auto') return false;
  if (inst.type !== 'stock' && inst.type !== 'etf') return false;
  return true;
}

/** Eligible for a live price_history refresh — never NAV-backed names. */
export function isRefreshableAutoHolding(inst, navSeries) {
  if (!isAutoPricedMarket(inst)) return false;
  const path = decidePricePath(inst, navSeries || []);
  if (path.path === 'nav_series' && path.series.length) return false;
  return true;
}

export function lastCloseOf(series) {
  return lastCloseDate(series);
}

/** Explicit `lastClose` wins so a planner can drop the series after reading the date. */
export function candidateLastClose(candidate) {
  if (candidate && Object.prototype.hasOwnProperty.call(candidate, 'lastClose')) {
    return candidate.lastClose || null;
  }
  return lastCloseOf(candidate?.historySeries);
}

export function sortOldestFirst(rows) {
  return [...rows].sort((a, b) => {
    const da = a.lastClose || '';
    const db = b.lastClose || '';
    if (da !== db) {
      if (!da) return -1;
      if (!db) return 1;
      return da.localeCompare(db);
    }
    return String(a.symbol || '').localeCompare(String(b.symbol || ''));
  });
}

function refreshRow(c, lastClose) {
  return {
    instrumentId: c.instrumentId,
    symbol: c.symbol,
    name: c.name || null,
    lastClose: lastClose || null,
  };
}

/**
 * Split names that need a refresh into ones we may call now and ones still
 * inside a per-holding backoff. Cap slots come from the eligible list only,
 * oldest (or missing) history first, so a backed-off name cannot crowd out
 * a holding that could actually move.
 */
export function splitRefreshCandidates(candidates, {
  today = todayToronto(),
  isCooling = () => false,
} = {}) {
  const eligible = [];
  const cooling = [];
  for (const c of candidates || []) {
    if (!c?.refreshable) continue;
    const lastClose = candidateLastClose(c);
    if (!lastCloseNeedsRefresh(lastClose, today)) continue;
    const row = refreshRow(c, lastClose);
    if (isCooling(c, row)) cooling.push(row);
    else eligible.push(row);
  }
  return {
    eligible: sortOldestFirst(eligible),
    cooling: sortOldestFirst(cooling),
  };
}

/**
 * Pick auto holdings whose last cached close is more than ~1 trading day old.
 * Returns oldest-first, capped. Pass `isCooling` to leave backoff holds out.
 */
export function planAutoPriceRefresh(candidates, {
  today = todayToronto(),
  cap = ALERT_REFRESH_CAP,
  isCooling = () => false,
} = {}) {
  const { eligible } = splitRefreshCandidates(candidates, { today, isCooling });
  return eligible.slice(0, Math.max(0, Number(cap) || 0));
}

function decorate(row) {
  const reasonText = row.reasonText || (row.reason ? reasonTextFor(row.reason) : null);
  const retryAfter = row.retryAfter || null;
  const full = {
    ...row,
    reasonText: reasonText || null,
    retryAfter,
    retryAfterLabel: row.retryAfterLabel || (retryAfter ? formatRetryClock(retryAfter) : null),
    skippedHops: row.skippedHops || [],
  };
  full.line = formatHoldingRefreshLine(full);
  return full;
}

export function describeBackoffHold({ symbol, instrumentId, lastClose, rec }) {
  return decorate({
    symbol: String(symbol || '').toUpperCase(),
    instrumentId,
    status: 'cooldown',
    reason: rec?.reason || 'total-miss',
    error: 'Backed off after a recent total miss',
    lastClose: lastClose || null,
    priceAsOf: lastClose || null,
    retryAfter: rec?.until ? new Date(rec.until).toISOString() : null,
  });
}

function reasonFromFailure(err) {
  const attempts = err?.attempts || [];
  const classified = err?.classified || classifyAttempts(attempts);
  if (classified.allNotFound || (err?.notFound && !classified.anyRateLimit)) return 'not-found';
  if (classified.anyRateLimit) return 'rate-limit';
  const msg = String(err?.message || '');
  if (/429|403|rate limit|cooldown|cooling down|too many/i.test(msg)) return 'rate-limit';
  if (/not\s*found|no data|does not know|unknown symbol/i.test(msg)) return 'not-found';
  return 'total-miss';
}

function earliestCooldownMs(attempts) {
  let earliest = null;
  for (const a of attempts || []) {
    const t = Date.parse(a?.cooldownUntil || '');
    if (!Number.isFinite(t)) continue;
    if (earliest == null || t < earliest) earliest = t;
  }
  return earliest;
}

function finishMiss({
  symbol,
  instrumentId,
  lastClose,
  priceAsOf,
  hasHistory,
  state,
  nowMs,
  liveMissUntil,
  reason,
  error,
  skippedHops,
  attempts,
  countStrike = true,
  stale = false,
}) {
  const allSkipped = Array.isArray(attempts) && attempts.length > 0 && attempts.every((a) => a.skipped);
  const useReason = allSkipped ? 'provider-cooldown' : reason;
  const next = nextMissState(state, {
    nowMs,
    hasHistory,
    reason: useReason,
    countStrike: allSkipped ? false : countStrike,
    earliestCooldownMs: allSkipped ? earliestCooldownMs(attempts) : null,
  });
  liveMissUntil?.set(symbol, next);
  return decorate({
    symbol,
    instrumentId,
    status: allSkipped ? 'cooldown' : 'failed',
    reason: next.reason,
    error: error || 'Price lookup failed',
    lastClose: lastClose || null,
    priceAsOf: priceAsOf || lastClose || null,
    retryAfter: new Date(next.until).toISOString(),
    skippedHops: skippedHops || skippedCooldownHops(attempts),
    stale,
  });
}

export async function refreshOneAutoHolding(inst, {
  getHistory,
  getPriceHistory,
  nowMs,
  liveMissUntil,
  bypassMissBackoff = false,
} = {}) {
  const symbol = String(inst.symbol || '').toUpperCase();
  const before = getPriceHistory ? await getPriceHistory(inst.symbol) : null;
  const beforeClose = lastCloseOf(before?.series);
  const hasHistory = !!before?.series?.length;
  const state = liveMissUntil?.get(symbol) || null;

  if (typeof getHistory !== 'function') {
    return decorate({
      symbol,
      instrumentId: inst.id,
      status: 'failed',
      error: 'No history fetcher configured',
      lastClose: beforeClose,
      priceAsOf: beforeClose,
    });
  }

  if (!bypassMissBackoff && state && nowMs < state.until) {
    return describeBackoffHold({
      symbol,
      instrumentId: inst.id,
      lastClose: beforeClose,
      rec: state,
    });
  }

  try {
    const h = await getHistory(inst.symbol, 'max', { force: !!bypassMissBackoff });
    const skippedHops = skippedCooldownHops(h?.attempts);
    if (!h?.series?.length) {
      return finishMiss({
        symbol,
        instrumentId: inst.id,
        lastClose: beforeClose,
        priceAsOf: beforeClose,
        hasHistory,
        state,
        nowMs,
        liveMissUntil,
        reason: 'total-miss',
        error: 'No series returned',
        skippedHops,
        attempts: h?.attempts,
      });
    }

    const afterClose = lastCloseOf(h.series);
    const cacheWindow = !!(h.stale && h.fromCache && /recently failed/i.test(h.error || ''));
    if (cacheWindow) {
      return decorate({
        symbol,
        instrumentId: inst.id,
        status: 'failed',
        error: h.error || 'Live providers unavailable — cache unchanged',
        lastClose: afterClose,
        priceAsOf: afterClose,
        stale: true,
        skippedHops,
        reason: state?.reason || 'rate-limit',
        retryAfter: state?.until && state.until > nowMs ? new Date(state.until).toISOString() : null,
      });
    }

    if (h.stale && h.fromCache) {
      return finishMiss({
        symbol,
        instrumentId: inst.id,
        lastClose: afterClose,
        priceAsOf: afterClose,
        hasHistory,
        state,
        nowMs,
        liveMissUntil,
        reason: reasonFromFailure({ attempts: h.attempts, message: h.error }),
        error: h.error || 'Live providers unavailable — cache unchanged',
        skippedHops,
        attempts: h.attempts,
        stale: true,
      });
    }

    // A provider answered. Reset the ladder even if the last close did not move.
    liveMissUntil?.delete(symbol);
    if (h.stale) {
      return decorate({
        symbol,
        instrumentId: inst.id,
        status: 'failed',
        error: h.error || 'Live history did not extend the last close',
        lastClose: afterClose,
        priceAsOf: afterClose,
        stale: true,
        skippedHops,
        provider: h.provider || null,
      });
    }

    const extended = afterClose && afterClose !== beforeClose;
    return decorate({
      symbol,
      instrumentId: inst.id,
      status: extended || h.quoteAppended ? 'updated' : 'unchanged',
      lastClose: afterClose,
      priceAsOf: afterClose,
      provider: h.provider || null,
      quoteAppended: !!h.quoteAppended,
      series: normalizeSeries(h.series),
      fetchedAt: h.fetchedAt || new Date(nowMs).toISOString(),
      skippedHops,
    });
  } catch (e) {
    const attempts = e?.attempts || [];
    return finishMiss({
      symbol,
      instrumentId: inst.id,
      lastClose: beforeClose,
      priceAsOf: beforeClose,
      hasHistory,
      state,
      nowMs,
      liveMissUntil,
      reason: reasonFromFailure(e),
      error: e.message,
      skippedHops: skippedCooldownHops(attempts),
      attempts,
    });
  }
}
