// yahoo.js
// Auto-source adapter. Uses Yahoo's v8 chart endpoint, which returns both the
// latest price and a daily history without the cookie/crumb dance that the v7
// quote and quoteSummary endpoints now require. Covers TSX (.TO) + US listed
// stocks/ETFs and most US mutual funds. It does NOT cover Canadian FundServ
// mutual fund codes or private alts — those flow through manual NAV entry.
//
// Host order is query2 then query1. History uses period1/period2 because
// range=max is downsampled. User-Agent comes from YAHOO_UA (see yahooHeaders.js).
// Every chart HTTP call goes through a global 1-at-a-time queue.

import { clearCooldown, markCooldown } from './providerCooldown.js';
import { buildChartQuery, resolveYahooUserAgent, yahooRequestHeaders } from './yahooHeaders.js';
import {
  createPaceQueue,
  parseRetryAfter,
  resetYahooDedupeForTests,
  retryDelayMs,
  YAHOO_JITTER_MS,
  YAHOO_MIN_INTERVAL_MS,
} from './yahooQueue.js';

export const YAHOO_QUERY2 = 'https://query2.finance.yahoo.com';
export const YAHOO_QUERY1 = 'https://query1.finance.yahoo.com';

// query2 first: both hosts returned bars here, and query2 has answered before
// when query1 was limited.
export const YAHOO_HOSTS = [YAHOO_QUERY2, YAHOO_QUERY1];

const PATH = '/v8/finance/chart';

const HOST_PROVIDER = {
  [YAHOO_QUERY1]: 'yahoo',
  [YAHOO_QUERY2]: 'yahoo-query2',
};

function defaultDeps() {
  return {
    fetch: (...args) => globalThis.fetch(...args),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: () => Date.now(),
    random: Math.random,
  };
}

function emptyState() {
  return {
    lastSuccessAt: null,
    lastSuccessSymbol: null,
    lastAttemptAt: null,
    lastHttpStatus: null,
    lastError: null,
    lastHost: null,
  };
}

let deps = defaultDeps();
let queue = null;
let state = emptyState();
// symbol -> Set of hosts that returned 429 during this process. A 429 from
// one host must not be treated as "Yahoo is exhausted" until the other host
// has also been contacted.
const recent429 = new Map();

function getQueue() {
  if (!queue) {
    queue = createPaceQueue({
      minIntervalMs: YAHOO_MIN_INTERVAL_MS,
      jitterMs: YAHOO_JITTER_MS,
      now: () => deps.now(),
      sleep: (ms) => deps.sleep(ms),
      random: () => deps.random(),
    });
  }
  return queue;
}

export function setYahooDeps(patch) {
  deps = { ...deps, ...patch };
  queue = null;
}

export function resetYahooForTests() {
  deps = defaultDeps();
  queue = null;
  state = emptyState();
  recent429.clear();
  resetYahooDedupeForTests();
}

export function yahooStatus() {
  const selected = resolveYahooUserAgent(process.env, { random: deps.random });
  return {
    userAgentMode: selected.mode,
    userAgent: selected.userAgent,
    envUserAgent: process.env.YAHOO_UA ?? null,
    hosts: ['query2', 'query1'],
    endpoint: PATH,
    historyQuery: 'period1/period2',
    quoteQuery: 'range',
    minIntervalMs: YAHOO_MIN_INTERVAL_MS,
    concurrency: 1,
    lastSuccessAt: state.lastSuccessAt,
    lastSuccessSymbol: state.lastSuccessSymbol,
    lastAttemptAt: state.lastAttemptAt,
    lastHttpStatus: state.lastHttpStatus,
    lastError: state.lastError,
    lastHost: state.lastHost,
  };
}

// Distinguishes "Yahoo refused us" from "symbol does not exist".
export class YahooError extends Error {
  constructor(message, {
    blocked = false,
    notFound = false,
    status = null,
    retryAfterMs = null,
    otherHostUntried = false,
    host = null,
  } = {}) {
    super(message);
    this.name = 'YahooError';
    this.blocked = blocked;
    this.notFound = notFound;
    this.status = status;
    this.retryAfterMs = retryAfterMs;
    this.otherHostUntried = otherHostUntried;
    this.host = host;
  }
}

export function quoteFromChartResult(symbol, r) {
  const m = r?.meta || {};
  return {
    symbol,
    price: m.regularMarketPrice ?? null,
    previousClose: m.chartPreviousClose ?? m.previousClose ?? null,
    currency: m.currency ?? null,
    exchange: m.exchangeName ?? null,
    name: m.longName || m.shortName || symbol,
    asOf: m.regularMarketTime ? new Date(m.regularMarketTime * 1000).toISOString() : null,
  };
}

export function seriesFromChartResult(r) {
  const ts = r?.timestamp || [];
  const adj = r?.indicators?.adjclose?.[0]?.adjclose || [];
  const close = r?.indicators?.quote?.[0]?.close || [];
  return ts
    .map((t, i) => ({
      date: new Date(t * 1000).toISOString().slice(0, 10),
      close: adj[i] ?? close[i] ?? null,
    }))
    .filter((p) => p.close != null);
}

export function readChartPayload(json, symbol) {
  const errCode = json?.chart?.error?.code;
  if (errCode) {
    const notFound = /not\s*found|No data found/i.test(`${errCode} ${json?.chart?.error?.description || ''}`);
    throw new YahooError(json?.chart?.error?.description || errCode, { notFound, blocked: !notFound });
  }
  const result = json?.chart?.result?.[0];
  if (!result) throw new YahooError(`No data returned for ${symbol}`, { notFound: true });
  return result;
}

function remember429(symbol, host) {
  let set = recent429.get(symbol);
  if (!set) {
    set = new Set();
    recent429.set(symbol, set);
  }
  set.add(host);
  const id = HOST_PROVIDER[host];
  if (id) markCooldown(id);
}

function siblingUntried(symbol, list) {
  const seen = recent429.get(symbol);
  return YAHOO_HOSTS.some((host) => !list.includes(host) && !seen?.has(host));
}

function noteSuccess(symbol, host) {
  recent429.delete(symbol);
  const id = HOST_PROVIDER[host];
  if (id) clearCooldown(id);
  state.lastSuccessAt = new Date(deps.now()).toISOString();
  state.lastSuccessSymbol = symbol;
  state.lastHost = host;
  state.lastError = null;
}

function refusedMessage(status) {
  return `Yahoo refused the request (HTTP ${status}) — this host is likely blocking the server's IP`;
}

async function requestOnce(symbol, range, interval, host) {
  const nowSec = Math.floor(deps.now() / 1000);
  const qs = buildChartQuery({ range, interval, nowSec });
  const url = `${host}${PATH}/${encodeURIComponent(symbol)}?${qs}`;
  const headers = yahooRequestHeaders(process.env, { random: deps.random });
  state.lastAttemptAt = new Date(deps.now()).toISOString();
  state.lastHost = host;

  let res;
  try {
    res = await getQueue().enqueue(() => deps.fetch(url, {
      headers,
      signal: AbortSignal.timeout(10000),
    }));
  } catch (e) {
    state.lastHttpStatus = null;
    state.lastError = e.message;
    return {
      ok: false,
      host,
      error: new YahooError(`Network error reaching Yahoo: ${e.message}`, { blocked: true, host }),
    };
  }

  state.lastHttpStatus = res.status;
  const retryAfterMs = parseRetryAfter(res.headers?.get?.('retry-after'), deps.now());

  if (res.status === 404) {
    const error = new YahooError(`Yahoo does not know the symbol ${symbol}`, { notFound: true, status: 404, host });
    state.lastError = error.message;
    return { ok: false, host, done: true, error };
  }

  if (res.status === 401 || res.status === 403 || res.status === 429) {
    if (res.status === 429) remember429(symbol, host);
    const error = new YahooError(refusedMessage(res.status), {
      blocked: true,
      status: res.status,
      retryAfterMs,
      host,
    });
    state.lastError = error.message;
    return { ok: false, host, status: res.status, retryAfterMs, error };
  }

  if (!res.ok) {
    const error = new YahooError(`Yahoo returned HTTP ${res.status} for ${symbol}`, {
      blocked: true,
      status: res.status,
      host,
    });
    state.lastError = error.message;
    return { ok: false, host, status: res.status, error };
  }

  let json;
  try {
    json = await res.json();
  } catch {
    const error = new YahooError('Yahoo returned a non-JSON response (likely a block page)', {
      blocked: true,
      status: res.status,
      host,
    });
    state.lastError = error.message;
    return { ok: false, host, error };
  }

  try {
    const result = readChartPayload(json, symbol);
    noteSuccess(symbol, host);
    return { ok: true, host, result };
  } catch (e) {
    state.lastError = e.message;
    return { ok: false, host, error: e, done: !!e.notFound };
  }
}

function bestRetryAfter(rows) {
  let best = null;
  for (const row of rows) {
    if (row?.retryAfterMs == null || !Number.isFinite(row.retryAfterMs)) continue;
    if (best == null || row.retryAfterMs > best) best = row.retryAfterMs;
  }
  return best;
}

async function fetchChart(symbol, range, interval, hosts = YAHOO_HOSTS, { allowRetry = true } = {}) {
  const list = Array.isArray(hosts) && hosts.length ? hosts : YAHOO_HOSTS;
  const errors = [];
  for (const host of list) {
    const out = await requestOnce(symbol, range, interval, host);
    if (out.ok) return out.result;
    if (out.done) throw out.error;
    errors.push(out);
  }

  const rateLimited = errors.filter((row) => row.status === 429);
  const retryAfterMs = bestRetryAfter(rateLimited);
  if (rateLimited.length && siblingUntried(symbol, list)) {
    const prior = rateLimited.at(-1).error;
    throw new YahooError(prior.message, {
      blocked: true,
      status: 429,
      retryAfterMs: prior.retryAfterMs ?? retryAfterMs,
      otherHostUntried: true,
      host: prior.host,
    });
  }

  if (allowRetry && rateLimited.length && rateLimited.length === errors.length) {
    const delay = retryDelayMs({
      attempt: 0,
      retryAfterMs,
      random: deps.random,
    });
    await getQueue().enqueue(async () => {
      await deps.sleep(delay);
    });
    return fetchChart(symbol, range, interval, list, { allowRetry: false });
  }

  const last = errors.at(-1);
  if (last?.error) throw last.error;
  throw new YahooError('Yahoo unreachable', { blocked: true });
}

export async function getQuote(symbol, hosts) {
  const r = await fetchChart(symbol, '1d', '1d', hosts);
  return quoteFromChartResult(symbol, r);
}

export async function getHistory(symbol, range = '1y', interval = '1d', hosts) {
  const r = await fetchChart(symbol, range, interval, hosts);
  return { symbol, range, interval, series: seriesFromChartResult(r) };
}

export async function lookup(symbol) {
  try {
    const q = await getQuote(symbol);
    if (q.price == null) {
      return { found: false, symbol, reason: 'Yahoo returned no price for this symbol', blocked: false };
    }
    const bare = symbol.replace(/\..*$/, '');
    const guessType = /^[A-Z]{5}X$/.test(bare) ? 'mutualfund' : 'stock';
    return { found: true, symbol, name: q.name, currency: q.currency, exchange: q.exchange, guessType, price: q.price };
  } catch (e) {
    return {
      found: false,
      symbol,
      reason: e.message,
      blocked: e instanceof YahooError ? !!e.blocked : true,
    };
  }
}

export async function diagnose(symbol = 'AAPL') {
  const started = Date.now();
  try {
    const q = await getQuote(symbol);
    return { reachable: true, symbol, price: q.price, name: q.name, ms: Date.now() - started };
  } catch (e) {
    return {
      reachable: false,
      symbol,
      blocked: e instanceof YahooError ? !!e.blocked : true,
      status: e instanceof YahooError ? e.status : null,
      reason: e.message,
      ms: Date.now() - started,
    };
  }
}
