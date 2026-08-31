// providers.js — price/history sourcing with automatic failover.
//
// Yahoo blocks datacenter IPs inconsistently, so a single-source adapter is a
// single point of failure. This tries each provider in order and uses the first
// that answers. Adding a provider means adding one entry to PROVIDERS.
//
// Each provider exposes:
//   id       — short name used in logs and diagnostics
//   quote(symbol)   -> { symbol, price, currency, name, asOf } | throws
//   history(symbol, range) -> { series: [{date, close}] }      | throws
//   supports(symbol) -> boolean (cheap pre-filter)

import { getQuote as yQuote, getHistory as yHistory, YahooError } from './yahoo.js';

// ---------- Twelve Data (keyed, free tier: 800 req/day, 8 req/min) ----------
// Stooq was the original fallback here but as of 2026-08 its entire site sits
// behind a JS proof-of-work bot check (WebCrypto challenge + cookie), which no
// server-side HTTP client can pass — confirmed with curl against stooq.com and
// stooq.pl directly, not Render-specific. It cannot serve as a fallback until
// that changes, so it's been dropped rather than kept as a dead 10s-timeout
// hop on every failed lookup.
//
// Twelve Data addresses TSX symbols via a separate `exchange` param rather
// than a suffix (confirmed against their symbol_search endpoint: RY on TSX
// resolves with symbol=RY&exchange=TSX). Requires TWELVEDATA_API_KEY — set it
// directly in the Render dashboard, never paste it into chat (see the Neon
// connection-string note in HANDOFF.md).
const TWELVEDATA_BASE = 'https://api.twelvedata.com';

function twelvedataParams(symbol) {
  const s = symbol.trim();
  if (/\.to$/i.test(s)) return { symbol: s.replace(/\.to$/i, ''), exchange: 'TSX' };
  if (/\.v$/i.test(s)) return { symbol: s.replace(/\.v$/i, ''), exchange: 'TSXV' };
  return { symbol: s, exchange: null };
}

async function twelvedataFetch(path, params) {
  const key = process.env.TWELVEDATA_API_KEY;
  if (!key) throw new Error('TWELVEDATA_API_KEY not configured');
  const url = new URL(`${TWELVEDATA_BASE}/${path}`);
  for (const [k, v] of Object.entries(params)) if (v) url.searchParams.set(k, v);
  url.searchParams.set('apikey', key);
  const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
  const json = await res.json();
  if (json.status === 'error' || json.code >= 400) {
    throw new Error(`Twelve Data: ${json.message || `HTTP ${json.code}`}`);
  }
  return json;
}

const twelvedata = {
  id: 'twelvedata',
  supports: () => true,
  async quote(symbol) {
    const { symbol: sym, exchange } = twelvedataParams(symbol);
    const q = await twelvedataFetch('quote', { symbol: sym, exchange });
    const price = parseFloat(q.close);
    if (!Number.isFinite(price)) throw new Error(`Twelve Data: no close price for ${symbol}`);
    return {
      symbol, price,
      previousClose: Number.isFinite(parseFloat(q.previous_close)) ? parseFloat(q.previous_close) : null,
      currency: q.currency ?? null,
      name: q.name ?? symbol,
      exchange: q.exchange ?? exchange,
      asOf: q.datetime ?? null,
    };
  },
  async history(symbol, range) {
    const { symbol: sym, exchange } = twelvedataParams(symbol);
    const outputsize = range === '1y' ? 260 : range === '2y' ? 520 : 1300; // ~5y trading days, capped by free-tier max
    const t = await twelvedataFetch('time_series', { symbol: sym, exchange, interval: '1day', outputsize });
    const values = t.values || [];
    const series = values
      .map((v) => ({ date: v.datetime, close: parseFloat(v.close) }))
      .filter((p) => Number.isFinite(p.close))
      .reverse(); // Twelve Data returns newest-first
    if (!series.length) throw new Error(`Twelve Data returned no rows for ${symbol}`);
    return { symbol, series };
  },
};

// Best-effort sector/country enrichment for the lookup flow only — not part
// of the price chain, since a profile isn't required for pricing to work.
// Verified against Twelve Data's free tier for AAPL (sector "Technology",
// country "United States"); TSX coverage is unverified — Twelve Data's TSX
// *quotes* are paywalled on the free tier, so this may fail the same way for
// TSX symbols. lookup() treats a failure here as "no classification data",
// not a lookup failure.
async function twelvedataProfile(symbol) {
  const { symbol: sym, exchange } = twelvedataParams(symbol);
  const p = await twelvedataFetch('profile', { symbol: sym, exchange });
  return { sector: p.sector || null, country: p.country || null };
}

// ---------- Finnhub (keyed, free tier: 60 req/min) ----------
// Twelve Data's free tier paywalls TSX quotes despite listing TSX in its
// symbol search — confirmed live, not assumed. Finnhub's pricing page lists
// "Canadian Exchanges" (TSX/TSXV/CNSX) as a covered exchange group, but that's
// marketing copy, not a tested claim — verify via diagnostics before trusting
// it. Symbol suffix is assumed to match Yahoo's convention (XBB.TO passed
// through as-is) since that's unconfirmed too.
//
// Free tier's /quote returns HTTP 200 with all-zero fields for a symbol it
// doesn't have, not an error — a zero price is treated as "no data" below.
// Historical candles (/stock/candle) have been Premium-only on Finnhub for a
// while by reputation, not verified here either; history() attempts it anyway
// so a real failure (or success) shows up in diagnostics instead of being
// assumed.
const FINNHUB_BASE = 'https://finnhub.io/api/v1';

async function finnhubFetch(path, params) {
  const key = process.env.FINNHUB_API_KEY;
  if (!key) throw new Error('FINNHUB_API_KEY not configured');
  const url = new URL(`${FINNHUB_BASE}/${path}`);
  for (const [k, v] of Object.entries(params)) if (v != null) url.searchParams.set(k, v);
  url.searchParams.set('token', key);
  const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Finnhub HTTP ${res.status}${body ? `: ${body.slice(0, 200)}` : ''}`);
  }
  return res.json();
}

const finnhub = {
  id: 'finnhub',
  supports: () => true,
  async quote(symbol) {
    const q = await finnhubFetch('quote', { symbol });
    if (!q.c) throw new Error(`Finnhub has no data for ${symbol}`);
    return {
      symbol,
      price: q.c,
      previousClose: q.pc || null,
      currency: null,   // free-tier /quote doesn't carry currency
      name: symbol,     // nor a display name
      exchange: null,
      asOf: q.t ? new Date(q.t * 1000).toISOString() : null,
      partial: true,    // flags that name/currency need user input
    };
  },
  async history(symbol, range) {
    const days = range === '1y' ? 365 : range === '2y' ? 730 : 1825;
    const to = Math.floor(Date.now() / 1000);
    const from = to - days * 86400;
    const c = await finnhubFetch('stock/candle', { symbol, resolution: 'D', from, to });
    if (c.s !== 'ok' || !c.t?.length) throw new Error(`Finnhub: no candle data for ${symbol} (${c.s || 'no status'})`);
    const series = c.t
      .map((ts, i) => ({ date: new Date(ts * 1000).toISOString().slice(0, 10), close: c.c[i] }))
      .filter((p) => Number.isFinite(p.close));
    if (!series.length) throw new Error(`Finnhub returned no rows for ${symbol}`);
    return { symbol, series };
  },
};

// ---------- Alpha Vantage (keyed, free tier: 25 req/DAY, not per-minute) ----------
// Last resort in the chain, on purpose: the daily cap is thin enough that
// burning it on symbols the other providers already cover would starve out
// the one case it's actually here for (TSX, once the other three fail).
// Toronto suffix is `.TRT` per their docs examples, unconfirmed against a
// real TSX symbol — verify via /api/diagnostics same as the other providers.
// Alpha Vantage returns HTTP 200 with an "Information"/"Note" field instead
// of a real error code when the key is invalid or the daily cap is hit, so
// that has to be checked explicitly rather than relying on res.ok.
const ALPHAVANTAGE_BASE = 'https://www.alphavantage.co/query';

function alphavantageSymbol(symbol) {
  return /\.to$/i.test(symbol) ? symbol.replace(/\.to$/i, '.TRT') : symbol;
}

async function alphavantageFetch(params) {
  const key = process.env.ALPHAVANTAGE_API_KEY;
  if (!key) throw new Error('ALPHAVANTAGE_API_KEY not configured');
  const url = new URL(ALPHAVANTAGE_BASE);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  url.searchParams.set('apikey', key);
  const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
  const json = await res.json();
  if (json['Error Message']) throw new Error(`Alpha Vantage: ${json['Error Message']}`);
  if (json['Note'] || json['Information']) throw new Error(`Alpha Vantage: ${json['Note'] || json['Information']}`);
  return json;
}

const alphavantage = {
  id: 'alphavantage',
  supports: () => true,
  async quote(symbol) {
    const sym = alphavantageSymbol(symbol);
    const json = await alphavantageFetch({ function: 'GLOBAL_QUOTE', symbol: sym });
    const q = json['Global Quote'];
    const price = q ? parseFloat(q['05. price']) : NaN;
    if (!q || !Number.isFinite(price)) throw new Error(`Alpha Vantage: no quote data for ${symbol}`);
    return {
      symbol, price,
      previousClose: Number.isFinite(parseFloat(q['08. previous close'])) ? parseFloat(q['08. previous close']) : null,
      currency: null, name: symbol, exchange: null,
      asOf: q['07. latest trading day'] || null,
      partial: true,
    };
  },
  async history(symbol) {
    const sym = alphavantageSymbol(symbol);
    const json = await alphavantageFetch({ function: 'TIME_SERIES_DAILY', symbol: sym, outputsize: 'full' });
    const series0 = json['Time Series (Daily)'];
    if (!series0) throw new Error(`Alpha Vantage: no history for ${symbol}`);
    const series = Object.entries(series0)
      .map(([date, v]) => ({ date, close: parseFloat(v['4. close']) }))
      .filter((p) => Number.isFinite(p.close))
      .sort((a, b) => a.date.localeCompare(b.date));
    if (!series.length) throw new Error(`Alpha Vantage returned no rows for ${symbol}`);
    return { symbol, series };
  },
};

const yahoo = {
  id: 'yahoo',
  supports: () => true,
  quote: (symbol) => yQuote(symbol),
  history: (symbol, range) => yHistory(symbol, range || '5y'),
};

// Order matters: richest metadata first, most-reachable last. Alpha Vantage
// goes last — its 25/day cap is too thin to spend on symbols the earlier
// providers already cover.
export const PROVIDERS = [yahoo, twelvedata, finnhub, alphavantage];

function isNotFound(e) {
  return (e instanceof YahooError && e.notFound) || /no data|not\s*found/i.test(e.message || '');
}

// Try each provider until one answers. A genuine "symbol doesn't exist" from a
// provider does NOT stop the chain — another source may still carry it.
async function viaChain(method, symbol, arg) {
  const attempts = [];
  for (const p of PROVIDERS) {
    if (!p.supports(symbol)) continue;
    try {
      const out = await p[method](symbol, arg);
      return { ...out, provider: p.id, attempts };
    } catch (e) {
      attempts.push({ provider: p.id, error: e.message, notFound: isNotFound(e) });
    }
  }
  const err = new Error(
    `All providers failed for ${symbol}: ${attempts.map((a) => `${a.provider} (${a.error})`).join('; ')}`
  );
  err.attempts = attempts;
  // If every provider said "no such symbol", it's genuinely unknown, not a block.
  err.notFound = attempts.length > 0 && attempts.every((a) => a.notFound);
  throw err;
}

export const getQuote = (symbol) => viaChain('quote', symbol);
export const getHistory = (symbol, range = '5y') => viaChain('history', symbol, range);

// Resolve a ticker for the editor across all providers.
export async function lookup(symbol) {
  try {
    const q = await getQuote(symbol);
    if (q.price == null) return { found: false, symbol, reason: 'No price returned', blocked: false };
    const bare = symbol.replace(/\..*$/, '');
    const guessType = /^[A-Z]{5}X$/i.test(bare) ? 'mutualfund' : 'stock';
    let profile = null, profileError = null;
    // Best-effort — a failure here doesn't fail the lookup, since a price
    // without a classification is still useful. But swallowing it silently
    // last time made a real rate-limit hit look like an unexplained gap
    // (Twelve Data pricing the quote + this profile call = 2 of its 8
    // requests/minute in one lookup), so the reason is surfaced instead.
    try { profile = await twelvedataProfile(symbol); }
    catch (e) { profileError = e.message; }
    return {
      found: true, symbol, provider: q.provider, partial: !!q.partial,
      name: q.name, currency: q.currency, exchange: q.exchange, guessType, price: q.price,
      sector: profile?.sector || null, country: profile?.country || null,
      classificationError: profile ? null : profileError,
    };
  } catch (e) {
    return {
      found: false, symbol,
      reason: e.message,
      blocked: !e.notFound,
      attempts: e.attempts || [],
    };
  }
}

// Probe every provider against representative symbols so the failure mode is
// visible instead of guessed at.
export async function probeAll(symbols = ['AAPL', 'XBB.TO']) {
  const results = [];
  for (const p of PROVIDERS) {
    for (const sym of symbols) {
      const t = Date.now();
      try {
        const q = await p.quote(sym);
        results.push({ provider: p.id, symbol: sym, ok: true, price: q.price, ms: Date.now() - t });
      } catch (e) {
        results.push({
          provider: p.id, symbol: sym, ok: false,
          status: e instanceof YahooError ? e.status : null,
          notFound: isNotFound(e),
          error: e.message, ms: Date.now() - t,
        });
      }
    }
  }
  const working = [...new Set(results.filter((r) => r.ok).map((r) => r.provider))];
  return {
    results,
    workingProviders: working,
    verdict: working.length
      ? `Working: ${working.join(', ')}`
      : 'No provider reachable from this server — outbound access is blocked or all sources are down',
  };
}
