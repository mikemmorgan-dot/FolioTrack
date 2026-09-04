// historyCache.js — persistent, cache-first price history.
//
// Live providers (Yahoo → Twelve Data → Finnhub → Alpha Vantage) are tried
// sequentially and only on a miss/stale cache. A successful series is stored
// and reused for 18h (equities are end-of-day). If every live hop fails but
// we still have a stored series, that series is returned with stale: true
// instead of an empty chart.

import { getHistory as liveHistory } from './providers.js';

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
  now = () => Date.now(),
  ttlMs = HISTORY_TTL_MS,
} = {}) {
  if (typeof getPriceHistory !== 'function' || typeof putPriceHistory !== 'function') {
    throw new Error('createHistoryCache requires getPriceHistory and putPriceHistory');
  }

  const inflight = new Map();

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

  async function fetchAndStore(key, prior) {
    // Always ask for max so one success serves Full history, Since added, and
    // the 1y/2y/5y detail toggle without another live hop.
    const live = await fetchLive(key, 'max');
    const series = mergeSeries(prior?.series, live?.series);
    if (!series.length) throw new Error(`No price rows returned for ${key}`);
    const rec = {
      symbol: key,
      series,
      provider: live.provider || null,
      range: live.range || 'max',
      fetchedAt: new Date(now()).toISOString(),
    };
    await putPriceHistory(key, rec);
    return rec;
  }

  async function getHistory(symbol, range = 'max') {
    const key = normalizeSymbol(symbol);
    if (!key) throw new Error('Missing symbol');
    const cached = await getPriceHistory(key);
    const fresh = cached?.series?.length && ageMs(cached.fetchedAt, now()) < ttlMs;
    if (fresh) {
      return respond(cached, range, { stale: false, fromCache: true });
    }

    let pending = inflight.get(key);
    if (!pending) {
      pending = fetchAndStore(key, cached).finally(() => inflight.delete(key));
      inflight.set(key, pending);
    }

    try {
      const stored = await pending;
      return respond(stored, range, { stale: false, fromCache: false });
    } catch (e) {
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

  return { getHistory };
}
