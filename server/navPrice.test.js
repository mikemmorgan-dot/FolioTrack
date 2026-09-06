import { describe, it, expect } from 'vitest';
import {
  seriesFromNav,
  latestFromSeries,
  quoteFromNav,
  quoteFieldsFromLatestNav,
  decidePricePath,
  loadNavMarket,
} from './navPrice.js';

const RY = { id: 'inst_ry', symbol: 'RY.TO', source: 'auto', currency: 'CAD' };
const WPM = { id: 'inst_wpm', symbol: 'WPM.TO', source: 'manual', currency: 'CAD' };

describe('seriesFromNav', () => {
  it('keeps finite points, sorted by date', () => {
    expect(seriesFromNav([
      { date: '2026-09-04', nav: 90 },
      { date: '2026-01-02', nav: '80' },
      { date: '2026-03-01', nav: 'nope' },
      { date: null, nav: 1 },
    ])).toEqual([
      { date: '2026-01-02', price: 80 },
      { date: '2026-09-04', price: 90 },
    ]);
  });
});

describe('decidePricePath', () => {
  it('uses nav_series for auto instruments that have points', () => {
    const d = decidePricePath(RY, [{ date: '2026-09-04', nav: 178.2 }]);
    expect(d.path).toBe('nav_series');
    expect(d.series).toEqual([{ date: '2026-09-04', price: 178.2 }]);
  });

  it('leaves auto instruments without NAV on the provider path', () => {
    expect(decidePricePath(RY, []).path).toBe('auto');
    expect(decidePricePath(RY, null).path).toBe('auto');
  });

  it('keeps manuals on nav_series even with no points yet', () => {
    expect(decidePricePath(WPM, []).path).toBe('nav_series');
    expect(decidePricePath(WPM, []).series).toEqual([]);
  });
});

describe('quote helpers', () => {
  it('builds a manual quote from latest NAV', () => {
    expect(quoteFromNav(RY, { date: '2026-09-04', nav: 178.2 })).toEqual({
      price: 178.2, asOf: '2026-09-04', currency: 'CAD',
    });
    expect(quoteFieldsFromLatestNav({ date: '2026-09-04', nav: 178.2 })).toEqual({
      price: 178.2, priceAsOf: '2026-09-04', priceSource: 'manual',
    });
    expect(quoteFieldsFromLatestNav(null)).toBeNull();
    expect(latestFromSeries([])).toBeNull();
  });
});

describe('loadNavMarket', () => {
  it('returns hasNav + quote for auto + nav_series (the live RY.TO case)', async () => {
    const store = {
      getNavSeries: async () => [{ date: '2026-09-04', nav: 178.2 }],
    };
    const m = await loadNavMarket(store, RY);
    expect(m.hasNav).toBe(true);
    expect(m.path).toBe('nav_series');
    expect(m.series).toEqual([{ date: '2026-09-04', price: 178.2 }]);
    expect(m.quote).toEqual({ price: 178.2, asOf: '2026-09-04', currency: 'CAD' });
  });

  it('falls through when auto has no NAV', async () => {
    const store = { getNavSeries: async () => [], latestNav: async () => null };
    const m = await loadNavMarket(store, RY);
    expect(m.hasNav).toBe(false);
    expect(m.path).toBe('auto');
    expect(m.quote).toBeNull();
  });
});
