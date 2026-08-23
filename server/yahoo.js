// yahoo.js
// Auto-source adapter. Uses Yahoo's v8 chart endpoint, which returns both the
// latest price and a daily history without the cookie/crumb dance that the v7
// quote and quoteSummary endpoints now require. Covers TSX (.TO) + US listed
// stocks/ETFs and most US mutual funds. It does NOT cover Canadian FundServ
// mutual fund codes or private alts — those flow through manual NAV entry.

const BASE = 'https://query1.finance.yahoo.com/v8/finance/chart';
const HEADERS = {
  // Yahoo blocks empty UAs; a browser-like UA keeps the unofficial endpoint happy.
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15',
  Accept: 'application/json',
};

async function fetchChart(symbol, range, interval) {
  const url = `${BASE}/${encodeURIComponent(symbol)}?range=${range}&interval=${interval}`;
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) throw new Error(`Yahoo ${res.status} for ${symbol}`);
  const json = await res.json();
  const result = json?.chart?.result?.[0];
  if (!result) throw new Error(`No data for ${symbol}`);
  return result;
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
