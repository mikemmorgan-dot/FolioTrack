// JSON-store implementation of the politician tables. Production uses the
// SQL in pgStore.js. Feed reads are filtered and paged here so a dev file
// is not copied wholesale into a response either.

import { currentVersionOf } from '../util.js';
import { canonicalTicker, matchableAssetClass } from './normalize.js';
import {
  OCR_CLAIM_MS,
  PENDING_OCR_NOTE,
  claimFresh,
  filingNeedsPresidentialOcr,
} from './ocrPending.js';
import { applyPoliticianAlertPatch, coercePoliticianAlertSettings } from './settings.js';

export const FEED_LIMIT_DEFAULT = 40;
export const FEED_LIMIT_MAX = 50;
export const FEED_OFFSET_MAX = 2000;

export function politicianBucket(db) {
  if (!db.politicianFilings) db.politicianFilings = {};
  if (!Array.isArray(db.politicianTrades)) db.politicianTrades = [];
  if (!db.politicianPoll || typeof db.politicianPoll !== 'object') db.politicianPoll = {};
  return db;
}

export function filingId(source, filingKey) {
  return `${source}:${filingKey}`;
}

function dayOk(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

export function normalizeFeedQuery(query = {}) {
  const limitRaw = Number(query.limit);
  const limit = Number.isFinite(limitRaw)
    ? Math.min(FEED_LIMIT_MAX, Math.max(1, Math.round(limitRaw)))
    : FEED_LIMIT_DEFAULT;
  const offsetRaw = Number(query.offset);
  const offset = Number.isFinite(offsetRaw)
    ? Math.min(FEED_OFFSET_MAX, Math.max(0, Math.round(offsetRaw)))
    : 0;
  const office = ['house', 'senate', 'president', 'vice-president'].includes(query.office) ? query.office : '';
  const party = ['D', 'R', 'I'].includes(query.party) ? query.party : '';
  const side = ['buy', 'sell', 'exchange'].includes(query.side) ? query.side : '';
  const q = String(query.q || '').trim().slice(0, 80);
  const ticker = canonicalTicker(query.ticker);
  const from = dayOk(query.from) ? query.from : '';
  const to = dayOk(query.to) ? query.to : '';
  const personKey = String(query.personKey || '').trim().slice(0, 120);
  const heldOnly = query.heldOnly === true || query.heldOnly === '1';
  const filer = query.filer === 'member' || query.filer === 'candidate' ? query.filer : '';
  return { limit, offset, office, party, side, q, ticker, from, to, personKey, heldOnly, filer };
}

function officeOk(rowOffice, filter) {
  if (!filter) return true;
  if (filter === 'president') return rowOffice === 'president' || rowOffice === 'vice-president';
  return rowOffice === filter;
}

export function filterFeedRows(rows, query, heldNorms = null) {
  const q = query.q.toLowerCase();
  const held = heldNorms instanceof Set ? heldNorms : null;
  return rows.filter((row) => {
    if (!officeOk(row.office, query.office)) return false;
    if (query.party && row.party !== query.party) return false;
    if (query.filer === 'candidate' && row.filerStatus !== 'candidate') return false;
    if (query.filer === 'member' && row.filerStatus === 'candidate') return false;
    if (query.personKey && row.personKey !== query.personKey) return false;
    if (query.from && (!row.disclosedDate || row.disclosedDate < query.from)) return false;
    if (query.to && (!row.disclosedDate || row.disclosedDate > query.to)) return false;
    if (query.side && row.txType !== query.side) return false;
    if (query.ticker && row.tickerNorm !== query.ticker) return false;
    if (query.heldOnly || held) {
      if (row.kind !== 'trade') return false;
      if (!matchableAssetClass(row.assetClass)) return false;
      if (held && !held.has(row.tickerNorm)) return false;
    }
    if (q) {
      const hay = `${row.personName || ''} ${row.ticker || ''} ${row.asset || ''}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

function compareFeed(a, b) {
  const ad = a.disclosedDate || '';
  const bd = b.disclosedDate || '';
  if (ad !== bd) return ad < bd ? 1 : -1;
  return String(a.id) < String(b.id) ? 1 : String(a.id) > String(b.id) ? -1 : 0;
}

export function pageFeed(rows, query) {
  const sorted = [...rows].sort(compareFeed);
  const slice = sorted.slice(query.offset, query.offset + query.limit);
  return {
    items: slice,
    offset: query.offset,
    limit: query.limit,
    total: sorted.length,
    hasMore: query.offset + slice.length < sorted.length,
  };
}

export function heldSymbolsFromDb(db) {
  const out = [];
  for (const model of Object.values(db.models || {})) {
    const version = currentVersionOf(model);
    if (!version) continue;
    for (const holding of version.holdings || []) {
      const inst = db.instruments?.[holding.instrumentId];
      if (!inst?.symbol) continue;
      out.push({
        symbol: inst.symbol,
        tickerNorm: canonicalTicker(inst.symbol),
        modelKey: model.key,
        modelName: model.name,
      });
    }
  }
  return out;
}

function feedRows(db) {
  const reviews = Object.values(db.politicianFilings)
    .filter((f) => f.parseStatus === 'needs_manual_review' || f.parseStatus === 'partial')
    .map((f) => ({
      kind: 'review',
      id: f.id,
      personKey: f.personKey,
      personName: f.personName,
      office: f.office,
      party: f.party || null,
      filerStatus: f.filerStatus || null,
      state: f.state || null,
      owner: null,
      ticker: null,
      tickerNorm: null,
      asset: null,
      assetClass: null,
      txType: null,
      partial: false,
      txDate: null,
      disclosedDate: f.filedDate || null,
      lagDays: null,
      amountRange: null,
      sourceUrl: f.sourceUrl,
      parseNote: f.parseNote || null,
    }));
  const trades = db.politicianTrades.map((t) => {
    const { digestPending, ...rest } = t;
    return { kind: 'trade', ...rest };
  });
  return [...trades, ...reviews];
}

export const memoryMethods = {
  async getPoliticianAlertSettings() {
    return coercePoliticianAlertSettings(this.db.politicianAlertSettings || {});
  },
  async savePoliticianAlertSettings(patch) {
    const next = applyPoliticianAlertPatch(this.db.politicianAlertSettings || {}, patch);
    this.db.politicianAlertSettings = next;
    this.persist();
    return next;
  },
  async getPoliticianPollState() {
    return this.db.politicianPoll || {};
  },
  async setPoliticianPollState(state) {
    this.db.politicianPoll = state || {};
    this.persist();
    return this.db.politicianPoll;
  },
  async getPoliticianRoster() {
    return this.db.politicianRoster || null;
  },
  async setPoliticianRoster(roster) {
    this.db.politicianRoster = roster;
    this.persist();
    return roster;
  },
  async existingPoliticianKeys(source, keys) {
    const want = new Set(keys || []);
    const found = [];
    for (const key of want) {
      if (this.db.politicianFilings[filingId(source, key)]) found.push(key);
    }
    return found;
  },
  async insertPoliticianBundle(filing, trades = []) {
    politicianBucket(this.db);
    const id = filing.id || filingId(filing.source, filing.filingKey);
    if (this.db.politicianFilings[id]) return { created: false, trades: 0 };
    this.db.politicianFilings[id] = { ...filing, id };
    for (const trade of trades) this.db.politicianTrades.push(trade);
    this.persist();
    return { created: true, trades: trades.length };
  },
  async getPoliticianFilings(source, keys) {
    const want = new Set(keys || []);
    return [...want].map((key) => this.db.politicianFilings[filingId(source, key)]).filter(Boolean);
  },
  async updatePoliticianFiling(filing, { protectClaim = false, nowMs = Date.now() } = {}) {
    const row = this.db.politicianFilings[filing.id];
    if (!row) return null;
    if (protectClaim && claimFresh(row, nowMs)) return { skipped: true };
    Object.assign(row, filing);
    this.persist();
    return row;
  },
  async claimPoliticianOcr(filing, { force = false, now = new Date(), staleMs = OCR_CLAIM_MS } = {}) {
    const id = filing.id || filingId(filing.source, filing.filingKey);
    const nowMs = now instanceof Date ? now.getTime() : Date.parse(now);
    const stamp = new Date(nowMs).toISOString();
    const existing = this.db.politicianFilings[id];
    const claimable = !existing || force || filingNeedsPresidentialOcr(
      { ...existing, ocrClaimedAt: existing.ocrClaimedAt },
      nowMs,
    ) || (existing.ocrDone !== true && existing.parseStatus !== 'ocr_running');
    if (existing && !claimable) return { claimed: false, id };
    const row = existing || { ...filing, id };
    row.parseStatus = 'ocr_running';
    row.parseNote = 'OCR in progress';
    row.ocrDone = false;
    row.ocrClaimedAt = stamp;
    this.db.politicianFilings[id] = row;
    this.persist();
    return { claimed: true, id, created: !existing };
  },
  async releasePoliticianOcrClaim(id) {
    const row = this.db.politicianFilings[id];
    if (!row || row.parseStatus !== 'ocr_running') return false;
    row.parseStatus = 'pending_ocr';
    row.parseNote = PENDING_OCR_NOTE;
    row.ocrDone = false;
    row.ocrClaimedAt = null;
    this.persist();
    return true;
  },
  async listPendingPresidentialFilings({ limit = 20, now = new Date() } = {}) {
    const nowMs = now instanceof Date ? now.getTime() : Date.parse(now);
    return Object.values(this.db.politicianFilings)
      .filter((row) => filingNeedsPresidentialOcr(row, nowMs))
      .sort((a, b) => String(b.filedDate || '').localeCompare(String(a.filedDate || ''))
        || String(a.filingKey).localeCompare(String(b.filingKey)))
      .slice(0, limit);
  },
  async getPresidentialFiling(filingKey) {
    return this.db.politicianFilings[filingId('oge', filingKey)] || null;
  },
  async listDigestPendingTrades(limit = 80) {
    return (this.db.politicianTrades || [])
      .filter((trade) => trade.digestPending === true)
      .sort((a, b) => String(b.disclosedDate || '').localeCompare(String(a.disclosedDate || ''))
        || String(b.id).localeCompare(String(a.id)))
      .slice(0, limit)
      .map((trade) => ({ ...trade }));
  },
  async clearDigestPending(ids = []) {
    const want = new Set(ids || []);
    if (!want.size) return 0;
    let cleared = 0;
    for (const trade of this.db.politicianTrades || []) {
      if (want.has(trade.id) && trade.digestPending) {
        trade.digestPending = false;
        cleared += 1;
      }
    }
    if (cleared) this.persist();
    return cleared;
  },
  async insertPoliticianTrades(trades = []) {
    const have = new Set((this.db.politicianTrades || []).map((t) => t.id));
    let inserted = 0;
    for (const trade of trades) {
      if (have.has(trade.id)) continue;
      this.db.politicianTrades.push(trade);
      have.add(trade.id);
      inserted += 1;
    }
    if (inserted) this.persist();
    return { inserted };
  },
  async listPoliticianFeed(query = {}) {
    const q = normalizeFeedQuery(query);
    const held = q.heldOnly ? new Set(heldSymbolsFromDb(this.db).map((h) => h.tickerNorm).filter(Boolean)) : null;
    return pageFeed(filterFeedRows(feedRows(politicianBucket(this.db)), q, held), q);
  },
  async getPolitician(personKey, query = {}) {
    const db = politicianBucket(this.db);
    const trades = db.politicianTrades.filter((t) => t.personKey === personKey);
    const filing = Object.values(db.politicianFilings).find((f) => f.personKey === personKey);
    if (!trades.length && !filing) return null;
    const sample = trades[0] || filing;
    const dated = [
      ...trades.map((t) => ({ status: t.filerStatus, date: t.disclosedDate || '' })),
      ...(filing ? [{ status: filing.filerStatus, date: filing.filedDate || '' }] : []),
    ].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
    const filerStatus = dated.find((row) => row.status)?.status || null;
    const counts = { buy: 0, sell: 0, exchange: 0, trades: trades.length };
    const byTicker = new Map();
    for (const trade of trades) {
      if (trade.txType === 'buy' || trade.txType === 'sell' || trade.txType === 'exchange') {
        counts[trade.txType] += 1;
      }
      if (!trade.ticker) continue;
      byTicker.set(trade.ticker, (byTicker.get(trade.ticker) || 0) + 1);
    }
    const topTickers = [...byTicker.entries()]
      .map(([ticker, count]) => ({ ticker, count }))
      .sort((a, b) => b.count - a.count || a.ticker.localeCompare(b.ticker))
      .slice(0, 8);
    const q = normalizeFeedQuery({ ...query, personKey });
    const held = q.heldOnly
      ? new Set(heldSymbolsFromDb(this.db).map((h) => h.tickerNorm).filter(Boolean))
      : null;
    const feed = pageFeed(filterFeedRows(feedRows(db), q, held), q);
    return {
      person: {
        personKey,
        personName: sample.personName,
        office: sample.office,
        party: sample.party || null,
        filerStatus,
        state: sample.state || null,
      },
      counts,
      topTickers,
      ...feed,
    };
  },
  async listHeldPoliticianSymbols() {
    return heldSymbolsFromDb(this.db);
  },
  async summarizeHeldTrades(norms) {
    const want = new Set((norms || []).filter(Boolean));
    const acc = new Map();
    for (const trade of this.db.politicianTrades || []) {
      if (!want.has(trade.tickerNorm)) continue;
      if (!matchableAssetClass(trade.assetClass)) continue;
      const cur = acc.get(trade.tickerNorm) || { count: 0, latest: null };
      cur.count += 1;
      if (trade.disclosedDate && (!cur.latest || trade.disclosedDate > cur.latest)) cur.latest = trade.disclosedDate;
      acc.set(trade.tickerNorm, cur);
    }
    return [...acc.entries()].map(([tickerNorm, row]) => ({ tickerNorm, ...row }));
  },
};

export function installMemoryPolitician(Store) {
  for (const [name, fn] of Object.entries(memoryMethods)) {
    Store.prototype[name] = function memoryPoliticianMethod(...args) {
      const db = politicianBucket(this.db);
      return fn.apply({ db, persist: () => this._persist() }, args);
    };
  }
}
