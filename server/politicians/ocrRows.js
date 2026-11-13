// Turn OCR word boxes into 278-T rows.
//
// A row is kept only when the date parses, the amount is one of the statutory
// buckets, and the type word is purchase, sale, or exchange. A single-character
// OCR slip on that type word is accepted only when it is unambiguous
// (purchaso → purchase, not a word that could be two different types).
// Amounts and dates are never rewritten into a nearby bucket or day.
// Anything else is counted as unreadable and left for manual review.

import { canonicalAmountRange, canonicalTicker, normalizeOwner, parseUsDate } from './normalize.js';

const TYPE_WORDS = ['purchase', 'sale', 'exchange'];
const MIN_CONFIDENCE = 60;

function letters(value) {
  return String(value || '').toLowerCase().replace(/[^a-z]/g, '');
}

function editDistance(a, b) {
  if (Math.abs(a.length - b.length) > 1) return 99;
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    const next = [i];
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      next[j] = Math.min(prev[j] + 1, next[j - 1] + 1, prev[j - 1] + cost);
    }
    for (let j = 0; j < next.length; j += 1) prev[j] = next[j];
  }
  return prev[b.length];
}

// Unambiguous type, or null. Distance 0 is exact. Distance 1 is a single
// insertion, deletion, or substitution and must match only one of the three words.
export function ocrTransactionType(token) {
  const text = letters(token);
  if (text.length < 3) return null;
  const hits = TYPE_WORDS.filter((word) => editDistance(text, word) <= 1);
  return hits.length === 1 ? hits[0] : null;
}

function txType(word) {
  const kind = ocrTransactionType(word);
  if (kind === 'purchase') return 'buy';
  if (kind === 'sale') return 'sell';
  if (kind === 'exchange') return 'exchange';
  return null;
}

function wordBox(word) {
  const box = word?.bbox || word;
  const x = Number(box?.x0 ?? box?.x ?? 0);
  const y = Number(box?.y0 ?? box?.y ?? 0);
  const x1 = Number(box?.x1 ?? (x + Number(box?.w || box?.width || 0)));
  const y1 = Number(box?.y1 ?? (y + Number(box?.h || box?.height || 0)));
  return {
    text: String(word?.text ?? ''),
    confidence: Number(word?.confidence ?? word?.conf ?? 0),
    x,
    y,
    x1,
    y1,
    cy: (y + y1) / 2,
  };
}

export function groupOcrLines(rawWords) {
  const words = (rawWords || []).map(wordBox).filter((w) => w.text.trim());
  words.sort((a, b) => a.cy - b.cy || a.x - b.x);
  const heights = words.map((w) => Math.max(1, w.y1 - w.y)).sort((a, b) => a - b);
  const median = heights.length ? heights[Math.floor(heights.length / 2)] : 12;
  const gap = Math.max(8, median * 0.55);
  const lines = [];
  for (const word of words) {
    const last = lines[lines.length - 1];
    if (!last || Math.abs(word.cy - last.cy) > gap) {
      lines.push({ cy: word.cy, words: [word] });
    } else {
      last.words.push(word);
      last.cy = (last.cy * (last.words.length - 1) + word.cy) / last.words.length;
    }
  }
  for (const line of lines) line.words.sort((a, b) => a.x - b.x);
  return lines;
}

function amountTokens(words) {
  return words.filter((w) => /\$[\d,]{3,}/.test(w.text));
}

function dateToken(words) {
  return words.find((w) => /\d{1,2}\/\d{1,2}\/\d{4}/.test(w.text)) || null;
}

function saneDate(iso, now = new Date()) {
  if (!iso) return false;
  const year = Number(iso.slice(0, 4));
  const maxYear = now.getUTCFullYear() + 1;
  return year >= 2012 && year <= maxYear;
}

function rowConfidence(parts) {
  const nums = parts.map((n) => Number(n)).filter((n) => Number.isFinite(n));
  if (!nums.length) return 0;
  return Math.round(Math.min(...nums));
}

/**
 * @returns {{ trades: object[], rejected: number, sawTable: boolean }}
 * trades include ocr: true and ocrConfidence. rejected counts lines that
 * looked like a transaction and failed validation.
 */
export function rowsFromOcrWords(rawWords, { now = new Date() } = {}) {
  const lines = groupOcrLines(rawWords);
  const trades = [];
  let rejected = 0;
  let sawTable = false;
  for (const line of lines) {
    const words = line.words;
    const dated = dateToken(words);
    const amounts = amountTokens(words);
    if (!dated && amounts.length < 2) continue;
    sawTable = true;
    const dateIndex = dated ? words.indexOf(dated) : words.length;
    const typeWord = [...words.slice(0, dateIndex)].reverse().find((w) => ocrTransactionType(w.text));
    const iso = dated ? parseUsDate((dated.text.match(/\d{1,2}\/\d{1,2}\/\d{4}/) || [])[0]) : null;
    const amount = amounts.length >= 2
      ? canonicalAmountRange(`${amounts[0].text} - ${amounts[amounts.length - 1].text}`)
      : null;
    const kind = typeWord ? txType(typeWord.text) : null;
    const confidence = rowConfidence([
      typeWord?.confidence,
      dated?.confidence,
      ...amounts.slice(0, 2).map((w) => w.confidence),
    ]);
    const typeX = typeWord ? typeWord.x : (dated ? dated.x : Infinity);
    const descWords = words.filter((w) => w.x < typeX - 2 && !/^\d{1,3}$/.test(w.text.trim()));
    let asset = descWords.map((w) => w.text).join(' ').replace(/\s+/g, ' ').trim();
    asset = asset.replace(/^[\d|_\-–—.\s]+/, '').trim();
    const ticker = canonicalTicker((asset.match(/\(([A-Z][A-Z0-9.]{0,8})\)/) || [])[1]);
    const ok = kind && iso && saneDate(iso, now) && amount && asset.length >= 3 && confidence >= MIN_CONFIDENCE;
    if (!ok) {
      rejected += 1;
      continue;
    }
    let owner = 'unknown';
    const ownerPrefix = asset.match(/^(spouse|joint|dependent child|child)\s*[:\-]\s*/i);
    if (ownerPrefix) {
      owner = normalizeOwner(ownerPrefix[1]);
      asset = asset.slice(ownerPrefix[0].length).trim();
    }
    trades.push({
      owner,
      ticker,
      asset,
      assetClass: assetClass(asset, ticker),
      txType: kind,
      partial: false,
      txDate: iso,
      amountRange: amount,
      ocr: true,
      ocrConfidence: confidence,
    });
  }
  return { trades, rejected, sawTable };
}

function assetClass(asset, ticker) {
  const s = String(asset || '');
  if (/\b(call|put|option)s?\b/i.test(s)) return 'option';
  if (/\b(bitcoin|ethereum|crypto)\b/i.test(s)) return 'crypto';
  if (/\b(bond|note|municipal|debenture)\b/i.test(s) || /\bdue\b/i.test(s)) return 'bond';
  if (ticker && /\b(etf|exchange traded fund)\b/i.test(s)) return 'etf';
  if (ticker && /\bfund\b/i.test(s)) return 'fund';
  if (ticker) return 'stock';
  return 'other';
}

export const OCR_MIN_CONFIDENCE = MIN_CONFIDENCE;
