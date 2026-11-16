// Chart payload for one person's current annual filing. Percentages use the
// per-row estimate (midpoint, or the floor when the range is open). They are
// estimates because the filing printed a range.

import { formatUsd, sumHoldingValues, totalValueLabel } from './assetValue.js';
import { holdingClassLabel, holdingMatchable } from './holdingClass.js';
import { isReadableAnnual, selectCurrentAnnual } from './annualRecords.js';

const TOP_N = 12;
// A tie a little past the top 12 can still be named one by one. A larger tie
// becomes one slice so the legend stays readable and the bucket is not split.
const NAMED_CAP = 16;

function pctOf(part, total) {
  if (!total) return 0;
  return (part / total) * 100;
}

function round1(value) {
  return Math.round(value * 10) / 10;
}

function withPercents(slices, totalMid) {
  if (!slices.length || !totalMid) return slices.map((slice) => ({ ...slice, pct: 0 }));
  const raw = slices.map((slice) => pctOf(slice.midpoint, totalMid));
  const rounded = raw.map(round1);
  const drift = round1(100 - rounded.reduce((sum, n) => sum + n, 0));
  if (drift && rounded.length) {
    let index = 0;
    for (let i = 1; i < rounded.length; i += 1) {
      if (rounded[i] > rounded[index]) index = i;
    }
    rounded[index] = round1(rounded[index] + drift);
  }
  return slices.map((slice, i) => ({ ...slice, pct: rounded[i] }));
}

function positionSlice(row, index) {
  return {
    id: row.id || `p-${index}`,
    kind: 'position',
    label: row.ticker || row.asset,
    asset: row.asset,
    ticker: row.ticker || null,
    tickerNorm: row.tickerNorm || null,
    tickerSource: row.tickerSource || null,
    assetClass: row.assetClass || 'other',
    owner: row.owner || 'unknown',
    valueRange: row.valueRange,
    valueBound: row.valueBound,
    min: row.valueMin,
    max: row.valueMax,
    midpoint: row.valueMid,
    count: 1,
    heldModels: row.heldModels || [],
  };
}

function compactUsd(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '';
  const abs = Math.abs(n);
  const sign = n < 0 ? '-' : '';
  if (abs >= 1_000_000) {
    const millions = abs / 1_000_000;
    const shown = Math.abs(millions - Math.round(millions)) < 0.05
      ? String(Math.round(millions))
      : millions.toFixed(1);
    return `${sign}$${shown}M`;
  }
  if (abs >= 1_000) {
    const thousands = abs / 1_000;
    const shown = Math.abs(thousands - Math.round(thousands)) < 0.05
      ? String(Math.round(thousands))
      : thousands.toFixed(1);
    return `${sign}$${shown}K`;
  }
  return formatUsd(n) || '';
}

function bucketKey(row) {
  return [
    row.valueRange || '',
    row.valueBound || '',
    row.valueMin ?? '',
    row.valueMax ?? '',
    Number(row.valueMid) || 0,
  ].join('|');
}

function shortHoldingName(asset) {
  const text = String(asset || '').replace(/\s+/g, ' ').trim();
  const cut = text.split(/\s+(?:Location|Underlying|See [Ll]ine|U\.?S\.?\s*bank account)\b/i)[0].replace(/[*,.:]+$/g, '').trim();
  const base = cut || text || 'Holding';
  if (base.length <= 72) return base;
  return `${base.slice(0, 69).trim()}...`;
}

function bucketLabel(rows) {
  const sample = rows[0] || {};
  const n = rows.length;
  const noun = n === 1 ? 'holding' : 'holdings';
  const open = sample.valueBound === 'at_least' || sample.valueMax == null;
  const band = open
    ? `Over ${compactUsd(sample.valueMin)}`
    : `${compactUsd(sample.valueMin)}-${compactUsd(sample.valueMax)}`;
  return `${band} each (${n} ${noun})`;
}

function groupedSlice(rows, kind, label) {
  const totals = sumHoldingValues(rows);
  return {
    id: kind === 'other' ? 'other' : `bucket-${bucketKey(rows[0] || {})}`,
    kind,
    label,
    asset: label,
    ticker: null,
    tickerNorm: null,
    tickerSource: null,
    assetClass: null,
    owner: null,
    valueRange: totalValueLabel(totals),
    valueBound: totals.openEnded ? 'at_least' : 'range',
    min: totals.min,
    max: totals.max,
    midpoint: totals.midpoint,
    count: rows.length,
    names: kind === 'bucket' && rows.length <= 40 ? rows.map((row) => shortHoldingName(row.asset || row.ticker)) : [],
  };
}

function otherSlice(rows) {
  const n = rows.length;
  return groupedSlice(rows, 'other', `All other holdings (${n})`);
}

function bucketSlice(rows) {
  return groupedSlice(rows, 'bucket', bucketLabel(rows));
}

// Named slices are the largest positions. A statutory value bucket is never
// split between a named slice and Other: a short tie is named in full, and a
// long tie (the 25 "Over $50,000,000" rows) is one labeled slice.
export function positionSlices(rows, limit = TOP_N) {
  const sorted = (rows || []).slice().sort((a, b) => (
    (b.valueMid || 0) - (a.valueMid || 0)
    || String(a.asset || '').localeCompare(String(b.asset || ''))
  ));
  const groups = [];
  for (const row of sorted) {
    const key = bucketKey(row);
    const last = groups[groups.length - 1];
    if (last && last.key === key) last.rows.push(row);
    else groups.push({ key, rows: [row] });
  }
  const slices = [];
  let index = 0;
  for (; index < groups.length; index += 1) {
    if (slices.length >= limit) break;
    const group = groups[index].rows;
    const room = limit - slices.length;
    if (group.length <= room || slices.length + group.length <= NAMED_CAP) {
      for (const row of group) slices.push(positionSlice(row, slices.length));
      if (slices.length > limit) {
        index += 1;
        break;
      }
      continue;
    }
    slices.push(bucketSlice(group));
  }
  const rest = groups.slice(index).flatMap((group) => group.rows);
  if (rest.length) slices.push(otherSlice(rest));
  const totalMid = (rows || []).reduce((sum, row) => sum + (Number(row.valueMid) || 0), 0);
  return withPercents(slices, totalMid);
}

export function classSlices(rows) {
  const groups = new Map();
  for (const row of rows || []) {
    const key = row.assetClass || 'other';
    const bucket = groups.get(key) || [];
    bucket.push(row);
    groups.set(key, bucket);
  }
  const slices = [...groups.entries()]
    .map(([key, list]) => {
      const totals = sumHoldingValues(list);
      const held = list.filter((row) => row.heldModels?.length);
      return {
        id: `class-${key}`,
        kind: 'class',
        label: holdingClassLabel(key),
        asset: `${list.length} position${list.length === 1 ? '' : 's'}`,
        ticker: null,
        tickerNorm: null,
        tickerSource: null,
        assetClass: key,
        owner: null,
        valueRange: totalValueLabel(totals),
        valueBound: totals.openEnded ? 'at_least' : 'range',
        min: totals.min,
        max: totals.max,
        midpoint: totals.midpoint,
        count: list.length,
        heldCount: held.length,
      };
    })
    .sort((a, b) => b.midpoint - a.midpoint || a.label.localeCompare(b.label));
  const totalMid = slices.reduce((sum, slice) => sum + slice.midpoint, 0);
  return withPercents(slices, totalMid);
}

function filingMeta(filing) {
  if (!filing) return null;
  return {
    id: filing.id,
    year: filing.reportYear || null,
    filedDate: filing.filedDate || null,
    sourceUrl: filing.sourceUrl || null,
    kind: filing.filingKind || 'original',
    parseStatus: filing.parseStatus,
    note: filing.parseNote || null,
    excludedCount: Number(filing.excludedCount) || 0,
    unreadableCount: Number(filing.unreadableCount) || 0,
  };
}

function withHeld(rows, held) {
  return (rows || []).map((row) => ({
    ...row,
    heldModels: holdingMatchable(row.assetClass) && row.tickerNorm && held
      ? (held.get(row.tickerNorm) || [])
      : [],
  }));
}

export function presentHoldings({ filings = [], holdings = [], held = null } = {}) {
  const { current, newerUnreadable } = selectCurrentAnnual(filings);
  if (!current) {
    return {
      status: 'none',
      note: null,
      filing: null,
      newerUnreadable: null,
      totals: null,
      positions: [],
      classes: [],
    };
  }
  const filing = filingMeta(current);
  const newer = newerUnreadable ? filingMeta(newerUnreadable) : null;
  if (!isReadableAnnual(current)) {
    const status = current.parseStatus === 'pending_ocr' ? 'pending_ocr' : 'unreadable';
    return {
      status,
      note: current.parseNote || 'This annual report could not be read. No holdings were guessed.',
      filing,
      newerUnreadable: newer,
      totals: null,
      positions: [],
      classes: [],
    };
  }
  const rows = withHeld(holdings.filter((row) => row.filingId === current.id), held);
  const totals = sumHoldingValues(rows);
  const noteBits = [];
  if (current.parseNote) noteBits.push(current.parseNote);
  if (newer) {
    noteBits.push(`A later ${newer.year || ''} filing could not be read, so these holdings are the earlier version of that year.`.replace('  ', ' '));
  }
  return {
    status: current.parseStatus,
    note: noteBits.filter(Boolean).join(' ') || null,
    filing,
    newerUnreadable: newer,
    totals: {
      ...totals,
      label: totalValueLabel(totals),
      midpointLabel: formatUsd(totals.midpoint),
    },
    positions: positionSlices(rows),
    classes: classSlices(rows),
  };
}
