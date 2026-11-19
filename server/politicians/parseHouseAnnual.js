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
import { classifyHolding } from './holdingClass.js';
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

function cleanText(text) {
  return String(text || '').replace(/\u0000/g, '').replace(/\s+/g, ' ').trim();
}

function cleanItems(items) {
  return (items || [])
    .map((item) => ({ ...item, str: cleanText(item.str) }))
    .filter((item) => item.str);
}

function letterCount(items) {
  return (items || []).reduce((sum, item) => sum + String(item.str || '').replace(/[^A-Za-z]/g, '').length, 0);
}

function scheduleCode(text) {
  const m = cleanText(text).match(/^s\s*([a-i])\s*:/i);
  return m ? m[1].toUpperCase() : null;
}

function isScheduleAHeader(text) {
  return /value of asset/i.test(text) || /schedule\s*a\b/i.test(text) || scheduleCode(text) === 'A';
}

function isSchedulePage(items) {
  return (items || []).some((item) => isScheduleAHeader(item.str));
}

function isNoneDisclosed(text) {
  return /^none disclosed\.?$/i.test(String(text || '').trim());
}

function isMetaLine(asset) {
  return /^[LD]\s*:/.test(asset) || /^\*\s*for the complete list/i.test(asset);
}

function isHeaderLine(asset, whole) {
  if (!asset && !whole) return false;
  const text = asset || whole;
  if (/^(asset|owner|filing id|name|status|state\/district|filing type|filing year|filing date|period covered)\b/i.test(text)) {
    return true;
  }
  if (/^S\s*B\b/.test(asset || '') || /^S\s*B\b/.test(whole || '')) return true;
  if (/clerk of the house/i.test(whole || '')) return true;
  if (isNoneDisclosed(asset) || isNoneDisclosed(whole)) return true;
  if (/^i certify\b/i.test(asset || '')) return true;
  return false;
}

function valueStarts(text) {
  return /^(none|undetermined|over\s+\$|\$[\d,]+)/i.test(text);
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

const DEFAULT_COLUMNS = { asset: [0, 220], owner: [220, 270], value: [270, 360], income: 360 };

function headerX(items, pattern) {
  const hit = (items || []).find((item) => pattern.test(item.str || ''));
  return hit ? hit.x : null;
}

export function columnsFromHeaderItems(items) {
  const valueX = headerX(items, /value of asset/i);
  if (valueX == null) return null;
  const assetX = headerX(items, /^asset$/i);
  const ownerX = headerX(items, /^owner$/i);
  const incomeX = headerX(items, /^income type/i);
  const ownerStart = ownerX != null ? ownerX - 8 : valueX - 50;
  const valueStart = ownerX != null
    ? Math.min(valueX - 8, (ownerX + valueX) / 2)
    : valueX - 15;
  const valueEnd = incomeX != null ? incomeX - 6 : valueX + 120;
  return {
    asset: [assetX == null ? 0 : Math.max(0, assetX - 5), ownerStart],
    owner: [ownerStart, valueStart],
    value: [valueStart, valueEnd],
    income: valueEnd,
  };
}

function band(columns, name) {
  const cols = columns || DEFAULT_COLUMNS;
  return cols[name] || DEFAULT_COLUMNS[name];
}

function firstStatutoryValue(items, incomeX) {
  const sorted = [...(items || [])].sort((a, b) => a.x - b.x);
  const parts = [];
  for (const item of sorted) {
    if (incomeX != null && item.x >= incomeX) break;
    parts.push(item.str);
  }
  const text = parts.join(' ').replace(/\s+/g, ' ').trim();
  const match = text.match(/undetermined\b|over\s+\$\s*50,000,000|\$\s*[\d,]+\s*[-–—]\s*\$?\s*[\d,]+|\$\s*[\d,]+\s*[-–—]\s*$/i);
  return match ? match[0].trim() : '';
}

function takeOwnerFromAsset(asset, owner) {
  if (owner) return { asset, owner };
  const m = String(asset || '').match(/\s+\b(SP|JT|DC)\b\s*$/i);
  if (!m) return { asset, owner };
  return { asset: asset.slice(0, m.index).trim(), owner: ownerCode(m[1]) };
}

function finishAsset(draft) {
  const split = takeOwnerFromAsset(
    draft.parts.join(' ').replace(/\s+/g, ' ').trim().replace(/\s*⇒\s*/g, ' ').trim(),
    draft.owner,
  );
  const asset = split.asset.replace(/\s*\*\s*Investment Vehicle details available\b.*/i, '').trim();
  draft.owner = split.owner;
  const valueText = draft.values.join(' ').replace(/\s+/g, ' ').trim();
  if (!asset || !valueText) return { kind: 'unreadable' };
  const value = parseAssetValue(valueText);
  if (value.kind === 'excluded') return { kind: 'excluded', reason: value.reason };
  if (value.kind === 'undetermined') {
    const code = codeFromAsset(asset);
    const assetClass = classifyHolding({ asset, assetCode: code }, 'house');
    const name = asset.replace(/\s*\[[A-Z0-9]{2}\]\s*/g, ' ').replace(/\s+/g, ' ').trim();
    return {
      kind: 'holding',
      holding: {
        asset: name || asset,
        ticker: tickerFromAsset(asset),
        assetClass: assetClass || 'other',
        assetCode: code,
        owner: draft.owner || 'self',
        valueRange: 'Undetermined',
        valueMin: null,
        valueMax: null,
        valueMid: null,
        valueBound: 'undetermined',
      },
    };
  }
  if (value.kind !== 'range' && value.kind !== 'at_least') return { kind: 'unreadable' };
  const code = codeFromAsset(asset);
  const assetClass = classifyHolding({ asset, assetCode: code }, 'house');
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
    noneDisclosed: false,
    inScheduleA: false,
    columns: null,
    open: null,
    holdings: [],
    excluded: 0,
    unreadable: 0,
    textChars: 0,
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

function closeScheduleA(state) {
  flush(state);
  state.inScheduleA = false;
}

export function consumeHouseAnnualPage(state, rawItems) {
  if (state.closed) return state;
  const items = cleanItems(rawItems);
  state.textChars += letterCount(items);
  const pageHasScheduleA = isSchedulePage(items);
  if (pageHasScheduleA) state.sawSchedule = true;
  if (!pageHasScheduleA && !state.inScheduleA && !state.sawSchedule) return state;

  for (const row of itemsToRows(items)) {
    const whole = rowText(row.items);
    const code = scheduleCode(whole);
    if (code) {
      if (code === 'A') {
        state.sawSchedule = true;
        state.inScheduleA = true;
      } else if (state.inScheduleA || state.sawSchedule) {
        closeScheduleA(state);
        if (code === 'B') state.closed = true;
      }
      continue;
    }
    const headerCols = columnsFromHeaderItems(row.items);
    if (headerCols) {
      state.columns = headerCols;
      state.sawSchedule = true;
      state.inScheduleA = true;
      continue;
    }
    if (state.closed) return state;
    if (!state.inScheduleA && !state.sawSchedule) continue;
    if (!state.inScheduleA && state.closed) continue;
    // After Schedule A has been seen, only read rows until the next schedule
    // header closes it. Continuation pages may omit the "S A:" title.
    if (!state.inScheduleA && !pageHasScheduleA) continue;

    const cols = state.columns || DEFAULT_COLUMNS;
    const asset = bandText(row.items, ...band(cols, 'asset'));
    const owner = ownerCode(bandText(row.items, ...band(cols, 'owner')));
    let value = bandText(row.items, ...band(cols, 'value'));
    if (value && parseAssetValue(value).kind === 'unreadable') {
      const statutory = firstStatutoryValue(row.items.filter((item) => item.x < (cols.income ?? 360)), cols.income);
      if (statutory) value = statutory;
    } else if (!value) {
      const statutory = firstStatutoryValue(row.items, cols.income);
      if (statutory) value = statutory;
    }

    if (isNoneDisclosed(asset) || isNoneDisclosed(whole)) {
      if (state.inScheduleA || state.sawSchedule) state.noneDisclosed = true;
      continue;
    }
    if (!asset && !value) continue;
    if (asset && (isMetaLine(asset) || isHeaderLine(asset, whole))) continue;
    if (!state.inScheduleA && !pageHasScheduleA) continue;
    state.inScheduleA = true;

    const codeOnly = /^(\[[A-Z0-9]{2}\]\s*)+$/.test(asset);
    const openValue = state.open ? state.open.values.join(' ') : '';
    const continueValue = state.open && (
      (codeOnly || (asset && !value && !owner && /\[[A-Z0-9]{2}\]/.test(asset)))
      || (
        /-\s*$/.test(openValue)
        && (bareUpper(value) || (!asset && valueStarts(value)))
      )
      || (
        asset && !value && !owner && state.open.values.length
        && !valueStarts(asset)
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
    const scanned = (state.textChars || 0) < 80;
    if (scanned) {
      return {
        status: 'pending_ocr',
        holdings: [],
        excludedCount: 0,
        unreadableCount: 0,
        ocrDone: false,
        note: 'No Schedule A text layer. The annual report looks scanned and will be read by the House OCR job. No holdings were guessed.',
      };
    }
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
  if (!kept && !dropped && state.noneDisclosed) {
    return {
      status: 'parsed',
      holdings: [],
      excludedCount: 0,
      unreadableCount: 0,
      note: 'Schedule A reported none disclosed.',
    };
  }
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
  const undetermined = state.holdings.filter((row) => row.valueBound === 'undetermined').length;
  if (state.excluded) {
    bits.push(`${state.excluded} item${state.excluded === 1 ? '' : 's'} with value None or not disclosed ${state.excluded === 1 ? 'was' : 'were'} left out`);
  }
  if (undetermined) {
    bits.push(`${undetermined} holding${undetermined === 1 ? '' : 's'} with an undetermined value ${undetermined === 1 ? 'is' : 'are'} listed and left out of the totals`);
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
