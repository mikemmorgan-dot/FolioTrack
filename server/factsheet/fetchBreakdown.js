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
  parseFactsheetText,
  findFactsheetPdfUrl,
  hasBreakdownRows,
  emptyParse,
  pdfBufferToText,
} from './parse.js';
import { parseFundFactsText, parseFundPulseText, parseRbcMonthlyText, isRbcMonthlyText } from './parseFundDocs.js';
import { parseManulifeEtfText, isManulifeEtfText } from './parseManulifeEtf.js';
import { hasPublishedReturns, mergePublishedReturns, publishedToPeriodRow } from './publishedReturns.js';

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

export function buildNote({ issuer, scrapedAt, asOfEstimated, estimates, documentLabel = 'factsheet' }) {
  const bits = [`Issuer ${documentLabel} · ${issuer} · scraped ${scrapedAt}`];
  if (asOfEstimated) bits.push('as-of estimated');
  if (estimates) bits.push('estimates');
  return bits.join(' · ');
}

export function sourceSummary(source) {
  if (!source) return null;
  const out = {
    symbol: source.symbol,
    issuer: source.issuer,
    parser: source.parser,
    url: source.url,
  };
  if (source.series) out.series = source.series;
  if (source.fundserv) out.fundserv = source.fundserv;
  if (source.fundPulseUrl) out.fundPulseUrl = source.fundPulseUrl;
  if (source.monthlyUrl) out.monthlyUrl = source.monthlyUrl;
  if (source.productUrl) out.productUrl = source.productUrl;
  if (source.documentLabel) out.documentLabel = source.documentLabel;
  return out;
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

async function optionalGet(url, fetchImpl) {
  if (!url) return null;
  try {
    return await httpGet(url, fetchImpl);
  } catch {
    // Secondary docs (FundPulse) must not fail a Fund Facts parse that already worked.
    return null;
  }
}

function attachPublishedMeta(pub, { source, scrapedAt, document, label }) {
  if (!pub) return null;
  return {
    ...pub,
    kind: 'published',
    scrapedAt,
    source: `${label} · ${source.issuer}`,
    document: document || pub.document || source.url,
    series: pub.series || source.series || null,
  };
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
  let mer = null;
  let factsPublished = null;
  let pulse = null;
  let navPoint = null;
  let documentLabel = source.documentLabel || 'factsheet';

  const isPdf = looksLikePdf(first.finalUrl, first.ctype) || source.parser === 'pdf';

  if (isPdf) {
    try {
      if (source.kind === 'mutualfund' || source.fundPulseUrl || source.documentLabel === 'Fund Facts') {
        const text = await pdfBufferToText(first.buf);
        const facts = parseFundFactsText(text);
        parsed = {
          sectorBreakdown: facts.sectorBreakdown,
          countryBreakdown: facts.countryBreakdown,
          asOf: facts.asOf,
          asOfEstimated: facts.asOfEstimated,
        };
        mer = facts.mer;
        factsPublished = facts.published;
        documentLabel = source.documentLabel || 'Fund Facts';
      } else {
        const text = await pdfBufferToText(first.buf);
        if (source.kind === 'manulife-etf' || isManulifeEtfText(text)) {
          const manulife = parseManulifeEtfText(text);
          parsed = {
            sectorBreakdown: manulife.sectorBreakdown,
            countryBreakdown: manulife.countryBreakdown,
            asOf: manulife.asOf,
            asOfEstimated: manulife.asOfEstimated,
          };
          mer = manulife.mer;
          factsPublished = manulife.published;
          navPoint = manulife.navPoint;
          documentLabel = source.documentLabel || 'factsheet';
        } else {
          parsed = parseFactsheetText(text);
        }
      }
    } catch (e) {
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

  const secondaryUrl = source.fundPulseUrl || source.monthlyUrl;
  let monthly = null;
  if (secondaryUrl) {
    const pulseGot = await optionalGet(secondaryUrl, fetchImpl);
    if (pulseGot) {
      try {
        const pulseText = await pdfBufferToText(pulseGot.buf);
        if (source.monthlyUrl && (source.issuer === 'RBC GAM' || isRbcMonthlyText(pulseText))) {
          monthly = parseRbcMonthlyText(pulseText);
        } else {
          pulse = parseFundPulseText(pulseText);
        }
      } catch {
        pulse = null;
        monthly = null;
      }
    }
  }

  const secondary = monthly || pulse;
  if (monthly && (monthly.sectorBreakdown?.length || monthly.countryBreakdown?.length)) {
    parsed = {
      sectorBreakdown: monthly.sectorBreakdown?.length ? monthly.sectorBreakdown : parsed.sectorBreakdown,
      countryBreakdown: monthly.countryBreakdown?.length ? monthly.countryBreakdown : parsed.countryBreakdown,
      asOf: monthly.allocationAsOf || monthly.asOf || parsed.asOf,
      asOfEstimated: false,
    };
    documentLabel = 'Monthly update';
  } else if (!hasBreakdownRows(parsed) && pulse && (pulse.sectorBreakdown?.length || pulse.countryBreakdown?.length)) {
    parsed = {
      sectorBreakdown: pulse.sectorBreakdown || [],
      countryBreakdown: pulse.countryBreakdown || [],
      asOf: pulse.allocationAsOf || pulse.asOf,
      asOfEstimated: false,
    };
    documentLabel = 'FundPulse';
  }

  const scrapedAt = todayISO(now);
  const published = mergePublishedReturns(
    attachPublishedMeta(secondary?.published, {
      source,
      scrapedAt,
      document: secondaryUrl,
      label: monthly ? 'Monthly update' : 'FundPulse',
    }),
    attachPublishedMeta(factsPublished, {
      source, scrapedAt, document: source.url, label: source.documentLabel || 'Fund Facts',
    })
  );

  if (!hasBreakdownRows(parsed) && !hasPublishedReturns(published)) {
    throw new BreakdownFetchError(
      `Couldn’t parse sector or country weights from the ${source.issuer} page. Enter the breakdown manually below.`,
      { status: 422, code: 'parse' }
    );
  }

  const estimates = !parsed.asOf;
  const note = hasBreakdownRows(parsed)
    ? buildNote({
      issuer: source.issuer,
      scrapedAt,
      asOfEstimated: !!parsed.asOfEstimated,
      estimates,
      documentLabel,
    })
    : null;

  if (mer == null && secondary?.mer != null) mer = secondary.mer;

  const proposed = {
    sectorBreakdown: parsed.sectorBreakdown?.length ? parsed.sectorBreakdown : null,
    countryBreakdown: parsed.countryBreakdown?.length ? parsed.countryBreakdown : null,
    breakdownAsOf: parsed.asOf || null,
    breakdownNote: note,
  };
  if (mer != null) proposed.mer = mer;
  if (published) {
    proposed.publishedReturns = {
      ...published,
      scrapedAt,
      source: published.source || `${documentLabel} · ${source.issuer}`,
      series: published.series || source.series || null,
    };
    proposed.publishedPeriodReturns = publishedToPeriodRow(proposed.publishedReturns);
  }
  if (!navPoint && secondary?.navPoint) navPoint = secondary.navPoint;
  if (navPoint) {
    proposed.navPoint = {
      ...navPoint,
      source: navPoint.source || `${documentLabel} · ${source.issuer}`,
    };
  }

  return {
    mapped: true,
    source: sourceSummary(source),
    scrapedAt,
    asOfEstimated: !!parsed.asOfEstimated,
    estimates,
    proposed,
  };
}
