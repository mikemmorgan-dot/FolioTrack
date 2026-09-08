// parseManulifeEtf.js — Manulife Smart ETF factsheet PDFs
// (https://funds.manulife.ca/en-us/etfs/{TICKER}/pdf).
//
// pdf-parse emits pie-slice percents *before* the legend heading + labels:
//   18.89
//   …
//   Geographic Allocation (%)
//   Japan
//   …
// Pair those, drop leftover slice duplicates so weights sum ~100, then
// classify onto FolioTrack sector/region lists. Compound + calendar tables
// become publishedReturns (manufacturer figures — not a NAV series).

import {
  extractAsOf,
  extractMer,
  parseAsOfDate,
  sliceBetween,
} from './parse.js';
import { classifyLabel, shouldSkipLabel } from './labels.js';
import { pctToDecimal, normalizePublishedReturns } from './publishedReturns.js';

const PERIOD_HEADERS = [
  [/^(?:1\s*mth|1\s*mo(?:nth)?)$/i, 'm1'],
  [/^(?:3\s*mth|3\s*mo(?:nth)?)$/i, 'm3'],
  [/^(?:6\s*mth|6\s*mo(?:nth)?)$/i, 'm6'],
  [/^ytd$/i, 'ytd'],
  [/^(?:1\s*yr|1\s*year)$/i, 'y1'],
  [/^(?:2\s*yrs?|2\s*years?)$/i, 'y2ann'],
  [/^(?:3\s*yrs?|3\s*years?)$/i, 'y3ann'],
  [/^(?:5\s*yrs?|5\s*years?)$/i, 'y5ann'],
  [/^(?:10\s*yrs?|10\s*years?)$/i, 'y10ann'],
  [/^(?:15\s*yrs?|15\s*years?)$/i, 'y15ann'],
  [/^(?:20\s*yrs?|20\s*years?)$/i, 'y20ann'],
  [/^(?:since\s*)?inception$/i, 'inceptionAnn'],
];

const HEADER_TOKEN_RE = /1\s*Mth|3\s*Mth|6\s*Mth|YTD|1\s*Yr|2\s*Yrs?|3\s*Yrs?|5\s*Yrs?|10\s*Yrs?|15\s*Yrs?|20\s*Yrs?|Inception|20\d{2}/gi;

function linesOf(text) {
  return String(text || '')
    .split(/\n+/)
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

function isDash(s) {
  return /^(?:—|--|-|–|n\/?a)$/i.test(String(s || '').trim());
}

function parsePercentToken(s) {
  const t = String(s || '').trim();
  if (!t || isDash(t)) return null;
  const m = t.match(/^(-?\d+(?:\.\d+)?)\s*%?$/);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

function lineIsPercent(line) {
  return parsePercentToken(line) != null || isDash(line);
}

function periodKeyFromLabel(label) {
  const t = String(label || '').replace(/\s+/g, ' ').trim();
  return PERIOD_HEADERS.find(([re]) => re.test(t))?.[1] || null;
}

function mergeClassified(rows, hint) {
  const map = new Map();
  for (const r of rows) {
    if (!r?.label || !Number.isFinite(r.weight) || r.weight <= 0) continue;
    if (shouldSkipLabel(r.label)) continue;
    const classified = classifyLabel(r.label, hint);
    if (!classified?.label) continue;
    if (!map.has(classified.label)) map.set(classified.label, r.weight);
  }
  return [...map.entries()]
    .map(([label, weight]) => ({ label, weight: Math.round(weight * 10) / 10 }))
    .sort((a, b) => b.weight - a.weight);
}

// Drop leftover pie-slice duplicates so the remaining n weights sit nearest 100.
function pickPercents(percents, n) {
  if (n <= 0) return [];
  if (percents.length === n) return percents;
  if (percents.length < n) return percents;
  const extras = percents.length - n;
  if (extras === 1) {
    let best = percents.slice(0, n);
    let bestScore = Math.abs(best.reduce((a, b) => a + b, 0) - 100);
    for (let drop = 0; drop < percents.length; drop++) {
      const pick = percents.filter((_, i) => i !== drop);
      const score = Math.abs(pick.reduce((a, b) => a + b, 0) - 100);
      if (score < bestScore) {
        bestScore = score;
        best = pick;
      }
    }
    return best;
  }
  const first = percents.slice(0, n);
  const last = percents.slice(-n);
  const sf = Math.abs(first.reduce((a, b) => a + b, 0) - 100);
  const sl = Math.abs(last.reduce((a, b) => a + b, 0) - 100);
  return sl < sf ? last : first;
}

function zipLegend(labels, percents) {
  const chosen = pickPercents(percents, labels.length);
  const rows = [];
  for (let i = 0; i < Math.min(labels.length, chosen.length); i++) {
    const weight = chosen[i];
    if (!Number.isFinite(weight) || weight <= 0) continue;
    rows.push({ label: labels[i], weight });
  }
  return rows;
}

// Percents sit on their own lines immediately before the heading; labels follow.
function parsePieLegend(text, headingRe) {
  const s = String(text || '');
  const m = s.match(headingRe);
  if (!m) return [];
  const beforeLines = linesOf(s.slice(0, m.index));
  const afterLines = linesOf(s.slice(m.index + m[0].length));

  const percents = [];
  for (let i = beforeLines.length - 1; i >= 0; i--) {
    const n = parsePercentToken(beforeLines[i]);
    if (n == null) {
      if (isDash(beforeLines[i])) continue;
      break;
    }
    percents.unshift(n);
  }

  const labels = [];
  for (const line of afterLines) {
    if (lineIsPercent(line)) break;
    if (/allocation|holdings|source for|portfolio advisor|©/i.test(line)) break;
    labels.push(line);
  }

  if (labels.length && percents.length) return zipLegend(labels, percents);
  return [];
}

function tokenizeHeaders(line) {
  return [...String(line).matchAll(HEADER_TOKEN_RE)].map((m) => m[0]);
}

function parseValueTokens(line) {
  const out = [];
  for (const tok of String(line).trim().split(/\s+/)) {
    if (isDash(tok)) {
      out.push(null);
      continue;
    }
    const n = parsePercentToken(tok);
    if (n == null) {
      if (out.length) break;
      continue;
    }
    out.push(n);
  }
  return out;
}

function tableAfter(text, headingRe) {
  const block = sliceBetween(text, headingRe, /risk measures|growth of|management\b|portfolio allocation|annual distributions|top 10 holdings/i)
    || String(text);
  const m = block.match(headingRe);
  const after = m ? block.slice(m.index + m[0].length) : block;
  const lines = linesOf(after);
  if (lines.length < 2) return null;
  const headers = tokenizeHeaders(lines[0]);
  const values = parseValueTokens(lines[1]);
  if (!headers.length || !values.length) return null;
  return { headers, values };
}

function calendarFromSheet(text) {
  const table = tableAfter(text, /calendar returns\s*\(%\)/i);
  if (!table) return [];
  const years = [];
  for (let i = 0; i < table.headers.length; i++) {
    const year = Number(table.headers[i]);
    const raw = table.values[i];
    if (!Number.isInteger(year) || year < 1990 || year > 2100 || raw == null) continue;
    const value = pctToDecimal(raw);
    if (value == null) continue;
    years.push({ year, value, ytd: false });
  }
  return years;
}

function periodsFromSheet(text) {
  const table = tableAfter(text, /compound returns\s*\(%\)/i);
  if (!table) return {};
  const out = {};
  for (let i = 0; i < table.headers.length; i++) {
    const key = periodKeyFromLabel(table.headers[i]);
    if (!key) continue;
    const raw = table.values[i];
    if (raw == null) continue;
    const value = pctToDecimal(raw);
    if (value != null) out[key] = value;
  }
  return out;
}

function performanceAsOf(text) {
  const m = String(text).match(/performance\s+as at\s+([A-Za-z]+\s+\d{1,2},?\s+20\d{2})/i);
  return m ? parseAsOfDate(m[1]) : null;
}

function holdingsAsOf(text) {
  const m = String(text).match(/holdings\s+as at\s+([A-Za-z]+\s+\d{1,2},?\s+20\d{2})/i);
  return m ? parseAsOfDate(m[1]) : null;
}

function extractNavPoint(text) {
  const m = String(text).match(
    /NAV per unit\s*\$?\s*([\d.]+)\s+as at\s+([A-Za-z]+\s+\d{1,2},?\s+20\d{2})/i
  );
  if (!m) return null;
  const nav = Number(m[1]);
  const date = parseAsOfDate(m[2]);
  if (!Number.isFinite(nav) || nav <= 0 || !date) return null;
  return { date, nav, source: 'Manulife factsheet' };
}

export function isManulifeEtfText(text) {
  const s = String(text || '');
  return /manulife/i.test(s) && /geographic allocation/i.test(s) && /compound returns/i.test(s);
}

export function parseManulifeEtfText(text) {
  const geoRows = parsePieLegend(text, /geographic allocation\s*\(%\)/i);
  const sectorRows = parsePieLegend(text, /sector allocation(?:\s*\(equities\))?\s*\(%\)/i);
  const countryBreakdown = mergeClassified(geoRows, 'country');
  const sectorBreakdown = mergeClassified(sectorRows, 'sector');

  const asOf = holdingsAsOf(text) || extractAsOf(text).asOf;
  const mer = extractMer(text);
  const periods = periodsFromSheet(text);
  const calendarYears = calendarFromSheet(text);
  const published = normalizePublishedReturns({
    ...periods,
    calendarYears,
    asOf: performanceAsOf(text) || asOf,
    source: 'factsheet · Manulife',
  });

  return {
    sectorBreakdown,
    countryBreakdown,
    asOf,
    asOfEstimated: false,
    mer,
    published,
    navPoint: extractNavPoint(text),
  };
}
