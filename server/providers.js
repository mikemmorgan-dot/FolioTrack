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

const yahoo = {
  id: 'yahoo',
  supports: () => true,
  quote: (symbol) => yQuote(symbol),
  history: (symbol, range) => yHistory(symbol, range || '5y'),
};

// Order matters: richest metadata first, most-reachable last.
export const PROVIDERS = [yahoo, twelvedata];

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
    return {
      found: true, symbol, provider: q.provider, partial: !!q.partial,
      name: q.name, currency: q.currency, exchange: q.exchange, guessType, price: q.price,
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
