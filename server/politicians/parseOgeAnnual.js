// OGE Form 278e annual public financial disclosure for the President and
// Vice President. Parts 2, 5, and 6 are asset schedules. Part 2 is the filer,
// Part 5 is the spouse, and Part 6 does not print an owner, so the owner
// stays unstated. Income columns are not holdings. A row is kept only when
// the value column is a statutory range or "Over $50,000,000".

import { canonicalTicker } from './normalize.js';
import { parseAssetValue } from './assetValue.js';
import { classFromDescribedHolding } from './holdingClass.js';
import { ogeOffice } from './parseOge.js';
import { bandText, forEachPdfPage, itemsToRows, rowText } from './pdfItems.js';

export function parseOgeAnnualApiRow(row) {
  if (!row || typeof row !== 'object') return null;
  const typeHtml = String(row.type || '');
  const label = typeHtml.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  if (!/annual/i.test(label) || /transaction/i.test(label)) return null;
  const office = ogeOffice(row.title);
  if (!office) return null;
  const href = /href=['"]([^'"]+)['"]/i.exec(typeHtml);
  const url = href ? href[1].replace(/&amp;/g, '&') : null;
  const request = !url || /request this document/i.test(label) || /201(?:%20|\s)Request/i.test(url);
  const name = String(row.name || '').trim();
  const comma = name.indexOf(',');
  const last = comma >= 0 ? name.slice(0, comma).trim() : name;
  const first = comma >= 0 ? name.slice(comma + 1).trim() : '';
  const filedDate = String(row.docDate || '').slice(0, 10);
  const yearMatch = label.match(/annual\s*\((20\d{2})\)/i);
  let filingKey = null;
  if (!request && url) {
    const unid = /\/([A-F0-9]{16,})\/\$FILE\//i.exec(url.replace(/%2B/gi, '+'));
    filingKey = unid ? unid[1].toUpperCase() : null;
  }
  if (!filingKey) {
    const stamp = /^\d{4}-\d{2}-\d{2}$/.test(filedDate) ? filedDate : 'undated';
    filingKey = `annual:${name.toLowerCase()}:${stamp}`;
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
    reportYear: yearMatch ? Number(yearMatch[1]) : null,
    filingKind: /amendment/i.test(label) ? 'amendment' : 'original',
    request,
    sourceUrl: request ? (url || 'https://www.oge.gov/web/oge.nsf/officials%20individual%20disclosures%20search%20collection?openform') : url,
  };
}

function partOwner(title) {
  const text = String(title || '');
  if (/part\s*2\b/i.test(text)) return 'self';
  if (/part\s*5\b/i.test(text)) return 'spouse';
  if (/part\s*6\b/i.test(text)) return 'unknown';
  return null;
}

function headerBands(row) {
  const find = (re) => row.items.find((item) => re.test(item.str.replace(/\s+/g, ' ')));
  const description = find(/^description$/i);
  const eif = find(/^eif$/i);
  const value = find(/^value$/i);
  const incomeType = find(/income type/i);
  if (!description || !value) return null;
  const descEnd = eif ? eif.x : value.x;
  const valueEnd = incomeType ? incomeType.x : value.x + 140;
  return {
    desc: [description.x - 4, descEnd - 2],
    value: [value.x - 4, valueEnd - 2],
  };
}

export function reportYearFromCover(items) {
  const rows = itemsToRows(items || []);
  for (const row of rows) {
    const text = rowText(row.items);
    const match = text.match(/Year\s*\(Annual\b[^0-9]{0,40}(20\d{2})/i);
    if (match) return Number(match[1]);
  }
  return null;
}

function tickerFromAsset(asset) {
  const found = [...String(asset || '').matchAll(/\(([A-Z][A-Z0-9.]{0,8})\)/g)]
    .map((m) => canonicalTicker(m[1]))
    .filter(Boolean);
  return found.length ? found[found.length - 1] : null;
}

export function createOgeAnnualParse() {
  return {
    sawPart: false,
    reportYear: null,
    holdings: [],
    excluded: 0,
    unreadable: 0,
    open: null,
    letters: 0,
  };
}

function flush(state) {
  if (!state.open) return;
  const asset = state.open.parts.join(' ').replace(/\s+/g, ' ').replace(/\s+\*+$/g, '').trim();
  const valueText = state.open.values.join(' ').replace(/\s+/g, ' ').trim();
  state.open = null;
  if (!asset || !/[A-Za-z]{3,}/.test(asset)) {
    if (valueText) state.unreadable += 1;
    return;
  }
  const value = parseAssetValue(valueText);
  if (value.kind === 'excluded') {
    state.excluded += 1;
    return;
  }
  if (value.kind !== 'range' && value.kind !== 'at_least') {
    state.unreadable += 1;
    return;
  }
  state.holdings.push({
    asset,
    ticker: tickerFromAsset(asset),
    assetClass: classFromDescribedHolding(asset),
    owner: state.openOwner || 'unknown',
    valueRange: value.label,
    valueMin: value.min,
    valueMax: value.max,
    valueMid: value.mid,
    valueBound: value.kind === 'at_least' ? 'at_least' : 'range',
  });
}

export function consumeOgeAnnualPage(state, items) {
  for (const item of items || []) state.letters += (String(item.str).match(/[A-Za-z]/g) || []).length;
  if (!state.reportYear) state.reportYear = reportYearFromCover(items);
  const rows = itemsToRows(items);
  let bands = null;
  let owner = null;
  for (const row of rows) {
    const text = rowText(row.items);
    const part = text.match(/Part\s*[256]\s*:\s*[^.]*/i);
    if (part) {
      const next = partOwner(part[0]);
      if (next) {
        flush(state);
        owner = next;
        state.sawPart = true;
        state.openOwner = owner;
      }
    }
    const detected = headerBands(row);
    if (detected) {
      bands = detected;
      continue;
    }
    if (!bands || !owner) continue;
    const description = bandText(row.items, bands.desc[0], bands.desc[1]);
    const value = bandText(row.items, bands.value[0], bands.value[1]);
    if (!description && !value) continue;
    if (/^(instructions for part|filer'?s name|oge form|note:|page number|#|description)$/i.test(description)) {
      continue;
    }
    const valueStart = /^(none|over\s+\$|\$[\d,]+)/i.test(value);
    if (description && valueStart) {
      flush(state);
      state.openOwner = owner;
      state.open = { parts: [description], values: [value] };
      continue;
    }
    if (state.open && description && !value) {
      state.open.parts.push(description);
      continue;
    }
    if (state.open && value && /-\s*$/.test(state.open.values.join(' '))) {
      state.open.values.push(value);
      if (description) state.open.parts.push(description);
    }
  }
  return state;
}

export function ogeAnnualResult(state) {
  flush(state);
  if (!state.sawPart && state.letters < 80) {
    return {
      status: 'pending_ocr',
      holdings: [],
      excludedCount: 0,
      unreadableCount: 0,
      reportYear: state.reportYear,
      note: 'No readable text layer. The 278e looks scanned, so no holdings were guessed. OCR is left to the scheduled job.',
    };
  }
  if (!state.sawPart) {
    return {
      status: 'needs_manual_review',
      holdings: [],
      excludedCount: state.excluded,
      unreadableCount: state.unreadable,
      reportYear: state.reportYear,
      note: 'The 278e text did not include a readable Part 2, Part 5, or Part 6 asset table. No holdings were guessed.',
    };
  }
  if (!state.holdings.length && !state.excluded) {
    return {
      status: 'needs_manual_review',
      holdings: [],
      excludedCount: 0,
      unreadableCount: state.unreadable,
      reportYear: state.reportYear,
      note: 'Asset parts were present, but no statutory value range could be read. Those rows were not guessed.',
    };
  }
  const bits = [];
  if (state.excluded) {
    bits.push(`${state.excluded} item${state.excluded === 1 ? '' : 's'} with value None or not disclosed ${state.excluded === 1 ? 'was' : 'were'} left out`);
  }
  if (state.unreadable) {
    bits.push(`${state.unreadable} row${state.unreadable === 1 ? '' : 's'} had a value that was not a statutory range and ${state.unreadable === 1 ? 'was' : 'were'} not guessed`);
  }
  return {
    status: state.unreadable ? 'partial' : 'parsed',
    holdings: state.holdings,
    excludedCount: state.excluded,
    unreadableCount: state.unreadable,
    reportYear: state.reportYear,
    note: bits.length ? `${bits.join('. ')}.` : null,
  };
}

export async function parseOgeAnnualPdf(buffer, forEachPage = forEachPdfPage) {
  const state = createOgeAnnualParse();
  await forEachPage(buffer, ({ items }) => {
    consumeOgeAnnualPage(state, items);
  });
  return ogeAnnualResult(state);
}
