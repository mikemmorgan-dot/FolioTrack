// Chart payload for one person's current annual filing. Percentages use the
// per-row estimate (midpoint, or the floor when the range is open). They are
// estimates because the filing printed a range.

import { formatUsd, sumHoldingValues, totalValueLabel } from './assetValue.js';
import { holdingClassLabel, holdingMatchable } from './holdingClass.js';
import { isReadableAnnual, selectCurrentAnnual } from './annualRecords.js';

const TOP_N = 12;

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

function otherSlice(rows) {
  const totals = sumHoldingValues(rows);
  return {
    id: 'other',
    kind: 'other',
    label: 'Other',
    asset: `${rows.length} other position${rows.length === 1 ? '' : 's'}`,
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
  };
}

export function positionSlices(rows, limit = TOP_N) {
  const sorted = (rows || []).slice().sort((a, b) => (
    (b.valueMid || 0) - (a.valueMid || 0)
    || String(a.asset || '').localeCompare(String(b.asset || ''))
  ));
  const top = sorted.slice(0, limit).map(positionSlice);
  const rest = sorted.slice(limit);
  const slices = rest.length ? [...top, otherSlice(rest)] : top;
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
