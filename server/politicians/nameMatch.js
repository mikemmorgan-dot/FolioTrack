// Resolve a disclosure asset name to a ticker.
//
// 278-Ts print "Micron Technology Inc" and "Berkshire Hathaway Class B", not
// MU and BRK.B. Matches are exact after normalization, or a single fuzzy
// candidate above a strict bar. Bonds, notes, munis, Treasuries, coupons,
// and private funds never receive a ticker. A ticker that arrived on the
// filing is left alone.

import { canonicalTicker } from './normalize.js';
import { CURATED_FUNDS } from './etfNames.js';

export const SEC_EXCHANGE_URL = 'https://www.sec.gov/files/company_tickers_exchange.json';
export const SEC_TICKERS_URL = 'https://www.sec.gov/files/company_tickers.json';
export const SEC_USER_AGENT = 'FolioTrack/1.0 (politician trade research; +https://foliotrack.onrender.com)';
export const CATALOG_VERSION = 1;
export const CATALOG_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
export const FUZZY_MIN_SIMILARITY = 0.94;
export const FUZZY_MIN_STEM = 12;
export const FUZZY_GAP = 0.04;

const TRAILING = new Set([
  'inc', 'incorporated', 'corp', 'corporation', 'co', 'company', 'companies',
  'ltd', 'limited', 'llc', 'plc', 'lp', 'llp', 'nv', 'sa', 'ag', 'se', 'spa',
  'com', 'new', 'del', 'de', 'md', 'mn', 'pa', 'fl', 'ca', 'wa', 'oh', 'tx',
  'ny', 'nj', 'va', 'nc', 'il', 'ma', 'ga', 'mi', 'wi', 'mo', 'az', 'or', 'ut',
  'tn', 'ky', 'la', 'al', 'ok', 'ct', 'ia', 'ks', 'ar', 'ms', 'sc', 'ne', 'nm',
  'wv', 'id', 'hi', 'me', 'nh', 'ri', 'mt', 'nd', 'sd', 'ak', 'wy', 'dc', 'usa',
]);

const WHEN_ISSUED_TAIL = new Set(['m', 'n', 'v', 'w', 'z']);

const MONTH = '(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*';

export function isExchangeTraded(value) {
  return /\betf\b/i.test(value) || /exchange[\s-]+traded/i.test(value);
}

export function isPrivateFund(value) {
  const text = String(value || '');
  return /\bprivate\s+(?:equity|fund|credit|investment)\b/i.test(text)
    || /\bhedge\s+fund\b/i.test(text);
}

// Debt before "call"/"put". A corporate note often says "Call" or "callable"
// for the call feature, and a percent coupon is a bond even when the word
// "note" was not read.
export function isDebtDescription(value) {
  const text = String(value || '');
  if (!text || isExchangeTraded(text)) return false;
  if (/\b(bonds?|notes?|debentures?|munis?|municipals?)\b/i.test(text)) return true;
  if (/\bcallable\b/i.test(text)) return true;
  if (/\b(?:u\.?\s*s\.?|united states)\s+treasur/i.test(text)) return true;
  if (/\btreasur(?:y|ies)\s+(?:bonds?|notes?|bills?|securit(?:y|ies))\b/i.test(text)) return true;
  if (/\bt-?(?:bills?|notes?|bonds?)\b/i.test(text)) return true;
  if (new RegExp(`\\bdue\\s+(?:\\d{1,2}[/\\-]\\d{1,2}[/\\-]\\d{2,4}|\\d{4}|${MONTH}\\.?\\s+\\d)`, 'i').test(text)) return true;
  if (/\b\d{1,2}(?:\.\d+)?\s*%/.test(text)) return true;
  return false;
}

export function isOptionDescription(value) {
  return /\b(calls?|puts?|options?)\b/i.test(String(value || ''));
}

export function classifyDescribedAsset(asset, { ticker = null } = {}) {
  const text = String(asset || '');
  if (isPrivateFund(text)) return 'other';
  if (isDebtDescription(text)) return 'bond';
  if (isOptionDescription(text)) return 'option';
  if (/\b(bitcoin|ethereum|crypto)\b/i.test(text)) return 'crypto';
  if (isExchangeTraded(text)) return 'etf';
  if (/\bfund\b/i.test(text)) return 'fund';
  if (ticker) return 'stock';
  return 'other';
}

export function shareClassFromTicker(ticker) {
  const m = String(ticker || '').match(/\.([A-Z])$/);
  return m ? m[1].toLowerCase() : '';
}

function suffixTypo(token) {
  if (token.length < 3 || token.length > 5) return false;
  // Real words one edit from a suffix ("core" / "corp") stay in the name.
  if (['core', 'come', 'copy', 'code', 'coin', 'cord', 'cold', 'coal', 'cook', 'cool', 'inch'].includes(token)) {
    return false;
  }
  return editDistance(token, 'inc') <= 1
    || editDistance(token, 'corp') <= 1
    || editDistance(token, 'ltd') <= 1
    || editDistance(token, 'llc') <= 1;
}

export function normalizeAssetName(raw) {
  const original = String(raw || '');
  let text = original
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/&/g, ' and ')
    .replace(/[’']/g, '')
    .toLowerCase();
  const looksEtf = isExchangeTraded(text);
  const looksFund = /\bfund\b/i.test(text);
  let shareClass = '';
  const classMatch = text.match(/\b(?:class|cl|series)\s+([a-c])\b/);
  if (classMatch) shareClass = classMatch[1];
  text = text.replace(/\b(?:class|cl|series)\s+[a-c]\b/g, ' ');
  text = text.replace(/[^a-z0-9]+/g, ' ');
  let tokens = text.split(/\s+/).filter(Boolean);
  if (tokens[0] === 'the') tokens.shift();
  let guard = 0;
  while (tokens.length > 1 && guard < 8) {
    guard += 1;
    const last = tokens[tokens.length - 1];
    if (TRAILING.has(last) || suffixTypo(last)) {
      tokens.pop();
      if (tokens[tokens.length - 1] === 'and') tokens.pop();
      continue;
    }
    break;
  }
  if (looksEtf || looksFund) {
    tokens = tokens.filter((token) => !['etf', 'fund', 'trust', 'shares', 'share', 'shs'].includes(token));
  } else {
    tokens = tokens.filter((token) => !['common', 'ordinary', 'stock', 'shares', 'share', 'shs'].includes(token));
  }
  return {
    stem: tokens.join(' ').trim(),
    shareClass,
    looksEtf,
    looksFund,
  };
}

function unique(values) {
  return [...new Set(values)];
}

function exchangeTier(exchange) {
  const text = String(exchange || '').trim().toLowerCase();
  if (!text) return 2;
  if (text === 'otc') return 3;
  if (text.includes('nasdaq') || text.includes('nyse') || text === 'cboe' || text === 'txse') return 1;
  return 2;
}

// SEC lists a when-issued print (METAM beside META, GOOGM beside GOOG) under
// the same company name. Drop a ticker that is another ticker for that name
// plus one when-issued letter. GOOGL stays, because L is not that suffix and
// it is a real class beside GOOG.
function dropWhenIssued(tickers) {
  const set = new Set(tickers);
  return tickers.filter((ticker) => {
    if (ticker.length < 2) return true;
    const extra = ticker[ticker.length - 1].toLowerCase();
    if (!WHEN_ISSUED_TAIL.has(extra)) return true;
    return !set.has(ticker.slice(0, -1));
  });
}

export function secRow(row) {
  if (Array.isArray(row)) {
    if (row.length >= 4 && typeof row[0] === 'number') {
      return { name: row[1] || '', ticker: row[2] || '', exchange: row[3] || '' };
    }
    return { name: row[0] || '', ticker: row[1] || '', exchange: row[2] || '' };
  }
  if (!row || typeof row !== 'object') return { name: '', ticker: '', exchange: '' };
  return {
    name: row.name || row.title || '',
    ticker: row.ticker || '',
    exchange: row.exchange || '',
  };
}

export function indexSecRows(rows) {
  const grouped = new Map();
  for (const raw of rows || []) {
    const row = secRow(raw);
    const ticker = canonicalTicker(row.ticker);
    if (!ticker) continue;
    const { stem, looksEtf, looksFund } = normalizeAssetName(row.name);
    if (!stem || stem.length < 2) continue;
    const assetClass = looksEtf ? 'etf' : looksFund ? 'fund' : 'stock';
    const list = grouped.get(stem) || [];
    list.push({
      ticker,
      exchange: row.exchange,
      shareClass: shareClassFromTicker(ticker),
      assetClass,
    });
    grouped.set(stem, list);
  }

  const exact = new Map();
  const classedStems = new Set();
  for (const [stem, list] of grouped) {
    const best = Math.min(...list.map((item) => exchangeTier(item.exchange)));
    const kept = list.filter((item) => exchangeTier(item.exchange) === best);
    const plain = [];
    const byClass = new Map();
    let assetClass = 'stock';
    for (const item of kept) {
      if (item.assetClass === 'etf') assetClass = 'etf';
      else if (item.assetClass === 'fund' && assetClass !== 'etf') assetClass = 'fund';
      if (!item.shareClass) plain.push(item.ticker);
      else {
        const arr = byClass.get(item.shareClass) || [];
        arr.push(item.ticker);
        byClass.set(item.shareClass, arr);
      }
    }
    const plainTickers = dropWhenIssued(unique(plain));
    if (plainTickers.length === 1) {
      exact.set(`${stem}|`, { ticker: plainTickers[0], assetClass, source: 'sec' });
    }
    for (const [shareClass, tickers] of byClass) {
      const uniq = unique(tickers);
      if (uniq.length !== 1) continue;
      exact.set(`${stem}|${shareClass}`, { ticker: uniq[0], assetClass, source: 'sec' });
      classedStems.add(stem);
      if (plainTickers.length === 0 && byClass.size === 1) {
        exact.set(`${stem}|`, { ticker: uniq[0], assetClass, source: 'sec' });
      }
    }
  }
  return { exact, classedStems };
}

function curatedExactMap(entries = CURATED_FUNDS) {
  const map = new Map();
  for (const [name, ticker, assetClass] of entries) {
    const canonical = canonicalTicker(ticker);
    const { stem } = normalizeAssetName(name);
    if (!canonical || !stem) continue;
    const prev = map.get(stem);
    if (prev && prev.ticker !== canonical) {
      map.set(stem, { ticker: null, assetClass, ambiguous: true });
      continue;
    }
    if (!prev) map.set(stem, { ticker: canonical, assetClass: assetClass || 'etf', source: 'curated' });
  }
  return map;
}

function fuzzyPool(exact) {
  const plain = [];
  const byClass = new Map();
  for (const [key, hit] of exact) {
    if (!hit?.ticker) continue;
    const split = key.lastIndexOf('|');
    const stem = key.slice(0, split);
    const shareClass = key.slice(split + 1);
    if (stem.length < 8) continue;
    const row = { stem, ticker: hit.ticker, assetClass: hit.assetClass, source: hit.source || 'sec' };
    if (!shareClass) plain.push(row);
    else {
      const list = byClass.get(shareClass) || [];
      list.push(row);
      byClass.set(shareClass, list);
    }
  }
  return { plain, byClass };
}

export function buildCatalog({ rows = [], fetchedAt = null, curated = CURATED_FUNDS } = {}) {
  const indexed = indexSecRows(rows);
  const curatedMap = curatedExactMap(curated);
  const fuzzy = fuzzyPool(indexed.exact);
  for (const [stem, hit] of curatedMap) {
    if (!hit?.ticker || stem.length < 8) continue;
    const existing = indexed.exact.get(`${stem}|`);
    if (existing?.ticker) continue;
    fuzzy.plain.push({ stem, ticker: hit.ticker, assetClass: hit.assetClass, source: 'curated' });
  }
  return {
    fetchedAt: fetchedAt || null,
    exact: indexed.exact,
    classedStems: indexed.classedStems,
    curated: curatedMap,
    fuzzyPlain: fuzzy.plain,
    fuzzyByClass: fuzzy.byClass,
  };
}

export function rowsFromSecPayload(payload) {
  if (!payload) return [];
  if (Array.isArray(payload.data) && Array.isArray(payload.fields)) {
    const nameAt = payload.fields.indexOf('name');
    const tickerAt = payload.fields.indexOf('ticker');
    const exchangeAt = payload.fields.indexOf('exchange');
    if (nameAt >= 0 && tickerAt >= 0) {
      return payload.data.map((row) => ({
        name: row[nameAt] || '',
        ticker: row[tickerAt] || '',
        exchange: exchangeAt >= 0 ? (row[exchangeAt] || '') : '',
      }));
    }
  }
  if (Array.isArray(payload)) return payload.map(secRow);
  if (typeof payload === 'object') {
    return Object.values(payload).map((row) => ({
      name: row?.title || row?.name || '',
      ticker: row?.ticker || '',
      exchange: row?.exchange || '',
    }));
  }
  return [];
}

function editDistance(a, b, maxDist = Infinity) {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > maxDist) return maxDist + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    const next = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const value = Math.min(prev[j] + 1, next[j - 1] + 1, prev[j - 1] + cost);
      next[j] = value;
      if (value < rowMin) rowMin = value;
    }
    if (rowMin > maxDist) return maxDist + 1;
    prev = next;
  }
  return prev[b.length];
}

function similarity(a, b) {
  const maxLen = Math.max(a.length, b.length);
  if (!maxLen) return 1;
  const maxDist = Math.floor((1 - FUZZY_MIN_SIMILARITY) * maxLen);
  const dist = editDistance(a, b, maxDist);
  if (dist > maxDist) return 0;
  return 1 - dist / maxLen;
}

function fuzzyPick(stem, pool) {
  if (!stem || stem.length < FUZZY_MIN_STEM) return null;
  const first = stem[0];
  const firstToken = stem.split(' ')[0] || '';
  let best = null;
  let second = 0;
  for (const row of pool) {
    if (row.stem[0] !== first) continue;
    if (Math.abs(row.stem.length - stem.length) > Math.ceil((1 - FUZZY_MIN_SIMILARITY) * Math.max(row.stem.length, stem.length)) + 1) {
      continue;
    }
    if (firstToken.length >= 4 && !row.stem.startsWith(`${firstToken} `) && row.stem !== firstToken) continue;
    const score = similarity(stem, row.stem);
    if (score < FUZZY_MIN_SIMILARITY) continue;
    if (!best || score > best.score) {
      second = best && best.ticker !== row.ticker ? best.score : second;
      best = { ...row, score };
    } else if (row.ticker !== best.ticker && score > second) {
      second = score;
    }
  }
  if (!best) return null;
  if (second >= best.score - FUZZY_GAP) return null;
  return best;
}

function exactHit(catalog, stem, shareClass) {
  if (!stem) return null;
  if (shareClass) {
    const keyed = catalog.exact.get(`${stem}|${shareClass}`);
    if (keyed?.ticker) return { ...keyed, reason: 'exact' };
    const plain = catalog.exact.get(`${stem}|`);
    if (plain?.ticker && !catalog.classedStems.has(stem)) return { ...plain, reason: 'exact' };
    return null;
  }
  const plain = catalog.exact.get(`${stem}|`);
  return plain?.ticker ? { ...plain, reason: 'exact' } : null;
}

export function matchAssetName(asset, catalog) {
  const described = classifyDescribedAsset(asset);
  if (described === 'bond') return { ticker: null, assetClass: 'bond', confidence: null, reason: 'debt' };
  if (described === 'option') return { ticker: null, assetClass: 'option', confidence: null, reason: 'option' };
  if (described === 'crypto') return { ticker: null, assetClass: 'crypto', confidence: null, reason: 'crypto' };
  if (isPrivateFund(asset)) return { ticker: null, assetClass: 'other', confidence: null, reason: 'private' };
  const norm = normalizeAssetName(asset);
  if (!catalog || !norm.stem) {
    return { ticker: null, assetClass: described, confidence: null, reason: 'none' };
  }
  const curated = catalog.curated?.get(norm.stem);
  if (curated?.ticker && !curated.ambiguous) {
    return {
      ticker: curated.ticker,
      assetClass: curated.assetClass || (norm.looksEtf ? 'etf' : 'fund'),
      confidence: 100,
      reason: 'curated',
    };
  }
  const exact = exactHit(catalog, norm.stem, norm.shareClass);
  if (exact) {
    const assetClass = norm.looksEtf ? 'etf' : norm.looksFund ? 'fund' : exact.assetClass;
    return { ticker: exact.ticker, assetClass, confidence: 100, reason: 'exact' };
  }
  // A class letter only fuzzy-matches that class. Falling through to the
  // unsuffixed ticker would undo the exact-match refusal when the company
  // has two listings (TAP and TAP.A, GOOG and GOOGL).
  const fuzzy = norm.shareClass
    ? fuzzyPick(norm.stem, catalog.fuzzyByClass?.get(norm.shareClass) || [])
    : fuzzyPick(norm.stem, catalog.fuzzyPlain || []);
  if (!fuzzy) return { ticker: null, assetClass: described, confidence: null, reason: 'none' };
  const assetClass = norm.looksEtf ? 'etf' : norm.looksFund ? 'fund' : fuzzy.assetClass;
  return {
    ticker: fuzzy.ticker,
    assetClass,
    confidence: Math.round(fuzzy.score * 100),
    reason: 'fuzzy',
  };
}

export function annotateTrade(trade, catalog) {
  if (!trade) return trade;
  if (trade.ticker || trade.tickerNorm) {
    const described = classifyDescribedAsset(trade.asset, { ticker: trade.ticker });
    return {
      ...trade,
      assetClass: trade.assetClass === 'option' && described === 'bond' ? 'bond' : trade.assetClass,
      tickerSource: trade.tickerSource || 'filing',
    };
  }
  const blocked = trade.assetClass === 'bond' || trade.assetClass === 'option' || trade.assetClass === 'crypto';
  if (blocked) {
    const described = classifyDescribedAsset(trade.asset);
    return {
      ...trade,
      assetClass: described === 'bond' ? 'bond' : trade.assetClass,
      ticker: null,
      tickerNorm: null,
      tickerSource: null,
      tickerMatchConfidence: null,
      nameMatchAt: catalog?.fetchedAt || trade.nameMatchAt || null,
    };
  }
  const match = matchAssetName(trade.asset, catalog);
  if (!match.ticker) {
    const replaceClass = match.reason === 'debt' || match.reason === 'option' || match.reason === 'crypto'
      || ((match.assetClass === 'etf' || match.assetClass === 'fund') && (!trade.assetClass || trade.assetClass === 'other'));
    return {
      ...trade,
      assetClass: replaceClass ? match.assetClass : trade.assetClass,
      ticker: null,
      tickerNorm: null,
      tickerSource: null,
      tickerMatchConfidence: null,
      nameMatchAt: catalog?.fetchedAt || trade.nameMatchAt || null,
    };
  }
  return {
    ...trade,
    ticker: match.ticker,
    tickerNorm: canonicalTicker(match.ticker),
    assetClass: match.assetClass,
    tickerSource: 'name_match',
    tickerMatchConfidence: match.confidence,
    nameMatchAt: catalog?.fetchedAt || null,
  };
}

export function planNameMatchUpdate(row, catalog) {
  const next = annotateTrade({
    ...row,
    ticker: null,
    tickerNorm: null,
    tickerSource: row.tickerSource === 'filing' ? 'filing' : null,
  }, catalog);
  return {
    id: row.id,
    ticker: next.tickerSource === 'name_match' ? next.ticker : null,
    tickerNorm: next.tickerSource === 'name_match' ? next.tickerNorm : null,
    assetClass: next.assetClass || row.assetClass,
    tickerSource: next.tickerSource === 'name_match' ? 'name_match' : null,
    tickerMatchConfidence: next.tickerSource === 'name_match' ? next.tickerMatchConfidence : null,
    nameMatchAt: next.nameMatchAt || catalog?.fetchedAt || null,
  };
}

function freshCatalog(doc, now) {
  if (!doc || doc.version !== CATALOG_VERSION || !Array.isArray(doc.rows) || !doc.fetchedAt) return false;
  const age = now.getTime() - Date.parse(doc.fetchedAt);
  return Number.isFinite(age) && age >= 0 && age < CATALOG_MAX_AGE_MS;
}

async function readJson(res) {
  const text = typeof res.text === 'function' ? await res.text() : '';
  return JSON.parse(text);
}

export async function fetchSecRows(fetchImpl = globalThis.fetch, { userAgent = SEC_USER_AGENT, timeoutMs = 20_000 } = {}) {
  const headers = { 'User-Agent': userAgent, Accept: 'application/json' };
  const init = {
    headers,
    signal: typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(timeoutMs) : undefined,
  };
  const exchange = await fetchImpl(SEC_EXCHANGE_URL, init);
  if (exchange?.ok) return rowsFromSecPayload(await readJson(exchange));
  const basic = await fetchImpl(SEC_TICKERS_URL, init);
  if (!basic?.ok) {
    const status = exchange?.status || basic?.status || 'no response';
    throw new Error(`SEC ticker list returned HTTP ${status}`);
  }
  return rowsFromSecPayload(await readJson(basic));
}

export async function loadTickerCatalog({
  store,
  fetchImpl = globalThis.fetch,
  now = new Date(),
  logger = console,
  userAgent = SEC_USER_AGENT,
} = {}) {
  const clock = now instanceof Date ? now : new Date(now);
  let cached = null;
  try {
    cached = typeof store?.getTickerNameCatalog === 'function' ? await store.getTickerNameCatalog() : null;
  } catch (err) {
    logger?.warn?.(`[name-match] catalog read failed: ${err.message}`);
  }
  if (freshCatalog(cached, clock)) return buildCatalog({ rows: cached.rows, fetchedAt: cached.fetchedAt });
  try {
    const rows = (await fetchSecRows(fetchImpl, { userAgent }))
      .map(secRow)
      .filter((row) => canonicalTicker(row.ticker));
    const doc = { version: CATALOG_VERSION, fetchedAt: clock.toISOString(), rows };
    if (typeof store?.saveTickerNameCatalog === 'function') {
      try { await store.saveTickerNameCatalog(doc); } catch (err) {
        logger?.warn?.(`[name-match] catalog save failed: ${err.message}`);
      }
    }
    return buildCatalog({ rows: doc.rows, fetchedAt: doc.fetchedAt });
  } catch (err) {
    logger?.warn?.(`[name-match] SEC catalog refresh failed: ${err.message}`);
    if (cached?.rows?.length) return buildCatalog({ rows: cached.rows, fetchedAt: cached.fetchedAt });
    return null;
  }
}

export async function backfillNullTickers({
  store,
  catalog,
  limit = 2000,
  maxBatches = 10,
  logger = null,
} = {}) {
  const empty = { examined: 0, matched: 0, updated: 0 };
  if (!catalog || typeof store?.listUnmatchedPoliticianTrades !== 'function') return empty;
  if (typeof store.applyPoliticianNameMatches !== 'function') return empty;
  let examined = 0;
  let matched = 0;
  let updated = 0;
  for (let batch = 0; batch < maxBatches; batch += 1) {
    const rows = await store.listUnmatchedPoliticianTrades({
      checkedBefore: catalog.fetchedAt,
      limit,
    });
    if (!rows?.length) break;
    const plans = rows
      .filter((row) => row && !row.ticker && !row.tickerNorm && row.tickerSource !== 'filing')
      .map((row) => planNameMatchUpdate(row, catalog));
    const result = await store.applyPoliticianNameMatches(plans);
    examined += rows.length;
    matched += result?.matched || 0;
    updated += result?.updated || 0;
    if (!result?.updated || rows.length < limit) break;
  }
  if (logger && examined) {
    logger.log(`[name-match] examined=${examined} matched=${matched} updated=${updated}`);
  }
  return { examined, matched, updated };
}
