// alerts/refresh.js — refresh stale auto-priced closes for alert checks.
//
// Only current-model holdings that are source=auto stock/ETF with no NAV
// series. Manual NAV, Cash, private/alt, and anything already on nav_series
// are never touched. Oldest last close first; capped per run. Honors the
// history-cache fail cooldown and provider 429 cooldowns (force: false).

import { decidePricePath } from '../navPrice.js';
import { isCashInstrument, todayToronto } from '../nav.js';
import {
  lastCloseDate,
  lastCloseNeedsRefresh,
  normalizeSeries,
} from '../historyCache.js';

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

/**
 * Pick auto holdings whose last cached close is more than ~1 trading day old.
 * Returns oldest-first, capped.
 */
export function planAutoPriceRefresh(candidates, {
  today = todayToronto(),
  cap = ALERT_REFRESH_CAP,
} = {}) {
  const need = [];
  for (const c of candidates || []) {
    if (!c?.refreshable) continue;
    const lastClose = candidateLastClose(c);
    if (!lastCloseNeedsRefresh(lastClose, today)) continue;
    need.push({
      instrumentId: c.instrumentId,
      symbol: c.symbol,
      name: c.name || null,
      lastClose: lastClose || null,
    });
  }
  return sortOldestFirst(need).slice(0, Math.max(0, Number(cap) || 0));
}

export async function refreshOneAutoHolding(inst, {
  getHistory,
  getPriceHistory,
  nowMs,
  liveMissUntil,
  missBackoffMs,
}) {
  const symbol = String(inst.symbol || '').toUpperCase();
  const before = getPriceHistory ? await getPriceHistory(inst.symbol) : null;
  const beforeClose = lastCloseOf(before?.series);

  if (typeof getHistory !== 'function') {
    return {
      symbol,
      instrumentId: inst.id,
      status: 'failed',
      error: 'No history fetcher configured',
      lastClose: beforeClose,
      priceAsOf: beforeClose,
    };
  }

  if (nowMs < (liveMissUntil?.get(symbol) || 0)) {
    return {
      symbol,
      instrumentId: inst.id,
      status: 'cooldown',
      error: 'Backed off after a recent total miss',
      lastClose: beforeClose,
      priceAsOf: beforeClose,
    };
  }

  try {
    // force:false — history cache still honors provider cooldown + fail window.
    const h = await getHistory(inst.symbol, 'max', { force: false });
    if (!h?.series?.length) {
      liveMissUntil?.set(symbol, nowMs + missBackoffMs);
      return {
        symbol,
        instrumentId: inst.id,
        status: 'failed',
        error: 'No series returned',
        lastClose: beforeClose,
        priceAsOf: beforeClose,
      };
    }

    const afterClose = lastCloseOf(h.series);
    liveMissUntil?.delete(symbol);

    if (h.stale) {
      return {
        symbol,
        instrumentId: inst.id,
        status: 'failed',
        error: h.error || 'Live providers unavailable — cache unchanged',
        lastClose: afterClose,
        priceAsOf: afterClose,
        stale: true,
      };
    }

    const extended = afterClose && afterClose !== beforeClose;
    return {
      symbol,
      instrumentId: inst.id,
      status: extended || h.quoteAppended ? 'updated' : 'unchanged',
      lastClose: afterClose,
      priceAsOf: afterClose,
      provider: h.provider || null,
      quoteAppended: !!h.quoteAppended,
      series: normalizeSeries(h.series),
      fetchedAt: h.fetchedAt || new Date(nowMs).toISOString(),
    };
  } catch (e) {
    liveMissUntil?.set(symbol, nowMs + missBackoffMs);
    return {
      symbol,
      instrumentId: inst.id,
      status: 'failed',
      error: e.message,
      lastClose: beforeClose,
      priceAsOf: beforeClose,
    };
  }
}
