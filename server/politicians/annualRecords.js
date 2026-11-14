// Turn a parsed annual filing into immutable rows. A filing key is inserted
// once. An amendment is a new key. A ticker printed on the row is never
// replaced by the name matcher.

import { annotateTrade } from './nameMatch.js';
import { canonicalTicker, displayName, personKey } from './normalize.js';
import { mapMatchedClass } from './holdingClass.js';

export function annualFilingId(source, filingKey) {
  return `annual:${source}:${filingKey}`;
}

export function buildAnnualFiling({
  source,
  filingKey,
  first,
  last,
  office,
  party = null,
  filerStatus = null,
  state = null,
  district = null,
  reportYear = null,
  filedDate = null,
  filingKind = 'original',
  sourceUrl,
  parsed,
}) {
  return {
    id: annualFilingId(source, filingKey),
    source,
    filingKey,
    personKey: personKey(office, last, first),
    personName: displayName(first, last) || 'Unknown',
    office,
    party,
    filerStatus: filerStatus || (office === 'house' ? null : 'member'),
    state,
    district,
    reportYear: Number.isFinite(Number(reportYear)) ? Number(reportYear) : null,
    filedDate: filedDate || null,
    filingKind: filingKind === 'amendment' ? 'amendment' : 'original',
    sourceUrl,
    parseStatus: parsed?.status || 'needs_manual_review',
    parseNote: parsed?.note || null,
    excludedCount: Number(parsed?.excludedCount) || 0,
    unreadableCount: Number(parsed?.unreadableCount) || 0,
    ocrDone: parsed?.ocrDone === true,
    ocrPage: parsed?.ocrPage ?? null,
    pageCount: parsed?.pageCount ?? null,
  };
}

const NO_MATCH = new Set(['bond', 'cash', 'real_estate', 'private', 'retirement', 'crypto']);

export function annotateHolding(holding, catalog = null) {
  const printed = canonicalTicker(holding?.ticker);
  const base = {
    ...holding,
    ticker: printed,
    tickerNorm: printed,
    tickerSource: printed ? 'filing' : null,
    tickerMatchConfidence: null,
  };
  if (printed || !catalog) return base;
  if (NO_MATCH.has(base.assetClass) || base.assetCode === 'OP' || /\b(call|put)s?\b|\boptions?\b/i.test(base.asset || '')) {
    return base;
  }
  const matched = annotateTrade({
    asset: base.asset,
    assetClass: base.assetClass === 'etf_fund' ? 'etf' : (base.assetClass || 'other'),
    ticker: null,
    tickerNorm: null,
  }, catalog);
  if (!matched?.ticker || matched.tickerSource !== 'name_match') return base;
  return {
    ...base,
    ticker: matched.ticker,
    tickerNorm: canonicalTicker(matched.ticker),
    tickerSource: 'name_match',
    tickerMatchConfidence: matched.tickerMatchConfidence ?? null,
    assetClass: base.assetClass && base.assetClass !== 'other'
      ? base.assetClass
      : mapMatchedClass(matched.assetClass),
  };
}

export function buildHoldingRows(filing, parsed, catalog = null) {
  const holdings = parsed?.holdings || [];
  return holdings.map((holding, index) => {
    const row = annotateHolding(holding, catalog);
    const rowIndex = index + 1;
    return {
      id: `${filing.id}:${rowIndex}`,
      filingId: filing.id,
      rowIndex,
      asset: row.asset,
      ticker: row.ticker || null,
      tickerNorm: row.tickerNorm || null,
      tickerSource: row.tickerSource || null,
      tickerMatchConfidence: row.tickerMatchConfidence ?? null,
      assetClass: row.assetClass || 'other',
      owner: row.owner || 'unknown',
      valueRange: row.valueRange,
      valueMin: row.valueMin,
      valueMax: row.valueMax,
      valueMid: row.valueMid,
      valueBound: row.valueBound,
      ocr: holding.ocr === true,
      ocrConfidence: Number.isFinite(Number(holding.ocrConfidence))
        ? Math.round(Number(holding.ocrConfidence))
        : null,
    };
  });
}

export function isReadableAnnual(filing) {
  return filing?.parseStatus === 'parsed' || filing?.parseStatus === 'partial';
}

// Newest filed disclosure wins. An unreadable amendment does not hide a
// readable original of the same report year. A newer report year that cannot
// be read is not replaced by an older year.
export function selectCurrentAnnual(filings) {
  const list = (filings || []).slice().sort((a, b) => {
    const date = String(b.filedDate || '').localeCompare(String(a.filedDate || ''));
    if (date) return date;
    const year = (Number(b.reportYear) || 0) - (Number(a.reportYear) || 0);
    if (year) return year;
    const kind = (b.filingKind === 'amendment') - (a.filingKind === 'amendment');
    if (kind) return kind;
    return String(b.filingKey || '').localeCompare(String(a.filingKey || ''));
  });
  if (!list.length) return { current: null, newerUnreadable: null };
  const newest = list[0];
  if (isReadableAnnual(newest)) return { current: newest, newerUnreadable: null };
  const sameYear = list.filter((row) => row !== newest && (row.reportYear || null) === (newest.reportYear || null));
  const prior = sameYear.find((row) => isReadableAnnual(row));
  if (prior) return { current: prior, newerUnreadable: newest };
  return { current: newest, newerUnreadable: null };
}
