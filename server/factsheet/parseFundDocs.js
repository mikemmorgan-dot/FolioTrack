// parseFundDocs.js — Canadian Fund Facts (CSA) + Fidelity FundPulse text.
// Allocation look-through comes from Fund Facts when the mix tables are
// present. Multi-year annualized / calendar returns prefer FundPulse when
// that document has a performance table (series-specific). Never invent
// daily NAVs from these figures.

import {
  extractAsOf,
  extractHintedPercents,
  extractLabeledPercents,
  extractLeadingPercents,
  extractMer,
  parseAsOfDate,
  parseFactsheetText,
  sliceBetween,
} from './parse.js';
import { pctToDecimal, normalizePublishedReturns } from './publishedReturns.js';

const PERIOD_LABELS = [
  [/^1\s*mo(?:nth)?$/i, 'm1'],
  [/^3\s*mo(?:nth)?$/i, 'm3'],
  [/^6\s*mo(?:nth)?$/i, 'm6'],
  [/^1\s*yr$|^1\s*year$/i, 'y1'],
  [/^2\s*yr$|^2\s*year$/i, 'y2ann'],
  [/^3\s*yr$|^3\s*year$/i, 'y3ann'],
  [/^5\s*yr$|^5\s*year$/i, 'y5ann'],
  [/^10\s*yr$|^10\s*year$/i, 'y10ann'],
  [/^15\s*yr$|^15\s*year$/i, 'y15ann'],
  [/^20\s*yr$|^20\s*year$/i, 'y20ann'],
  [/^since\s*inception$|^inception$/i, 'inceptionAnn'],
];

function combineHinted(parts) {
  const sector = [];
  const country = [];
  for (const p of parts) {
    sector.push(...(p.sector || []));
    country.push(...(p.country || []));
  }
  // First label wins — same rule as parse.js mergeRows.
  const merge = (rows) => {
    const map = new Map();
    for (const r of rows) {
      if (!r?.label || !Number.isFinite(r.weight) || r.weight <= 0) continue;
      if (!map.has(r.label)) map.set(r.label, r.weight);
    }
    return [...map.entries()]
      .map(([label, weight]) => ({ label, weight: Math.round(weight * 10) / 10 }))
      .sort((a, b) => b.weight - a.weight);
  };
  return { sectorBreakdown: merge(sector), countryBreakdown: merge(country) };
}

function asOfAfter(text, headingRe) {
  const s = String(text || '');
  const m = s.match(headingRe);
  if (!m) return null;
  const window = s.slice(m.index, m.index + 220);
  const asAt = window.match(/\bas at\s+([A-Za-z]+\s+\d{1,2},?\s+20\d{2})/i);
  if (asAt) return parseAsOfDate(asAt[1]);
  const paren = window.match(/\(([A-Za-z]+\s+\d{1,2},?\s+20\d{2})\)/);
  if (paren) return parseAsOfDate(paren[1]);
  return parseAsOfDate(window);
}

function calendarFromFundFacts(text) {
  const years = [];
  const re = /return\s*for\s*(\d{4})\s*was\s*(-?\d+(?:\.\d+)?)\s*%/gi;
  let m;
  while ((m = re.exec(text))) {
    const value = pctToDecimal(m[2]);
    if (value == null) continue;
    years.push({ year: Number(m[1]), value, ytd: false });
  }
  return years;
}

function calendarFromPulse(text, performanceAsOf) {
  const header = String(text).match(/YTD\s+((?:20\d{2}\s+)+20\d{2}|20\d{2}(?:\s+20\d{2})+)/i);
  if (!header) return [];
  const years = header[1].trim().split(/\s+/).map(Number).filter((y) => y >= 1990 && y <= 2100);
  const after = String(text).slice(header.index + header[0].length);
  const nums = [];
  for (const line of after.split(/\n/)) {
    const t = line.replace(/\s+/g, ' ').trim();
    if (!t) continue;
    const m = t.match(/^(-?\d+(?:\.\d+)?)$/);
    if (m) {
      nums.push(Number(m[1]));
      if (nums.length >= years.length + 1) break;
      continue;
    }
    if (nums.length) break;
  }
  if (!nums.length) return [];
  const rows = [];
  // First number is YTD. Year comes from the performance as-of, not years[0]+1
  // (headers are usually YTD, 2025, 2024… with the current year omitted).
  const ytdYear = performanceAsOf
    ? Number(String(performanceAsOf).slice(0, 4))
    : (years[0] != null ? years[0] + 1 : null);
  if (nums[0] != null && ytdYear) {
    rows.push({ year: ytdYear, value: pctToDecimal(nums[0]), ytd: true });
  }
  const cyStart = ytdYear && pctToDecimal(nums[0]) != null ? 1 : 0;
  for (let i = 0; i < years.length; i++) {
    const v = pctToDecimal(nums[i + cyStart]);
    if (v == null) continue;
    rows.push({ year: years[i], value: v, ytd: false });
  }
  return rows.filter((r) => r.value != null);
}

function periodReturnsFromPulse(text) {
  const block = sliceBetween(
    text,
    /standard period returns/i,
    /growth of|calendar year|risk classification|quarterly top/i
  ) || text;
  const out = {};
  for (const line of String(block).split(/\n+/)) {
    const t = line.replace(/\s+/g, ' ').trim();
    const m = t.match(/^(.{1,24}?)\s+(-?\d+(?:\.\d+)?)\s*%?$/);
    if (!m) continue;
    const label = m[1].trim();
    const key = PERIOD_LABELS.find(([re]) => re.test(label))?.[1];
    if (!key) continue;
    const v = pctToDecimal(m[2]);
    if (v != null) out[key] = v;
  }
  return out;
}

function extractNavPoint(text) {
  const m = String(text).match(
    /NAV\s*[-–]\s*Class\s+[A-Z0-9]+\s*\$?\s*([\d.]+)\s*\(\s*as at\s+([A-Za-z]+\s+\d{1,2},?\s+20\d{2})\s*\)/i
  );
  if (!m) return null;
  const nav = Number(m[1]);
  const date = parseAsOfDate(m[2]);
  if (!Number.isFinite(nav) || nav <= 0 || !date) return null;
  return { date, nav, source: 'FundPulse' };
}

function documentDate(text) {
  // Fund Facts header: Series F \n APRIL 24, 2026
  const m = String(text).match(/series\s+[A-Z0-9]+\s+([A-Za-z]+\s+\d{1,2},?\s+20\d{2})/i);
  if (m) return parseAsOfDate(m[1]);
  return parseAsOfDate(String(text).slice(0, 400));
}

function calendarFromYearChart(text) {
  const m = String(text).match(
    /((?:20\d{2}\s+){4,}20\d{2})\s+((?:-?\d+(?:\.\d+)?\s*%\s*){4,})/i
  );
  if (!m) return [];
  const years = m[1].trim().split(/\s+/).map(Number).filter((y) => y >= 1990 && y <= 2100);
  const pcts = [...m[2].matchAll(/(-?\d+(?:\.\d+)?)\s*%/g)].map((x) => Number(x[1]));
  if (!years.length || pcts.length < years.length) return [];
  return years.map((year, i) => ({ year, value: pctToDecimal(pcts[i]), ytd: false }))
    .filter((r) => r.value != null);
}

export function parseFundFactsText(text) {
  const generic = parseFactsheetText(text);
  const countryBlock = sliceBetween(text, /BY COUNTRY/i, /BY SECTOR|HOW RISKY/i);
  const sectorBlock = sliceBetween(text, /BY SECTOR/i, /HOW RISKY|HOW HAS THE FUND PERFORMED/i);
  const investMix = sliceBetween(text, /investment mix/i, /how risky|how has the fund performed/i);
  const fromMix = combineHinted([
    extractHintedPercents(countryBlock, 'country'),
    extractHintedPercents(sectorBlock, 'sector'),
    extractLeadingPercents(investMix, 'sector'),
    extractLabeledPercents(text),
  ]);
  const mixAsOf = extractAsOf(text);
  const mer = extractMer(text);
  const calendarYears = calendarFromFundFacts(text);
  const chartYears = calendarYears.length ? [] : calendarFromYearChart(text);
  // CSA "ten years ago … annual compound return" is 10Y, not since-inception.
  const tenYear = String(text).match(/ten years ago[\s\S]{0,240}?annual compound return of\s*(-?\d+(?:\.\d+)?)\s*%/i);
  const inception = !tenYear && String(text).match(/annual compound return of\s*(-?\d+(?:\.\d+)?)\s*%/i);
  const published = normalizePublishedReturns({
    ...(tenYear ? { y10ann: pctToDecimal(tenYear[1]) } : {}),
    ...(inception ? { inceptionAnn: pctToDecimal(inception[1]) } : {}),
    calendarYears: calendarYears.length ? calendarYears : chartYears,
    asOf: documentDate(text) || mixAsOf.asOf,
    source: 'Fund Facts',
    series: (String(text).match(/series\s+([A-Z0-9]+)/i) || [])[1] || null,
  });

  return {
    sectorBreakdown: fromMix.sectorBreakdown.length ? fromMix.sectorBreakdown : generic.sectorBreakdown,
    countryBreakdown: fromMix.countryBreakdown.length ? fromMix.countryBreakdown : generic.countryBreakdown,
    asOf: mixAsOf.asOf,
    asOfEstimated: !!mixAsOf.estimated && !!mixAsOf.asOf,
    mer,
    published,
    documentDate: documentDate(text),
  };
}

export function parseFundPulseText(text) {
  const performanceAsOf = asOfAfter(text, /performance\s*\(class/i) || asOfAfter(text, /standard period returns/i);
  const allocationAsOf = asOfAfter(text, /\nallocation\s*\n/i) || asOfAfter(text, /asset mix/i);
  const sectorBlock = sliceBetween(text, /sector mix\s*\(%\)/i, /country mix|fund strategy|fund facts|©/i);
  const countryBlock = sliceBetween(text, /country mix\s*\(%\)/i, /source:|fund strategy|fund facts|©/i);
  const rows = combineHinted([
    extractHintedPercents(sectorBlock, 'sector'),
    extractHintedPercents(countryBlock, 'country'),
  ]);
  const periods = periodReturnsFromPulse(text);
  const calendarYears = calendarFromPulse(text, performanceAsOf);
  const ytdFromCal = calendarYears.find((r) => r.ytd);
  const published = normalizePublishedReturns({
    ...periods,
    ytd: ytdFromCal?.value ?? periods.ytd,
    calendarYears,
    asOf: performanceAsOf,
    source: 'FundPulse',
    series: (String(text).match(/series\s+([A-Z0-9]+)\s+for fee/i) || String(text).match(/series\s+([A-Z0-9]+)/i) || [])[1] || 'F',
  });
  return {
    sectorBreakdown: rows.sectorBreakdown,
    countryBreakdown: rows.countryBreakdown,
    asOf: allocationAsOf || performanceAsOf,
    allocationAsOf,
    performanceAsOf,
    mer: extractMer(text),
    published,
    navPoint: extractNavPoint(text),
  };
}

export function isRbcMonthlyText(text) {
  const s = String(text || '');
  return /RBC Global Asset Management/i.test(s) && /Performance analysis for Series/i.test(s);
}

function seriesMer(text) {
  const m = String(text).match(/series\s+[A-Z0-9]+\s+MER\s*%?\s+(-?\d+(?:\.\d+)?)/i);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) && n > 0 && n < 10 ? n : null;
}

function calendarFromRbcMonthly(text, performanceAsOf) {
  const header = String(text).match(/calendar returns\s*%\s+((?:20\d{2}\s+)+)YTD/i);
  if (!header) return [];
  const years = header[1].trim().split(/\s+/).map(Number).filter((y) => y >= 1990 && y <= 2100);
  const after = String(text).slice(header.index + header[0].length);
  const numsLine = after.match(/^\s*((?:-?\d+(?:\.\d+)?\s+)+)-?\d+(?:\.\d+)?\s+Fund/im)
    || after.match(/((?:-?\d+(?:\.\d+)?\s+){4,}-?\d+(?:\.\d+)?)\s+Fund/i);
  if (!numsLine) return [];
  const nums = numsLine[1].trim().split(/\s+/).map(Number).filter((n) => Number.isFinite(n));
  // Last number before "Fund" is YTD; the capture above may drop it. Re-read full run.
  const full = after.match(/((?:-?\d+(?:\.\d+)?\s+){5,}-?\d+(?:\.\d+)?)\s+Fund/i);
  const all = (full ? full[1] : numsLine[1]).trim().split(/\s+/).map(Number).filter((n) => Number.isFinite(n));
  if (all.length < years.length) return [];
  const rows = years.map((year, i) => ({ year, value: pctToDecimal(all[i]), ytd: false }));
  const ytd = all[years.length];
  const ytdYear = performanceAsOf ? Number(String(performanceAsOf).slice(0, 4)) : null;
  if (ytd != null && ytdYear) rows.push({ year: ytdYear, value: pctToDecimal(ytd), ytd: true });
  return rows.filter((r) => r.value != null);
}

function trailingFromRbcMonthly(text) {
  const block = String(text).match(
    /1\s*Mth\s+3\s*Mth\s+6\s*Mth\s+1\s*Yr\s+3\s*Yr\s+5\s*Yr\s+10\s*Yr\s+Since incep\.?\s+Trailing return\s*%?\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)/i
  );
  if (!block) return {};
  const keys = ['m1', 'm3', 'm6', 'y1', 'y3ann', 'y5ann', 'y10ann', 'inceptionAnn'];
  const out = {};
  keys.forEach((k, i) => {
    const v = pctToDecimal(block[i + 1]);
    if (v != null) out[k] = v;
  });
  return out;
}

function rbcNavPoint(text, asOf) {
  const m = String(text).match(/Series\s+([A-Z0-9]+)\s+NAV\s*\$?\s*([\d.]+)/i);
  if (!m) return null;
  const nav = Number(m[2]);
  if (!Number.isFinite(nav) || nav <= 0 || !asOf) return null;
  return { date: asOf, nav, source: 'Monthly update' };
}

export function parseRbcMonthlyText(text) {
  const performanceAsOf = asOfAfter(text, /performance analysis for series/i)
    || asOfAfter(text, /portfolio analysis as of/i);
  const allocationAsOf = asOfAfter(text, /portfolio analysis as of/i)
    || asOfAfter(text, /equity sector allocation/i)
    || performanceAsOf;
  const sectorBlock = sliceBetween(
    text,
    /equity sector allocation/i,
    /highest\/lowest|disclosure|portfolio manager|these pages are not complete/i
  );
  const assetBlock = sliceBetween(text, /asset mix/i, /value\s+blend|equity style|equity characteristics|dividend yield/i);
  const rows = combineHinted([
    extractHintedPercents(sectorBlock, 'sector'),
    extractHintedPercents(assetBlock, 'country'),
  ]);
  const geo = (rows.countryBreakdown || []).filter((r) => (
    r.label === 'Canada' || r.label === 'United States' || r.label === 'International'
    || r.label === 'Emerging Markets' || r.label === 'Global'
  ));
  const periods = trailingFromRbcMonthly(text);
  const calendarYears = calendarFromRbcMonthly(text, performanceAsOf);
  const ytdFromCal = calendarYears.find((r) => r.ytd);
  const published = normalizePublishedReturns({
    ...periods,
    ytd: ytdFromCal?.value ?? periods.ytd,
    calendarYears,
    asOf: performanceAsOf,
    source: 'Monthly update',
    series: (String(text).match(/Performance analysis for Series\s+([A-Z0-9]+)/i)
      || String(text).match(/Series\s+([A-Z0-9]+)\s+NAV/i)
      || [])[1] || 'F',
  });
  return {
    sectorBreakdown: rows.sectorBreakdown,
    countryBreakdown: geo,
    asOf: allocationAsOf || performanceAsOf,
    allocationAsOf,
    performanceAsOf,
    mer: extractMer(text) || seriesMer(text),
    published,
    navPoint: rbcNavPoint(text, performanceAsOf || allocationAsOf),
  };
}
