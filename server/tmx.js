// tmx.js — TMX Money quotes and daily history for .TO and .V symbols.
// Same cooldown and diagnostics path as the other hops: viaChain records
// last success, and a 429/403 starts the provider cooldown.

import { noteProviderResult, providerStat } from './providerStats.js';
import {
  HISTORY_QUERY,
  QUOTE_QUERY,
  TMX_ENDPOINT,
  parseTmxHistory,
  parseTmxQuote,
  tmxHistoryRequest,
  tmxQuoteRequest,
  tmxSupports,
  toTmxSymbol,
} from '../client/src/tmxBrowser.js';

export { TMX_ENDPOINT, tmxSupports, toTmxSymbol };

function defaultDeps() {
  return { fetch: (...args) => globalThis.fetch(...args) };
}

let deps = defaultDeps();

export function setTmxDeps(patch) {
  deps = { ...deps, ...patch };
}

export function resetTmxForTests() {
  deps = defaultDeps();
}

export function tmxStatus() {
  const stat = providerStat('tmx');
  return {
    endpoint: TMX_ENDPOINT,
    quoteOperation: 'getQuoteBySymbol',
    historyOperation: 'getTimeSeriesData',
    historyFreq: 'day',
    symbols: 'strip .TO and .V; TECK-B.TO → TECK.B',
    lastSuccessAt: stat.lastSuccessAt,
    lastSuccessSymbol: stat.lastSuccessSymbol,
    lastError: stat.lastError,
    lastAttemptAt: stat.lastAttemptAt,
  };
}

function httpError(status, symbol) {
  const err = new Error(`TMX refused the request (HTTP ${status}) for ${symbol}`);
  err.status = status;
  err.notFound = status === 404;
  return err;
}

async function post(operationName, query, variables, symbol) {
  let res;
  try {
    res = await deps.fetch(TMX_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'User-Agent': 'FolioTrack/1.0 (portfolio price history)',
        Origin: 'https://money.tmx.com',
        Referer: 'https://money.tmx.com/',
      },
      body: JSON.stringify({ operationName, query, variables }),
      signal: AbortSignal.timeout(20000),
    });
  } catch (e) {
    const err = new Error(`Network error reaching TMX: ${e.message}`);
    err.status = null;
    noteProviderResult('tmx', { ok: false, symbol, error: err.message });
    throw err;
  }
  if (res.status === 429 || res.status === 403 || res.status === 401) {
    const err = httpError(res.status, symbol);
    noteProviderResult('tmx', { ok: false, symbol, error: err.message });
    throw err;
  }
  if (!res.ok) {
    const err = httpError(res.status, symbol);
    noteProviderResult('tmx', { ok: false, symbol, error: err.message });
    throw err;
  }
  let json;
  try {
    json = await res.json();
  } catch {
    const err = new Error('TMX returned a non-JSON response');
    err.status = res.status;
    noteProviderResult('tmx', { ok: false, symbol, error: err.message });
    throw err;
  }
  return json;
}

export async function getQuote(symbol) {
  if (!tmxSupports(symbol)) {
    const err = new Error(`TMX does not cover ${symbol}`);
    err.notFound = true;
    throw err;
  }
  const req = tmxQuoteRequest(symbol);
  if (!req.variables.symbol) {
    const err = new Error(`TMX does not cover ${symbol}`);
    err.notFound = true;
    throw err;
  }
  try {
    const json = await post(req.operationName, QUOTE_QUERY, req.variables, symbol);
    const quote = parseTmxQuote(json, symbol);
    noteProviderResult('tmx', { ok: true, symbol });
    return quote;
  } catch (e) {
    if (!/Network error|TMX refused|non-JSON/.test(e.message || '')) {
      noteProviderResult('tmx', { ok: false, symbol, error: e.message });
    }
    throw e;
  }
}

export async function getHistory(symbol, range = 'max', now = new Date()) {
  if (!tmxSupports(symbol)) {
    const err = new Error(`TMX does not cover ${symbol}`);
    err.notFound = true;
    throw err;
  }
  const req = tmxHistoryRequest(symbol, range, now);
  try {
    const json = await post(req.operationName, HISTORY_QUERY, req.variables, symbol);
    const out = parseTmxHistory(json, symbol);
    noteProviderResult('tmx', { ok: true, symbol });
    return { ...out, range };
  } catch (e) {
    if (!/Network error|TMX refused|non-JSON/.test(e.message || '')) {
      noteProviderResult('tmx', { ok: false, symbol, error: e.message });
    }
    throw e;
  }
}

export const tmx = {
  id: 'tmx',
  supports: tmxSupports,
  quote: (symbol) => getQuote(symbol),
  history: (symbol, range) => getHistory(symbol, range),
};
