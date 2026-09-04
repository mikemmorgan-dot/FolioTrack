// parse.js — turn issuer HTML / PDF text into {label, weight} breakdown rows.
// Prefer HTML allocation tables. PDF text is used when the issuer is PDF-only
// (Vanguard Canada factsheets). BlackRock embeds allocation arrays in JS.

import { load } from 'cheerio';
import { PDFParse } from 'pdf-parse';
import { classifyLabel, tableHint, shouldSkipLabel } from './labels.js';

const MONTHS = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
  july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
  jan: 1, feb: 2, mar: 3, apr: 4, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9,
  oct: 10, nov: 11, dec: 12,
};

function pad2(n) {
  return String(n).padStart(2, '0');
}

export function parseAsOfDate(text) {
  if (!text) return null;
  const s = String(text);

  const iso = s.match(/\b(20\d{2}-\d{2}-\d{2})\b/);
  if (iso) return iso[1];

  const mdY = s.match(
    /\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+(\d{1,2}),?\s+(20\d{2})\b/i
  );
  if (mdY) {
    const m = MONTHS[mdY[1].toLowerCase()];
    if (m) return `${mdY[3]}-${pad2(m)}-${pad2(Number(mdY[2]))}`;
  }

  const dMY = s.match(
    /\b(\d{1,2})\s+(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+(20\d{2})\b/i
  );
  if (dMY) {
    const m = MONTHS[dMY[2].toLowerCase()];
    if (m) return `${dMY[3]}-${pad2(m)}-${pad2(Number(dMY[1]))}`;
  }

  return null;
}

export function extractAsOf(text) {
  if (!text) return { asOf: null, estimated: false };
  const s = String(text);

  const factsheet = s.match(/Factsheet\s*\|?\s*([A-Za-z]+\s+\d{1,2},?\s+20\d{2})/i);
  if (factsheet) {
    const asOf = parseAsOfDate(factsheet[1]);
    if (asOf) return { asOf, estimated: false };
  }

  const holdings = s.match(
    /(?:holdings|portfolio|sector|geographic|exposure|allocation)[^\n.]{0,40}as of\s+([A-Za-z]+\s+\d{1,2},?\s+20\d{2})/i
  );
  if (holdings) {
    const asOf = parseAsOfDate(holdings[1]);
    if (asOf) return { asOf, estimated: false };
  }

  const generic = s.match(/\bas of\s+([A-Za-z]+\s+\d{1,2},?\s+20\d{2})/i);
  if (generic) {
    const asOf = parseAsOfDate(generic[1]);
    if (asOf) return { asOf, estimated: true };
  }

  const iso = parseAsOfDate(s);
  return iso ? { asOf: iso, estimated: true } : { asOf: null, estimated: false };
}

function parseWeight(raw) {
  if (raw == null) return null;
  const n = Number(String(raw).replace(/[%\s,]/g, ''));
  if (!Number.isFinite(n) || n <= 0) return null;
  // Factsheets are in percent (36.6). A 0–1 weight would be a bug here.
  return n > 0 && n <= 100 ? n : null;
}

function mergeRows(rows) {
  const map = new Map();
  for (const r of rows) {
    if (!r?.label || !Number.isFinite(r.weight) || r.weight <= 0) continue;
    map.set(r.label, (map.get(r.label) || 0) + r.weight);
  }
  return [...map.entries()]
    .map(([label, weight]) => ({ label, weight: Math.round(weight * 10) / 10 }))
    .sort((a, b) => b.weight - a.weight);
}

function pushClassified(bucket, label, weight, hint) {
  const w = parseWeight(weight);
  if (w == null || shouldSkipLabel(label)) return;
  const classified = classifyLabel(label, hint);
  if (!classified?.label) return;
  bucket[classified.kind].push({ label: classified.label, weight: w });
}

function parseLooseJsonArray(raw) {
  const cleaned = String(raw)
    .replace(/,\s*([}\]])/g, '$1')
    .replace(/'/g, '"');
  return JSON.parse(cleaned);
}

function hintFromName(name) {
  const t = String(name || '').toLowerCase();
  if (/asset|maturity|rating|currency|duration/.test(t)) return 'skip';
  if (/sector|gics|industry/.test(t)) return 'sector';
  if (/country|countries|geo|location|region|market/.test(t)) return 'country';
  return null;
}

export function extractBlackRockTables(html) {
  const sector = [];
  const country = [];
  const re = /var\s+(\w+DataTable)\s*=\s*(\[[\s\S]*?\]);/g;
  let m;
  while ((m = re.exec(html))) {
    const hint = hintFromName(m[1]);
    if (hint === 'skip') continue;
    let rows;
    try { rows = parseLooseJsonArray(m[2]); } catch { continue; }
    if (!Array.isArray(rows)) continue;
    for (const row of rows) {
      const label = row.name || row.label || row.type;
      const weight = row.value ?? row.weight ?? row.y;
      pushClassified({ sector, country }, label, weight, hint);
    }
  }
  return { sector, country };
}

function extractHtmlTables(html) {
  const $ = load(html);
  const sector = [];
  const country = [];

  $('table').each((_, table) => {
    const $t = $(table);
    const caption = `${$t.find('caption').text()} ${$t.find('th').text()} ${$t.prevAll('h1,h2,h3,h4,p').first().text()}`;
    const hint = tableHint(caption);
    $t.find('tr').each((__, tr) => {
      const cells = $(tr).find('th,td').toArray().map((c) => $(c).text().replace(/\s+/g, ' ').trim());
      if (cells.length < 2) return;
      if (/^(sector|type|name|label|region|country|geography)$/i.test(cells[0]) && /weight|%/i.test(cells[1])) return;
      const label = cells[0];
      const pctCell = cells.find((c, i) => i > 0 && /%/.test(c)) || cells[1];
      pushClassified({ sector, country }, label, pctCell, hint);
    });
  });

  return { sector, country };
}

const KNOWN_FOR_TEXT = [
  ['sector', 'Information Technology'],
  ['sector', 'Financials'],
  ['sector', 'Communication Services'],
  ['sector', 'Consumer Discretionary'],
  ['sector', 'Consumer Staples'],
  ['sector', 'Health Care'],
  ['sector', 'Healthcare'],
  ['sector', 'Industrials'],
  ['sector', 'Energy'],
  ['sector', 'Utilities'],
  ['sector', 'Real Estate'],
  ['sector', 'Materials'],
  ['sector', 'Fixed Income'],
  ['country', 'United States'],
  ['country', 'Canada'],
  ['country', 'United Kingdom'],
  ['country', 'Japan'],
  ['country', 'China'],
  ['country', 'Hong Kong'],
  ['country', 'Taiwan'],
  ['country', 'South Korea'],
  ['country', 'France'],
  ['country', 'Germany'],
  ['country', 'Switzerland'],
  ['country', 'Netherlands'],
  ['country', 'Ireland'],
  ['country', 'Australia'],
  ['country', 'India'],
  ['country', 'Brazil'],
  ['country', 'Mexico'],
  ['country', 'Emerging Markets'],
  ['country', 'International'],
  ['country', 'Global'],
];

export function extractLabeledPercents(text) {
  const sector = [];
  const country = [];
  if (!text) return { sector, country };
  const lines = String(text).split(/\n+/);
  for (const line of lines) {
    const trimmed = line.replace(/\s+/g, ' ').trim();
    for (const [hint, label] of KNOWN_FOR_TEXT) {
      const re = new RegExp(`^${label}\\s+(\\d+(?:\\.\\d+)?)\\s*%`, 'i');
      const m = trimmed.match(re);
      if (m) {
        pushClassified({ sector, country }, label, m[1], hint);
        break;
      }
    }
  }
  return { sector, country };
}

function combine(parts) {
  const sector = [];
  const country = [];
  for (const p of parts) {
    sector.push(...(p.sector || []));
    country.push(...(p.country || []));
  }
  return {
    sectorBreakdown: mergeRows(sector),
    countryBreakdown: mergeRows(country),
  };
}

export function parseFactsheetText(text) {
  const { asOf, estimated } = extractAsOf(text);
  const rows = combine([extractLabeledPercents(text)]);
  return { ...rows, asOf, asOfEstimated: estimated && !!asOf };
}

export function parseFactsheetHtml(html) {
  const { asOf, estimated } = extractAsOf(html);
  const fromJs = extractBlackRockTables(html);
  const fromTables = extractHtmlTables(html);
  const structuredCount = (fromJs.sector?.length || 0) + (fromJs.country?.length || 0)
    + (fromTables.sector?.length || 0) + (fromTables.country?.length || 0);
  const fromText = structuredCount
    ? { sector: [], country: [] }
    : extractLabeledPercents(load(html).text());
  const rows = combine([fromJs, fromTables, fromText]);
  return { ...rows, asOf, asOfEstimated: estimated && !!asOf };
}

export async function extractPdfText(buffer) {
  const parser = new PDFParse({ data: buffer });
  try {
    const result = await parser.getText();
    return result?.text || '';
  } finally {
    await parser.destroy().catch(() => {});
  }
}

export async function parseFactsheetPdf(buffer) {
  const text = await extractPdfText(buffer);
  return parseFactsheetText(text);
}

export function findFactsheetPdfUrl(html, baseUrl) {
  const $ = load(html);
  let href = null;
  $('a').each((_, a) => {
    if (href) return;
    const $a = $(a);
    const text = `${$a.text()} ${$a.attr('href') || ''}`.toLowerCase();
    const h = $a.attr('href') || '';
    if (/\.pdf(\?|$)/i.test(h) && /fact\s*sheet|fs_en/i.test(text)) href = h;
  });
  if (!href) return null;
  try { return new URL(href, baseUrl).toString(); } catch { return href; }
}

export function emptyParse() {
  return { sectorBreakdown: [], countryBreakdown: [], asOf: null, asOfEstimated: false };
}

export function hasBreakdownRows(parsed) {
  return (parsed?.sectorBreakdown?.length || 0) + (parsed?.countryBreakdown?.length || 0) > 0;
}
