// Shared field normalization for politician trade filings.
// Amounts stay the statutory range string. Nothing here invents a dollar figure.

export const AMOUNT_RANGES = [
  [1001, 15000, '$1,001 - $15,000'],
  [15001, 50000, '$15,001 - $50,000'],
  [50001, 100000, '$50,001 - $100,000'],
  [100001, 250000, '$100,001 - $250,000'],
  [250001, 500000, '$250,001 - $500,000'],
  [500001, 1000000, '$500,001 - $1,000,000'],
  [1000001, 5000000, '$1,000,001 - $5,000,000'],
  [5000001, 25000000, '$5,000,001 - $25,000,000'],
  [25000001, 50000000, '$25,000,001 - $50,000,000'],
];

const OVER_50M = 'Over $50,000,000';

const CA_LISTING = /\.(TO|V|CN|NE)$/;

const TICKER_WORDS = new Set([
  'INC', 'LLC', 'LTD', 'CO', 'CORP', 'ETF', 'ADR', 'NEW', 'THE', 'AND', 'FOR',
  'USD', 'CAD', 'NYSE', 'NASDAQ',
]);

export function usCalendarYear(now = new Date()) {
  return Number(new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric',
  }).format(now));
}

export function backfillYearList(now = new Date(), years = 2) {
  const end = usCalendarYear(now);
  const n = Math.min(5, Math.max(1, Math.round(Number(years) || 2)));
  const out = [];
  for (let i = n - 1; i >= 0; i -= 1) out.push(end - i);
  return out;
}

export function windowStartIso(now = new Date(), years = 2) {
  return `${backfillYearList(now, years)[0]}-01-01`;
}

export function parseUsDate(value) {
  const m = String(value ?? '').trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) return null;
  const month = Number(m[1]);
  const day = Number(m[2]);
  const year = Number(m[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31 || year < 1990 || year > 2100) return null;
  const iso = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  const dt = new Date(`${iso}T00:00:00Z`);
  if (dt.getUTCFullYear() !== year || dt.getUTCMonth() + 1 !== month || dt.getUTCDate() !== day) return null;
  return iso;
}

export function isoDate(value) {
  if (value == null || value === '') return null;
  const s = String(value).trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) {
    const iso = s.slice(0, 10);
    return parseIso(iso) ? iso : null;
  }
  return parseUsDate(s);
}

function parseIso(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return false;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const dt = new Date(`${iso}T00:00:00Z`);
  return dt.getUTCFullYear() === year && dt.getUTCMonth() + 1 === month && dt.getUTCDate() === day;
}

export function lagDays(txDate, disclosedDate) {
  if (!txDate || !disclosedDate) return null;
  const a = Date.parse(`${txDate}T00:00:00Z`);
  const b = Date.parse(`${disclosedDate}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.round((b - a) / 86400000);
}

function dollars(token) {
  const n = Number(String(token).replace(/[$,\s]/g, ''));
  return Number.isFinite(n) ? n : null;
}

// Return the official range label when the text is one of the statutory
// buckets. A midpoint, a rounded figure, or an unrecognized pair is null.
export function canonicalAmountRange(raw) {
  const text = String(raw ?? '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
  if (!text) return null;
  const over = text.match(/over\s+\$?\s*([\d,]+)/i);
  if (over) {
    return dollars(over[1]) === 50000000 ? OVER_50M : null;
  }
  const m = text.match(/\$?\s*([\d,]+)\s*[-–—•]\s*\$?\s*([\d,]+)/);
  if (!m) return null;
  const lo = dollars(m[1]);
  const hi = dollars(m[2]);
  const hit = AMOUNT_RANGES.find(([a, b]) => a === lo && b === hi);
  return hit ? hit[2] : null;
}

export function canonicalTicker(raw) {
  if (raw == null) return null;
  let s = String(raw).trim().toUpperCase().replace(/\s+/g, '');
  if (!s || s === '--' || s === 'N/A' || s === 'NA' || s === 'NONE' || s === '-') return null;
  s = s.replace(/^([A-Z]{1,5})[/-]([A-Z])$/, '$1.$2');
  if (!/^[A-Z][A-Z0-9.]{0,11}$/.test(s)) return null;
  if (TICKER_WORDS.has(s)) return null;
  return s;
}

export function isCanadianListing(symbol) {
  const t = canonicalTicker(symbol);
  return Boolean(t && CA_LISTING.test(t));
}

// Exact listing match. RY.TO does not match a US RY trade. BRK/B matches BRK.B.
export function tickersMatch(modelSymbol, tradeTicker) {
  const a = canonicalTicker(modelSymbol);
  const b = canonicalTicker(tradeTicker);
  if (!a || !b) return false;
  if (isCanadianListing(a) !== isCanadianListing(b)) return false;
  return a === b;
}

export function matchableAssetClass(assetClass) {
  return assetClass === 'stock' || assetClass === 'etf' || assetClass === 'fund';
}

const OWNER_WORDS = [
  [/dependent\s+child|\bchild\b|\bdc\b/i, 'child'],
  [/\bspouse\b|\bsp\b/i, 'spouse'],
  [/\bjoint\b|\bjt\b/i, 'joint'],
  [/\bself\b/i, 'self'],
];

export function normalizeOwner(raw, { blankIsSelf = false } = {}) {
  const text = String(raw ?? '').trim();
  if (!text) return blankIsSelf ? 'self' : 'unknown';
  const upper = text.toUpperCase();
  if (upper === 'SP' || upper === 'SPOUSE') return 'spouse';
  if (upper === 'JT' || upper === 'JOINT') return 'joint';
  if (upper === 'DC' || upper === 'DEPENDENT CHILD') return 'child';
  if (upper === 'SELF' || upper === '--') return 'self';
  for (const [re, owner] of OWNER_WORDS) {
    if (re.test(text)) return owner;
  }
  return 'unknown';
}

export function ownerLabel(owner) {
  switch (owner) {
    case 'self': return 'Self';
    case 'spouse': return 'Spouse';
    case 'joint': return 'Joint';
    case 'child': return 'Child';
    default: return 'Owner not stated';
  }
}

export function txLabel(txType, partial) {
  const base = txType === 'buy' ? 'Buy' : txType === 'sell' ? 'Sell' : txType === 'exchange' ? 'Exchange' : 'Other';
  return partial ? `${base} (partial)` : base;
}

export function officeLabel(office) {
  switch (office) {
    case 'house': return 'House';
    case 'senate': return 'Senate';
    case 'president': return 'President';
    case 'vice-president': return 'Vice President';
    default: return office || '—';
  }
}

export function partyLabel(party) {
  switch (party) {
    case 'D': return 'Democrat';
    case 'R': return 'Republican';
    case 'I': return 'Independent';
    default: return null;
  }
}

export function personKey(office, last, first) {
  const norm = (s) => String(s ?? '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
  const lastN = norm(last);
  const firstN = norm(first).split(' ').filter(Boolean)[0] || '';
  return [office, lastN, firstN].filter(Boolean).join(':');
}

export function displayName(first, last) {
  return [String(first ?? '').trim(), String(last ?? '').trim()].filter(Boolean).join(' ').replace(/\s+/g, ' ');
}

export function nameFold(value) {
  return String(value ?? '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\b(jr|sr|ii|iii|iv|hon|mr|mrs|ms|dr)\b\.?/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
