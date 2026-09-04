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
