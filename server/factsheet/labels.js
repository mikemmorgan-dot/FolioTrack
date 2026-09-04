// labels.js — map issuer allocation labels onto FolioTrack's sector/region lists.
// Unknown labels pass through as-is (ClassifySelect already has an Other hatch).

import { GICS_SECTORS, SECTOR_OPTIONS, COUNTRIES, REGION_OPTIONS } from '../../client/src/classify.js';

const SKIP = new Set([
  'total', 'net', 'net other assets', 'liabilities', 'other assets',
  'cash and/or derivatives', 'cash and cash equivalents', 'derivatives',
  'unclassified', 'not classified', 'n/a', 'na',
]);

const SECTOR_ALIASES = {
  'information technology': 'Information Technology',
  'technology': 'Information Technology',
  'tech': 'Information Technology',
  'it': 'Information Technology',
  'financials': 'Financials',
  'financial': 'Financials',
  'financial services': 'Financials',
  'financials services': 'Financials',
  'health care': 'Health Care',
  'healthcare': 'Health Care',
  'health': 'Health Care',
  'consumer discretionary': 'Consumer Discretionary',
  'consumer cyclical': 'Consumer Discretionary',
  'consumer cyclicals': 'Consumer Discretionary',
  'consumer staples': 'Consumer Staples',
  'consumer defensive': 'Consumer Staples',
  'consumer staples defensive': 'Consumer Staples',
  'communication services': 'Communication Services',
  'communications': 'Communication Services',
  'telecommunication services': 'Communication Services',
  'telecommunications': 'Communication Services',
  'telecom': 'Communication Services',
  'industrials': 'Industrials',
  'industrial': 'Industrials',
  'energy': 'Energy',
  'utilities': 'Utilities',
  'utility': 'Utilities',
  'real estate': 'Real Estate',
  'materials': 'Materials',
  'basic materials': 'Materials',
  'basic material': 'Materials',
  'fixed income': 'Fixed Income',
  'bonds': 'Fixed Income',
  'bond': 'Fixed Income',
  'government bonds': 'Fixed Income',
  'corporate bonds': 'Fixed Income',
  'private equity': 'Private Equity',
  'private credit': 'Private Credit',
  'diversified': 'Diversified',
  'multi-sector': 'Diversified',
  'other': 'Diversified',
};

const COUNTRY_ALIASES = {
  'united states': 'United States',
  'united states of america': 'United States',
  'usa': 'United States',
  'u.s.': 'United States',
  'u.s.a.': 'United States',
  'us': 'United States',
  'u.s. equity': 'United States',
  'america': 'United States',
  'canada': 'Canada',
  'canadian': 'Canada',
  'united kingdom': 'United Kingdom',
  'uk': 'United Kingdom',
  'u.k.': 'United Kingdom',
  'great britain': 'United Kingdom',
  'britain': 'United Kingdom',
  'south korea': 'South Korea',
  'korea': 'South Korea',
  'republic of korea': 'South Korea',
  'korea, republic of': 'South Korea',
  'taiwan': 'Taiwan',
  'taiwan, province of china': 'Taiwan',
  'china': 'China',
  'hong kong': 'Hong Kong',
  'emerging markets': 'Emerging Markets',
  'emerging market': 'Emerging Markets',
  'em': 'Emerging Markets',
  'international': 'International',
  'global': 'Global',
  'developed markets': 'Developed Markets (ex-North America)',
  'developed markets (ex-north america)': 'Developed Markets (ex-North America)',
  'developed ex-north america': 'Developed Markets (ex-North America)',
  'eafe': 'Developed Markets (ex-North America)',
  'europe': 'International',
  'asia': 'International',
  'asia pacific': 'International',
  'asia-pacific': 'International',
  'japan': 'Japan',
  'australia': 'Australia',
  'germany': 'Germany',
  'france': 'France',
  'switzerland': 'Switzerland',
  'netherlands': 'Netherlands',
  'ireland': 'Ireland',
  'india': 'India',
  'brazil': 'Brazil',
  'mexico': 'Mexico',
  'spain': 'Spain',
  'italy': 'Italy',
  'sweden': 'Sweden',
  'denmark': 'Denmark',
  'norway': 'Norway',
  'finland': 'Finland',
  'belgium': 'Belgium',
  'singapore': 'Singapore',
  'israel': 'Israel',
  'south africa': 'South Africa',
  'new zealand': 'New Zealand',
  'indonesia': 'Indonesia',
  'malaysia': 'Malaysia',
  'thailand': 'Thailand',
  'philippines': 'Philippines',
  'vietnam': 'Vietnam',
  'austria': 'Austria',
  'portugal': 'Portugal',
  'poland': 'Poland',
  'turkey': 'Turkey',
  'saudi arabia': 'Saudi Arabia',
  'united arab emirates': 'United Arab Emirates',
  'uae': 'United Arab Emirates',
  'qatar': 'Qatar',
  'argentina': 'Argentina',
  'chile': 'Chile',
  'colombia': 'Colombia',
  'peru': 'Peru',
  'luxembourg': 'Luxembourg',
  'greece': 'Greece',
  'czech republic': 'Czech Republic',
  'hungary': 'Hungary',
  'iceland': 'Iceland',
};

function key(s) {
  return String(s || '').toLowerCase().replace(/[%*†‡]+/g, '').replace(/\s+/g, ' ').trim();
}

export function shouldSkipLabel(label) {
  const k = key(label);
  if (!k) return true;
  if (SKIP.has(k)) return true;
  if (/^total\b/.test(k)) return true;
  if (k === 'cash' || k.startsWith('cash ')) return true;
  return false;
}

export function mapSectorLabel(label) {
  if (shouldSkipLabel(label)) return null;
  const k = key(label);
  if (SECTOR_ALIASES[k]) return SECTOR_ALIASES[k];
  const exact = SECTOR_OPTIONS.find((s) => s.toLowerCase() === k);
  if (exact) return exact;
  const gics = GICS_SECTORS.find((s) => s.toLowerCase() === k);
  return gics || String(label).trim();
}

export function mapRegionLabel(label) {
  if (shouldSkipLabel(label)) return null;
  const k = key(label);
  if (COUNTRY_ALIASES[k]) return COUNTRY_ALIASES[k];
  const exact = REGION_OPTIONS.find((s) => s.toLowerCase() === k);
  if (exact) return exact;
  const country = COUNTRIES.find((s) => s.toLowerCase() === k);
  return country || String(label).trim();
}

export function classifyLabel(label, hint) {
  if (shouldSkipLabel(label)) return null;
  const k = key(label);
  if (hint === 'sector') return { kind: 'sector', label: mapSectorLabel(label) };
  if (hint === 'country' || hint === 'region' || hint === 'geographic') {
    return { kind: 'country', label: mapRegionLabel(label) };
  }
  if (SECTOR_ALIASES[k] || SECTOR_OPTIONS.some((s) => s.toLowerCase() === k)) {
    return { kind: 'sector', label: mapSectorLabel(label) };
  }
  if (COUNTRY_ALIASES[k] || REGION_OPTIONS.some((s) => s.toLowerCase() === k)) {
    return { kind: 'country', label: mapRegionLabel(label) };
  }
  return null;
}

export function tableHint(text) {
  const t = key(text);
  if (/\b(geo|geograph|country|countries|region|market allocation|location)\b/.test(t)) return 'country';
  if (/\b(sector|gics|industry)\b/.test(t)) return 'sector';
  return null;
}
