// Statutory value buckets on annual financial disclosures.
// A midpoint is the arithmetic center of a closed range, rounded to the
// nearest dollar. "Over $50,000,000" has no ceiling: the estimate is the
// printed floor and the row is marked at least. Anything else is not a value.

import { AMOUNT_RANGES, canonicalAmountRange } from './normalize.js';

const OVER_50M = 50_000_000;

function dollars(token) {
  const n = Number(String(token).replace(/[$,\s]/g, ''));
  return Number.isFinite(n) ? n : null;
}

export function parseAssetValue(raw) {
  const text = String(raw ?? '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
  if (!text) return { kind: 'unreadable' };
  if (/^(none|n\/?a|not disclosed|undisclosed|undetermined|exempt|spouse exempt|value not reported)\b/i.test(text) || text === '--' || text === '-' || text === '—') {
    return { kind: 'excluded', reason: /^none/i.test(text) ? 'none' : 'not_disclosed' };
  }
  // Some House annuals print the below-threshold bucket as $1 - $1,000
  // instead of "None". It is a closed range, not a guess.
  const small = text.match(/^\$?\s*1\s*[-–—]\s*\$?\s*1,000$/);
  if (small) {
    return { kind: 'range', min: 1, max: 1000, mid: 501, label: '$1 - $1,000' };
  }
  const over = text.match(/^over\s+\$?\s*([\d,]+)\b/i);
  if (over) {
    if (dollars(over[1]) !== OVER_50M) return { kind: 'unreadable' };
    return {
      kind: 'at_least',
      min: OVER_50M,
      max: null,
      mid: OVER_50M,
      label: 'Over $50,000,000',
    };
  }
  const label = canonicalAmountRange(text);
  if (!label) return { kind: 'unreadable' };
  const hit = AMOUNT_RANGES.find((row) => row[2] === label);
  if (!hit) return { kind: 'unreadable' };
  const [min, max] = hit;
  return {
    kind: 'range',
    min,
    max,
    mid: Math.round((min + max) / 2),
    label,
  };
}

export function formatUsd(value) {
  if (value == null || !Number.isFinite(Number(value))) return null;
  return `$${Math.round(Number(value)).toLocaleString('en-US')}`;
}

export function rangeLabel(row) {
  if (!row) return null;
  if (row.valueBound === 'at_least' || row.kind === 'at_least') {
    const floor = row.valueMin ?? row.min;
    return floor == null ? 'At least' : `At least ${formatUsd(floor)}`;
  }
  return row.valueRange || row.label || null;
}

// Sum of the printed floors through sum of the printed ceilings.
// One open-ended row means the total has no ceiling.
export function sumHoldingValues(rows) {
  let min = 0;
  let max = 0;
  let midpoint = 0;
  let openEnded = false;
  let count = 0;
  for (const row of rows || []) {
    const lo = Number(row.valueMin ?? row.min);
    const mid = Number(row.valueMid ?? row.mid);
    const hi = row.valueMax ?? row.max;
    if (!Number.isFinite(lo) || !Number.isFinite(mid)) continue;
    count += 1;
    min += lo;
    midpoint += mid;
    if (hi == null || row.valueBound === 'at_least' || row.kind === 'at_least') openEnded = true;
    else max += Number(hi);
  }
  return {
    count,
    min,
    max: openEnded ? null : max,
    midpoint,
    openEnded,
  };
}

export function totalValueLabel(totals) {
  if (!totals || !totals.count) return null;
  if (totals.openEnded) return `At least ${formatUsd(totals.min)}`;
  return `${formatUsd(totals.min)} – ${formatUsd(totals.max)}`;
}
