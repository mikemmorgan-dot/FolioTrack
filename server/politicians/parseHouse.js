// House Clerk periodic transaction reports.
//
// The yearly index is {year}FD.zip → {year}FD.xml (the same rows are also in
// {year}FD.txt). FilingType P is a Periodic Transaction Report. The PDF for
// DocID is /public_disc/ptr-pdfs/{year}/{DocID}.pdf.
//
// pdfjs lays a machine-generated PTR out as one row that often wraps:
//   SP Warner Bros. Discovery, Inc. - Series S 10/07/2026 10/07/2026 $50,001 -
//   A Common Stock (WBD) [ST] $100,000
// Scanned filings (DocIDs that start with 8 or 9 are usually paper) have no
// text layer. Those stay metadata + link.

import { canonicalAmountRange, canonicalTicker, parseUsDate } from './normalize.js';

export const HOUSE_BASE = 'https://disclosures-clerk.house.gov';

export function houseIndexUrl(year) {
  return `${HOUSE_BASE}/public_disc/financial-pdfs/${year}FD.zip`;
}

export function housePtrUrl(year, docId) {
  return `${HOUSE_BASE}/public_disc/ptr-pdfs/${year}/${docId}.pdf`;
}

const ASSET_CLASS = {
  ST: 'stock',
  EF: 'etf',
  ET: 'etf',
  MF: 'fund',
  OP: 'option',
  CT: 'crypto',
  CS: 'bond',
  GS: 'bond',
  AB: 'bond',
  PS: 'other',
  RE: 'stock',
  RF: 'stock',
  RN: 'stock',
};

function decodeXml(text) {
  return String(text)
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

function tagText(block, name) {
  const m = block.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`, 'i'));
  return m ? decodeXml(m[1]).replace(/\s+/g, ' ').trim() : '';
}

export function parseHouseIndexXml(xml) {
  const filings = [];
  const re = /<Member>([\s\S]*?)<\/Member>/gi;
  let m;
  while ((m = re.exec(String(xml))) !== null) {
    const block = m[1];
    const filingType = tagText(block, 'FilingType');
    if (filingType !== 'P') continue;
    const docId = tagText(block, 'DocID');
    const year = tagText(block, 'Year');
    if (!docId || !year) continue;
    const filed = parseUsDate(tagText(block, 'FilingDate'));
    filings.push({
      source: 'house',
      filingKey: `${year}:${docId}`,
      docId,
      year,
      first: tagText(block, 'First'),
      last: tagText(block, 'Last'),
      prefix: tagText(block, 'Prefix'),
      suffix: tagText(block, 'Suffix'),
      stateDst: tagText(block, 'StateDst'),
      filedDate: filed,
      sourceUrl: housePtrUrl(year, docId),
    });
  }
  return filings;
}

export function parseHouseIndexTxt(text) {
  const lines = String(text).replace(/^\uFEFF/, '').split(/\r?\n/);
  if (!lines.length) return [];
  const header = lines[0].split('\t').map((h) => h.trim());
  const idx = (name) => header.indexOf(name);
  const filings = [];
  for (const line of lines.slice(1)) {
    if (!line.trim()) continue;
    const cols = line.split('\t');
    if (cols[idx('FilingType')]?.trim() !== 'P') continue;
    const docId = cols[idx('DocID')]?.trim();
    const year = cols[idx('Year')]?.trim();
    if (!docId || !year) continue;
    filings.push({
      source: 'house',
      filingKey: `${year}:${docId}`,
      docId,
      year,
      first: cols[idx('First')]?.trim() || '',
      last: cols[idx('Last')]?.trim() || '',
      prefix: cols[idx('Prefix')]?.trim() || '',
      suffix: cols[idx('Suffix')]?.trim() || '',
      stateDst: cols[idx('StateDst')]?.trim() || '',
      filedDate: parseUsDate(cols[idx('FilingDate')] || ''),
      sourceUrl: housePtrUrl(year, docId),
    });
  }
  return filings;
}

function cleanPdfText(text) {
  return String(text ?? '').replace(/\u0000/g, '');
}

const TX_LINE = /^(?:(SP|DC|JT)\s+)?(.+?)\s+(P|S|E)(?:\s*\(partial\))?\s+(\d{1,2}\/\d{1,2}\/\d{4})\s+(\d{1,2}\/\d{1,2}\/\d{4})\s+(\$[\d,]+(?:\s*-\s*\$[\d,]+)?|\$[\d,]+\s*-|Over\s+\$[\d,]+)\s*$/;

function amountIncomplete(amount) {
  return /-\s*$/.test(amount) && !/\$[\d,]+\s*-\s*\$/.test(amount);
}

function splitAmountTail(line) {
  const m = line.match(/^(.*?)(\$[\d,]+|Over\s+\$[\d,]+)\s*$/);
  if (!m) return null;
  return { rest: m[1].trim(), amount: m[2] };
}

function isFooter(line) {
  return line.startsWith('* For the complete')
    || line.startsWith('I CERTIFY')
    || line.startsWith('Digitally Signed');
}

function metaKind(line) {
  if (/^F\s*S\s*:/.test(line)) return 'status';
  if (/^D\s*:/.test(line)) return 'desc';
  if (/^S\s*O\s*:/.test(line)) return 'sub';
  return null;
}

function mapType(code) {
  if (code === 'P') return 'buy';
  if (code === 'S') return 'sell';
  if (code === 'E') return 'exchange';
  return null;
}

function finishRow(raw) {
  let asset = raw.asset.replace(/\s+/g, ' ').trim();
  const codeMatch = asset.match(/\s\[([A-Z]{2})\]\s*$/);
  const code = codeMatch ? codeMatch[1] : null;
  if (codeMatch) asset = asset.slice(0, codeMatch.index).trim();
  const tickers = [...asset.matchAll(/\(([A-Z][A-Z0-9.]{0,8})\)/g)]
    .map((m) => canonicalTicker(m[1]))
    .filter(Boolean);
  const amount = canonicalAmountRange(raw.amount);
  const txType = mapType(raw.type);
  const txDate = parseUsDate(raw.txDate);
  if (!asset || !amount || !txType || !txDate) return null;
  const owner = raw.owner === 'SP' ? 'spouse'
    : raw.owner === 'JT' ? 'joint'
      : raw.owner === 'DC' ? 'child'
        : 'self';
  return {
    owner,
    ticker: tickers.length ? tickers[tickers.length - 1] : null,
    asset,
    assetClass: (code && ASSET_CLASS[code]) || 'other',
    assetCode: code,
    txType,
    partial: raw.partial,
    txDate,
    amountRange: amount,
  };
}

export function parseHousePtrText(text) {
  const cleaned = cleanPdfText(text);
  const lines = cleaned.split(/\r?\n/).map((l) => l.replace(/\s+/g, ' ').trim()).filter(Boolean);
  if (!lines.length) {
    return {
      status: 'needs_manual_review',
      trades: [],
      note: 'No text layer. The filing looks scanned and was not guessed.',
    };
  }

  const rows = [];
  let raw = null;
  let mode = 'seek';
  let sawStart = 0;
  let dropped = 0;

  const flush = () => {
    if (!raw) return;
    sawStart += 1;
    const trade = finishRow(raw);
    if (trade) rows.push(trade);
    else dropped += 1;
    raw = null;
    mode = 'seek';
  };

  for (const line of lines) {
    if (isFooter(line)) {
      flush();
      break;
    }
    const tx = line.match(TX_LINE);
    if (tx) {
      flush();
      raw = {
        owner: tx[1] || '',
        asset: tx[2],
        type: tx[3],
        partial: /\(partial\)/i.test(line),
        txDate: tx[4],
        amount: tx[6],
      };
      mode = 'asset';
      continue;
    }
    if (!raw) continue;
    const kind = metaKind(line);
    if (kind === 'desc') {
      mode = 'desc';
      continue;
    }
    if (kind) {
      mode = 'meta';
      continue;
    }
    if (mode === 'desc') continue;
    if (mode === 'meta') continue;
    if (amountIncomplete(raw.amount)) {
      const tail = splitAmountTail(line);
      if (tail) {
        raw.amount = `${raw.amount.replace(/\s*-\s*$/, '')} - ${tail.amount}`;
        if (tail.rest) raw.asset += ` ${tail.rest}`;
        continue;
      }
    }
    raw.asset += ` ${line}`;
  }
  flush();

  if (!rows.length) {
    return {
      status: 'needs_manual_review',
      trades: [],
      note: sawStart
        ? 'A transaction table was present but no row had a reliable date, type, and amount range.'
        : 'Filing text did not contain a readable transaction table.',
    };
  }
  return {
    status: 'parsed',
    trades: rows,
    note: dropped ? `${dropped} row${dropped === 1 ? '' : 's'} skipped because the amount or date was not readable.` : null,
  };
}
