import { describe, it, expect } from 'vitest';
import {
  addDaysISO,
  drawdownRatio,
  resolveDrawdown,
  collectCurrentHoldings,
  evaluateHolding,
  isPriceStale,
  WEEKS_52_DAYS,
} from './drawdown.js';

const TODAY = '2026-09-01';

describe('drawdown ratio', () => {
  it('is current / reference − 1', () => {
    expect(drawdownRatio(76.6, 100)).toBeCloseTo(-0.234, 10);
    expect(drawdownRatio(140, 200)).toBeCloseTo(-0.3, 10);
    expect(drawdownRatio(200, 200)).toBe(0);
  });

  it('returns null when a price is missing or not positive', () => {
    expect(drawdownRatio(null, 100)).toBeNull();
    expect(drawdownRatio(10, 0)).toBeNull();
    expect(drawdownRatio(-1, 10)).toBeNull();
  });
});

describe('52-week peak from cached closes', () => {
  it('uses the highest close inside the trailing 52 weeks and ignores older highs', () => {
    const latest = '2026-09-01';
    const cutoff = addDaysISO(latest, -WEEKS_52_DAYS);
    const resolved = resolveDrawdown({
      today: TODAY,
      historySeries: [
        { date: '2024-01-01', close: 500 },
        { date: addDaysISO(cutoff, -1), close: 400 },
        { date: cutoff, close: 180 },
        { date: '2026-01-15', close: 200 },
        { date: '2026-06-01', close: 150 },
        { date: latest, close: 140 },
      ],
    });
    expect(resolved.basis).toBe('52w');
    expect(resolved.covers52w).toBe(true);
    expect(resolved.referencePrice).toBe(200);
    expect(resolved.referenceDate).toBe('2026-01-15');
    expect(resolved.currentPrice).toBe(140);
    expect(resolved.priceAsOf).toBe(latest);
    expect(resolved.drawdown).toBeCloseTo(-0.3, 10);
    expect(resolved.basisLabel).toBe('from 52-week high, using cached closes as of 2026-09-01');
    expect(resolved.stale).toBe(false);
  });

  it('breaks a tie toward the later date', () => {
    const resolved = resolveDrawdown({
      today: TODAY,
      historySeries: [
        { date: '2026-02-01', close: 200 },
        { date: '2026-03-01', close: 200 },
        { date: '2026-09-01', close: 150 },
      ],
    });
    expect(resolved.referenceDate).toBe('2026-03-01');
    expect(resolved.referencePrice).toBe(200);
  });

  it('does not claim a 52-week high when the cache is shorter', () => {
    const resolved = resolveDrawdown({
      today: TODAY,
      historySeries: [
        { date: '2026-08-01', close: 110 },
        { date: '2026-09-01', close: 90 },
      ],
    });
    expect(resolved.covers52w).toBe(false);
    expect(resolved.referencePrice).toBe(110);
    expect(resolved.basisLabel).toContain('shorter than 52 weeks');
    expect(resolved.basisLabel).toContain('as of 2026-09-01');
  });

  it('falls back to the saved NAV series peak when history is unavailable', () => {
    const resolved = resolveDrawdown({
      today: TODAY,
      historySeries: [],
      navSeries: [
        { date: '2024-01-02', nav: 80 },
        { date: '2025-06-30', nav: 120 },
        { date: '2026-08-01', nav: 90 },
      ],
    });
    expect(resolved.basis).toBe('nav');
    expect(resolved.referencePrice).toBe(120);
    expect(resolved.referenceDate).toBe('2025-06-30');
    expect(resolved.currentPrice).toBe(90);
    expect(resolved.drawdown).toBeCloseTo(90 / 120 - 1, 10);
    expect(resolved.basisLabel).toBe('from saved NAV series peak, using NAV as of 2026-08-01');
  });

  it('prefers cached closes over a higher NAV peak when both exist', () => {
    const resolved = resolveDrawdown({
      today: TODAY,
      historySeries: [
        { date: '2026-01-15', close: 50 },
        { date: '2026-09-01', close: 40 },
      ],
      navSeries: [{ date: '2026-09-01', nav: 10 }, { date: '2025-01-01', nav: 999 }],
    });
    expect(resolved.basis).toBe('52w');
    expect(resolved.referencePrice).toBe(50);
    expect(resolved.currentPrice).toBe(40);
  });

  it('returns null when there is no price', () => {
    expect(resolveDrawdown({ today: TODAY, historySeries: [], navSeries: [] })).toBeNull();
    expect(resolveDrawdown({ today: TODAY, historySeries: [{ date: 'bad', close: 1 }] })).toBeNull();
  });
});

describe('stale prices', () => {
  it('flags an as-of date older than 5 days', () => {
    expect(isPriceStale('2026-09-26', '2026-10-01')).toBe(false);
    expect(isPriceStale('2026-09-25', '2026-10-01')).toBe(true);
    const resolved = resolveDrawdown({
      today: '2026-10-01',
      historySeries: [
        { date: '2026-01-01', close: 100 },
        { date: '2026-08-01', close: 70 },
      ],
    });
    expect(resolved.stale).toBe(true);
    expect(resolved.priceAsOf).toBe('2026-08-01');
  });
});

describe('dedupe current holdings', () => {
  const models = [
    {
      key: 'growth',
      name: 'Growth',
      versions: [
        { effectiveDate: '2019-01-01', holdings: [{ instrumentId: 'inst_old', weight: 1 }] },
        { effectiveDate: '2024-06-01', holdings: [{ instrumentId: 'inst_nvda', weight: 0.2 }, { instrumentId: 'inst_cash', weight: 0.05 }] },
      ],
    },
    {
      key: 'aggressive',
      name: 'Aggressive',
      versions: [
        { effectiveDate: '2024-06-01', holdings: [{ instrumentId: 'inst_nvda', weight: 0.4 }] },
      ],
    },
  ];

  it('keeps one row per instrument and lists every current model that holds it', () => {
    const rows = collectCurrentHoldings(models);
    const nvda = rows.find((r) => r.instrumentId === 'inst_nvda');
    expect(rows.filter((r) => r.instrumentId === 'inst_nvda')).toHaveLength(1);
    expect(nvda.models.map((m) => m.name).sort()).toEqual(['Aggressive', 'Growth']);
    expect(rows.some((r) => r.instrumentId === 'inst_old')).toBe(false);
  });

  it('skips cash and holdings with no price, and prices an alt from its NAV peak', () => {
    const cash = evaluateHolding({
      inst: { id: 'inst_cash', symbol: 'CASH', name: 'Cash', type: 'cash' },
      models: [{ key: 'growth', name: 'Growth' }],
      historySeries: [{ date: '2026-09-01', close: 1 }],
      navSeries: [],
      today: TODAY,
    });
    expect(cash.skip).toBe('cash');

    const empty = evaluateHolding({
      inst: { id: 'inst_x', symbol: 'PRIV', name: 'Private', type: 'alt' },
      models: [],
      historySeries: [],
      navSeries: [],
      today: TODAY,
    });
    expect(empty.skip).toBe('no-price');

    const alt = evaluateHolding({
      inst: { id: 'inst_ocic', symbol: 'OCIC', name: 'Blue Owl', type: 'alt', currency: 'USD' },
      models: [{ key: 'growth', name: 'Growth' }],
      historySeries: null,
      navSeries: [{ date: '2026-01-01', nav: 10 }, { date: '2026-08-01', nav: 8 }],
      today: TODAY,
    });
    expect(alt.skip).toBeNull();
    expect(alt.basis).toBe('nav');
    expect(alt.drawdown).toBeCloseTo(-0.2, 10);
    expect(alt.models).toHaveLength(1);
  });
});
