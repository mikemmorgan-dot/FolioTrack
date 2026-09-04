// fetchBreakdown.js — resolve a mapped ticker, fetch the issuer page/PDF,
// parse allocations, return a proposed ClassifyPanel payload.
//
// Never writes the instrument. Timeouts, non-200, and parse misses throw
// a typed error so the route can return a clear message and leave existing
// data untouched.

import { lookupSource } from './sources.js';
import {
  parseFactsheetHtml,
  parseFactsheetPdf,
  findFactsheetPdfUrl,
  hasBreakdownRows,
  emptyParse,
} from './parse.js';

const FETCH_MS = 12000;
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15';

export class BreakdownFetchError extends Error {
  constructor(message, { status = 422, code = 'parse' } = {}) {
    super(message);
    this.name = 'BreakdownFetchError';
    this.status = status;
    this.code = code;
  }
}

function todayISO(now) {
  return new Date(now).toISOString().slice(0, 10);
}

export function buildNote({ issuer, scrapedAt, asOfEstimated, estimates }) {
  const bits = [`Issuer factsheet · ${issuer} · scraped ${scrapedAt}`];
  if (asOfEstimated) bits.push('as-of estimated');
  if (estimates) bits.push('estimates');
  return bits.join(' · ');
}

export function sourceSummary(source) {
  if (!source) return null;
  return {
    symbol: source.symbol,
    issuer: source.issuer,
    parser: source.parser,
    url: source.url,
  };
}

async function httpGet(url, fetchImpl) {
  let res;
  try {
    res = await fetchImpl(url, {
      headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml,application/pdf,text/plain,*/*' },
      redirect: 'follow',
      signal: AbortSignal.timeout(FETCH_MS),
    });
  } catch (e) {
    throw new BreakdownFetchError(
      `Couldn’t reach the issuer page (${e.message}). Enter the breakdown manually below.`,
      { status: 502, code: 'network' }
    );
  }
  if (!res.ok) {
    throw new BreakdownFetchError(
      `Issuer page returned HTTP ${res.status}. Enter the breakdown manually below.`,
      { status: 502, code: 'http' }
    );
  }
  const ctype = (res.headers.get('content-type') || '').toLowerCase();
  const buf = Buffer.from(await res.arrayBuffer());
  return { buf, ctype, finalUrl: res.url || url };
}

function looksLikePdf(url, ctype) {
  return /\.pdf(\?|$)/i.test(url) || ctype.includes('pdf');
}

export async function fetchBreakdownForSymbol(symbol, { fetchImpl = fetch, now = new Date() } = {}) {
  const source = lookupSource(symbol);
  if (!source) {
    throw new BreakdownFetchError(
      `No issuer factsheet mapped for ${symbol}. Enter the breakdown manually below.`,
      { status: 422, code: 'unmapped' }
    );
  }

  const first = await httpGet(source.url, fetchImpl);
  let parsed = emptyParse();

  if (looksLikePdf(first.finalUrl, first.ctype) || source.parser === 'pdf') {
    try { parsed = await parseFactsheetPdf(first.buf); } catch (e) {
      throw new BreakdownFetchError(
        `Couldn’t read the issuer PDF (${e.message}). Enter the breakdown manually below.`,
        { status: 502, code: 'pdf' }
      );
    }
  } else {
    const html = first.buf.toString('utf8');
    parsed = parseFactsheetHtml(html);
    if (!hasBreakdownRows(parsed) && source.parser === 'html-or-pdf') {
      const pdfUrl = findFactsheetPdfUrl(html, first.finalUrl);
      if (pdfUrl) {
        const pdf = await httpGet(pdfUrl, fetchImpl);
        parsed = await parseFactsheetPdf(pdf.buf);
      }
    }
  }

  if (!hasBreakdownRows(parsed)) {
    throw new BreakdownFetchError(
      `Couldn’t parse sector or country weights from the ${source.issuer} page. Enter the breakdown manually below.`,
      { status: 422, code: 'parse' }
    );
  }

  const scrapedAt = todayISO(now);
  const estimates = !parsed.asOf;
  const note = buildNote({
    issuer: source.issuer,
    scrapedAt,
    asOfEstimated: !!parsed.asOfEstimated,
    estimates,
  });

  return {
    mapped: true,
    source: sourceSummary(source),
    scrapedAt,
    asOfEstimated: !!parsed.asOfEstimated,
    estimates,
    proposed: {
      sectorBreakdown: parsed.sectorBreakdown.length ? parsed.sectorBreakdown : null,
      countryBreakdown: parsed.countryBreakdown.length ? parsed.countryBreakdown : null,
      breakdownAsOf: parsed.asOf,
      breakdownNote: note,
    },
  };
}
