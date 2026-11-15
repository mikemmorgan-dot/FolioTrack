import { describe, it, expect, afterEach } from 'vitest';
import { monthEndCloses, monthEndDate, monthGrid } from './perf.js';
import { markCooldown, resetCooldowns } from './providerCooldown.js';
import { isMonthlyPriceableInstrument } from './listing.js';
import {
  monthlyHistoryComplete,
  planHistoryBackfill,
  createHistoryBackfill,
} from './historyBackfill.js';

const LAST = '2026-10';

function daily(startYm, endYm) {
  const out = [];
  for (const ym of monthGrid(startYm, endYm)) {
    out.push({ date: `${ym}-15`, close: 10 });
    out.push({ date: monthEndDate(ym), close: 11 });
  }
  return out;
}

function ends(series) {
  return monthEndCloses(series);
}

describe('monthlyHistoryComplete', () => {
  it('accepts a continuous max run through the last finished month', () => {
    const series = daily('2016-01', '2026-10');
    expect(monthlyHistoryComplete({
      monthEnds: ends(series),
      pointCount: series.length,
      range: 'max',
      lastComplete: LAST,
    })).toBe(true);
  });

  it('rejects a one-day quote, a gap, and a stale tail', () => {
    expect(monthlyHistoryComplete({
      monthEnds: [{ date: '2026-09-04', close: 128 }],
      pointCount: 1,
      range: 'max',
      lastComplete: LAST,
    })).toBe(false);
    const gappy = [
      ...ends(daily('2024-01', '2024-02')),
      ...ends(daily('2024-04', '2026-10')),
    ];
    expect(monthlyHistoryComplete({
      monthEnds: gappy,
      pointCount: 800,
      range: 'max',
      lastComplete: LAST,
    })).toBe(false);
    const shortTail = daily('2016-01', '2026-08');
    expect(monthlyHistoryComplete({
      monthEnds: ends(shortTail),
      pointCount: shortTail.length,
      range: 'max',
      lastComplete: LAST,
    })).toBe(false);
  });

  it('accepts a short listing once max history is dense through last month', () => {
    const series = [];
    for (const ym of monthGrid('2026-08', '2026-10')) {
      for (let day = 1; day <= 20; day += 1) {
        series.push({ date: `${ym}-${String(day).padStart(2, '0')}`, close: 10 + day });
      }
    }
    expect(series.length).toBeGreaterThanOrEqual(40);
    expect(monthlyHistoryComplete({
      monthEnds: ends(series),
      pointCount: series.length,
      range: 'max',
      lastComplete: LAST,
    })).toBe(true);
  });
});

describe('who gets a backfill', () => {
  it('keeps funds, cash, and private sleeves off the price chain', () => {
    expect(isMonthlyPriceableInstrument({ symbol: 'ATZ.TO', type: 'stock', source: 'manual' })).toBe(true);
    expect(isMonthlyPriceableInstrument({ symbol: 'VFV.TO', type: 'etf', source: 'auto' })).toBe(true);
    expect(isMonthlyPriceableInstrument({ symbol: 'FID5982', type: 'mutualfund', source: 'manual' })).toBe(false);
    expect(isMonthlyPriceableInstrument({ symbol: 'RBF608', type: 'mutualfund', source: 'manual' })).toBe(false);
    expect(isMonthlyPriceableInstrument({ symbol: 'RBF1005', type: 'stock', source: 'manual' })).toBe(false);
    expect(isMonthlyPriceableInstrument({ symbol: 'OCIC', type: 'alt', source: 'manual' })).toBe(false);
    expect(isMonthlyPriceableInstrument({ symbol: 'CASH', type: 'cash', source: 'manual' })).toBe(false);
    expect(isMonthlyPriceableInstrument({ symbol: 'CVC-EU', type: 'alt', source: 'manual' })).toBe(false);
  });

  it('skips complete names, caps the rest, and does not spend a slot on a cooldown', () => {
    const rows = [
      { symbol: 'VFV.TO', complete: true, supportMonths: 160, lastMonth: '2026-10' },
      { symbol: 'WPM.TO', complete: false, supportMonths: 0, lastMonth: '' },
      { symbol: 'ATZ.TO', complete: false, supportMonths: 0, lastMonth: '' },
      { symbol: 'CNQ.TO', complete: false, supportMonths: 0, lastMonth: '' },
      { symbol: 'HBM.TO', complete: false, supportMonths: 3, lastMonth: '2026-08' },
      { symbol: 'NTR.TO', complete: false, supportMonths: 0, lastMonth: '' },
    ];
    const plan = planHistoryBackfill(rows, {
      cap: 3,
      isCooling: (row) => row.symbol === 'CNQ.TO',
    });
    expect(plan.skipped).toEqual(['VFV.TO']);
    expect(plan.cooling).toEqual(['CNQ.TO']);
    expect(plan.fetch.map((r) => r.symbol)).toEqual(['ATZ.TO', 'NTR.TO', 'WPM.TO']);
    expect(plan.deferred).toEqual(['HBM.TO']);
  });
});

describe('runHistoryBackfill', () => {
  afterEach(() => resetCooldowns());

  function world() {
    const filled = daily('2012-11', '2026-10');
    const instruments = {
      inst_vfv: { id: 'inst_vfv', symbol: 'VFV.TO', source: 'auto', type: 'etf' },
      inst_atz: { id: 'inst_atz', symbol: 'ATZ.TO', source: 'manual', type: 'stock' },
      inst_cnq: { id: 'inst_cnq', symbol: 'CNQ.TO', source: 'manual', type: 'stock' },
      inst_hbm: { id: 'inst_hbm', symbol: 'HBM.TO', source: 'manual', type: 'stock' },
      inst_ntr: { id: 'inst_ntr', symbol: 'NTR.TO', source: 'manual', type: 'stock' },
      inst_shop: { id: 'inst_shop', symbol: 'SHOP.TO', source: 'manual', type: 'stock' },
      inst_su: { id: 'inst_su', symbol: 'SU.TO', source: 'manual', type: 'stock' },
      inst_wpm: { id: 'inst_wpm', symbol: 'WPM.TO', source: 'manual', type: 'stock' },
      inst_fid: { id: 'inst_fid', symbol: 'FID5982', source: 'manual', type: 'mutualfund' },
      inst_rbf: { id: 'inst_rbf', symbol: 'RBF608', source: 'manual', type: 'mutualfund' },
      inst_cash: { id: 'inst_cash', symbol: 'CASH', source: 'manual', type: 'cash' },
      inst_ocic: { id: 'inst_ocic', symbol: 'OCIC', source: 'manual', type: 'alt' },
      inst_future: { id: 'inst_future', symbol: 'NEW.TO', source: 'auto', type: 'stock' },
    };
    const H = (id, weight) => ({ instrumentId: id, weight });
    const models = [{
      key: 'aggressive-growth',
      name: 'Aggressive Growth',
      riskRank: 5,
      benchmark: [{ symbol: 'XBB.TO', weight: 1 }],
      versions: [
        {
          id: 'ver_now',
          effectiveDate: '2020-01-01',
          holdings: [
            H('inst_vfv', 0.2),
            H('inst_atz', 0.1),
            H('inst_cnq', 0.1),
            H('inst_hbm', 0.1),
            H('inst_ntr', 0.1),
            H('inst_shop', 0.1),
            H('inst_su', 0.1),
            H('inst_wpm', 0.1),
            H('inst_fid', 0.05),
            H('inst_rbf', 0.04),
            H('inst_cash', 0.01),
            H('inst_ocic', 0),
          ],
        },
        {
          id: 'ver_future',
          effectiveDate: '2099-01-01',
          holdings: [H('inst_future', 1)],
        },
      ],
    }];
    const prices = {
      'VFV.TO': { series: filled, range: 'max' },
    };
    const versionJson = JSON.stringify(models);
    return {
      models,
      versionJson,
      prices,
      async listModels() { return models; },
      async getInstrument(id) { return instruments[id] || null; },
      async getMonthEndPrices(symbol) {
        const rec = prices[String(symbol).toUpperCase()];
        if (!rec) return null;
        return { symbol, series: monthEndCloses(rec.series) };
      },
      async getPriceHistoryMeta(symbol) {
        const rec = prices[String(symbol).toUpperCase()];
        if (!rec) return null;
        const series = rec.series || [];
        return {
          symbol,
          range: rec.range || 'max',
          pointCount: series.length,
          lastClose: series.at(-1)?.date || null,
        };
      },
    };
  }

  it('fetches missing listed names, skips a complete cache, and never touches funds', async () => {
    const store = world();
    const calls = [];
    const backfill = createHistoryBackfill({
      store,
      cap: 4,
      today: () => '2026-11-14',
      now: () => Date.parse('2026-11-14T15:00:00.000Z'),
      getHistory: async (symbol, range, opts) => {
        calls.push({ symbol, range, opts });
        const series = daily('2016-01', '2026-10');
        store.prices[symbol] = { series, range: 'max' };
        return { symbol, pointCount: series.length, stale: false, fromCache: false };
      },
    });
    const first = await backfill.run();
    expect(first.fetched).toBe(4);
    expect(first.skipped).toBe(1);
    expect(calls).toHaveLength(4);
    for (const call of calls) {
      expect(call.range).toBe('max');
      expect(call.opts).toEqual({ bypassFresh: true, omitSeries: true });
    }
    expect(calls.map((c) => c.symbol)).not.toContain('VFV.TO');
    expect(calls.map((c) => c.symbol)).not.toContain('FID5982');
    expect(calls.map((c) => c.symbol)).not.toContain('RBF608');
    expect(calls.map((c) => c.symbol)).not.toContain('CASH');
    expect(calls.map((c) => c.symbol)).not.toContain('OCIC');
    expect(calls.map((c) => c.symbol)).not.toContain('NEW.TO');
    expect(store.versionJson).toBe(JSON.stringify(store.models));

    const second = await backfill.run();
    const secondSymbols = calls.slice(4).map((c) => c.symbol);
    expect(second.fetched).toBe(4);
    expect(secondSymbols).not.toEqual(expect.arrayContaining(calls.slice(0, 4).map((c) => c.symbol)));
    expect(new Set([...calls.map((c) => c.symbol)])).toEqual(new Set([
      'ATZ.TO', 'CNQ.TO', 'HBM.TO', 'NTR.TO', 'SHOP.TO', 'SU.TO', 'WPM.TO', 'XBB.TO',
    ]));
  });

  it('does not retry a symbol that just missed, and does not call a cooled-down chain', async () => {
    const store = world();
    let calls = 0;
    const backfill = createHistoryBackfill({
      store,
      cap: 20,
      today: () => '2026-11-14',
      now: () => Date.parse('2026-11-14T15:00:00.000Z'),
      getHistory: async () => {
        calls += 1;
        const err = new Error('All providers failed for ATZ.TO: yahoo (HTTP 429)');
        err.classified = { anyRateLimit: true, allNotFound: false, kinds: ['rate-limit'] };
        throw err;
      },
    });
    const first = await backfill.run();
    expect(first.failed).toBe(8);
    expect(calls).toBe(8);
    const second = await backfill.run();
    expect(second.fetched).toBe(0);
    expect(second.failed).toBe(0);
    expect(second.cooling).toBe(8);
    expect(calls).toBe(8);

    for (const id of ['tmx', 'yahoo-query2', 'yahoo', 'stooq', 'alphavantage']) markCooldown(id);
    const cooled = createHistoryBackfill({
      store,
      cap: 4,
      today: () => '2026-11-14',
      now: () => Date.parse('2026-11-14T18:00:00.000Z'),
      getHistory: async () => {
        calls += 1;
        throw new Error('should not call providers while the chain is cooling down');
      },
    });
    const third = await cooled.run();
    expect(third.fetched).toBe(0);
    expect(third.cooling).toBeGreaterThan(0);
    expect(calls).toBe(8);
  });
});
