// navField.js — Prices panel NAV + Yahoo paste helpers. Pure, so vitest can
// import them without rendering React.

export const YAHOO_PASTE_PLACEHOLDER = 'Date,Close\n2024-01-02,128.00';

// Empty means "skip this row". Anything else must be a positive number.
// "skip" is the input placeholder, not a value, and is rejected if typed.
export function parseNavInput(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return { empty: true, value: null, error: null };
  const normalized = s.replace(/[$,\s]/g, '');
  if (!/^[+]?\d+(\.\d+)?$/.test(normalized) && !/^[+]?\.\d+$/.test(normalized)) {
    return { empty: false, value: null, error: 'New NAV must be a number' };
  }
  const n = Number(normalized);
  if (!Number.isFinite(n) || n <= 0) {
    return { empty: false, value: null, error: 'New NAV must be a number greater than 0' };
  }
  return { empty: false, value: n, error: null };
}

export function navFieldError(raw) {
  return parseNavInput(raw).error;
}

export function formatRetryHint(ms) {
  if (ms == null || !Number.isFinite(Number(ms))) return null;
  const n = Number(ms);
  if (n <= 0) return '0s';
  if (n < 90_000) return `${Math.max(1, Math.ceil(n / 1000))}s`;
  return `${Math.round(n / 1000)}s`;
}

// Fetch Yahoo failure text. Keeps a server message that already explains the
// rate limit, and always leaves the paste fallback in place.
export function formatFetchYahooError(message, { code = null, retryAfterMs = null } = {}) {
  const base = String(message || '').trim();
  const rate = code === 'rate_limit' || /\b429\b|rate-?limit/i.test(base);
  let text = base || (rate ? 'Yahoo rate-limited this server (HTTP 429).' : 'Yahoo failed.');
  if (rate && retryAfterMs != null && Number.isFinite(Number(retryAfterMs)) && !/retry after/i.test(text)) {
    const hint = formatRetryHint(retryAfterMs);
    if (hint) text += ` Retry after ${hint}.`;
  }
  if (!/paste/i.test(text)) {
    text += ' Paste Date / Close below, or type a NAV.';
  }
  return text;
}

export function pasteForSubmit(value) {
  return String(value ?? '');
}
