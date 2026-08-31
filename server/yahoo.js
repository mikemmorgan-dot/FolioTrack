// yahoo.js
// Auto-source adapter. Uses Yahoo's v8 chart endpoint, which returns both the
// latest price and a daily history without the cookie/crumb dance that the v7
// quote and quoteSummary endpoints now require. Covers TSX (.TO) + US listed
// stocks/ETFs and most US mutual funds. It does NOT cover Canadian FundServ
// mutual fund codes or private alts — those flow through manual NAV entry.

// Yahoo load-balances these hosts and blocks them inconsistently from
// datacenter IPs, so we try each in turn before giving up.
const HOSTS = [
  'https://query1.finance.yahoo.com',
  'https://query2.finance.yahoo.com',
];
const PATH = '/v8/finance/chart';

const HEADERS = {
  // Yahoo blocks empty UAs; a browser-like UA keeps the unofficial endpoint happy.
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15',
  Accept: 'application/json,text/plain,*/*',
  'Accept-Language': 'en-US,en;q=0.9',
  Referer: 'https://finance.yahoo.com/',
};

// Distinguishes "Yahoo refused us" from "symbol does not exist" — the two were
// previously collapsed into one useless message.
export class YahooError extends Error {
  constructor(message, { blocked = false, notFound = false, status = null } = {}) {
    super(message);
    this.name = 'YahooError';
    this.blocked = blocked;   // network/403/429 — our access problem
    this.notFound = notFound; // Yahoo answered, symbol genuinely unknown
    this.status = status;
  }
}

async function fetchChart(symbol, range, interval) {
  let lastErr = null;
  for (const host of HOSTS) {
    const url = `${host}${PATH}/${encodeURIComponent(symbol)}?range=${range}&interval=${interval}`;
    let res;
    try {
      res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(10000) });
    } catch (e) {
      lastErr = new YahooError(`Network error reaching Yahoo: ${e.message}`, { blocked: true });
      continue; // try next host
    }

    // Yahoo returns 404 with a JSON error body for unknown symbols.
    if (res.status === 404) {
      throw new YahooError(`Yahoo does not know the symbol ${symbol}`, { notFound: true, status: 404 });
    }
    if (res.status === 401 || res.status === 403 || res.status === 429) {
      lastErr = new YahooError(
        `Yahoo refused the request (HTTP ${res.status}) — this host is likely blocking the server's IP`,
        { blocked: true, status: res.status }
      );
      continue; // try next host
    }
    if (!res.ok) {
      lastErr = new YahooError(`Yahoo returned HTTP ${res.status} for ${symbol}`, { blocked: true, status: res.status });
      continue;
    }

    let json;
    try {
      json = await res.json();
    } catch {
      lastErr = new YahooError('Yahoo returned a non-JSON response (likely a block page)', { blocked: true, status: res.status });
      continue;
    }

    const errCode = json?.chart?.error?.code;
    if (errCode) {
      const notFound = /not\s*found|No data found/i.test(`${errCode} ${json?.chart?.error?.description || ''}`);
      throw new YahooError(json?.chart?.error?.description || errCode, { notFound, blocked: !notFound });
    }

    const result = json?.chart?.result?.[0];
    if (!result) throw new YahooError(`No data returned for ${symbol}`, { notFound: true });
    return result;
  }
  throw lastErr || new YahooError('Yahoo unreachable', { blocked: true });
}

export async function getQuote(symbol) {
  const r = await fetchChart(symbol, '1d', '1d');
  const m = r.meta || {};
  return {
    symbol,
    price: m.regularMarketPrice ?? null,
    previousClose: m.chartPreviousClose ?? m.previousClose ?? null,
    currency: m.currency ?? null,
    exchange: m.exchangeName ?? null,
    name: m.longName || m.shortName || symbol,
    asOf: m.regularMarketTime ? new Date(m.regularMarketTime * 1000).toISOString() : null,
  };
}

export async function getHistory(symbol, range = '1y', interval = '1d') {
  const r = await fetchChart(symbol, range, interval);
  const ts = r.timestamp || [];
  const adj = r.indicators?.adjclose?.[0]?.adjclose || [];
  const close = r.indicators?.quote?.[0]?.close || [];
  const series = ts
    .map((t, i) => ({
      date: new Date(t * 1000).toISOString().slice(0, 10),
      close: adj[i] ?? close[i] ?? null,
    }))
    .filter((p) => p.close != null);
  return { symbol, range, interval, series };
}

// Resolve a ticker for the editor. Never collapses a block into "not found":
// the client needs to tell those apart to show an honest message.
export async function lookup(symbol) {
  try {
    const q = await getQuote(symbol);
    if (q.price == null) {
      return { found: false, symbol, reason: 'Yahoo returned no price for this symbol', blocked: false };
    }
    const bare = symbol.replace(/\..*$/, '');
    const guessType = /^[A-Z]{5}X$/.test(bare) ? 'mutualfund' : 'stock';
    return { found: true, symbol, name: q.name, currency: q.currency, exchange: q.exchange, guessType, price: q.price };
  } catch (e) {
    return {
      found: false,
      symbol,
      reason: e.message,
      blocked: e instanceof YahooError ? !!e.blocked : true,
    };
  }
}

// Connectivity probe: is Yahoo reachable from THIS server right now?
export async function diagnose(symbol = 'AAPL') {
  const started = Date.now();
  try {
    const q = await getQuote(symbol);
    return { reachable: true, symbol, price: q.price, name: q.name, ms: Date.now() - started };
  } catch (e) {
    return {
      reachable: false,
      symbol,
      blocked: e instanceof YahooError ? !!e.blocked : true,
      status: e instanceof YahooError ? e.status : null,
      reason: e.message,
      ms: Date.now() - started,
    };
  }
}
