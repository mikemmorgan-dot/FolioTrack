// enrich.js — attach instrument records + prices onto a version's holdings.
//
// Live quotes are optional. GET /api/models/:key uses cache-only so the
// current version (weights, names, version number) can paint without waiting
// on the provider chain. A follow-up quotes request fills prices in.

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
    let price = null, priceAsOf = null, priceSource = inst.source;
    try {
      if (inst.source === 'auto') {
        if (liveQuotes) {
          const q = await quotes.cachedQuote(inst.symbol);
          price = q.price; priceAsOf = q.asOf;
        } else {
          const q = quotes.peek(inst.symbol);
          if (q) { price = q.price; priceAsOf = q.asOf; }
        }
      } else {
        const nav = await store.latestNav(inst.id);
        price = nav?.nav ?? null; priceAsOf = nav?.date ?? null;
      }
    } catch (e) {
      priceSource = `${inst.source} (error: ${e.message})`;
    }
    return { ...inst, weight: holding.weight, price, priceAsOf, priceSource };
  }));
}

export function quotePatch(holdings) {
  return holdings.map((h) => ({
    id: h.id,
    price: h.price,
    priceAsOf: h.priceAsOf,
    priceSource: h.priceSource,
  }));
}
