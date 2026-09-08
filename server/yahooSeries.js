// yahooSeries.js — propose / apply an EOD series from Yahoo (or a Yahoo paste).
//
// How to add another TSX stock
// ----------------------------
// Any `.TO` stock is eligible without a mapping. Yahoo is called as-is
// (RY.TO, ENB.TO, TOU.TO). If the instrument is stored as a bare ticker
// that Yahoo lists under `.TO`, add one alias to YAHOO_ALIASES
// (`RY` → `RY.TO`). That is the whole list — do not add a paid TSX vendor.
//
// Fetch proposes only. Apply writes nav_series (the path that feeds quotes
// + Performance after the PR #10 rule: non-empty NAV wins over source=auto).
// Merge is by date. A long series that is not already from Yahoo needs an
// explicit confirm before overwrite. 429/fail returns a typed error and
// leaves the manual Prices path open — never a hard wall.
//
// Also writes price_history (PR #6 cache) so a later auto hop can reuse it.
// Do not invent daily closes from annual fund returns.

import { mergeSeries, normalizeSeries, normalizeSymbol } from './historyCache.js';
import { lookupSource } from './factsheet/sources.js';
import { YahooError } from './yahoo.js';

export const YAHOO_PRICE_SOURCE = 'Yahoo Finance';
export const LONG_MANUAL_SERIES = 10;

// Bare tickers that Yahoo lists with a TSX suffix. `.TO` names pass through.
export const YAHOO_ALIASES = {
  RY: 'RY.TO',
  'RY.TO': 'RY.TO',
};

const MONTHS = {
  january: '01', february: '02', march: '03', april: '04', may: '05', june: '06',
  july: '07', august: '08', september: '09', october: '10', november: '11', december: '12',
  jan: '01', feb: '02', mar: '03', apr: '04', jun: '06', jul: '07', aug: '08',
  sep: '09', sept: '09', oct: '10', nov: '11', dec: '12',
};

export class YahooSeriesError extends Error {
  constructor(message, { status = 502, code = 'blocked', manualFallback = true } = {}) {
    super(message);
    this.name = 'YahooSeriesError';
    this.status = status;
    this.code = code;
    this.manualFallback = manualFallback;
  }
}

export function yahooSymbolFor(symbol) {
  const raw = String(symbol || '').trim().toUpperCase();
  if (!raw) return null;
  if (YAHOO_ALIASES[raw]) return YAHOO_ALIASES[raw];
  const compact = raw.replace(/[\s-]+/g, '');
  if (YAHOO_ALIASES[compact]) return YAHOO_ALIASES[compact];
  return raw;
}

export function yahooPageUrl(symbol) {
  const s = yahooSymbolFor(symbol);
  return s ? `https://ca.finance.yahoo.com/quote/${encodeURIComponent(s)}/` : null;
}

export function yahooHistoryUrl(symbol) {
  const s = yahooSymbolFor(symbol);
  return s ? `https://ca.finance.yahoo.com/quote/${encodeURIComponent(s)}/history` : null;
}

// Fundserv-style codes are not Yahoo tickers (RBF608, FID5982).
export function looksLikeFundserv(symbol) {
  const s = String(symbol || '').trim().toUpperCase().replace(/[\s.-]+/g, '');
  return /^[A-Z]{2,4}\d{3,5}$/.test(s);
}

export function isYahooHistoryEligible(inst, lookup = lookupSource) {
  if (!inst) return false;
  const type = inst.type;
  if (type === 'cash' || type === 'alt' || type === 'mutualfund') return false;
  if (looksLikeFundserv(inst.symbol)) return false;
  if (type === 'stock') return true;
  if (type === 'etf') return !lookup(inst.symbol);
  return false;
}

export function classifyYahooFailure(err) {
  const status = err?.status ?? err?.statusCode ?? null;
  const msg = String(err?.message || '');
  if (status === 429 || /\bHTTP\s*429\b|too many requests|rate.?limit/i.test(msg)) {
    return { code: 'rate_limit', status: 429 };
  }
  if (err instanceof YahooError && err.notFound) {
    return { code: 'not_found', status: 404 };
  }
  if (/does not know|no data found|not\s*found/i.test(msg) && !/429|403|refus|block/i.test(msg)) {
    return { code: 'not_found', status: 404 };
  }
  if (status === 401 || status === 403 || /\bHTTP\s*(401|403)\b|refus|block/i.test(msg)) {
    return { code: 'blocked', status: status || 403 };
  }
  return { code: 'blocked', status: status || 502 };
}

export function yahooFallbackCopy(symbol, classified, err) {
  const s = yahooSymbolFor(symbol) || symbol || 'this ticker';
  const page = yahooHistoryUrl(s);
  if (classified.code === 'rate_limit') {
    return `Yahoo rate-limited this server (HTTP 429). Paste Date / Close from ${page} into Prices, or type them there. A retry from Render often hits the same limit.`;
  }
  if (classified.code === 'not_found') {
    return `Yahoo does not have a chart for ${s}. Enter prices manually in Prices.`;
  }
  const why = err?.message ? ` ${err.message.replace(/\s+/g, ' ').trim()}` : '';
  return `Yahoo did not return a history for ${s}.${why} Enter Date / Close from ${page} in Prices — this is not a hard wall.`;
}

function splitRow(line) {
  if (line.includes('\t')) return line.split('\t').map((c) => c.trim());
  if (line.includes(',')) {
    // Yahoo CSV is simple — no quoted commas in Date/Close.
    return line.split(',').map((c) => c.trim());
  }
  return line.trim().split(/\s{2,}|\s+/).map((c) => c.trim());
}

export function parseLooseDate(raw) {
  const s = String(raw || '').trim();
  if (!s) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const mdY = s.match(
    /^(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+(\d{1,2}),?\s+(20\d{2})$/i
  );
  if (mdY) {
    const mm = MONTHS[mdY[1].toLowerCase()];
    if (mm) return `${mdY[3]}-${mm}-${String(Number(mdY[2])).padStart(2, '0')}`;
  }
  const dmy = s.match(
    /^(\d{1,2})\s+(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+(20\d{2})$/i
  );
  if (dmy) {
    const mm = MONTHS[dmy[2].toLowerCase()];
    if (mm) return `${dmy[3]}-${mm}-${String(Number(dmy[1])).padStart(2, '0')}`;
  }
  const us = s.match(/^(\d{1,2})\/(\d{1,2})\/(20\d{2})$/);
  if (us) {
    return `${us[3]}-${String(Number(us[1])).padStart(2, '0')}-${String(Number(us[2])).padStart(2, '0')}`;
  }
  return null;
}

function parseClose(raw) {
  if (raw == null) return null;
  const n = Number(String(raw).replace(/[$,]/g, '').trim());
  return Number.isFinite(n) && n > 0 ? n : null;
}

// Yahoo History download (Date,Open,High,Low,Close,Adj Close,Volume) or
// "Date, Close" / "Dec 31, 2025  178.20" rows copied from the website.
export function parseYahooPaste(text) {
  const lines = String(text || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return [];
  let dateIdx = 0;
  let closeIdx = 1;
  let start = 0;
  const headerCols = splitRow(lines[0]);
  const headerJoin = headerCols.join(' ').toLowerCase();
  if (/\bdate\b/.test(headerJoin) && /\bclose\b/.test(headerJoin)) {
    dateIdx = headerCols.findIndex((c) => /^date$/i.test(c));
    const adj = headerCols.findIndex((c) => /adj\s*close/i.test(c));
    const close = headerCols.findIndex((c) => /^close$/i.test(c));
    closeIdx = adj >= 0 ? adj : close;
    if (dateIdx < 0) dateIdx = 0;
    if (closeIdx < 0) closeIdx = 1;
    start = 1;
  }

  const rows = [];
  for (const line of lines.slice(start)) {
    const cols = splitRow(line);
    let date = parseLooseDate(cols[dateIdx]);
    let close = parseClose(cols[closeIdx]);
    if (!date || close == null) {
      // Website copy: "Dec 31, 2025  178.20  179.10 …" — date may be first two tokens.
      const m = line.match(
        /^((?:\d{4}-\d{2}-\d{2})|(?:[A-Za-z]{3,9}\s+\d{1,2},?\s+20\d{2})|(?:\d{1,2}\/\d{1,2}\/20\d{2}))\s+[,\t]?\s*\$?([\d.]+)/
      );
      if (m) {
        date = parseLooseDate(m[1]);
        close = parseClose(m[2]);
      }
    }
    if (date && close != null) rows.push({ date, close });
  }
  return normalizeSeries(rows);
}

export function applySummary(existing, incoming) {
  const prior = new Map(normalizeSeries(existing).map((p) => [p.date, p.close]));
  const next = normalizeSeries(incoming);
  let overwriteCount = 0;
  let addedCount = 0;
  for (const p of next) {
    if (prior.has(p.date)) overwriteCount += 1;
    else addedCount += 1;
  }
  return {
    existingCount: prior.size,
    incomingCount: next.length,
    overwriteCount,
    addedCount,
    from: next[0]?.date || null,
    to: next.at(-1)?.date || null,
    lastClose: next.at(-1)?.close ?? null,
  };
}

export function planApplySeries(existing, incoming, {
  confirm = false,
  existingSource = null,
} = {}) {
  const incomingN = normalizeSeries(incoming);
  if (!incomingN.length) {
    const err = new Error('No usable Date / Close rows to apply.');
    err.status = 400;
    throw err;
  }
  const existingN = normalizeSeries(
    (existing || []).map((p) => ({ date: p.date, close: p.close ?? p.nav ?? p.price }))
  );
  const summary = applySummary(existingN, incomingN);
  const longManual = existingN.length >= LONG_MANUAL_SERIES
    && existingSource !== YAHOO_PRICE_SOURCE
    && summary.overwriteCount > 0;

  if (longManual && !confirm) {
    return {
      needsConfirm: true,
      summary,
      series: incomingN,
      error: `This name already has ${summary.existingCount} dated prices that are not from Yahoo. Applying will overwrite ${summary.overwriteCount} date${summary.overwriteCount === 1 ? '' : 's'} and add ${summary.addedCount}. Confirm to merge by date (same date → Yahoo close).`,
    };
  }

  return {
    needsConfirm: false,
    summary,
    series: incomingN,
    merged: mergeSeries(existingN, incomingN),
  };
}

function proposeFromRecord(rec, extra = {}) {
  const series = normalizeSeries(rec.series);
  const symbol = rec.symbol || extra.yahooSymbol;
  return {
    yahooSymbol: symbol,
    source: YAHOO_PRICE_SOURCE,
    provider: 'yahoo',
    pageUrl: yahooPageUrl(symbol),
    historyUrl: yahooHistoryUrl(symbol),
    series,
    count: series.length,
    from: series[0]?.date || null,
    to: series.at(-1)?.date || null,
    lastClose: series.at(-1)?.close ?? null,
    fetchedAt: rec.fetchedAt || null,
    stale: false,
    fromCache: false,
    ...extra,
  };
}

export async function fetchYahooHistoryForSymbol(symbol, {
  getHistoryImpl,
  getCached,
  putCached,
  now = () => Date.now(),
} = {}) {
  const yahooSymbol = yahooSymbolFor(symbol);
  if (!yahooSymbol) {
    throw new YahooSeriesError('Missing symbol.', { status: 400, code: 'not_found', manualFallback: true });
  }
  if (typeof getHistoryImpl !== 'function') {
    throw new YahooSeriesError('Yahoo history provider is not configured.', { status: 500, code: 'blocked' });
  }

  const cached = getCached ? await getCached(normalizeSymbol(yahooSymbol)) : null;

  try {
    const live = await getHistoryImpl(yahooSymbol, 'max');
    const series = normalizeSeries(live?.series);
    if (!series.length) {
      throw new YahooSeriesError(
        yahooFallbackCopy(yahooSymbol, { code: 'blocked' }, { message: 'Yahoo returned no daily closes.' }),
        { status: 502, code: 'empty', manualFallback: true }
      );
    }
    const rec = {
      symbol: yahooSymbol,
      series,
      provider: 'yahoo',
      range: live.range || 'max',
      fetchedAt: new Date(now()).toISOString(),
    };
    if (putCached) await putCached(yahooSymbol, rec);
    return proposeFromRecord(rec);
  } catch (e) {
    if (e instanceof YahooSeriesError) {
      if (cached?.series?.length) {
        return proposeFromRecord(cached, {
          yahooSymbol,
          stale: true,
          fromCache: true,
          error: e.message,
          code: e.code,
          manualFallback: true,
        });
      }
      throw e;
    }
    const classified = classifyYahooFailure(e);
    if (cached?.series?.length) {
      return proposeFromRecord(cached, {
        yahooSymbol,
        stale: true,
        fromCache: true,
        error: yahooFallbackCopy(yahooSymbol, classified, e),
        code: classified.code,
        manualFallback: true,
      });
    }
    throw new YahooSeriesError(yahooFallbackCopy(yahooSymbol, classified, e), {
      status: classified.status >= 400 ? classified.status : 502,
      code: classified.code,
      manualFallback: true,
    });
  }
}
