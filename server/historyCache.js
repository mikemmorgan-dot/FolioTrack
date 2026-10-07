// historyCache.js — persistent, cache-first price history.
//
// Live providers are tried sequentially and only on a miss/stale cache.
// US names walk Yahoo query2 → query1 → Twelve Data → Finnhub → Alpha
// Vantage → Stooq. Canadian .TO/.V/.NE/.CN names start at Yahoo and skip the
// free-tier providers that do not cover those listings (see providers.js).
// A successful series is stored
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

// First date included in a 1y/2y/5y window. null means the caller asked for
// the full stored history (range "max" or anything we do not clip).
export function rangeStartIso(range, now = Date.now()) {
  const days = RANGE_DAYS[range];
  if (!days) return null;
  const cutoff = new Date(now);
  cutoff.setUTCDate(cutoff.getUTCDate() - days);
  return cutoff.toISOString().slice(0, 10);
}

export function sliceSeriesForRange(series, range, now = Date.now()) {
  const pts = normalizeSeries(series);
  const cut = rangeStartIso(range, now);
  if (!cut) return pts;
  return pts.filter((p) => p.date >= cut);
}

function ageMs(fetchedAt, now) {
  const t = Date.parse(fetchedAt);
  return Number.isFinite(t) ? now - t : Infinity;
}

export function createHistoryCache({
  getPriceHistory,
  putPriceHistory,
  getPriceHistoryMeta = null,
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
  const hasMeta = typeof getPriceHistoryMeta === 'function';

  function respond(rec, range, extra = {}) {
    return {
      symbol: rec?.symbol,
      series: sliceSeriesForRange(rec?.series, range, now()),
      provider: rec?.provider || null,
      range,
      fetchedAt: rec?.fetchedAt || null,
      stale: false,
      fromCache: false,
      ...extra,
    };
  }

  function metaLast(meta) {
    return meta?.lastClose || lastCloseDate(meta?.series) || null;
  }

  function metaCount(meta) {
    if (meta?.pointCount != null) return Number(meta.pointCount) || 0;
    return meta?.series?.length || 0;
  }

  function isFresh(meta) {
    if (!metaCount(meta)) return false;
    if (ageMs(meta.fetchedAt, now()) >= ttlMs) return false;
    if (lastCloseNeedsRefresh(metaLast(meta), today())) return false;
    return true;
  }

  function boundOpts(range) {
    const since = rangeStartIso(range, now());
    return since ? { since } : {};
  }

  // Meta tells us fetchedAt and the last close without the daily rows.
  // When the store has no meta helper, the series comes back on this object
  // and we keep using it (tests and older stores).
  async function loadMeta(key) {
    if (hasMeta) {
      const meta = await getPriceHistoryMeta(key);
      return meta || null;
    }
    const rec = await getPriceHistory(key);
    if (!rec) return null;
    return {
      symbol: rec.symbol || key,
      provider: rec.provider || null,
      range: rec.range || 'max',
      fetchedAt: rec.fetchedAt || null,
      lastClose: rec.lastClose || lastCloseDate(rec.series),
      pointCount: rec.pointCount ?? rec.series?.length ?? 0,
      series: rec.series || [],
    };
  }

  async function readWindow(key, range, meta) {
    if (meta?.series) {
      return {
        symbol: meta.symbol || key,
        series: meta.series,
        provider: meta.provider || null,
        range,
        fetchedAt: meta.fetchedAt || null,
      };
    }
    const rec = await getPriceHistory(key, boundOpts(range));
    return rec || {
      symbol: key,
      series: [],
      provider: null,
      range,
      fetchedAt: null,
    };
  }

  function slim(meta, range, extra = {}) {
    return {
      symbol: meta?.symbol,
      series: [],
      lastClose: metaLast(meta),
      pointCount: metaCount(meta),
      provider: meta?.provider || null,
      range,
      fetchedAt: meta?.fetchedAt || null,
      stale: false,
      fromCache: false,
      ...extra,
    };
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
    // prior.series is set only when we already loaded the rows (no meta
    // helper). With meta, the store upserts and keeps dates we do not send.
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
    return { ...rec, attempts: live?.attempts || [] };
  }

  async function materialize(key, range, stored, { omitSeries }) {
    const attempts = stored.attempts || [];
    if (hasMeta) {
      const meta2 = await getPriceHistoryMeta(key);
      const last = meta2?.lastClose || lastCloseDate(stored.series);
      const stillStaleClose = lastCloseNeedsRefresh(last, today());
      if (!stillStaleClose) liveFailUntil.delete(key);
      if (omitSeries) {
        return slim(meta2 || { symbol: key, lastClose: last, fetchedAt: stored.fetchedAt, provider: stored.provider }, range, {
          stale: stillStaleClose,
          fromCache: false,
          quoteAppended: !!stored.quoteAppended,
          attempts,
          error: stillStaleClose ? 'Live history did not extend the last close' : undefined,
        });
      }
      const rec = await readWindow(key, range, null);
      const windowLast = lastCloseDate(rec?.series) || last;
      const still = lastCloseNeedsRefresh(windowLast, today());
      if (!still) liveFailUntil.delete(key);
      return respond(rec, range, {
        stale: still,
        fromCache: false,
        quoteAppended: !!stored.quoteAppended,
        attempts,
        error: still ? 'Live history did not extend the last close' : undefined,
      });
    }
    const stillStaleClose = lastCloseNeedsRefresh(lastCloseDate(stored.series), today());
    if (!stillStaleClose) liveFailUntil.delete(key);
    if (omitSeries) {
      return slim({
        symbol: stored.symbol,
        lastClose: lastCloseDate(stored.series),
        pointCount: stored.series?.length || 0,
        provider: stored.provider,
        fetchedAt: stored.fetchedAt,
      }, range, {
        stale: stillStaleClose,
        fromCache: false,
        quoteAppended: !!stored.quoteAppended,
        attempts,
        error: stillStaleClose ? 'Live history did not extend the last close' : undefined,
      });
    }
    return respond(stored, range, {
      stale: stillStaleClose,
      fromCache: false,
      quoteAppended: !!stored.quoteAppended,
      attempts,
      error: stillStaleClose ? 'Live history did not extend the last close' : undefined,
    });
  }

  async function getHistory(symbol, range = 'max', { force = false, omitSeries = false } = {}) {
    const key = normalizeSymbol(symbol);
    if (!key) throw new Error('Missing symbol');
    const meta = await loadMeta(key);
    if (isFresh(meta) && !force) {
      if (omitSeries) return slim(meta, range, { stale: false, fromCache: true });
      const rec = await readWindow(key, range, meta?.series ? meta : null);
      return respond(rec, range, { stale: false, fromCache: true });
    }

    // After a total live miss, don't walk the chain again for a few minutes if
    // we can still show a stored series. An explicit Retry (force) bypasses this.
    if (!force && metaCount(meta) > 0 && now() < (liveFailUntil.get(key) || 0)) {
      if (omitSeries) {
        return slim(meta, range, {
          stale: true,
          fromCache: true,
          error: 'Live providers recently failed — showing cached prices',
        });
      }
      const rec = await readWindow(key, range, meta?.series ? meta : null);
      return respond(rec, range, {
        stale: true,
        fromCache: true,
        error: 'Live providers recently failed — showing cached prices',
      });
    }

    let pending = inflight.get(key);
    if (!pending) {
      // Do not pass a series we never loaded. The store keeps older dates.
      const prior = meta?.series ? meta : null;
      pending = fetchAndStore(key, prior).finally(() => inflight.delete(key));
      inflight.set(key, pending);
    }

    try {
      const stored = await pending;
      return materialize(key, range, stored, { omitSeries });
    } catch (e) {
      liveFailUntil.set(key, now() + failCooldownMs);
      // History failed — still try a live quote so alerts/charts can move
      // forward one day when quotes are reachable but candles are not.
      if (metaCount(meta) > 0 && typeof fetchQuote === 'function') {
        try {
          const q = await fetchQuote(key);
          const quoteDate = String(today()).slice(0, 10);
          const before = metaLast(meta);
          const price = Number(q?.price);
          const extendsClose = price > 0 && /^\d{4}-\d{2}-\d{2}$/.test(quoteDate) && (!before || quoteDate > before);
          if (extendsClose) {
            const series = meta?.series
              ? appendQuotePoint(meta.series, q, quoteDate)
              : [{ date: quoteDate, close: price }];
            const rec = {
              symbol: key,
              series,
              provider: q.provider || meta?.provider || null,
              range: meta?.range || 'max',
              fetchedAt: new Date(now()).toISOString(),
            };
            await putPriceHistory(key, rec);
            liveFailUntil.delete(key);
            if (omitSeries) {
              return slim({
                symbol: key,
                lastClose: quoteDate,
                pointCount: (metaCount(meta) || 0) + 1,
                provider: rec.provider,
                fetchedAt: rec.fetchedAt,
              }, range, {
                stale: false,
                fromCache: false,
                quoteAppended: true,
                attempts: e.attempts || [],
              });
            }
            if (meta?.series) {
              return respond(rec, range, {
                stale: false,
                fromCache: false,
                quoteAppended: true,
                attempts: e.attempts || [],
              });
            }
            const window = await readWindow(key, range, null);
            return respond(window, range, {
              stale: false,
              fromCache: false,
              quoteAppended: true,
              attempts: e.attempts || [],
            });
          }
        } catch {
          // fall through to stale cache
        }
      }
      if (metaCount(meta) > 0) {
        if (omitSeries) {
          return slim(meta, range, {
            stale: true,
            fromCache: true,
            error: e.message,
            attempts: e.attempts || [],
          });
        }
        const rec = meta?.series
          ? { symbol: meta.symbol || key, series: meta.series, provider: meta.provider, fetchedAt: meta.fetchedAt }
          : await readWindow(key, range, null);
        return respond(rec, range, {
          stale: true,
          fromCache: true,
          error: e.message,
          attempts: e.attempts || [],
        });
      }
      throw e;
    }
  }

  return { getHistory, lastCloseNeedsRefresh, isFresh: (cached) => isFresh(cached) };
}
