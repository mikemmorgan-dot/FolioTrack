import { describe, it, expect } from 'vitest';
import {
  firstAddedToModel,
  filterSeriesByRange,
  periodReturnFromSeries,
  rangeBounds,
} from './holdingHistory.js';

const versions = [
  {
    id: 'v1', effectiveDate: '2025-01-01', createdAt: '2025-01-01T00:00:00Z',
    holdings: [{ instrumentId: 'inst_vfv', weight: 0.2 }, { instrumentId: 'inst_xbb', weight: 0.8 }],
  },
  {
    id: 'v2', effectiveDate: '2025-07-01', createdAt: '2025-07-01T00:00:00Z',
    holdings: [{ instrumentId: 'inst_vfv', weight: 0.3 }, { instrumentId: 'inst_enb', weight: 0.1 }, { instrumentId: 'inst_xbb', weight: 0.6 }],
  },
];

describe('firstAddedToModel', () => {
  it('uses the earliest version that includes the instrument', () => {
    expect(firstAddedToModel(versions, 'inst_vfv')).toEqual({ addedAt: '2025-01-01', versionId: 'v1' });
    expect(firstAddedToModel(versions, 'inst_enb')).toEqual({ addedAt: '2025-07-01', versionId: 'v2' });
  });

  it('keeps the first appearance even if the holding is later removed', () => {
    const dropped = [
      ...versions,
      { id: 'v3', effectiveDate: '2026-01-01', holdings: [{ instrumentId: 'inst_xbb', weight: 1 }] },
    ];
    expect(firstAddedToModel(dropped, 'inst_vfv').addedAt).toBe('2025-01-01');
  });

  it('returns null when the instrument never appears', () => {
    expect(firstAddedToModel(versions, 'inst_missing')).toBeNull();
    expect(firstAddedToModel([], 'inst_vfv')).toBeNull();
  });
});

const series = [
  { date: '2024-06-01', price: 80 },
  { date: '2024-12-31', price: 90 },
  { date: '2025-01-02', price: 100 },
  { date: '2025-07-01', price: 110 },
  { date: '2026-01-01', price: 121 },
];

describe('filterSeriesByRange', () => {
  it('returns the full series for full / missing mode', () => {
    expect(filterSeriesByRange(series, { mode: 'full' })).toHaveLength(5);
    expect(filterSeriesByRange(series, {})).toHaveLength(5);
  });

  it('since-added keeps the last close on or before the add date, then later points', () => {
    const sliced = filterSeriesByRange(series, { mode: 'since-added', addedAt: '2025-01-01' });
    expect(sliced.map((p) => p.date)).toEqual(['2024-12-31', '2025-01-02', '2025-07-01', '2026-01-01']);
  });

  it('does not duplicate a point that lands exactly on the add date', () => {
    const sliced = filterSeriesByRange(series, { mode: 'since-added', addedAt: '2025-07-01' });
    expect(sliced[0]).toEqual({ date: '2025-01-02', price: 100 });
    expect(sliced.map((p) => p.date)).toEqual(['2025-01-02', '2025-07-01', '2026-01-01']);
  });
});

describe('periodReturnFromSeries', () => {
  it('is last/first − 1 over the visible points', () => {
    const sliced = filterSeriesByRange(series, { mode: 'since-added', addedAt: '2025-01-01' });
    expect(periodReturnFromSeries(sliced)).toBeCloseTo(121 / 90 - 1, 9);
    expect(periodReturnFromSeries(series)).toBeCloseTo(121 / 80 - 1, 9);
    expect(periodReturnFromSeries(series.slice(0, 1))).toBeNull();
  });

  it('reports range bounds for the visible series', () => {
    expect(rangeBounds(series)).toEqual({ from: '2024-06-01', to: '2026-01-01' });
    expect(rangeBounds([])).toEqual({ from: null, to: null });
  });
});
