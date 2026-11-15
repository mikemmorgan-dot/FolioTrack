// Typeahead rules for the politician screen. The server ranks people.
// This module decides when a query is also a ticker, and how the keyboard moves.

export const SEARCH_DEBOUNCE_MS = 250;

const TICKER_WORDS = new Set([
  'INC', 'LLC', 'LTD', 'CO', 'CORP', 'ETF', 'ADR', 'NEW', 'THE', 'AND', 'FOR',
  'USD', 'CAD', 'NYSE', 'NASDAQ',
]);

export function officeShort(office) {
  if (office === 'house') return 'House';
  if (office === 'senate') return 'Senate';
  if (office === 'president') return 'President';
  if (office === 'vice-president') return 'VP';
  return '';
}

export function partyLabel(party) {
  if (party === 'D') return 'Democrat';
  if (party === 'R') return 'Republican';
  if (party === 'I') return 'Independent';
  return '';
}

export function personSuggestionMeta(person) {
  const bits = [officeShort(person?.office), partyLabel(person?.party), person?.state || '']
    .filter(Boolean);
  if (person?.filerStatus === 'candidate') bits.push('Candidate');
  return bits.join(' · ');
}

export function tradeCountLabel(count) {
  const n = Number(count) || 0;
  return `${n} trade${n === 1 ? '' : 's'}`;
}

// A ticker is 1–5 letters, optionally BRK.B / RY.TO. Longer strings are names
// ("pelosi"). A lowercase query that already matched a person stays a name;
// AAPL, BRK.B, and a query with no person match still offer the feed.
export function tickerSymbol(raw, { hasPeople = false, settled = true } = {}) {
  const text = String(raw ?? '').trim();
  if (!text || /\s/.test(text)) return null;
  let symbol = text.toUpperCase().replace(/\s+/g, '');
  symbol = symbol.replace(/^([A-Z]{1,5})[/-]([A-Z])$/, '$1.$2');
  if (!/^[A-Z][A-Z0-9.]{0,11}$/.test(symbol)) return null;
  if (TICKER_WORDS.has(symbol)) return null;
  const root = symbol.split('.')[0];
  if (root.length < 1 || root.length > 5) return null;
  const strong = text === text.toUpperCase() || /[.\d/-]/.test(text);
  if (hasPeople && !strong) return null;
  if (!settled && !strong) return null;
  return symbol;
}

export function searchKeyAction({ key, options, activeIndex, open }) {
  const count = options.length;
  if (key === 'ArrowDown') {
    if (!count) return { open: false, activeIndex: -1, activate: null };
    const next = open && activeIndex >= 0 ? (activeIndex + 1) % count : 0;
    return { open: true, activeIndex: next, activate: null };
  }
  if (key === 'ArrowUp') {
    if (!count) return { open: false, activeIndex: -1, activate: null };
    const next = open && activeIndex >= 0 ? (activeIndex - 1 + count) % count : count - 1;
    return { open: true, activeIndex: next, activate: null };
  }
  if (key === 'Escape') return { open: false, activeIndex: -1, activate: null };
  if (key === 'Enter') {
    if (activeIndex >= 0 && options[activeIndex]) {
      return { open: false, activeIndex, activate: options[activeIndex] };
    }
    if (count === 1) return { open: false, activeIndex: 0, activate: options[0] };
    return { open, activeIndex, activate: null };
  }
  return null;
}
