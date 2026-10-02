// tmxBrowser.js — pure TMX Money helpers shared by the server hop and the
// Prices panel "Fill from my phone" button.
//
// Verified from this environment on 2026-10-02 against https://app-money.tmx.com/graphql:
// - POST getQuoteBySymbol({ symbol: "ATD", locale: "en" }) returned
//   Alimentation Couche-Tard, price 76.945 CAD, prevClose 77.2.
// - POST getTimeSeriesData({ symbol, freq: "day", start, end }) returned
//   daily bars (ATD from 1999-12-08, ENB from 1995-01-12, XBB from 2004-12-16,
//   TECK.B, and TSXV AUMB). Symbols are bare: ATD.TO → ATD, TECK.B.TO → TECK.B,
//   AUMB.V → AUMB. AUMB.V as a symbol is a 404.
// - GET (no custom headers beyond Accept) responds with
//   Access-Control-Allow-Origin: *. A browser can read that without a preflight.
// - POST application/json from an origin other than https://money.tmx.com does
//   not get Access-Control-Allow-Origin on the OPTIONS preflight, so the phone
//   path uses GET. Yahoo's chart endpoint did not send that header at all.

export const TMX_ENDPOINT = 'https://app-money.tmx.com/graphql';
export const TMX_PRICE_SOURCE = 'TMX Money';

export const QUOTE_QUERY = `query getQuoteBySymbol($symbol: String, $locale: String) {
  getQuoteBySymbol(symbol: $symbol, locale: $locale) {
    symbol
    name
    price
    prevClose
    currency
    datetime
    exchangeName
    exShortName
  }
}`;

export const HISTORY_QUERY = `query getTimeSeriesData($symbol: String!, $freq: String, $start: String, $end: String) {
  getTimeSeriesData(symbol: $symbol, freq: $freq, start: $start, end: $end) {
    dateTime
    close
  }
}`;

const RANGE_DAYS = {
  '1d': 10,
  '5d': 14,
  '1mo': 40,
  '3mo': 100,
  '6mo': 200,
  '1y': 370,
  '2y': 740,
  '5y': 1830,
  '10y': 3660,
};

export function tmxSupports(symbol) {
  return /\.(TO|V)$/i.test(String(symbol || '').trim());
}

// ATD.TO → ATD, TECK.B.TO and TECK-B.TO → TECK.B, AUMB.V → AUMB.
export function toTmxSymbol(symbol) {
  let s = String(symbol || '').trim().toUpperCase();
  if (!s) return null;
  s = s.replace(/\.(TO|V)$/, '');
  s = s.replace(/-([A-Z])$/, '.$1');
  return s || null;
}

export function tmxHistoryStart(range, now = new Date()) {
  const r = String(range || '5y');
  const t = now instanceof Date ? now : new Date(now);
  if (r === 'max') return '1990-01-01';
  if (r === 'ytd') return `${t.getUTCFullYear()}-01-01`;
  const days = RANGE_DAYS[r] ?? RANGE_DAYS['5y'];
  return new Date(t.getTime() - days * 86400000).toISOString().slice(0, 10);
}

export function tmxHistoryEnd(now = new Date()) {
  const t = now instanceof Date ? now : new Date(now);
  return t.toISOString().slice(0, 10);
}

export function tmxGraphqlGetUrl(operationName, query, variables) {
  const u = new URL(TMX_ENDPOINT);
  u.searchParams.set('operationName', operationName);
  u.searchParams.set('query', query);
  u.searchParams.set('variables', JSON.stringify(variables || {}));
  return u.toString();
}

export function readTmxPayload(json) {
  if (!json || typeof json !== 'object') {
    const err = new Error('TMX returned a non-JSON response');
    err.status = 502;
    throw err;
  }
  if (Array.isArray(json.errors) && json.errors.length) {
    const msg = json.errors.map((e) => e?.message || 'TMX error').join('; ');
    const err = new Error(`TMX: ${msg}`);
    err.notFound = /not found|couldn't find|no results/i.test(msg);
    const code = json.errors[0]?.code;
    if (code === 429 || code === '429' || code === 403 || code === '403') err.status = Number(code);
    throw err;
  }
  return json.data || null;
}

export function seriesFromTimeSeries(rows) {
  const byDate = new Map();
  for (const row of rows || []) {
    const date = String(row?.dateTime || row?.datetime || '').slice(0, 10);
    const close = Number(row?.close ?? row?.closePrice);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(close) || close <= 0) continue;
    byDate.set(date, { date, close });
  }
  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
}

export function parseTmxQuote(json, symbol) {
  const data = readTmxPayload(json);
  const q = data?.getQuoteBySymbol;
  const price = Number(q?.price);
  if (!q || !Number.isFinite(price) || price <= 0) {
    const err = new Error(`TMX has no quote for ${symbol}`);
    err.notFound = true;
    throw err;
  }
  const prev = Number(q.prevClose);
  return {
    symbol,
    price,
    previousClose: Number.isFinite(prev) ? prev : null,
    currency: q.currency || null,
    name: q.name || symbol,
    exchange: q.exShortName || q.exchangeName || null,
    asOf: q.datetime || null,
  };
}

export function parseTmxHistory(json, symbol) {
  const data = readTmxPayload(json);
  const rows = data?.getTimeSeriesData;
  if (!Array.isArray(rows)) {
    const err = new Error(`TMX has no history for ${symbol}`);
    err.notFound = true;
    throw err;
  }
  const series = seriesFromTimeSeries(rows);
  if (!series.length) {
    const err = new Error(`TMX returned no rows for ${symbol}`);
    err.notFound = true;
    throw err;
  }
  return { symbol, series };
}

export function tmxQuoteRequest(symbol) {
  const tmxSymbol = toTmxSymbol(symbol);
  return {
    operationName: 'getQuoteBySymbol',
    query: QUOTE_QUERY,
    variables: { symbol: tmxSymbol, locale: 'en' },
  };
}

export function tmxHistoryRequest(symbol, range = 'max', now = new Date()) {
  const tmxSymbol = toTmxSymbol(symbol);
  return {
    operationName: 'getTimeSeriesData',
    query: HISTORY_QUERY,
    variables: {
      symbol: tmxSymbol,
      freq: 'day',
      start: tmxHistoryStart(range, now),
      end: tmxHistoryEnd(now),
    },
  };
}

// Browser path. GET avoids the JSON-POST preflight, which TMX only allows
// for https://money.tmx.com. Yahoo chart responses did not include
// Access-Control-Allow-Origin, so this does not try Yahoo.
export async function fetchTmxInBrowser(symbol, fetchImpl = globalThis.fetch, now = new Date()) {
  if (!tmxSupports(symbol)) {
    const err = new Error('TMX in the browser covers .TO and .V symbols only');
    err.code = 'unsupported';
    throw err;
  }
  const quoteReq = tmxQuoteRequest(symbol);
  const histReq = tmxHistoryRequest(symbol, '5y', now);
  const headers = { Accept: 'application/json' };
  const [quoteRes, histRes] = await Promise.all([
    fetchImpl(tmxGraphqlGetUrl(quoteReq.operationName, quoteReq.query, quoteReq.variables), { method: 'GET', headers }),
    fetchImpl(tmxGraphqlGetUrl(histReq.operationName, histReq.query, histReq.variables), { method: 'GET', headers }),
  ]);
  if (!quoteRes?.ok && !histRes?.ok) {
    const err = new Error(`TMX HTTP ${quoteRes?.status || histRes?.status || 'error'}`);
    err.status = quoteRes?.status || histRes?.status || null;
    throw err;
  }
  let quote = null;
  let series = [];
  if (quoteRes?.ok) {
    try { quote = parseTmxQuote(await quoteRes.json(), symbol); } catch { quote = null; }
  }
  if (histRes?.ok) {
    try { series = parseTmxHistory(await histRes.json(), symbol).series; } catch { series = []; }
  }
  if (!quote && !series.length) {
    const err = new Error('TMX returned no price from this browser');
    err.notFound = true;
    throw err;
  }
  return {
    symbol,
    source: TMX_PRICE_SOURCE,
    quote,
    series,
    from: series[0]?.date || null,
    to: series.at(-1)?.date || null,
    lastClose: series.at(-1)?.close ?? quote?.price ?? null,
  };
}
