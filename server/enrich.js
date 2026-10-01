// enrich.js — attach instrument records + prices onto a version's holdings.
//
// Live quotes are optional. GET /api/models/:key uses cache-only so the
// current version (weights, names, version number) can paint without waiting
// on the provider chain. A follow-up quotes request fills prices in.
//
// Non-empty nav_series wins over source=auto: a user-entered NAV is the
// price, even if the instrument is still flagged auto (TSX provider miss).
import { quoteFieldsFromLatestNav } from './navPrice.js';
import { metadataPatchFromQuote } from './metadataRefresh.js';

export function createQuoteCache({ getQuote, ttlMs = 60_000 } = {}) {
  const cache = new Map();
  const inflight = new Map();

  function peek(symbol) {
    const hit = cache.get(symbol);
    if (hit && Date.now() - hit.t < ttlMs) return hit.v;
    return null;
  }

  async function cachedQuote(symbol) {
    const fresh = peek(symbol);
    if (fresh) return fresh;
    if (inflight.has(symbol)) return inflight.get(symbol);
    const p = Promise.resolve()
      .then(() => getQuote(symbol))
      .then((v) => {
        cache.set(symbol, { t: Date.now(), v });
        return v;
      })
      .finally(() => inflight.delete(symbol));
    inflight.set(symbol, p);
    return p;
  }

  return { peek, cachedQuote, cache };
}

export async function enrichHoldings(version, store, quotes, { liveQuotes = false } = {}) {
  if (!version) return [];
  const rows = [];
  for (const h of version.holdings) {
    const inst = await store.getInstrument(h.instrumentId);
    if (!inst) continue;
    rows.push({ holding: h, inst });
  }

  return Promise.all(rows.map(async ({ holding, inst }) => {
    let row = inst;
    let price = null, priceAsOf = null, priceSource = inst.source;
    let metadataUpdated = false;
    try {
      const fromNav = quoteFieldsFromLatestNav(await store.latestNav(inst.id), inst.navSource);
      if (fromNav) {
        ({ price, priceAsOf, priceSource } = fromNav);
      } else if (inst.source === 'auto') {
        if (liveQuotes) {
          const q = await quotes.cachedQuote(inst.symbol);
          price = q.price; priceAsOf = q.asOf;
          const refreshed = await applyQuoteMetadata(store, inst, q);
          if (refreshed) {
            row = refreshed.inst;
            metadataUpdated = refreshed.updated;
          }
        } else {
          const q = quotes.peek(inst.symbol);
          if (q) { price = q.price; priceAsOf = q.asOf; }
        }
      }
    } catch (e) {
      priceSource = `${inst.source} (error: ${e.message})`;
    }
    const out = { ...row, weight: holding.weight, price, priceAsOf, priceSource };
    if (metadataUpdated) out.metadataUpdated = true;
    return out;
  }));
}

async function applyQuoteMetadata(store, inst, quote) {
  const patch = metadataPatchFromQuote(inst, quote);
  if (!patch) return null;
  let next = { ...inst, ...patch };
  if (typeof store.updateInstrument === 'function') {
    try {
      const saved = await store.updateInstrument(inst.id, patch);
      if (saved) {
        next = {
          ...inst,
          ...saved,
          name: saved.name ?? patch.name ?? inst.name,
          sector: patch.sector !== undefined ? saved.sector : inst.sector,
          country: patch.country !== undefined ? saved.country : inst.country,
          meta: saved.meta ?? patch.meta,
        };
      }
    } catch {
      // The quote still stands if the metadata write fails.
    }
  }
  return { inst: next, updated: true };
}

export function quotePatch(holdings) {
  return holdings.map((h) => {
    const row = {
      id: h.id,
      price: h.price,
      priceAsOf: h.priceAsOf,
      priceSource: h.priceSource,
    };
    if (h.metadataUpdated) {
      row.metadataUpdated = true;
      row.name = h.name;
      row.sector = h.sector ?? null;
      row.country = h.country ?? null;
    }
    return row;
  });
}
