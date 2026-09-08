// store-json.test.js — look-through as-of/note persist and clear-on-empty.
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { JsonStore } from './store-json.js';

const files = [];
function tmpStore() {
  const file = path.join(os.tmpdir(), `foliotrack-lt-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  files.push(file);
  return new JsonStore(file).init();
}
afterEach(() => {
  for (const f of files) try { fs.unlinkSync(f); } catch { /* already gone */ }
  files.length = 0;
});

const ROWS = [{ label: 'Information Technology', weight: 35 }];

describe('JsonStore look-through metadata', () => {
  it('saves as-of and note with a breakdown, then clears both when rows are emptied', async () => {
    const store = await tmpStore();
    const saved = await store.updateInstrument('inst_vfv', {
      sectorBreakdown: ROWS,
      countryBreakdown: null,
      breakdownAsOf: '2026-06-30',
      breakdownNote: 'VFV factsheet Aug 2026',
    });
    expect(saved.sectorBreakdown).toEqual(ROWS);
    expect(saved.breakdownAsOf).toBe('2026-06-30');
    expect(saved.breakdownNote).toBe('VFV factsheet Aug 2026');
    expect(saved.breakdownUpdatedAt).toBeTruthy();

    const cleared = await store.updateInstrument('inst_vfv', {
      sectorBreakdown: null,
      countryBreakdown: null,
    });
    expect(cleared.sectorBreakdown).toBeNull();
    expect(cleared.countryBreakdown).toBeNull();
    expect(cleared.breakdownAsOf).toBeNull();
    expect(cleared.breakdownNote).toBeNull();
  });

  it('rejects a breakdown save without as-of', async () => {
    const store = await tmpStore();
    await expect(store.updateInstrument('inst_vfv', {
      sectorBreakdown: ROWS,
    })).rejects.toMatchObject({ status: 400 });
  });
});

describe('JsonStore published manufacturer returns', () => {
  it('persists publishedReturns without inventing a NAV series', async () => {
    const store = await tmpStore();
    const pub = {
      kind: 'published',
      y1: 0.5464,
      y3ann: 0.4428,
      asOf: '2026-08-31',
      source: 'FundPulse · Fidelity Canada',
      series: 'F',
      calendarYears: [{ year: 2025, value: 0.2135 }],
    };
    const saved = await store.updateInstrument('inst_rbf', { publishedReturns: pub });
    expect(saved.publishedReturns.y1).toBeCloseTo(0.5464, 5);
    expect(saved.publishedReturns.series).toBe('F');
    expect(await store.getNavSeries('inst_rbf')).toHaveLength(3);
    const cleared = await store.updateInstrument('inst_rbf', { publishedReturns: null });
    expect(cleared.publishedReturns).toBeNull();
  });
});

describe('JsonStore navSource + Yahoo apply', () => {
  it('labels an applied Yahoo series without dropping merge-by-date points', async () => {
    const store = await tmpStore();
    await store.addNav('inst_ry', { date: '2026-09-04', nav: 178.2 });
    const result = await store.addNavBatch({
      navSource: 'Yahoo Finance',
      points: [
        { instrumentId: 'inst_ry', date: '2024-01-02', nav: 128 },
        { instrumentId: 'inst_ry', date: '2026-09-04', nav: 180 },
      ],
    });
    const series = await store.getNavSeries('inst_ry');
    expect(series).toHaveLength(2);
    expect(series.find((p) => p.date === '2026-09-04').nav).toBe(180);
    expect(result.latest[0].nav).toBe(180);
    const inst = await store.getInstrument('inst_ry');
    expect(inst.navSource).toBe('Yahoo Finance');
    expect(inst.source).toBe('manual');
  });
});

describe('JsonStore price history', () => {
  it('persists and reads a series keyed by symbol', async () => {
    const store = await tmpStore();
    expect(await store.getPriceHistory('CRWD')).toBeNull();
    const series = [
      { date: '2024-01-02', close: 100 },
      { date: '2025-09-01', close: 220 },
    ];
    const saved = await store.putPriceHistory('crwd', {
      series, provider: 'yahoo', range: 'max', fetchedAt: '2026-09-04T12:00:00.000Z',
    });
    expect(saved.symbol).toBe('CRWD');
    const hit = await store.getPriceHistory('CRWD');
    expect(hit.series).toEqual(series);
    expect(hit.provider).toBe('yahoo');
    expect(hit.fetchedAt).toBe('2026-09-04T12:00:00.000Z');
  });
});
