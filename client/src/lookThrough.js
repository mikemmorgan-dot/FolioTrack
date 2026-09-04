// lookThrough.js — honesty helpers for fund look-through.
// Geo/Sector must not look more precise than the factsheet data behind it.

export function hasLookThrough(h) {
  return (Array.isArray(h?.sectorBreakdown) && h.sectorBreakdown.length > 0)
    || (Array.isArray(h?.countryBreakdown) && h.countryBreakdown.length > 0);
}

export function isFundType(type) {
  return type === 'etf' || type === 'mutualfund';
}

const AS_OF_RE = /^\d{4}-\d{2}-\d{2}$/;

export function factsheetAsOf(h) {
  const s = String(h?.breakdownAsOf || '').slice(0, 10);
  return AS_OF_RE.test(s) ? s : null;
}

// Holdings chip: dated look-through vs incomplete (breakdown without as-of).
export function lookThroughChip(h) {
  if (!hasLookThrough(h)) return '';
  const asOf = factsheetAsOf(h);
  return asOf ? `look-through · ${asOf}` : 'look-through incomplete';
}

// Coverage of a model's holdings for the Geo/Sector banner.
// `issues` is true when a fund/ETF is still single-bucket or a look-through
// holding has no factsheet as-of — those are the nags. Stocks/alts/cash
// without a breakdown are expected single-bucket and do not set issues.
export function lookThroughCoverage(holdings) {
  const list = holdings || [];
  const totalWeight = list.reduce((s, h) => s + (Number(h.weight) || 0), 0);
  let lookThroughWeight = 0;
  let singleBucketCount = 0;
  const missingAsOf = [];
  const missingFundBreakdown = [];
  const asOfDates = [];

  for (const h of list) {
    if (hasLookThrough(h)) {
      lookThroughWeight += Number(h.weight) || 0;
      const asOf = factsheetAsOf(h);
      if (asOf) asOfDates.push(asOf);
      else missingAsOf.push(h);
    } else {
      singleBucketCount += 1;
      if (isFundType(h.type)) missingFundBreakdown.push(h);
    }
  }

  return {
    lookThroughPct: totalWeight > 0 ? lookThroughWeight / totalWeight : 0,
    singleBucketCount,
    oldestAsOf: asOfDates.length ? [...asOfDates].sort()[0] : null,
    missingAsOf,
    missingFundBreakdown,
    issues: missingAsOf.length > 0 || missingFundBreakdown.length > 0,
  };
}
