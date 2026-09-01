// nav.test.js — batch NAV planning + JsonStore upsert/skip/cash-exclusion.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { JsonStore } from './store-json.js';
import { planNavBatch, isCashInstrument, isNavStale, listInUseManualInstruments } from './nav.js';

function inst(id, extra = {}) {
  return { id, symbol: id, name: id, type: 'mutualfund', source: 'manual', ...extra };
}

describe('planNavBatch', () => {
  const instrumentsById = new Map([
    ['inst_rbf', inst('inst_rbf', { symbol: 'RBF1005' })],
    ['inst_ocic', inst('inst_ocic', { symbol: 'OCIC', type: 'alt' })],
    ['inst_cash', inst('inst_cash', { symbol: 'CASH', type: 'cash' })],
    ['inst_cash2', inst('inst_cash2', { symbol: 'USD', type: 'cash' })],
  ]);

  it('skips missing and non-finite nav, writes the rest', () => {
    const { writes, error } = planNavBatch([
      { instrumentId: 'inst_rbf' },
      { instrumentId: 'inst_rbf', nav: '' },
      { instrumentId: 'inst_rbf', nav: 'nope' },
      { instrumentId: 'inst_ocic', nav: 9.5 },
    ], { asOf: '2026-09-01', instrumentsById });
    expect(error).toBeUndefined();
    expect(writes).toEqual([{ instrumentId: 'inst_ocic', date: '2026-09-01', nav: 9.5 }]);
  });

  it('rejects unknown instrument ids (after skipping empty nav)', () => {
    const { error } = planNavBatch([
      { instrumentId: 'ghost' },
      { instrumentId: 'nope', nav: 1 },
    ], { asOf: '2026-09-01', instrumentsById });
    expect(error).toMatch(/Unknown instrument id/);
    expect(error).toMatch(/nope/);
    expect(error).not.toMatch(/ghost/);
  });

  it('does not write cash by type or by symbol CASH', () => {
    const { writes } = planNavBatch([
      { instrumentId: 'inst_cash', nav: 1.05 },
      { instrumentId: 'inst_cash2', nav: 1.05 },
      { instrumentId: 'inst_rbf', nav: 47 },
    ], { asOf: '2026-09-01', instrumentsById });
    expect(writes).toEqual([{ instrumentId: 'inst_rbf', date: '2026-09-01', nav: 47 }]);
  });

  it('lets a per-point date override shared asOf; last write wins on the same key', () => {
    const { writes } = planNavBatch([
      { instrumentId: 'inst_rbf', nav: 47 },
      { instrumentId: 'inst_ocic', nav: 9.4, date: '2026-08-15' },
      { instrumentId: 'inst_rbf', nav: 48 },
    ], { asOf: '2026-09-01', instrumentsById });
    expect(writes).toEqual([
      { instrumentId: 'inst_rbf', date: '2026-09-01', nav: 48 },
      { instrumentId: 'inst_ocic', date: '2026-08-15', nav: 9.4 },
    ]);
  });
});

describe('isCashInstrument / isNavStale', () => {
  it('treats type cash or symbol CASH as cash', () => {
    expect(isCashInstrument({ type: 'cash', symbol: 'USD' })).toBe(true);
    expect(isCashInstrument({ type: 'alt', symbol: 'CASH' })).toBe(true);
    expect(isCashInstrument({ type: 'mutualfund', symbol: 'RBF1005' })).toBe(false);
  });

  it('uses calendar days, not trading days', () => {
    expect(isNavStale('etf', '2026-08-25', '2026-09-01')).toBe(false); // 7 days, not exceeded
    expect(isNavStale('etf', '2026-08-24', '2026-09-01')).toBe(true);  // 8
    expect(isNavStale('mutualfund', '2026-07-22', '2026-09-01')).toBe(true); // 41
    expect(isNavStale('mutualfund', '2026-07-23', '2026-09-01')).toBe(false); // 40
    expect(isNavStale('alt', '2026-05-23', '2026-09-01')).toBe(true); // 101
    expect(isNavStale('alt', '2026-05-24', '2026-09-01')).toBe(false); // 100
    expect(isNavStale('cash', '2020-01-01', '2026-09-01')).toBe(false);
    expect(isNavStale('etf', null, '2026-09-01')).toBe(false); // missing is not "stale"
  });
});

describe('JsonStore.addNavBatch + in-use list', () => {
  let dir;
  let store;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ft-nav-'));
    store = await new JsonStore(path.join(dir, 'store.json')).init();
  });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('upserts on (instrument, date) and returns latest per name written', async () => {
    const versionsBefore = (await store.getModel('conservative')).versions.length;
    const result = await store.addNavBatch({
      asOf: '2026-09-01',
      points: [
        { instrumentId: 'inst_rbf', nav: 47.1 },
        { instrumentId: 'inst_rbf', nav: 40, date: '2025-12-31' }, // overwrite seed point
      ],
    });
    expect((await store.getModel('conservative')).versions.length).toBe(versionsBefore);
    expect(await store.latestNav('inst_rbf')).toEqual({ date: '2026-09-01', nav: 47.1 });
    expect(result.latest).toEqual([{ instrumentId: 'inst_rbf', date: '2026-09-01', nav: 47.1 }]);
    const onDec = (await store.getNavSeries('inst_rbf')).find((p) => p.date === '2025-12-31');
    expect(onDec.nav).toBe(40);
  });

  it('returns the existing later latest when the write is an older date', async () => {
    const result = await store.addNavBatch({
      points: [{ instrumentId: 'inst_rbf', nav: 41, date: '2025-03-01' }],
    });
    expect(result.latest).toEqual([{ instrumentId: 'inst_rbf', date: '2025-12-31', nav: 46.32 }]);
  });

  it('skips empty nav, rejects unknown ids, and does not write cash', async () => {
    const ocic = await store.latestNav('inst_ocic');
    await store.addNavBatch({
      asOf: '2026-09-01',
      points: [
        { instrumentId: 'inst_ocic' },
        { instrumentId: 'inst_rbf', nav: 50 },
      ],
    });
    expect(await store.latestNav('inst_ocic')).toEqual(ocic);
    expect((await store.latestNav('inst_rbf')).nav).toBe(50);

    await expect(store.addNavBatch({
      asOf: '2026-09-01',
      points: [{ instrumentId: 'nope', nav: 1 }],
    })).rejects.toThrow(/Unknown instrument id/);

    const cash = await store.addInstrument({ symbol: 'CASH', name: 'Cash', type: 'cash', source: 'manual', currency: 'CAD' });
    const empty = await store.addNavBatch({
      asOf: '2026-09-01',
      points: [{ instrumentId: cash.id, nav: 1.05 }],
    });
    expect(empty.latest).toEqual([]);
    expect(await store.getNavSeries(cash.id)).toEqual([]);
  });

  it('lists unique in-use manuals with model names, excludes cash and old versions', async () => {
    const listed = await listInUseManualInstruments(store);
    expect(listed.map((x) => x.symbol).sort()).toEqual(['CVC-EU', 'OCIC', 'RBF1005']);
    const rbf = listed.find((x) => x.symbol === 'RBF1005');
    expect(rbf.latestNav).toBe(46.32);
    expect(rbf.latestDate).toBe('2025-12-31');
    expect(rbf.models.map((m) => m.key).sort()).toEqual(['balanced', 'conservative']);

    const cash = await store.addInstrument({ symbol: 'CASH', name: 'Cash', type: 'cash', source: 'manual', currency: 'CAD' });
    const ghost = await store.addInstrument({ symbol: 'GHOST', name: 'Ghost fund', type: 'mutualfund', source: 'manual', currency: 'CAD' });
    await store.addNav(ghost.id, { date: '2025-06-01', nav: 10 });
    await store.addVersion('balanced-growth', {
      effectiveDate: '2025-01-01', note: 'had ghost',
      holdings: [{ instrumentId: ghost.id, weight: 1 }],
    });
    await store.addVersion('balanced-growth', {
      effectiveDate: '2025-06-01', note: 'dropped ghost, added cash',
      holdings: [{ instrumentId: 'inst_vfv', weight: 0.9 }, { instrumentId: cash.id, weight: 0.1 }],
    });

    const after = await listInUseManualInstruments(store);
    expect(after.find((x) => x.symbol === 'GHOST')).toBeUndefined();
    expect(after.find((x) => x.symbol === 'CASH')).toBeUndefined();
    expect(after.find((x) => x.symbol === 'RBF1005')).toBeTruthy();
  });
});
