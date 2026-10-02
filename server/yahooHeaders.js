// yahooHeaders.js — User-Agent and chart query for the unofficial Yahoo v8 endpoint.
//
// Probed from this environment on 2026-10-02 against ATD.TO and AAPL:
// - No User-Agent, "FolioTrack/1.0 (portfolio price history)", Chrome, Firefox,
//   and Edge all returned HTTP 200 with CAD/USD bars.
// - The previous Safari browser User-Agent returned HTTP 429 (HTML "Too Many
//   Requests", no Retry-After) for ATD.TO and AAPL, including right after the
//   other agents had succeeded.
// - query1 and query2 both returned bars. query2 is tried first.
// - range=max&interval=1d was downsampled (ATD.TO monthly, AAPL quarterly).
//   period1/period2&interval=1d returned daily bars (ATD.TO max: 7654 rows).

export const DEFAULT_YAHOO_UA = 'FolioTrack/1.0 (portfolio price history)';

// Common desktop UAs that returned real bars. Safari is omitted on purpose.
export const ROTATING_UAS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:128.0) Gecko/20100101 Firefox/128.0',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36 Edg/128.0.0.0',
];

const SHORT_RANGES = new Set(['1d', '5d']);

const RANGE_SECONDS = {
  '1mo': 31 * 86400,
  '3mo': 93 * 86400,
  '6mo': 186 * 86400,
  '1y': 366 * 86400,
  '2y': 732 * 86400,
  '5y': 1827 * 86400,
  '10y': 3653 * 86400,
};

/**
 * YAHOO_UA:
 *   unset / "" / "descriptive" — FolioTrack descriptive UA (default)
 *   "none" / "omit"            — do not send User-Agent
 *   "rotate"                   — one of ROTATING_UAS per call
 *   anything else              — that exact string
 */
export function resolveYahooUserAgent(env = process.env, { random = Math.random } = {}) {
  const raw = env?.YAHOO_UA;
  if (raw == null || String(raw).trim() === '' || /^descriptive$/i.test(String(raw).trim())) {
    return { mode: 'descriptive', userAgent: DEFAULT_YAHOO_UA };
  }
  const value = String(raw).trim();
  if (/^(none|omit)$/i.test(value)) return { mode: 'omit', userAgent: null };
  if (/^rotate$/i.test(value)) {
    const n = ROTATING_UAS.length;
    const i = Math.abs(Math.floor(Number(random()) * n)) % n;
    return { mode: 'rotate', userAgent: ROTATING_UAS[i] };
  }
  return { mode: 'custom', userAgent: value };
}

export function yahooRequestHeaders(env = process.env, opts = {}) {
  const { userAgent } = resolveYahooUserAgent(env, opts);
  const headers = {
    Accept: 'application/json,text/plain,*/*',
    'Accept-Language': 'en-US,en;q=0.9',
  };
  if (userAgent) headers['User-Agent'] = userAgent;
  return headers;
}

export function buildChartQuery({ range = '1d', interval = '1d', nowSec } = {}) {
  const now = Number.isFinite(nowSec) ? Math.floor(nowSec) : Math.floor(Date.now() / 1000);
  const r = String(range || '1d');
  const iv = String(interval || '1d');
  if (iv === '1d' && !SHORT_RANGES.has(r)) {
    let period1 = 0;
    if (r !== 'max') {
      if (r === 'ytd') {
        const year = new Date(now * 1000).getUTCFullYear();
        period1 = Math.floor(Date.UTC(year, 0, 1) / 1000);
      } else {
        period1 = now - (RANGE_SECONDS[r] || RANGE_SECONDS['5y']);
      }
    }
    if (period1 < 0) period1 = 0;
    return `period1=${period1}&period2=${now}&interval=${encodeURIComponent(iv)}`;
  }
  return `range=${encodeURIComponent(r)}&interval=${encodeURIComponent(iv)}`;
}
