// compare.js — current-version compare payload for all models.
//
// Overlap (weight in common): for two models A and B,
//   intersectionWeight(A, B) = Σ_t min(w_A[t], w_B[t])
// over instruments t with a positive weight in both. That is the shared
// sleeve at the lesser weight — two books that both hold 20% VFV contribute
// 20%, not 40%. Unique weight is the sum of a model's weights in tickers
// that no other current model holds; shared weight is the rest of its book.
// Zero-weight rows are ignored. MER is the same weight-average of known
// instrument MERs the Overview hero already uses (null when none known).

export function blendedMer(holdings) {
  let w = 0;
  let sum = 0;
  for (const h of holdings || []) {
    if (!(h.weight > 0) || h.mer == null) continue;
    const mer = Number(h.mer);
    if (!Number.isFinite(mer)) continue;
    sum += h.weight * mer;
    w += h.weight;
  }
  return w > 0 ? sum / w : null;
}

export function merKnownWeight(holdings) {
  let known = 0;
  let total = 0;
  for (const h of holdings || []) {
    if (!(h.weight > 0)) continue;
    total += h.weight;
    if (h.mer != null && Number.isFinite(Number(h.mer))) known += h.weight;
  }
  return total > 0 ? known / total : 0;
}

export function weightByInstrument(holdings) {
  const map = new Map();
  for (const h of holdings || []) {
    if (!h?.id || !(h.weight > 0)) continue;
    map.set(h.id, (map.get(h.id) || 0) + h.weight);
  }
  return map;
}

export function intersectionWeight(mapA, mapB) {
  let s = 0;
  for (const [id, w] of mapA) {
    const other = mapB.get(id);
    if (other) s += Math.min(w, other);
  }
  return s;
}

export function sharedTickerCount(mapA, mapB) {
  let n = 0;
  for (const id of mapA.keys()) if (mapB.has(id)) n += 1;
  return n;
}

export function fixedIncomeWeight(holdings) {
  let w = 0;
  for (const h of holdings || []) {
    if (h.weight > 0 && h.sector === 'Fixed Income') w += h.weight;
  }
  return w;
}

const SHORT_NAMES = {
  Conservative: 'Cons',
  Balanced: 'Bal',
  'Balanced Growth': 'Bal Gr',
  Growth: 'Gro',
  'Aggressive Growth': 'Agg',
};

function shortName(name) {
  if (SHORT_NAMES[name]) return SHORT_NAMES[name];
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '';
  if (parts.length === 1) return parts[0].slice(0, 4);
  return parts.map((p) => p.slice(0, 3)).join(' ');
}

function positiveHoldings(holdings) {
  return (holdings || []).filter((h) => h?.id && h.weight > 0);
}

function holdingWeight(map, id) {
  return map.get(id) || 0;
}

export function buildCompare(snapshots) {
  const models = [...(snapshots || [])].sort((a, b) => (a.riskRank ?? 0) - (b.riskRank ?? 0));
  const maps = models.map((m) => weightByInstrument(m.holdings));

  const holdersById = new Map();
  for (let i = 0; i < models.length; i++) {
    for (const id of maps[i].keys()) {
      if (!holdersById.has(id)) holdersById.set(id, []);
      holdersById.get(id).push(models[i].key);
    }
  }

  const modelRows = models.map((m, i) => {
    const holdings = positiveHoldings(m.holdings);
    let uniqueWeight = 0;
    let sharedWeight = 0;
    for (const h of holdings) {
      const n = holdersById.get(h.id)?.length || 1;
      if (n <= 1) uniqueWeight += h.weight;
      else sharedWeight += h.weight;
    }
    const neighbors = [];
    if (i > 0) {
      neighbors.push({
        key: models[i - 1].key,
        name: models[i - 1].name,
        intersectionWeight: intersectionWeight(maps[i], maps[i - 1]),
      });
    }
    if (i < models.length - 1) {
      neighbors.push({
        key: models[i + 1].key,
        name: models[i + 1].name,
        intersectionWeight: intersectionWeight(maps[i], maps[i + 1]),
      });
    }
    return {
      key: m.key,
      name: m.name,
      shortName: shortName(m.name),
      riskRank: m.riskRank,
      versionCount: m.versionCount ?? m.versions?.length ?? 0,
      versionId: m.currentVersion?.id ?? null,
      effectiveDate: m.currentVersion?.effectiveDate ?? null,
      holdingCount: holdings.length,
      blendedMer: blendedMer(m.holdings),
      merKnownWeight: merKnownWeight(m.holdings),
      fixedIncomeWeight: fixedIncomeWeight(m.holdings),
      uniqueWeight,
      sharedWeight,
      neighbors,
      holdings: holdings
        .map((h) => ({
          id: h.id,
          symbol: h.symbol,
          name: h.name,
          type: h.type,
          sector: h.sector ?? null,
          mer: h.mer ?? null,
          weight: h.weight,
        }))
        .sort((a, b) => b.weight - a.weight || a.symbol.localeCompare(b.symbol)),
    };
  });

  const metaById = new Map();
  for (const m of models) {
    for (const h of positiveHoldings(m.holdings)) {
      if (!metaById.has(h.id)) {
        metaById.set(h.id, { id: h.id, symbol: h.symbol, name: h.name, type: h.type });
      }
    }
  }

  const universe = [...metaById.values()].map((meta) => {
    const weights = {};
    let maxWeight = 0;
    for (let i = 0; i < models.length; i++) {
      const w = holdingWeight(maps[i], meta.id);
      weights[models[i].key] = w > 0 ? w : null;
      if (w > maxWeight) maxWeight = w;
    }
    const modelCount = holdersById.get(meta.id)?.length || 0;
    return { ...meta, modelCount, maxWeight, weights };
  }).sort((a, b) => (
    b.modelCount - a.modelCount
    || b.maxWeight - a.maxWeight
    || a.symbol.localeCompare(b.symbol)
  ));

  const pairs = [];
  for (let i = 0; i < models.length; i++) {
    for (let j = i + 1; j < models.length; j++) {
      pairs.push({
        a: models[i].key,
        b: models[j].key,
        adjacent: j === i + 1,
        intersectionWeight: intersectionWeight(maps[i], maps[j]),
        sharedTickers: sharedTickerCount(maps[i], maps[j]),
      });
    }
  }

  return { models: modelRows, universe, pairs };
}
