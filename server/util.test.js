// util.test.js — see perf.test.js's header note on verification method.
import { describe, it, expect } from 'vitest';
import { holdingsEqual, normalizeAsOf, normalizeNote, nextBreakdownFields, instrumentFromSpec } from './util.js';

describe('holdingsEqual', () => {
  it('is order-independent', () => {
    const a = [{ instrumentId: 'A', weight: 0.5 }, { instrumentId: 'B', weight: 0.5 }];
    const b = [{ instrumentId: 'B', weight: 0.5 }, { instrumentId: 'A', weight: 0.5 }];
    expect(holdingsEqual(a, b)).toBe(true);
  });

  it('rejects a real weight change', () => {
    expect(holdingsEqual([{ instrumentId: 'A', weight: 0.5 }], [{ instrumentId: 'A', weight: 0.51 }])).toBe(false);
  });

  it('rejects a different holding set of the same length', () => {
    const a = [{ instrumentId: 'A', weight: 0.55 }, { instrumentId: 'C', weight: 0.05 }];
    const b = [{ instrumentId: 'A', weight: 0.55 }, { instrumentId: 'B', weight: 0.05 }];
    expect(holdingsEqual(a, b)).toBe(false);
  });

  it('treats two empty lists as equal', () => {
    expect(holdingsEqual([], [])).toBe(true);
  });
});

describe('normalizeAsOf', () => {
  it('accepts YYYY-MM-DD', () => {
    expect(normalizeAsOf('2026-06-30')).toBe('2026-06-30');
  });
  it('trims and slices a datetime', () => {
    expect(normalizeAsOf(' 2026-06-30T12:00:00Z ')).toBe('2026-06-30');
  });
  it('rejects empty and invalid', () => {
    expect(normalizeAsOf('')).toBeNull();
    expect(normalizeAsOf(null)).toBeNull();
    expect(normalizeAsOf('June 2026')).toBeNull();
    expect(normalizeAsOf('2026-6-30')).toBeNull();
  });
});

describe('normalizeNote', () => {
  it('trims and rejects empty to null', () => {
    expect(normalizeNote('  VFV factsheet Aug 2026  ')).toBe('VFV factsheet Aug 2026');
    expect(normalizeNote('   ')).toBeNull();
    expect(normalizeNote('')).toBeNull();
    expect(normalizeNote(null)).toBeNull();
  });
  it('caps length', () => {
    expect(normalizeNote('x'.repeat(250)).length).toBe(200);
  });
});

const ROWS = [{ label: 'Information Technology', weight: 35 }];
const DATED = {
  sectorBreakdown: ROWS,
  countryBreakdown: null,
  breakdownAsOf: '2026-06-30',
  breakdownNote: 'VFV factsheet Aug 2026',
};

describe('nextBreakdownFields', () => {
  it('persists as-of and note with breakdown rows', () => {
    const next = nextBreakdownFields({}, {
      sectorBreakdown: ROWS,
      breakdownAsOf: '2026-06-30',
      breakdownNote: '  estimate — verify against factsheet  ',
    });
    expect(next.sectorBreakdown).toEqual(ROWS);
    expect(next.breakdownAsOf).toBe('2026-06-30');
    expect(next.breakdownNote).toBe('estimate — verify against factsheet');
    expect(next.rowsTouched).toBe(true);
  });

  it('clears as-of and note when both breakdowns are emptied', () => {
    const next = nextBreakdownFields(DATED, {
      sectorBreakdown: [],
      countryBreakdown: null,
    });
    expect(next.sectorBreakdown).toBeNull();
    expect(next.countryBreakdown).toBeNull();
    expect(next.breakdownAsOf).toBeNull();
    expect(next.breakdownNote).toBeNull();
  });

  it('keeps as-of when one breakdown remains', () => {
    const current = {
      ...DATED,
      countryBreakdown: [{ label: 'United States', weight: 100 }],
    };
    const next = nextBreakdownFields(current, { sectorBreakdown: null });
    expect(next.sectorBreakdown).toBeNull();
    expect(next.countryBreakdown).toEqual([{ label: 'United States', weight: 100 }]);
    expect(next.breakdownAsOf).toBe('2026-06-30');
    expect(next.breakdownNote).toBe('VFV factsheet Aug 2026');
  });

  it('throws 400 when saving rows without an as-of', () => {
    expect(() => nextBreakdownFields({}, { sectorBreakdown: ROWS })).toThrow(/as-of/);
    let err;
    try { nextBreakdownFields({}, { sectorBreakdown: ROWS, breakdownAsOf: '' }); } catch (e) { err = e; }
    expect(err).toMatchObject({ status: 400 });
  });

  it('lets an as-of-only patch date existing rows without bumping rowsTouched', () => {
    const next = nextBreakdownFields(
      { sectorBreakdown: ROWS, breakdownAsOf: null, breakdownNote: null },
      { breakdownAsOf: '2025-12-31' },
    );
    expect(next.breakdownAsOf).toBe('2025-12-31');
    expect(next.sectorBreakdown).toEqual(ROWS);
    expect(next.rowsTouched).toBe(false);
  });

  it('clears as-of and note when no breakdown remains, even if the patch sends them', () => {
    const next = nextBreakdownFields({}, { breakdownAsOf: '2026-06-30', breakdownNote: 'stale' });
    expect(next.breakdownAsOf).toBeNull();
    expect(next.breakdownNote).toBeNull();
  });
});

describe('instrumentFromSpec look-through fields', () => {
  it('serializes as-of and note the same way as breakdowns', () => {
    const s = instrumentFromSpec({
      symbol: 'VFV.TO',
      sectorBreakdown: ROWS,
      breakdownAsOf: '2026-06-30',
      breakdownNote: '  VFV factsheet Aug 2026  ',
    });
    expect(s.breakdownAsOf).toBe('2026-06-30');
    expect(s.breakdownNote).toBe('VFV factsheet Aug 2026');
  });
});
