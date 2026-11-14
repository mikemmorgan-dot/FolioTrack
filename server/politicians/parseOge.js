// OGE Form 278-T for the President and Vice President.
//
// The public index is the Officials' Individual Disclosures Search Collection.
// The page loads rows from GET
// https://extapps2.oge.gov/201/Presiden.nsf/API.xsp/v3/rest
// (DataTables query params). `type` is HTML: a direct PDF link, or
// "Request this Document" when the file is not posted.
//
// Presidential 278-T PDFs checked in November 2026 are multi-megabyte scans.
// The OCR text layer misreads purchase/sale and dates. Those filings are
// stored with the PDF link and marked needs manual review. A text-layer
// report is accepted only when each kept row has an exact type word, a real
// date, and a statutory amount range, and almost every dollar-amount line
// meets that bar.

import { classifyDescribedAsset } from './nameMatch.js';
import { canonicalAmountRange, canonicalTicker, normalizeOwner, parseUsDate } from './normalize.js';

export const OGE_API = 'https://extapps2.oge.gov/201/Presiden.nsf/API.xsp/v3/rest';
export const OGE_COLLECTION = 'https://www.oge.gov/web/OGE.nsf/Officials%20Individual%20Disclosures%20Search%20Collection?OpenForm';

export function ogeOffice(title) {
  const t = String(title || '').trim().toLowerCase();
  if (t === 'president') return 'president';
  if (t === 'vice president') return 'vice-president';
  return null;
}

export function parseOgeApiRow(row) {
  if (!row || typeof row !== 'object') return null;
  const typeHtml = String(row.type || '');
  const label = typeHtml.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  if (!/278\s*transaction/i.test(label)) return null;
  const href = /href=['"]([^'"]+)['"]/i.exec(typeHtml);
  const url = href ? href[1].replace(/&amp;/g, '&') : null;
  const request = !url || /request this document/i.test(label) || /201(?:%20|\s)Request/i.test(url);
  const name = String(row.name || '').trim();
  const comma = name.indexOf(',');
  const last = comma >= 0 ? name.slice(0, comma).trim() : name;
  const first = comma >= 0 ? name.slice(comma + 1).trim() : '';
  const filedDate = String(row.docDate || '').slice(0, 10);
  const office = ogeOffice(row.title);
  let filingKey = null;
  if (!request && url) {
    const unid = /\/([A-F0-9]{16,})\/\$FILE\//i.exec(url.replace(/%2B/gi, '+'));
    filingKey = unid ? unid[1].toUpperCase() : null;
  }
  if (!filingKey) {
    const stamp = filedDate && /^\d{4}-\d{2}-\d{2}$/.test(filedDate) ? filedDate : 'undated';
    filingKey = `request:${name.toLowerCase()}:${stamp}`;
  }
  return {
    source: 'oge',
    filingKey,
    first,
    last,
    name,
    title: String(row.title || '').trim(),
    office,
    filedDate: /^\d{4}-\d{2}-\d{2}$/.test(filedDate) ? filedDate : null,
    request,
    sourceUrl: request
      ? (url || OGE_COLLECTION)
      : url,
  };
}

const TYPE_WORD = /\b(purchase|sale|exchange)\b/i;
const DATE_WORD = /\b(\d{1,2}\/\d{1,2}\/\d{4})\b/;

function ogeAssetClass(asset, ticker) {
  return classifyDescribedAsset(asset, { ticker });
}

function parseOgeLine(line) {
  const typeMatch = line.match(TYPE_WORD);
  const dateMatch = line.match(DATE_WORD);
  const amount = canonicalAmountRange(line);
  if (!typeMatch || !dateMatch || !amount) return null;
  if (typeMatch.index > dateMatch.index) return null;
  const txDate = parseUsDate(dateMatch[1]);
  if (!txDate) return null;
  let asset = line.slice(0, typeMatch.index).replace(/^\d+\s+/, '').replace(/\s+/g, ' ').trim();
  asset = asset.replace(/\s+(yes|no)\s*$/i, '').trim();
  if (!/[A-Za-z]{3,}/.test(asset)) return null;
  const word = typeMatch[1].toLowerCase();
  const txType = word === 'purchase' ? 'buy' : word === 'sale' ? 'sell' : 'exchange';
  const tickers = [...asset.matchAll(/\(([A-Z][A-Z0-9.]{0,8})\)/g)]
    .map((m) => canonicalTicker(m[1]))
    .filter(Boolean);
  const ticker = tickers.length ? tickers[tickers.length - 1] : null;
  let owner = 'unknown';
  const ownerPrefix = asset.match(/^(spouse|joint|dependent child|child)\s*[:\-]\s*/i);
  if (ownerPrefix) {
    owner = normalizeOwner(ownerPrefix[1]);
    asset = asset.slice(ownerPrefix[0].length).trim();
  }
  return {
    owner,
    ticker,
    asset,
    assetClass: ogeAssetClass(asset, ticker),
    txType,
    partial: false,
    txDate,
    amountRange: amount,
  };
}

export function parseOge278Text(text) {
  const lines = String(text ?? '')
    .replace(/\u0000/g, '')
    .split(/\r?\n/)
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  const letters = (String(text ?? '').match(/[A-Za-z]/g) || []).length;
  if (letters < 40) {
    return {
      status: 'needs_manual_review',
      trades: [],
      note: 'No readable text layer. The 278-T looks scanned and was not guessed.',
    };
  }
  const amountLines = lines.filter((l) => /\$\s*\d/.test(l));
  const trades = [];
  for (const line of lines) {
    if (!/\$\s*\d/.test(line)) continue;
    const trade = parseOgeLine(line);
    if (trade) trades.push(trade);
  }
  const reliable = amountLines.length === 0
    ? false
    : trades.length / amountLines.length >= 0.8 && trades.length === amountLines.length;
  if (!trades.length || !reliable) {
    return {
      status: 'needs_manual_review',
      trades: [],
      note: 'The 278-T text layer is not reliable enough to read transactions. Open the filing to review it.',
    };
  }
  return { status: 'parsed', trades, note: null };
}
