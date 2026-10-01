// historyCache.js — persistent, cache-first price history.
//
// Live providers (Yahoo → Twelve Data → Finnhub → Alpha Vantage) are tried
// sequentially and only on a miss/stale cache. A successful series is stored
// and reused for 18h (equities are end-of-day). If every live hop fails but
// we still have a stored series, that series is returned with stale: true
// instead of an empty chart.
//
// Freshness is BOTH fetchedAt within TTL AND a last close that is about one
// trading day current. A row whose fetchedAt was recently written but whose
// last close is weeks old (the PR #6 seed failure mode) is not treated as
// fresh — otherwise live refresh never runs again and alerts stay frozen.

import { getHistory as liveHistory, getQuote as liveQuote } from './providers.js';
import { COOLDOWN_MS } from './providerCooldown.js';
import { calendarDaysBetween, todayToronto } from './nav.js';

export const HISTORY_TTL_MS = 18 * 60 * 60 * 1000;

export function normalizeSymbol(symbol) {
  return String(symbol || '').trim().toUpperCase();
}

export function normalizeSeries(series) {
  const out = [];
  const seen = new Set();
  for (const p of series || []) {
    const date = String(p?.date || '').slice(0, 10);
    const close = Number(p.close ?? p.price ?? p.value ?? p.nav);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(close)) continue;
    if (seen.has(date)) continue;
    seen.add(date);
    out.push({ date, close });
  }
  out.sort((a, b) => a.date.localeCompare(b.date));
  return out;
}

export function mergeSeries(prior, incoming) {
  const map = new Map();
  for (const p of normalizeSeries(prior)) map.set(p.date, p.close);
  for (const p of normalizeSeries(incoming)) map.set(p.date, p.close);
  return [...map.entries()]
    .map(([date, close]) => ({ date, close }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

export function lastCloseDate(series) {
  const pts = normalizeSeries(series);
  return pts.length ? pts[pts.length - 1].date : null;
}

// "About one trading day": last close of today or yesterday is fine; Fri close
// still counts through the weekend and Monday. Anything older needs a refresh.
export function lastCloseNeedsRefresh(lastCloseISO, todayISO = todayToronto()) {
  if (!lastCloseISO) return true;
  const age = calendarDaysBetween(lastCloseISO, todayISO);
  if (age == null) return true;
  if (age <= 1) return false;
  const day = new Date(`${String(todayISO).slice(0, 10)}T12:00:00Z`).getUTCDay();
  // Sun ← Fri is 2 days; Mon ← Fri is 3 days.
  if (day === 0 && age <= 2) return false;
  if (day === 1 && age <= 3) return false;
  return true;
}

export function appendQuotePoint(series, quote, todayISO) {
  const price = Number(quote?.price);
  if (!Number.isFinite(price) || price <= 0) return normalizeSeries(series);
  const date = String(todayISO || todayToronto()).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return normalizeSeries(series);
  return mergeSeries(series, [{ date, close: price }]);
}

const RANGE_DAYS = { '1y': 365, '2y': 730, '5y': 1825 };

export function sliceSeriesForRange(series, range, now = Date.now()) {
  const pts = normalizeSeries(series);
  const days = RANGE_DAYS[range];
  if (!days) return pts;
  const cutoff = new Date(now);
  cutoff.setUTCDate(cutoff.getUTCDate() - days);
  const cut = cutoff.toISOString().slice(0, 10);
  return pts.filter((p) => p.date >= cut);
}

function ageMs(fetchedAt, now) {
  const t = Date.parse(fetchedAt);
  return Number.isFinite(t) ? now - t : Infinity;
}

export function createHistoryCache({
  getPriceHistory,
  putPriceHistory,
  fetchLive = liveHistory,
  fetchQuote = liveQuote,
  now = () => Date.now(),
  today = () => todayToronto(),
  ttlMs = HISTORY_TTL_MS,
  failCooldownMs = COOLDOWN_MS,
} = {}) {
  if (typeof getPriceHistory !== 'function' || typeof putPriceHistory !== 'function') {
    throw new Error('createHistoryCache requires getPriceHistory and putPriceHistory');
  }

  const inflight = new Map();
  const liveFailUntil = new Map();

  function respond(rec, range, extra = {}) {
    return {
      symbol: rec.symbol,
      series: sliceSeriesForRange(rec.series, range, now()),
      provider: rec.provider || null,
      range,
      fetchedAt: rec.fetchedAt || null,
      stale: false,
      fromCache: false,
      ...extra,
    };
  }

  function isFresh(cached) {
    if (!cached?.series?.length) return false;
    if (ageMs(cached.fetchedAt, now()) >= ttlMs) return false;
    if (lastCloseNeedsRefresh(lastCloseDate(cached.series), today())) return false;
    return true;
  }

  async function maybeAppendQuote(key, series) {
    if (!lastCloseNeedsRefresh(lastCloseDate(series), today())) return series;
    if (typeof fetchQuote !== 'function') return series;
    try {
      const q = await fetchQuote(key);
      return appendQuotePoint(series, q, today());
    } catch {
      return series;
    }
  }

  async function fetchAndStore(key, prior) {
    // Always ask for max so one success serves Full history, Since added, and
    // the 1y/2y/5y detail toggle without another live hop.
    const live = await fetchLive(key, 'max');
    let series = mergeSeries(prior?.series, live?.series);
    let quoteAppended = false;
    const beforeClose = lastCloseDate(series);
    series = await maybeAppendQuote(key, series);
    if (lastCloseDate(series) !== beforeClose) quoteAppended = true;
    if (!series.length) throw new Error(`No price rows returned for ${key}`);
    const rec = {
      symbol: key,
      series,
      provider: live.provider || null,
      range: live.range || 'max',
      fetchedAt: new Date(now()).toISOString(),
      quoteAppended,
    };
    await putPriceHistory(key, rec);
    // Provider answered but the series is still older than ~1 trading day and
    // the quote hop did not extend it — treat like a soft miss so we do not
    // hammer the chain on every request while last close stays frozen.
    if (lastCloseNeedsRefresh(lastCloseDate(series), today())) {
      liveFailUntil.set(key, now() + failCooldownMs);
    }
    return rec;
  }

  async function getHistory(symbol, range = 'max', { force = false } = {}) {
    const key = normalizeSymbol(symbol);
    if (!key) throw new Error('Missing symbol');
    const cached = await getPriceHistory(key);
    if (isFresh(cached) && !force) {
      return respond(cached, range, { stale: false, fromCache: true });
    }

    // After a total live miss, don't walk the chain again for a few minutes if
    // we can still show a stored series. An explicit Retry (force) bypasses this.
    if (!force && cached?.series?.length && now() < (liveFailUntil.get(key) || 0)) {
      return respond(cached, range, {
        stale: true,
        fromCache: true,
        error: 'Live providers recently failed — showing cached prices',
      });
    }

    let pending = inflight.get(key);
    if (!pending) {
      pending = fetchAndStore(key, cached).finally(() => inflight.delete(key));
      inflight.set(key, pending);
    }

    try {
      const stored = await pending;
      const stillStaleClose = lastCloseNeedsRefresh(lastCloseDate(stored.series), today());
      if (!stillStaleClose) liveFailUntil.delete(key);
      return respond(stored, range, {
        stale: stillStaleClose,
        fromCache: false,
        quoteAppended: !!stored.quoteAppended,
        error: stillStaleClose ? 'Live history did not extend the last close' : undefined,
      });
    } catch (e) {
      liveFailUntil.set(key, now() + failCooldownMs);
      // History failed — still try a live quote so alerts/charts can move
      // forward one day when quotes are reachable but candles are not.
      if (cached?.series?.length && typeof fetchQuote === 'function') {
        try {
          const q = await fetchQuote(key);
          const series = appendQuotePoint(cached.series, q, today());
          if (lastCloseDate(series) !== lastCloseDate(cached.series)) {
            const rec = {
              symbol: key,
              series,
              provider: q.provider || cached.provider || null,
              range: cached.range || 'max',
              fetchedAt: new Date(now()).toISOString(),
            };
            await putPriceHistory(key, rec);
            liveFailUntil.delete(key);
            return respond(rec, range, { stale: false, fromCache: false, quoteAppended: true });
          }
        } catch {
          // fall through to stale cache
        }
      }
      if (cached?.series?.length) {
        return respond(cached, range, {
          stale: true,
          fromCache: true,
          error: e.message,
        });
      }
      throw e;
    }
  }

  return { getHistory, lastCloseNeedsRefresh, isFresh: (cached) => isFresh(cached) };
}
