// House annual OCR. Values are accepted only when they match a statutory
// House range (or "Undetermined" / "Over $50,000,000"). Nearby numbers are
// never snapped to a bucket. Low-confidence rows are dropped.

import { AMOUNT_RANGES } from './normalize.js';
import { parseAssetValue } from './assetValue.js';
import { classifyHolding } from './holdingClass.js';
import { canonicalTicker } from './normalize.js';
import { groupOcrLines, OCR_MIN_CONFIDENCE } from './ocrRows.js';
import { houseAnnualResult, createHouseAnnualParse } from './parseHouseAnnual.js';

const MIN_CONFIDENCE = OCR_MIN_CONFIDENCE;
const FLOOR_TYPOS = new Map(AMOUNT_RANGES.map(([min, max, label]) => {
  const typo = min % 1000 === 1 ? min - 1 : null;
  return [typo ? `${typo}:${max}` : '', label];
}).filter(([key]) => key));

export function normalizeOcrDigits(token) {
  return String(token || '')
    .replace(/[Oo]/g, '0')
    .replace(/[Il|]/g, '1')
    .replace(/[^\d]/g, '');
}

function dollars(token) {
  const n = Number(normalizeOcrDigits(token));
  return Number.isFinite(n) && n > 0 ? n : null;
}

function rangeFromPair(lo, hi) {
  if (lo == null || hi == null || lo >= hi) return null;
  const exact = AMOUNT_RANGES.find(([a, b]) => a === lo && b === hi);
  if (exact) return { kind: 'range', min: exact[0], max: exact[1], mid: Math.round((exact[0] + exact[1]) / 2), label: exact[2], typo: false };
  // A lower bound whose trailing 001 is often read as 000, only when the
  // ceiling is the exact statutory max. The ceiling is never invented.
  const typoLabel = FLOOR_TYPOS.get(`${lo}:${hi}`);
  if (typoLabel) {
    const hit = AMOUNT_RANGES.find((row) => row[2] === typoLabel);
    return { kind: 'range', min: hit[0], max: hit[1], mid: Math.round((hit[0] + hit[1]) / 2), label: hit[2], typo: true };
  }
  if (lo === 1 && hi === 1000) {
    return { kind: 'range', min: 1, max: 1000, mid: 501, label: '$1 - $1,000', typo: false };
  }
  return null;
}

export function ocrHouseValueRange(text) {
  const raw = String(text || '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
  if (!raw) return null;
  if (/undetermined/i.test(raw)) {
    return { kind: 'undetermined', label: 'Undetermined', min: null, max: null, mid: null, typo: false };
  }
  const over = raw.match(/over\s+\$?\s*([\dOIl|,.\s]{5,})/i);
  if (over && dollars(over[1]) === 50_000_000) {
    return { kind: 'at_least', label: 'Over $50,000,000', min: 50_000_000, max: null, mid: 50_000_000, typo: false };
  }
  const exact = parseAssetValue(raw);
  if (exact.kind === 'range' || exact.kind === 'at_least' || exact.kind === 'undetermined') {
    return { ...exact, typo: false };
  }
  const hasDash = /[\d,]\s*[-–—]\s*\$?\s*[\d]/.test(raw);
  const amounts = [...raw.matchAll(/\$\s*[\dOIl|,. ]{3,}/gi)].map((m) => dollars(m[0])).filter((n) => n != null);
  if (amounts.length >= 2) {
    const hit = rangeFromPair(amounts[0], amounts[amounts.length - 1]);
    if (hit && (!hit.typo || hasDash)) return hit;
  }
  const nums = [...raw.matchAll(/(\d[\dOIl|]*[,\s]\d[\dOIl|,\s]{1,}|\d{4,})/g)]
    .map((m) => dollars(m[0]))
    .filter((n) => n != null && n >= 1000);
  if (nums.length >= 2) {
    const hit = rangeFromPair(nums[0], nums[nums.length - 1]);
    if (hit && (!hit.typo || hasDash)) return hit;
  }
  return null;
}

function lineText(line) {
  return (line.words || []).map((w) => w.text).join(' ').replace(/\s+/g, ' ').trim();
}

function lineConfidence(line, extra = []) {
  const nums = [...(line.words || []), ...extra].map((w) => Number(w.confidence)).filter((n) => Number.isFinite(n));
  if (!nums.length) return 0;
  return Math.round(Math.min(...nums));
}

function isSectionA(text) {
  const t = String(text || '').trim();
  if (/^s\s*a\s*:/i.test(t)) return true;
  if (/^value of asset\b/i.test(t)) return true;
  // A heading, not "on Schedule A of my 2024 statement".
  return /^schedule\s*a\b(\s*$|\s*[:.—–—-]|\s+assets?\b|\s+value\b)/i.test(t);
}

function isSectionB(text) {
  const t = String(text || '').trim();
  if (/^s\s*b\s*:/i.test(t)) return true;
  return /^schedule\s*b\b(\s*$|\s*[:.—–—-]|\s+transactions?\b)/i.test(t);
}

function isTransactionLine(text) {
  const t = String(text || '');
  if (/\b(type of tx|date of tx|amount of tx)\b/i.test(t)) return true;
  return /\b(sales?|purchases?|exchanges?)\b/i.test(t);
}

function isBoilerplate(text) {
  if (!text) return true;
  if (/^(asset|owner|value|income type|name|page|block)\b/i.test(text)) return true;
  if (/clerk of the house|i certify|financial disclosure|hand delivered/i.test(text)) return true;
  if (/^none disclosed\.?$/i.test(text)) return true;
  return false;
}

function ownerFromText(text) {
  if (/\b(joint|jtwros|\bJT\b)/i.test(text)) return 'joint';
  if (/\b(spouse|\bSP\b)/i.test(text)) return 'spouse';
  if (/\b(dependent|\bDC\b)/i.test(text)) return 'dependent';
  return 'self';
}

function assetFromLine(text, range) {
  let asset = String(text || '');
  if (range?.label) {
    const idx = asset.toLowerCase().indexOf(range.label.toLowerCase().slice(0, 6));
    if (idx > 0) asset = asset.slice(0, idx);
  }
  asset = asset
    .replace(/\$\s*[\dOIl|,. ]{3,}/g, ' ')
    .replace(/\b(tax deferred|qualified eif|dividends?|interest|rent|none|over)\b/ig, ' ')
    .replace(/\s*[-–—|:]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  asset = asset.replace(/^\d+\s+/, '').trim();
  return asset;
}

function tickerFromAsset(asset) {
  const found = [...String(asset || '').matchAll(/\(([A-Z][A-Z0-9.]{0,8})\)/g)]
    .map((m) => canonicalTicker(m[1]))
    .filter(Boolean);
  return found.length ? found[found.length - 1] : null;
}

function holdingFromParts({ asset, range, owner, confidence, typo }) {
  const name = asset.replace(/\s*\[[A-Z0-9]{2}\]\s*/g, ' ').replace(/\s+/g, ' ').trim();
  if (!name || name.length < 3) return null;
  const code = ([...name.matchAll(/\[([A-Z0-9]{2})\]/g)].pop() || [])[1] || null;
  const base = {
    asset: name,
    ticker: tickerFromAsset(name),
    assetClass: classifyHolding({ asset: name, assetCode: code }, 'house') || 'other',
    assetCode: code,
    owner: owner || 'self',
    ocr: true,
    ocrConfidence: confidence,
    ocrFlag: typo || confidence < MIN_CONFIDENCE ? 'low_confidence' : null,
  };
  if (range.kind === 'undetermined') {
    return {
      ...base,
      valueRange: 'Undetermined',
      valueMin: null,
      valueMax: null,
      valueMid: null,
      valueBound: 'undetermined',
    };
  }
  return {
    ...base,
    valueRange: range.label,
    valueMin: range.min,
    valueMax: range.max,
    valueMid: range.mid,
    valueBound: range.kind === 'at_least' ? 'at_least' : 'range',
  };
}

export function createHouseAnnualOcrParse() {
  return {
    ...createHouseAnnualParse(),
    inScheduleA: false,
    sawSchedule: false,
    letterMode: false,
    droppedLowConfidence: 0,
  };
}

export function consumeHouseAnnualOcrPage(state, words) {
  const lines = groupOcrLines(words);
  for (const line of lines) {
    const text = lineText(line);
    if (isSectionB(text)) {
      state.inScheduleA = false;
      state.closed = true;
      continue;
    }
    if (isSectionA(text)) {
      state.sawSchedule = true;
      state.inScheduleA = true;
      if (/dear mr|amendment|previously filed|the following information serves to amend/i.test(text)) {
        state.letterMode = true;
      }
      continue;
    }
    if (/dear mr|amendments? to previously filed|serves to amend/i.test(text)) {
      state.letterMode = true;
    }
    if (state.closed) continue;
    if (isBoilerplate(text)) {
      if (isNone(text) && state.inScheduleA) state.noneDisclosed = true;
      continue;
    }
    if (isTransactionLine(text)) continue;
    const range = ocrHouseValueRange(text);
    if (!range) continue;
    state.sawSchedule = true;
    state.inScheduleA = true;
    const confidence = lineConfidence(line);
    const asset = assetFromLine(text, range);
    const typo = range.typo === true;
    // A typo-tolerant floor (001→000) still has to clear the confidence floor.
    // An exact statutory label may be kept at the usual threshold only.
    if (!asset || confidence < MIN_CONFIDENCE) {
      state.droppedLowConfidence += 1;
      state.unreadable += 1;
      continue;
    }
    const holding = holdingFromParts({
      asset,
      range,
      owner: ownerFromText(text),
      confidence,
      typo,
    });
    if (!holding) {
      state.unreadable += 1;
      continue;
    }
    state.holdings.push(holding);
  }
  return state;
}

function isNone(text) {
  return /^none disclosed\.?$/i.test(String(text || '').trim());
}

export function houseAnnualOcrResult(state) {
  const parsed = houseAnnualResult(state);
  const bits = [];
  if (parsed.note) bits.push(parsed.note.replace(/\.$/, ''));
  if (state.droppedLowConfidence) {
    bits.push(`${state.droppedLowConfidence} low-confidence OCR row${state.droppedLowConfidence === 1 ? '' : 's'} ${state.droppedLowConfidence === 1 ? 'was' : 'were'} dropped`);
  }
  if (parsed.holdings.some((row) => row.ocr === true)) {
    bits.push('Holdings were read by OCR and values were not guessed');
  }
  return {
    ...parsed,
    note: bits.length ? `${bits.join('. ')}.` : parsed.note,
    droppedLowConfidence: state.droppedLowConfidence || 0,
  };
}

export function parseHouseAnnualOcrWords(pages) {
  const state = createHouseAnnualOcrParse();
  for (const words of pages || []) consumeHouseAnnualOcrPage(state, words);
  return houseAnnualOcrResult(state);
}
