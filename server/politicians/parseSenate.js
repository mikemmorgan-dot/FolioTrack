// Senate eFD periodic transaction reports.
//
// A session has to accept the prohibition agreement before search works.
// POST /search/report/data/ returns DataTables JSON. Each row is
// [first, last, filer label, report-link HTML, date received].
// Electronic filings are HTML at /search/view/ptr/{uuid}/ with a transactions
// table. Paper filings are /search/view/paper/{uuid}/ (scanned images). Paper
// is stored as a link and not fetched.

import { load } from 'cheerio';
import { isDebtDescription } from './nameMatch.js';
import { canonicalAmountRange, canonicalTicker, normalizeOwner, parseUsDate } from './normalize.js';

export const SENATE_BASE = 'https://efdsearch.senate.gov';

const HEADER_MAP = {
  '#': 'n',
  'transaction date': 'date',
  owner: 'owner',
  ticker: 'ticker',
  'asset name': 'asset',
  'asset type': 'assetType',
  type: 'type',
  amount: 'amount',
  comment: 'comment',
};

function assetClassFromLabel(label) {
  const s = String(label || '').toLowerCase();
  if (!s) return 'other';
  if (isDebtDescription(label)) return 'bond';
  if (s.includes('option')) return 'option';
  if (s.includes('crypto')) return 'crypto';
  if (!s.includes('etf') && !s.includes('exchange traded')
    && (s.includes('bond') || s.includes('note') || s.includes('municipal'))) return 'bond';
  if (s.includes('mutual fund') || s === 'fund') return 'fund';
  if (s.includes('etf') || s.includes('exchange traded')) return 'etf';
  if (s.includes('stock')) return 'stock';
  return 'other';
}

function mapSenateType(label) {
  const s = String(label || '').toLowerCase();
  const partial = s.includes('partial');
  if (s.includes('purchase') || s === 'buy') return { txType: 'buy', partial };
  if (s.includes('sale') || s === 'sell') return { txType: 'sell', partial };
  if (s.includes('exchange')) return { txType: 'exchange', partial };
  return null;
}

export function parseSenateSearchRow(row) {
  if (!Array.isArray(row) || row.length < 5) return null;
  const link = String(row[3] || '');
  const href = /href="([^"]+)"/i.exec(link);
  if (!href) return null;
  const path = href[1];
  const uuid = /\/(?:ptr|paper)\/([0-9a-f-]{36})\//i.exec(path);
  if (!uuid) return null;
  const kind = /\/paper\//i.test(path) ? 'paper' : (/\/ptr\//i.test(path) ? 'ptr' : null);
  if (!kind) return null;
  return {
    source: 'senate',
    filingKey: uuid[1].toLowerCase(),
    first: String(row[0] || '').trim(),
    last: String(row[1] || '').trim(),
    filer: String(row[2] || '').trim(),
    filedDate: parseUsDate(row[4]),
    path,
    kind,
    sourceUrl: path.startsWith('http') ? path : `${SENATE_BASE}${path}`,
  };
}

export function parseSenatePtrHtml(html) {
  const $ = load(String(html || ''));
  const tables = $('table').toArray();
  let table = null;
  let headers = [];
  for (const el of tables) {
    const heads = $(el).find('th').toArray().map((th) => $(th).text().replace(/\s+/g, ' ').trim().toLowerCase());
    if (heads.includes('transaction date') && heads.includes('amount')) {
      table = el;
      headers = heads;
      break;
    }
  }
  if (!table) {
    return {
      status: 'needs_manual_review',
      trades: [],
      note: 'The electronic report had no transaction table.',
    };
  }
  const cols = headers.map((h) => HEADER_MAP[h] || null);
  const trades = [];
  let dropped = 0;
  $(table).find('tr').each((_, tr) => {
    const cells = $(tr).find('td').toArray().map((td) => $(td).text().replace(/\s+/g, ' ').trim());
    if (!cells.length) return;
    const rec = {};
    cols.forEach((key, i) => {
      if (key) rec[key] = cells[i] || '';
    });
    const txDate = parseUsDate(rec.date);
    const typed = mapSenateType(rec.type);
    const amount = canonicalAmountRange(rec.amount);
    const asset = String(rec.asset || '').trim();
    if (!txDate || !typed || !amount || !asset) {
      dropped += 1;
      return;
    }
    const ticker = canonicalTicker(rec.ticker);
    trades.push({
      owner: normalizeOwner(rec.owner),
      ticker,
      asset,
      assetClass: assetClassFromLabel(rec.assetType),
      txType: typed.txType,
      partial: typed.partial,
      txDate,
      amountRange: amount,
    });
  });
  if (!trades.length) {
    return {
      status: 'needs_manual_review',
      trades: [],
      note: 'The transaction table had no row with a reliable date, type, and amount range.',
    };
  }
  return {
    status: 'parsed',
    trades,
    note: dropped ? `${dropped} row${dropped === 1 ? '' : 's'} skipped because a field was not readable.` : null,
  };
}

export function reviewPaperFiling(note = 'Paper filing. The Senate publishes this as a scanned image, so the trades were not guessed.') {
  return { status: 'needs_manual_review', trades: [], note };
}
