// House annual Financial Disclosure reports.
//
// The yearly index is the same {year}FD.zip the PTR poll reads. FilingType O
// is an original annual report. FilingType A is an amendment, and the e-filed
// amendments restate Schedule A. The PDF is
// /public_disc/financial-pdfs/{year}/{DocID}.pdf.
//
// Schedule A is a table. Asset names sit in the left column, the owner code
// (SP / JT / DC, blank = self) in the next, and the value range after that.
// Income columns are to the right and are not holdings. A value that wraps
// ("$5,000,001 -" then "$25,000,000") stays one range. "None" is excluded.

import { canonicalTicker, parseUsDate } from './normalize.js';
import { parseAssetValue } from './assetValue.js';
import { classFromHouseCode, classFromDescribedHolding } from './holdingClass.js';
import { bandText, forEachPdfPage, itemsToRows, rowText } from './pdfItems.js';
import { HOUSE_BASE } from './parseHouse.js';

export function houseAnnualUrl(year, docId) {
  return `${HOUSE_BASE}/public_disc/financial-pdfs/${year}/${docId}.pdf`;
}

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

function annualKind(filingType) {
  if (filingType === 'O') return 'original';
  if (filingType === 'A') return 'amendment';
  return null;
}

function pushAnnual(filings, fields) {
  const kind = annualKind(fields.filingType);
  if (!kind) return;
  const docId = fields.docId;
  const year = fields.year;
  if (!docId || !year) return;
  filings.push({
    source: 'house',
    filingKey: `${year}:${docId}`,
    docId,
    year: Number(year),
    reportYear: Number(year),
    filingKind: kind,
    first: fields.first || '',
    last: fields.last || '',
    prefix: fields.prefix || '',
    suffix: fields.suffix || '',
    stateDst: fields.stateDst || '',
    filedDate: parseUsDate(fields.filedDate || ''),
    sourceUrl: houseAnnualUrl(year, docId),
  });
}

export function parseHouseAnnualIndexXml(xml) {
  const filings = [];
  const re = /<Member>([\s\S]*?)<\/Member>/gi;
  let m;
  while ((m = re.exec(String(xml))) !== null) {
    const block = m[1];
    pushAnnual(filings, {
      filingType: tagText(block, 'FilingType'),
      docId: tagText(block, 'DocID'),
      year: tagText(block, 'Year'),
      first: tagText(block, 'First'),
      last: tagText(block, 'Last'),
      prefix: tagText(block, 'Prefix'),
      suffix: tagText(block, 'Suffix'),
      stateDst: tagText(block, 'StateDst'),
      filedDate: tagText(block, 'FilingDate'),
    });
  }
  return filings;
}

export function parseHouseAnnualIndexTxt(text) {
  const lines = String(text).replace(/^\uFEFF/, '').split(/\r?\n/);
  if (!lines.length) return [];
  const header = lines[0].split('\t').map((h) => h.trim());
  const idx = (name) => header.indexOf(name);
  const filings = [];
  for (const line of lines.slice(1)) {
    if (!line.trim()) continue;
    const cols = line.split('\t');
    pushAnnual(filings, {
      filingType: cols[idx('FilingType')]?.trim(),
      docId: cols[idx('DocID')]?.trim(),
      year: cols[idx('Year')]?.trim(),
      first: cols[idx('First')]?.trim() || '',
      last: cols[idx('Last')]?.trim() || '',
      prefix: cols[idx('Prefix')]?.trim() || '',
      suffix: cols[idx('Suffix')]?.trim() || '',
      stateDst: cols[idx('StateDst')]?.trim() || '',
      filedDate: cols[idx('FilingDate')] || '',
    });
  }
  return filings;
}

function isSchedulePage(items) {
  return (items || []).some((item) => /value of asset/i.test(item.str));
}

function isMetaLine(asset) {
  return /^[LD]\s*:/.test(asset) || /^\*\s*for the complete list/i.test(asset);
}

function isHeaderLine(asset, whole) {
  if (!asset) return false;
  if (/^(asset|owner|filing id|name|status|state\/district|filing type|filing year|filing date|period covered)\b/i.test(asset)) {
    return true;
  }
  if (/^S\s*B\b/.test(asset) || /^S\s*B\b/.test(whole)) return true;
  if (/clerk of the house/i.test(whole)) return true;
  if (/^none disclosed\.?$/i.test(asset)) return true;
  if (/^i certify\b/i.test(asset)) return true;
  return false;
}

function valueStarts(text) {
  return /^(none|over\s+\$|\$[\d,]+)/i.test(text);
}

function bareUpper(text) {
  return /^\$[\d,]+$/.test(text);
}

function ownerCode(text) {
  const token = String(text || '').trim().toUpperCase();
  if (token === 'SP') return 'spouse';
  if (token === 'JT') return 'joint';
  if (token === 'DC') return 'dependent';
  return null;
}

function tickerFromAsset(asset) {
  const found = [...String(asset || '').matchAll(/\(([A-Z][A-Z0-9.]{0,8})\)/g)]
    .map((m) => canonicalTicker(m[1]))
    .filter(Boolean);
  return found.length ? found[found.length - 1] : null;
}

function codeFromAsset(asset) {
  const codes = [...String(asset || '').matchAll(/\[([A-Z0-9]{2})\]/g)];
  return codes.length ? codes[codes.length - 1][1] : null;
}

function finishAsset(draft) {
  const asset = draft.parts.join(' ').replace(/\s+/g, ' ').trim();
  const valueText = draft.values.join(' ').replace(/\s+/g, ' ').trim();
  if (!asset || !valueText) return { kind: 'unreadable' };
  const value = parseAssetValue(valueText);
  if (value.kind === 'excluded') return { kind: 'excluded', reason: value.reason };
  if (value.kind !== 'range' && value.kind !== 'at_least') return { kind: 'unreadable' };
  const code = codeFromAsset(asset);
  const assetClass = code ? classFromHouseCode(code) : classFromDescribedHolding(asset);
  const name = asset.replace(/\s*\[[A-Z0-9]{2}\]\s*/g, ' ').replace(/\s+/g, ' ').trim();
  return {
    kind: 'holding',
    holding: {
      asset: name || asset,
      ticker: tickerFromAsset(asset),
      assetClass: assetClass || 'other',
      assetCode: code,
      owner: draft.owner || 'self',
      valueRange: value.label,
      valueMin: value.min,
      valueMax: value.max,
      valueMid: value.mid,
      valueBound: value.kind === 'at_least' ? 'at_least' : 'range',
    },
  };
}

export function createHouseAnnualParse() {
  return {
    sawSchedule: false,
    open: null,
    holdings: [],
    excluded: 0,
    unreadable: 0,
  };
}

function accept(state, result) {
  if (!result) return;
  if (result.kind === 'holding') state.holdings.push(result.holding);
  else if (result.kind === 'excluded') state.excluded += 1;
  else state.unreadable += 1;
}

function flush(state) {
  if (!state.open) return;
  accept(state, finishAsset(state.open));
  state.open = null;
}

export function consumeHouseAnnualPage(state, items) {
  if (state.closed) return state;
  if (!isSchedulePage(items)) {
    if (state.sawSchedule) flush(state);
    return state;
  }
  state.sawSchedule = true;
  for (const row of itemsToRows(items)) {
    const asset = bandText(row.items, 0, 220);
    const owner = ownerCode(bandText(row.items, 220, 270));
    const value = bandText(row.items, 270, 360);
    const whole = rowText(row.items);
    if (/^S\s*B\b/.test(asset) || /^S\s*B\b/.test(whole)) {
      state.closed = true;
      flush(state);
      return state;
    }
    if (!asset && !value) continue;
    if (asset && (isMetaLine(asset) || isHeaderLine(asset, whole))) continue;
    const codeOnly = /^(\[[A-Z0-9]{2}\]\s*)+$/.test(asset);
    const openValue = state.open ? state.open.values.join(' ') : '';
    const continueValue = state.open && (
      (codeOnly || (asset && !value && !owner && /\[[A-Z0-9]{2}\]/.test(asset)))
      || (
        /-\s*$/.test(openValue)
        && (bareUpper(value) || (!asset && valueStarts(value)))
      )
    );
    if (continueValue) {
      if (asset) state.open.parts.push(asset);
      if (owner && !state.open.owner) state.open.owner = owner;
      if (value) state.open.values.push(value);
      continue;
    }
    if (asset && (valueStarts(value) || owner || /\[[A-Z0-9]{2}\]/.test(asset))) {
      flush(state);
      state.open = { parts: [asset], owner, values: value ? [value] : [] };
    }
  }
  return state;
}

export function houseAnnualResult(state) {
  flush(state);
  if (!state.sawSchedule) {
    return {
      status: 'needs_manual_review',
      holdings: [],
      excludedCount: 0,
      unreadableCount: 0,
      note: 'No Schedule A text layer. The annual report looks scanned, so no holdings were guessed.',
    };
  }
  const kept = state.holdings.length;
  const dropped = state.unreadable;
  if (!kept && dropped && !state.excluded) {
    return {
      status: 'needs_manual_review',
      holdings: [],
      excludedCount: state.excluded,
      unreadableCount: dropped,
      note: 'Schedule A was present, but no value range could be read. Those rows were not guessed.',
    };
  }
  const status = dropped ? 'partial' : 'parsed';
  const bits = [];
  if (state.excluded) {
    bits.push(`${state.excluded} item${state.excluded === 1 ? '' : 's'} with value None or not disclosed ${state.excluded === 1 ? 'was' : 'were'} left out`);
  }
  if (dropped) {
    bits.push(`${dropped} row${dropped === 1 ? '' : 's'} had a value that was not a statutory range and ${dropped === 1 ? 'was' : 'were'} not guessed`);
  }
  return {
    status,
    holdings: state.holdings,
    excludedCount: state.excluded,
    unreadableCount: dropped,
    note: bits.length ? `${bits.join('. ')}.` : null,
  };
}

export async function parseHouseAnnualPdf(buffer, forEachPage = forEachPdfPage) {
  const state = createHouseAnnualParse();
  await forEachPage(buffer, ({ items }) => {
    consumeHouseAnnualPage(state, items);
  });
  return houseAnnualResult(state);
}
