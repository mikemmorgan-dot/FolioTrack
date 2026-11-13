// Turn a parsed filing into the row the stores insert. Trade ids are the
// filing id plus the row number, which is what makes a re-poll a no-op.

import { canonicalTicker, displayName, lagDays, personKey } from './normalize.js';

export function splitStateDst(stateDst) {
  const sd = String(stateDst || '');
  if (!/^[A-Z]{2}\d{2}$/.test(sd)) return { state: null, district: null };
  return { state: sd.slice(0, 2), district: sd.slice(2) };
}

export function buildFilingRecord({
  source,
  filingKey,
  first,
  last,
  office,
  party = null,
  filerStatus = null,
  state = null,
  district = null,
  filedDate = null,
  sourceUrl,
  parsed,
}) {
  const id = `${source}:${filingKey}`;
  return {
    id,
    source,
    filingKey,
    personKey: personKey(office, last, first),
    personName: displayName(first, last) || 'Unknown',
    office,
    party,
    filerStatus: filerStatus || (office === 'house' ? null : 'member'),
    state,
    district,
    filedDate,
    sourceUrl,
    parseStatus: parsed?.status || 'needs_manual_review',
    parseNote: parsed?.note || null,
    ocrDone: parsed?.ocrDone === true,
    ocrPage: parsed?.ocrPage ?? null,
    pageCount: parsed?.pageCount ?? null,
  };
}

export function buildTradeRows(filing, parsed) {
  if (!parsed?.trades?.length) return [];
  return parsed.trades.map((trade, index) => {
    const rowIndex = index + 1;
    return {
      id: `${filing.id}:${rowIndex}`,
      filingId: filing.id,
      rowIndex,
      personKey: filing.personKey,
      personName: filing.personName,
      office: filing.office,
      party: filing.party,
      filerStatus: filing.filerStatus || null,
      state: filing.state,
      owner: trade.owner,
      ticker: trade.ticker || null,
      tickerNorm: canonicalTicker(trade.ticker),
      asset: trade.asset,
      assetClass: trade.assetClass || 'other',
      txType: trade.txType,
      partial: trade.partial === true,
      txDate: trade.txDate,
      disclosedDate: filing.filedDate,
      lagDays: lagDays(trade.txDate, filing.filedDate),
      amountRange: trade.amountRange,
      sourceUrl: filing.sourceUrl,
      ocr: trade.ocr === true,
      ocrConfidence: Number.isFinite(Number(trade.ocrConfidence))
        ? Math.round(Number(trade.ocrConfidence))
        : null,
    };
  });
}

export function heldIndex(symbols) {
  const map = new Map();
  for (const row of symbols || []) {
    if (!row?.tickerNorm) continue;
    const list = map.get(row.tickerNorm) || [];
    if (!list.some((m) => m.key === row.modelKey)) {
      list.push({ key: row.modelKey, name: row.modelName });
    }
    map.set(row.tickerNorm, list);
  }
  return map;
}

export function badgesBySymbol(symbols, summaries) {
  const byNorm = new Map((summaries || []).map((s) => [s.tickerNorm, s]));
  const models = heldIndex(symbols);
  const out = {};
  for (const row of symbols || []) {
    if (!row?.symbol || !row.tickerNorm) continue;
    const hit = byNorm.get(row.tickerNorm);
    if (!hit?.count) continue;
    out[row.symbol] = {
      count: hit.count,
      latest: hit.latest || null,
      models: (models.get(row.tickerNorm) || []).map((m) => m.name || m.key),
    };
  }
  return out;
}
