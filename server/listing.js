// listing.js — infer currency / exchange / region from a ticker when no live
// quote is available. FundServ codes are checked before the "no suffix = US"
// rule so RBF1005 stays CAD. The pattern matches looksLikeFundserv in
// yahooSeries.js; kept local so this module does not import the history cache.

const TSX = new Set(['TO', 'NE', 'CN']);

export function isFundservCode(symbol) {
  const s = String(symbol || '').trim().toUpperCase().replace(/[\s.-]+/g, '');
  return /^[A-Z]{2,4}\d{3,5}$/.test(s);
}

export function inferListing(symbol) {
  const raw = String(symbol || '').trim().toUpperCase();
  if (!raw) return { currency: null, exchange: null, region: null };
  const suffix = raw.includes('.') ? raw.split('.').pop() : '';
  if (TSX.has(suffix)) return { currency: 'CAD', exchange: 'TSX', region: 'Canada' };
  if (suffix === 'V') return { currency: 'CAD', exchange: 'TSXV', region: 'Canada' };
  if (suffix === 'L') return { currency: 'GBP', exchange: 'London', region: 'United Kingdom' };
  if (isFundservCode(raw)) return { currency: 'CAD', exchange: null, region: 'Canada' };
  // No exchange suffix, including a US share class such as BRK.B.
  if (!raw.includes('.') || /^[A-Z][A-Z0-9]*\.[A-Z]$/.test(raw)) {
    return { currency: 'USD', exchange: 'US', region: 'United States' };
  }
  return { currency: null, exchange: null, region: null };
}

// A currency the user typed wins. Otherwise take the suffix inference.
export function currencyAfterFailedLookup({ current, inferred, userEdited } = {}) {
  if (userEdited && current) return current;
  return inferred || current || 'CAD';
}
