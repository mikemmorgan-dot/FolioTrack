// stooq.js — keyless daily CSV fallback.
// https://stooq.com/q/d/l/?s=avgo.us&i=d
// The site often answers with a JS challenge or HTTP 403. That is a failed
// hop, not "symbol does not exist".

const STOOQ_URL = 'https://stooq.com/q/d/l/';

export function toStooqSymbol(symbol) {
  const raw = String(symbol || '').trim();
  if (!raw) return null;
  const upper = raw.toUpperCase();
  if (/\.(TO|V|NE|CN)$/i.test(upper)) {
    return `${upper.replace(/\.(TO|V|NE|CN)$/i, '').toLowerCase()}.ca`;
  }
  if (/\.L$/i.test(upper)) return `${upper.replace(/\.L$/i, '').toLowerCase()}.uk`;
  if (!upper.includes('.')) return `${upper.toLowerCase()}.us`;
  return upper.toLowerCase();
}

export function isStooqBlockPage(text, status = null) {
  if (status === 403 || status === 429 || status === 503) return true;
  const head = String(text || '').slice(0, 2500).toLowerCase();
  if (!head) return false;
  if (head.includes('<html') || head.includes('<!doctype')) return true;
  if (/just a moment|enable javascript|cf-browser|challenge-platform|proof of work|attention required/.test(head)) {
    return true;
  }
  return false;
}

function blockedError(status = 403) {
  const err = new Error('Stooq returned a block page');
  err.status = status || 403;
  err.blocked = true;
  err.notFound = false;
  return err;
}

function notFoundError(symbol) {
  const err = new Error(`Stooq has no data for ${symbol}`);
  err.notFound = true;
  return err;
}

export function parseStooqCsv(text, symbol = '') {
  const raw = String(text || '').replace(/^\uFEFF/, '');
  if (isStooqBlockPage(raw)) throw blockedError(403);
  const lines = raw.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (!lines.length) throw notFoundError(symbol);
  const header = lines[0].toLowerCase();
  if (!header.startsWith('date')) {
    if (/no data/i.test(raw)) throw notFoundError(symbol);
    throw blockedError(403);
  }
  const series = [];
  for (const line of lines.slice(1)) {
    const cols = line.split(',');
    const date = String(cols[0] || '').slice(0, 10);
    const close = parseFloat(cols[4]);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(close)) continue;
    series.push({ date, close });
  }
  series.sort((a, b) => a.date.localeCompare(b.date));
  if (!series.length) throw notFoundError(symbol);
  const last = series[series.length - 1];
  return { series, price: last.close, asOf: last.date };
}

async function fetchStooqCsv(symbol) {
  const mapped = toStooqSymbol(symbol);
  if (!mapped) throw notFoundError(symbol);
  const url = `${STOOQ_URL}?s=${encodeURIComponent(mapped)}&i=d`;
  let res;
  try {
    res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; FolioTrack/1.0)',
        Accept: 'text/csv,text/plain,*/*',
      },
      signal: AbortSignal.timeout(8000),
    });
  } catch (e) {
    const err = new Error(`Network error reaching Stooq: ${e.message}`);
    err.blocked = true;
    throw err;
  }
  const text = await res.text();
  if (isStooqBlockPage(text, res.status) || res.status === 403 || res.status === 429) {
    throw blockedError(res.status === 200 ? 403 : res.status);
  }
  if (!res.ok) {
    const err = new Error(`Stooq HTTP ${res.status}`);
    err.status = res.status;
    err.blocked = res.status === 403 || res.status === 429;
    throw err;
  }
  return parseStooqCsv(text, symbol);
}

export const stooq = {
  id: 'stooq',
  supports: () => true,
  async quote(symbol) {
    const parsed = await fetchStooqCsv(symbol);
    return {
      symbol,
      price: parsed.price,
      previousClose: parsed.series.length > 1 ? parsed.series[parsed.series.length - 2].close : null,
      currency: null,
      name: symbol,
      exchange: null,
      asOf: parsed.asOf,
      partial: true,
    };
  },
  async history(symbol) {
    const parsed = await fetchStooqCsv(symbol);
    return { symbol, series: parsed.series };
  },
};
