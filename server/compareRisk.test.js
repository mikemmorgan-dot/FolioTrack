import { describe, it, expect, afterEach } from 'vitest';
import express from 'express';
import { once } from 'node:events';
import { monthGrid, monthEndDate } from './perf.js';
import { riskMetrics } from './risk.js';
import {
  addMonths,
  buildCompareRisk,
  loadCompareRisk,
  createCompareRiskHandler,
  supportMonths,
  lastCompleteMonth,
} from './compareRisk.js';

const AS_OF = '2026-11-14';

function wave(base) {
  return (ym) => base + (Number(ym.slice(5, 7)) % 2 === 0 ? 0.015 : -0.012);
}

function monthlyPath(startYm, endYm, retForMonth) {
  const months = monthGrid(startYm, endYm);
  let level = 100;
  return months.map((ym, i) => {
    if (i > 0) {
      const r = typeof retForMonth === 'function' ? retForMonth(ym) : retForMonth;
      level *= 1 + r;
    }
    return { date: monthEndDate(ym), close: level };
  });
}

function book(key, name, riskRank, holdings, extra = {}) {
  return {
    key,
    name,
    riskRank,
    versionId: extra.versionId === undefined ? `ver_${key}` : extra.versionId,
    effectiveDate: extra.effectiveDate || '2024-01-01',
    benchmark: extra.benchmark === undefined ? [{ symbol: 'XBB.TO', weight: 1 }] : extra.benchmark,
    holdings,
  };
}

function hold(id, symbol, weight) {
  return { instrumentId: id, symbol, weight };
}

async function withServer(app, fn) {
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const { port } = server.address();
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    server.close();
    await once(server, 'close');
  }
}

describe('lastCompleteMonth', () => {
  it('drops the month in progress', () => {
    expect(lastCompleteMonth('2026-11-14')).toBe('2026-10');
    expect(lastCompleteMonth('2026-11-30')).toBe('2026-11');
    expect(addMonths('2026-01', -1)).toBe('2025-12');
  });
});

describe('common-range alignment', () => {
  it('scores every model on the overlap, not on each book’s own start', () => {
    const overlapRet = (ym) => (Number(ym.slice(5, 7)) % 2 === 0 ? 0.03 : -0.01);
    const calm = monthlyPath('2018-01', '2026-10', (ym) => (ym < '2024-01' ? 0.08 : overlapRet(ym)));
    const late = monthlyPath('2024-01', '2026-10', overlapRet);
    const out = buildCompareRisk(
      [
        book('growth', 'Growth', 4, [hold('long', 'LONG', 1)]),
        book('conservative', 'Conservative', 1, [hold('late', 'LATE', 1)]),
      ],
      { long: calm, late },
      { 'XBB.TO': late },
      { period: 'max', rf: 0.04, asOf: AS_OF },
    );
    expect(out.models.map((m) => m.key)).toEqual(['conservative', 'growth']);
    expect(out.range.start).toBe('2024-02');
    expect(out.range.end).toBe('2026-10');
    expect(out.months[0]).toBe('2024-02');
    expect(out.months).not.toContain('2023-12');
    expect(out.months).not.toContain('2018-02');
    for (const m of out.models) expect(m.metrics.n).toBe(out.months.length);
    const aligned = out.months.map(overlapRet);
    const expected = riskMetrics(aligned, aligned, 0.04);
    for (const m of out.models) {
      expect(m.metrics.annualizedReturn).toBeCloseTo(expected.annualizedReturn, 6);
      expect(m.metrics.sharpe).toBeCloseTo(expected.sharpe, 6);
    }
    // The early 8% months would have dominated Growth if the ranges were not aligned.
    const early = riskMetrics(Array(60).fill(0.08), aligned, 0.04);
    expect(out.models.find((m) => m.key === 'growth').metrics.annualizedReturn)
      .toBeLessThan(early.annualizedReturn);
  });

  it('does not stitch across a gap in the shared months', () => {
    const continuous = monthlyPath('2024-01', '2024-06', 0.01);
    const gappy = [
      { date: '2024-01-31', close: 100 },
      { date: '2024-02-29', close: 101 },
      { date: '2024-04-30', close: 110 },
      { date: '2024-05-31', close: 111 },
      { date: '2024-06-30', close: 112 },
    ];
    const out = buildCompareRisk(
      [
        book('a', 'A', 1, [hold('c', 'C', 1)]),
        book('b', 'B', 2, [hold('g', 'G', 1)]),
      ],
      { c: continuous, g: gappy },
      { 'XBB.TO': continuous },
      { period: 'max', rf: 0, asOf: AS_OF },
    );
    expect(out.months).toEqual(['2024-05', '2024-06']);
    expect(out.months).not.toContain('2024-02');
    expect(supportMonths(new Map([
      ['2024-01', 1], ['2024-02', 1], ['2024-04', 1], ['2024-05', 1], ['2024-06', 1],
    ]))).toEqual(new Set(['2024-02', '2024-05', '2024-06']));
  });

  it('leaves a short holding out of the figure and reports its weight', () => {
    const full = monthlyPath('2019-01', '2026-10', 0.02);
    const sparse = [
      { date: '2025-01-31', close: 10 },
      { date: '2025-06-30', close: 50 },
      { date: '2025-12-31', close: 80 },
    ];
    const out = buildCompareRisk(
      [
        book('balanced', 'Balanced', 2, [hold('etf', 'VFV.TO', 1)]),
        book('conservative', 'Conservative', 1, [
          hold('etf', 'VFV.TO', 0.8),
          hold('alt', 'OCIC', 0.2),
        ]),
      ],
      { etf: full, alt: sparse },
      { 'XBB.TO': full },
      { period: '3y', rf: 0.04, asOf: AS_OF },
    );
    const cons = out.models.find((m) => m.key === 'conservative');
    const bal = out.models.find((m) => m.key === 'balanced');
    expect(out.period).toBe('3y');
    expect(out.range).toEqual({ start: '2023-11', end: '2026-10', months: 36 });
    expect(cons.partial).toBe(true);
    expect(cons.coverage).toBeCloseTo(0.8, 8);
    expect(cons.leftOut).toEqual([{ symbol: 'OCIC', weight: 0.2 }]);
    expect(bal.partial).toBe(false);
    expect(bal.coverage).toBeCloseTo(1, 8);
    const sleeve = riskMetrics(out.months.map(() => 0.02), out.months.map(() => 0.02), 0.04);
    expect(cons.metrics.annualizedReturn).toBeCloseTo(sleeve.annualizedReturn, 8);
    expect(cons.metrics.annualizedReturn).toBeCloseTo(bal.metrics.annualizedReturn, 8);
    expect(cons.metrics.n).toBe(36);
    expect(bal.metrics.n).toBe(36);
  });

  it('uses the last close in a month, not an earlier print', () => {
    const daily = [
      { date: '2024-01-10', close: 100 },
      { date: '2024-01-31', close: 110 },
      { date: '2024-02-15', close: 121 },
      { date: '2024-03-31', close: 133.1 },
    ];
    const out = buildCompareRisk(
      [book('a', 'A', 1, [hold('x', 'X', 1)], { benchmark: [] })],
      { x: daily },
      {},
      { period: 'max', rf: 0.04, asOf: AS_OF },
    );
    expect(out.months).toEqual(['2024-02', '2024-03']);
    expect(out.models[0].metrics.annualizedReturn).toBeCloseTo(Math.pow(1.1, 12) - 1, 6);
    expect(out.models[0].metricReasons.beta).toBe('No benchmark');
    expect(out.models[0].metrics.beta).toBeNull();
  });

  it('hides a trailing window the common history cannot fill, and does not invent its figures', () => {
    const series = monthlyPath('2023-01', '2026-04', 0.01);
    const out = buildCompareRisk(
      [
        book('a', 'A', 1, [hold('x', 'X', 1)]),
        book('b', 'B', 2, [hold('x', 'X', 1)]),
      ],
      { x: series },
      { 'XBB.TO': series },
      { period: '5y', rf: 0.04, asOf: AS_OF },
    );
    // 2023-02 through 2026-04 is 39 months: 1y and 3y fit, 5y does not.
    expect(out.common.months).toBe(39);
    expect(out.availablePeriods).toEqual(['1y', '3y', 'max']);
    expect(out.period).toBeNull();
    expect(out.range).toBeNull();
    expect(out.months).toEqual([]);
    expect(out.unavailableReason).toMatch(/39 months/);
    expect(out.unavailableReason).toMatch(/5y needs 60/);
    for (const m of out.models) {
      expect(m.metrics).toBeNull();
      expect(m.metrics?.sharpe).not.toEqual(expect.any(Number));
      expect(m.reason).toMatch(/5y needs 60/);
    }
  });

  it('returns a dash reason instead of a zero Sharpe when volatility is zero', () => {
    const flat = monthlyPath('2024-01', '2026-10', 0);
    const out = buildCompareRisk(
      [book('a', 'A', 1, [hold('x', 'X', 1)], { benchmark: [{ symbol: 'XBB.TO', weight: 1 }] })],
      { x: flat },
      { 'XBB.TO': flat },
      { period: '1y', rf: 0.04, asOf: AS_OF },
    );
    expect(out.models[0].metrics.volatility).toBe(0);
    expect(out.models[0].metrics.sharpe).toBeNull();
    expect(out.models[0].metricReasons.sharpe).toBe('Zero volatility');
    expect(out.models[0].metrics.informationRatio).toBeNull();
    expect(out.models[0].metricReasons.informationRatio).toBe('Tracking error is zero');
  });

  it('nulls benchmark-relative figures when the benchmark has no cached months', () => {
    const full = monthlyPath('2019-01', '2026-10', wave(0.004));
    const out = buildCompareRisk(
      [book('a', 'A', 1, [hold('x', 'X', 1)])],
      { x: full },
      {},
      { period: '3y', rf: 0.04, asOf: AS_OF },
    );
    expect(out.range).toEqual({ start: '2023-11', end: '2026-10', months: 36 });
    expect(out.models[0].metrics.sharpe).toEqual(expect.any(Number));
    expect(out.models[0].metrics.beta).toBeNull();
    expect(out.models[0].metrics.trackingError).toBeNull();
    expect(out.models[0].metrics.informationRatio).toBeNull();
    expect(out.models[0].metricReasons.beta).toBe('Benchmark gap');
    expect(out.models[0].benchmarkLabel).toBe('XBB.TO 100%');
  });

  it('starts Max common at the latest priced holding and benchmark, not the oldest sleeve', () => {
    const old = monthlyPath('1995-01', '2026-10', wave(0.004));
    const etf = monthlyPath('2012-11', '2026-10', wave(0.006));
    const lateAlt = monthlyPath('2020-01', '2026-10', wave(0.01));
    const out = buildCompareRisk(
      [
        book('conservative', 'Conservative', 1, [
          hold('old', 'ENB.TO', 0.1),
          hold('etf', 'VFV.TO', 0.7),
          hold('missing', 'ATZ.TO', 0.1),
          { ...hold('alt', 'OCIC', 0.1), monthlyPriceable: false },
        ]),
        book('growth', 'Growth', 4, [hold('old', 'ENB.TO', 1)]),
      ],
      { old, etf, missing: [], alt: lateAlt },
      { 'XBB.TO': etf },
      { period: 'max', rf: 0.04, asOf: AS_OF },
    );
    // The old union of "any holding" ran 1995-02 to 2026-10 (381 months) and
    // then dropped VFV because it does not cover 1995. Max common is the
    // overlap of the priced names plus the benchmark.
    expect(out.common).toEqual({ start: '2012-12', end: '2026-10', months: 167 });
    expect(out.range).toEqual(out.common);
    expect(out.months[0]).toBe('2012-12');
    expect(out.months.at(-1)).toBe('2026-10');
    expect(out.months).not.toContain('1995-02');
    expect(out.months).toContain('2020-02');
    const cons = out.models.find((m) => m.key === 'conservative');
    expect(cons.coverage).toBeCloseTo(0.8, 8);
    expect(cons.leftOut.map((h) => h.symbol).sort()).toEqual(['ATZ.TO', 'OCIC']);
    expect(cons.metrics.volatility).toBeLessThan(0.2);
    expect(cons.metrics.maxDrawdown).toBeGreaterThan(-0.5);
    expect(cons.metrics.beta).toEqual(expect.any(Number));
    expect(cons.metricReasons.beta).toBeNull();
    const gro = out.models.find((m) => m.key === 'growth');
    expect(gro.coverage).toBeCloseTo(1, 8);
    expect(gro.metrics.n).toBe(167);

    const year = buildCompareRisk(
      [
        book('conservative', 'Conservative', 1, [
          hold('old', 'ENB.TO', 0.1),
          hold('etf', 'VFV.TO', 0.7),
          hold('missing', 'ATZ.TO', 0.1),
          { ...hold('alt', 'OCIC', 0.1), monthlyPriceable: false },
        ], { benchmark: [] }),
      ],
      { old, etf, missing: [], alt: lateAlt },
      {},
      { period: '1y', rf: 0.04, asOf: AS_OF },
    );
    expect(year.range).toEqual({ start: '2025-11', end: '2026-10', months: 12 });
    expect(year.common.start).toBe('2012-12');
    const thin = year.models[0];
    // OCIC's own monthly run covers this 1y slice, so it stays in. ATZ has no cache.
    expect(thin.coverage).toBeCloseTo(0.9, 8);
    expect(thin.leftOut).toEqual([{ symbol: 'ATZ.TO', weight: 0.1 }]);

    const filled = buildCompareRisk(
      [
        book('conservative', 'Conservative', 1, [
          hold('old', 'ENB.TO', 0.1),
          hold('etf', 'VFV.TO', 0.7),
          hold('missing', 'ATZ.TO', 0.1),
          { ...hold('alt', 'OCIC', 0.1), monthlyPriceable: false },
        ], { benchmark: [] }),
      ],
      { old, etf, missing: etf, alt: lateAlt },
      {},
      { period: '1y', rf: 0.04, asOf: AS_OF },
    );
    expect(filled.models[0].coverage).toBeCloseTo(1, 8);
    expect(filled.models[0].leftOut).toEqual([]);
  });
});

describe('GET /api/models/compare/risk', () => {
  const live = [];

  function storeFor(extra = {}) {
    const prices = {
      'XBB.TO': monthlyPath('2019-01', '2026-10', wave(0.002)),
      'VFV.TO': monthlyPath('2019-01', '2026-10', wave(0.01)),
      'VDY.TO': monthlyPath('2019-01', '2026-10', wave(0.006)),
      'XEF.TO': monthlyPath('2019-01', '2026-10', wave(0.007)),
      'ENB.TO': monthlyPath('2019-01', '2026-10', wave(0.004)),
      'TOU.TO': monthlyPath('2019-01', '2026-10', wave(0.012)),
      'HIGH.TO': monthlyPath('2019-01', '2026-10', wave(0.03)),
      'ATZ.TO': monthlyPath('2016-01', '2026-10', wave(0.008)),
    };
    const nav = {
      inst_rbf: [
        { date: '2025-01-02', nav: 42.15 },
        { date: '2025-06-30', nav: 44.9 },
        { date: '2025-12-31', nav: 46.32 },
      ],
      inst_ocic: [
        { date: '2025-01-02', nav: 8.94 },
        { date: '2025-06-30', nav: 9.08 },
        { date: '2025-12-31', nav: 9.21 },
      ],
      inst_cvc: [
        { date: '2025-01-02', nav: 100 },
        { date: '2025-06-30', nav: 107.5 },
        { date: '2025-12-31', nav: 113.2 },
      ],
      inst_atz: [{ date: '2026-09-04', nav: 128.67 }],
      inst_ry_nav: monthlyPath('1995-01', '2026-10', wave(0.004)).map((p) => ({ date: p.date, nav: p.close })),
      inst_fid: [
        { date: '2025-01-02', nav: 60 },
        { date: '2025-06-30', nav: 64 },
        { date: '2025-12-31', nav: 69 },
      ],
    };
    const instruments = {
      inst_xbb: { id: 'inst_xbb', symbol: 'XBB.TO', source: 'auto', type: 'etf' },
      inst_vfv: { id: 'inst_vfv', symbol: 'VFV.TO', source: 'auto', type: 'etf' },
      inst_vdy: { id: 'inst_vdy', symbol: 'VDY.TO', source: 'auto', type: 'etf' },
      inst_xef: { id: 'inst_xef', symbol: 'XEF.TO', source: 'auto', type: 'etf' },
      inst_enb: { id: 'inst_enb', symbol: 'ENB.TO', source: 'auto', type: 'stock' },
      inst_tou: { id: 'inst_tou', symbol: 'TOU.TO', source: 'auto', type: 'stock' },
      inst_high: { id: 'inst_high', symbol: 'HIGH.TO', source: 'auto', type: 'etf' },
      inst_rbf: { id: 'inst_rbf', symbol: 'RBF1005', source: 'manual', type: 'mutualfund' },
      inst_ocic: { id: 'inst_ocic', symbol: 'OCIC', source: 'manual', type: 'alt' },
      inst_cvc: { id: 'inst_cvc', symbol: 'CVC-EU', source: 'manual', type: 'alt' },
      inst_atz: { id: 'inst_atz', symbol: 'ATZ.TO', source: 'manual', type: 'stock' },
      inst_ry_nav: { id: 'inst_ry_nav', symbol: 'RY.TO', source: 'manual', type: 'stock' },
      inst_fid: { id: 'inst_fid', symbol: 'FID5982', source: 'manual', type: 'mutualfund' },
    };
    const H = (id, weight) => ({ instrumentId: id, weight });
    const models = extra.models || [
      {
        key: 'growth', name: 'Growth', riskRank: 4,
        benchmark: [{ symbol: 'XBB.TO', weight: 0.15 }, { symbol: 'VFV.TO', weight: 0.55 }, { symbol: 'XEF.TO', weight: 0.3 }],
        versions: [{
          id: 'ver_gro', effectiveDate: '2025-01-01',
          holdings: [
            H('inst_xbb', 0.15), H('inst_vfv', 0.30), H('inst_vdy', 0.15), H('inst_xef', 0.15),
            H('inst_enb', 0.07), H('inst_tou', 0.06), H('inst_cvc', 0.07), H('inst_ocic', 0.05),
          ],
        }],
      },
      {
        key: 'conservative', name: 'Conservative', riskRank: 1,
        benchmark: [{ symbol: 'XBB.TO', weight: 0.7 }, { symbol: 'VFV.TO', weight: 0.2 }, { symbol: 'XEF.TO', weight: 0.1 }],
        versions: [{
          id: 'ver_cons', effectiveDate: '2025-01-01',
          holdings: [
            H('inst_xbb', 0.55), H('inst_vdy', 0.15), H('inst_vfv', 0.15),
            H('inst_rbf', 0.10), H('inst_ocic', 0.05),
          ],
        }],
      },
      {
        key: 'balanced', name: 'Balanced', riskRank: 2,
        benchmark: [{ symbol: 'XBB.TO', weight: 0.4 }, { symbol: 'VFV.TO', weight: 0.35 }, { symbol: 'XEF.TO', weight: 0.25 }],
        versions: [
          {
            id: 'ver_bal_old', effectiveDate: '2025-01-01',
            holdings: [H('inst_high', 1)],
          },
          {
            id: 'ver_bal', effectiveDate: '2025-07-01',
            holdings: [
              H('inst_xbb', 0.28), H('inst_vfv', 0.22), H('inst_vdy', 0.15), H('inst_xef', 0.10),
              H('inst_enb', 0.05), H('inst_rbf', 0.10), H('inst_ocic', 0.06), H('inst_cvc', 0.04),
            ],
          },
        ],
      },
      {
        key: 'balanced-growth', name: 'Balanced Growth', riskRank: 3,
        benchmark: [{ symbol: 'VFV.TO', weight: 1 }],
        versions: [],
      },
      {
        key: 'aggressive-growth', name: 'Aggressive Growth', riskRank: 5,
        benchmark: [{ symbol: 'VFV.TO', weight: 0.65 }, { symbol: 'XEF.TO', weight: 0.35 }],
        versions: extra.futureOnly ? [{
          id: 'ver_future', effectiveDate: '2099-01-01',
          holdings: [H('inst_high', 1)],
        }] : [],
      },
    ];
    const priceCalls = [];
    const navCalls = [];
    return {
      priceCalls,
      navCalls,
      async listModels() { return models; },
      async getInstrumentCore(id) { return instruments[id] || null; },
      async getMonthEndNav(id) { navCalls.push(id); return nav[id] || []; },
      async getMonthEndPrices(symbol) {
        const key = String(symbol).toUpperCase();
        priceCalls.push(key);
        return prices[key] ? { symbol: key, series: prices[key] } : null;
      },
      async getHistory() { live.push('getHistory'); throw new Error('provider chain'); },
      async getPriceHistory() { live.push('getPriceHistory'); throw new Error('full daily history'); },
    };
  }

  afterEach(() => { live.length = 0; });

  it('returns one aligned payload and does not call a price provider', async () => {
    const store = storeFor();
    const app = express();
    app.get('/api/models/compare/risk', createCompareRiskHandler(store, { today: () => AS_OF }));
    await withServer(app, async (base) => {
      const bad = await fetch(`${base}/api/models/compare/risk?period=nope`);
      expect(bad.status).toBe(400);
      const badBody = await bad.json();
      expect(badBody.error).toMatch(/1y, 3y, 5y, or max/);
      expect(store.priceCalls).toEqual([]);

      const res = await fetch(`${base}/api/models/compare/risk?period=3y&rf=4`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.rf).toBeCloseTo(0.04, 8);
      expect(body.period).toBe('3y');
      expect(body.availablePeriods).toEqual(['1y', '3y', '5y', 'max']);
      expect(body.range.months).toBe(36);
      expect(body.months).toHaveLength(36);
      expect(new Set(body.months).size).toBe(36);
      expect(body.models.map((m) => m.key)).toEqual([
        'conservative', 'balanced', 'balanced-growth', 'growth', 'aggressive-growth',
      ]);

      const priced = body.models.filter((m) => m.metrics);
      expect(priced.map((m) => m.key)).toEqual(['conservative', 'balanced', 'growth']);
      for (const m of priced) {
        expect(m.metrics.n).toBe(36);
        expect(m.versionId).not.toBe('ver_bal_old');
      }
      const cons = body.models.find((m) => m.key === 'conservative');
      expect(cons.coverage).toBeCloseTo(0.85, 8);
      expect(cons.partial).toBe(true);
      expect(cons.leftOut.map((h) => h.symbol).sort()).toEqual(['OCIC', 'RBF1005']);
      expect(cons.metrics.sharpe).toEqual(expect.any(Number));
      expect(cons.metrics.beta).toEqual(expect.any(Number));
      expect(cons.benchmarkLabel).toBe('XBB.TO 70% · VFV.TO 20% · XEF.TO 10%');

      const bal = body.models.find((m) => m.key === 'balanced');
      expect(bal.versionId).toBe('ver_bal');
      expect(bal.effectiveDate).toBe('2025-07-01');
      expect(bal.coverage).toBeCloseTo(0.8, 8);
      // The retired version was 100% HIGH.TO. Current weights must not inherit that path.
      const highOnly = riskMetrics(body.months.map(wave(0.03)), body.months.map(wave(0.002)), 0.04);
      expect(Math.abs(bal.metrics.annualizedReturn - highOnly.annualizedReturn)).toBeGreaterThan(0.05);

      expect(body.models.find((m) => m.key === 'balanced-growth').reason).toBe('No current version');
      expect(body.models.find((m) => m.key === 'balanced-growth').metrics).toBeNull();
      expect(body.models.find((m) => m.key === 'aggressive-growth').metrics).toBeNull();

      const firstPass = store.priceCalls.slice();
      expect(firstPass.filter((s, i) => firstPass.indexOf(s) !== i)).toEqual([]);
      expect(firstPass).not.toContain('RBF1005');
      expect(firstPass).not.toContain('OCIC');
      expect(firstPass).not.toContain('HIGH.TO');
      expect([...firstPass].sort()).toEqual(['ENB.TO', 'TOU.TO', 'VDY.TO', 'VFV.TO', 'XBB.TO', 'XEF.TO']);

      const zero = await fetch(`${base}/api/models/compare/risk?period=1y&rf=0`);
      const zeroBody = await zero.json();
      expect(zeroBody.rf).toBe(0);
      expect(zeroBody.range.months).toBe(12);
      expect(zeroBody.months.at(-1)).toBe(body.months.at(-1));
      expect(zeroBody.months[0]).not.toBe(body.months[0]);
      const cons1y = zeroBody.models.find((m) => m.key === 'conservative');
      expect(cons1y.metrics.sharpe).not.toBeCloseTo(cons.metrics.sharpe, 6);
      expect(live).toEqual([]);
    });
  });

  it('ignores a future version and a live-history fallback', async () => {
    const dedicated = storeFor();
    dedicated.listModels = async () => [{
      key: 'aggressive-growth', name: 'Aggressive Growth', riskRank: 5,
      benchmark: [{ symbol: 'VFV.TO', weight: 1 }],
      versions: [
        { id: 'ver_past', effectiveDate: '2024-01-01', holdings: [{ instrumentId: 'inst_vfv', weight: 1 }] },
        { id: 'ver_future', effectiveDate: '2099-01-01', holdings: [{ instrumentId: 'inst_high', weight: 1 }] },
      ],
    }];
    const out = await loadCompareRisk(dedicated, { period: '1y', rf: 0.04, asOf: AS_OF });
    expect(out.models[0].versionId).toBe('ver_past');
    expect(out.models[0].partial).toBe(false);
    expect(out.models[0].coverage).toBeCloseTo(1, 8);
    const vfv = riskMetrics(out.months.map(wave(0.01)), out.months.map(wave(0.01)), 0.04);
    expect(out.models[0].metrics.annualizedReturn).toBeCloseTo(vfv.annualizedReturn, 8);
    expect(dedicated.priceCalls).not.toContain('HIGH.TO');
    expect(live).toEqual([]);
  });

  it('scores a manual listed stock from the price cache and leaves a fund on NAV', async () => {
    const store = storeFor();
    store.listModels = async () => [{
      key: 'aggressive-growth', name: 'Aggressive Growth', riskRank: 5,
      benchmark: [{ symbol: 'VFV.TO', weight: 1 }],
      versions: [{
        id: 'ver_agg', effectiveDate: '2026-10-07',
        holdings: [
          { instrumentId: 'inst_vfv', weight: 0.5 },
          { instrumentId: 'inst_atz', weight: 0.4 },
          { instrumentId: 'inst_ry_nav', weight: 0.05 },
          { instrumentId: 'inst_fid', weight: 0.05 },
        ],
      }],
    }];
    const out = await loadCompareRisk(store, { period: '1y', rf: 0.04, asOf: AS_OF });
    const row = out.models[0];
    expect(row.coverage).toBeCloseTo(0.95, 8);
    expect(row.leftOut).toEqual([{ symbol: 'FID5982', weight: 0.05 }]);
    expect(row.partial).toBe(true);
    expect(store.priceCalls).toContain('ATZ.TO');
    expect(store.priceCalls).toContain('RY.TO');
    expect(store.priceCalls).not.toContain('FID5982');
    expect(live).toEqual([]);
  });
});
