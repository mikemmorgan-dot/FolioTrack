import { describe, it, expect } from 'vitest';
import {
  addCalendarYears,
  lastDayOfPreviousMonth,
  lastDayOfPreviousQuarter,
  lastDayOfPreviousYear,
  windowStarts,
  yearFraction,
  lastOnOrBefore,
  periodReturnsFromSeries,
  isThinSample,
} from './periodReturns.js';
import { filterSeriesByRange } from './holdingHistory.js';

describe('period anchors (MTD / QTD / YTD / trailing years)', () => {
  it('MTD is the last calendar day of the previous month', () => {
    expect(lastDayOfPreviousMonth('2026-09-04')).toBe('2026-08-31');
    expect(lastDayOfPreviousMonth('2026-01-15')).toBe('2025-12-31');
    expect(lastDayOfPreviousMonth('2024-03-01')).toBe('2024-02-29');
  });

  it('QTD is the last calendar day of the previous quarter', () => {
    expect(lastDayOfPreviousQuarter('2026-02-15')).toBe('2025-12-31'); // Q1
    expect(lastDayOfPreviousQuarter('2026-04-01')).toBe('2026-03-31'); // Q2
    expect(lastDayOfPreviousQuarter('2026-09-04')).toBe('2026-06-30'); // Q3
    expect(lastDayOfPreviousQuarter('2026-11-01')).toBe('2026-09-30'); // Q4
  });

  it('YTD is Dec 31 of the previous year', () => {
    expect(lastDayOfPreviousYear('2026-09-04')).toBe('2025-12-31');
    expect(lastDayOfPreviousYear('2026-01-01')).toBe('2025-12-31');
  });

  it('trailing N-year anchors keep the calendar day and clamp Feb 29', () => {
    const w = windowStarts('2026-09-04');
    expect(w.y1).toBe('2025-09-04');
    expect(w.y3ann).toBe('2023-09-04');
    expect(w.y5ann).toBe('2021-09-04');
    expect(w.y10ann).toBe('2016-09-04');
    expect(w.y15ann).toBe('2011-09-04');
    expect(w.y20ann).toBe('2006-09-04');
    expect(addCalendarYears('2024-02-29', -1)).toBe('2023-02-28');
    expect(addCalendarYears('2024-02-29', -4)).toBe('2020-02-29');
  });
});

describe('lastOnOrBefore', () => {
  const pts = [
    { date: '2026-08-28', price: 10 },
    { date: '2026-08-31', price: 11 },
    { date: '2026-09-02', price: 12 },
  ];
  it('picks the closest EOD on or before the date', () => {
    expect(lastOnOrBefore(pts, '2026-08-31')).toEqual({ date: '2026-08-31', price: 11 });
    expect(lastOnOrBefore(pts, '2026-09-01')).toEqual({ date: '2026-08-31', price: 11 });
    expect(lastOnOrBefore(pts, '2026-09-02')).toEqual({ date: '2026-09-02', price: 12 });
  });
  it('returns null when every point is after the date', () => {
    expect(lastOnOrBefore(pts, '2026-08-01')).toBeNull();
  });
});

describe('periodReturnsFromSeries', () => {
  const asOf = '2026-09-04';
  const series = [
    { date: '2006-09-04', price: 40 },
    { date: '2011-09-04', price: 50 },
    { date: '2016-09-04', price: 60 },
    { date: '2021-09-04', price: 80 },
    { date: '2023-09-04', price: 100 },
    { date: '2025-09-04', price: 80 },
    { date: '2025-12-31', price: 90 },
    { date: '2026-06-30', price: 110 },
    { date: '2026-08-28', price: 120 }, // Friday before Aug 31
    { date: '2026-09-04', price: 126 },
  ];

  it('MTD / QTD / YTD use on-or-before closes at the calendar anchors', () => {
    const r = periodReturnsFromSeries(series, { asOf });
    expect(r.mtd).toBeCloseTo(126 / 120 - 1, 10);
    expect(r.meta.mtd.from).toBe('2026-08-28');
    expect(r.meta.mtd.to).toBe('2026-09-04');
    expect(r.qtd).toBeCloseTo(126 / 110 - 1, 10);
    expect(r.meta.qtd.from).toBe('2026-06-30');
    expect(r.ytd).toBeCloseTo(126 / 90 - 1, 10);
    expect(r.meta.ytd.from).toBe('2025-12-31');
    expect(r.meta.mtd.annualized).toBe(false);
    expect(r.meta.ytd.annualized).toBe(false);
  });

  it('1Y is a simple total return, not annualized', () => {
    const r = periodReturnsFromSeries(series, { asOf });
    expect(r.y1).toBeCloseTo(126 / 80 - 1, 10);
    expect(r.meta.y1.annualized).toBe(false);
    expect(r.meta.y1.from).toBe('2025-09-04');
  });

  it('annualizes N-year windows from the actual observation span', () => {
    const r = periodReturnsFromSeries(series, { asOf });
    const years = yearFraction('2023-09-04', '2026-09-04');
    expect(r.y3ann).toBeCloseTo(Math.pow(126 / 100, 1 / years) - 1, 10);
    expect(r.meta.y3ann.annualized).toBe(true);
    expect(r.y5ann).toBeCloseTo(Math.pow(126 / 80, 1 / yearFraction('2021-09-04', '2026-09-04')) - 1, 10);
    expect(r.y10ann).toBeCloseTo(Math.pow(126 / 60, 1 / yearFraction('2016-09-04', '2026-09-04')) - 1, 10);
    expect(r.y15ann).toBeCloseTo(Math.pow(126 / 50, 1 / yearFraction('2011-09-04', '2026-09-04')) - 1, 10);
    expect(r.y20ann).toBeCloseTo(Math.pow(126 / 40, 1 / yearFraction('2006-09-04', '2026-09-04')) - 1, 10);
  });

  it('uses last series date as asOf when not passed', () => {
    const r = periodReturnsFromSeries(series);
    expect(r.asOf).toBe('2026-09-04');
    expect(r.mtd).toBeCloseTo(126 / 120 - 1, 10);
  });

  it('accepts NAV-shaped { date, nav } / { date, value } points', () => {
    const nav = [
      { date: '2025-12-31', nav: 90 },
      { date: '2026-06-30', value: 110 },
      { date: '2026-08-28', nav: 120 },
      { date: '2026-09-04', value: 126 },
    ];
    const r = periodReturnsFromSeries(nav, { asOf });
    expect(r.mtd).toBeCloseTo(126 / 120 - 1, 10);
    expect(r.qtd).toBeCloseTo(126 / 110 - 1, 10);
    expect(r.ytd).toBeCloseTo(126 / 90 - 1, 10);
  });
});

describe('short series → null (never 0%)', () => {
  it('returns null for windows the series does not cover', () => {
    const short = [
      { date: '2026-08-01', price: 10 },
      { date: '2026-09-04', price: 12 },
    ];
    const r = periodReturnsFromSeries(short, { asOf: '2026-09-04' });
    expect(r.mtd).toBeCloseTo(12 / 10 - 1, 10);
    expect(r.qtd).toBeNull();
    expect(r.ytd).toBeNull();
    expect(r.y1).toBeNull();
    expect(r.y3ann).toBeNull();
    expect(r.y5ann).toBeNull();
    expect(r.y10ann).toBeNull();
    expect(r.y15ann).toBeNull();
    expect(r.y20ann).toBeNull();
  });

  it('is null when start and end collapse to the same observation', () => {
    const r = periodReturnsFromSeries(
      [{ date: '2026-08-31', price: 100 }, { date: '2026-08-31', price: 100 }],
      { asOf: '2026-09-04' },
    );
    expect(r.mtd).toBeNull();
  });

  it('is all-null (not 0) for a single point or empty series', () => {
    expect(periodReturnsFromSeries([]).y1).toBeNull();
    expect(periodReturnsFromSeries([{ date: '2026-09-04', price: 10 }]).mtd).toBeNull();
  });

  it('does not invent a start by taking the first point after the window', () => {
    const r = periodReturnsFromSeries(
      [{ date: '2026-01-15', price: 50 }, { date: '2026-09-04', price: 60 }],
      { asOf: '2026-09-04' },
    );
    expect(r.ytd).toBeNull();
    expect(r.y1).toBeNull();
  });
});

describe('since-added clipping', () => {
  const full = [
    { date: '2016-09-04', price: 60 },
    { date: '2021-09-04', price: 80 },
    { date: '2023-09-04', price: 100 },
    { date: '2024-12-31', price: 90 },
    { date: '2025-01-02', price: 92 },
    { date: '2025-09-04', price: 80 },
    { date: '2025-12-31', price: 90 },
    { date: '2026-06-30', price: 110 },
    { date: '2026-08-28', price: 120 },
    { date: '2026-09-04', price: 126 },
  ];

  it('computes long windows on the full series', () => {
    const r = periodReturnsFromSeries(full, { asOf: '2026-09-04' });
    expect(r.y1).not.toBeNull();
    expect(r.y3ann).not.toBeNull();
    expect(r.y5ann).not.toBeNull();
    expect(r.y10ann).not.toBeNull();
  });

  it('does not report windows that start before the visible since-added series', () => {
    const visible = filterSeriesByRange(full, { mode: 'since-added', addedAt: '2025-01-01' });
    expect(visible[0].date).toBe('2024-12-31');
    const r = periodReturnsFromSeries(visible, { asOf: '2026-09-04' });
    expect(r.mtd).not.toBeNull();
    expect(r.qtd).not.toBeNull();
    expect(r.ytd).not.toBeNull();
    expect(r.y1).not.toBeNull();
    expect(r.y3ann).toBeNull();
    expect(r.y5ann).toBeNull();
    expect(r.y10ann).toBeNull();
    expect(r.y15ann).toBeNull();
    expect(r.y20ann).toBeNull();
  });

  it('still measures 1Y when the holding is older than a year', () => {
    const visible = filterSeriesByRange(full, { mode: 'since-added', addedAt: '2025-01-01' });
    const r = periodReturnsFromSeries(visible, { asOf: '2026-09-04' });
    expect(r.y1).toBeCloseTo(126 / 80 - 1, 10);
  });
});

describe('thin-sample estimate flag', () => {
  it('labels a sparse NAV series as an estimate over a 1y window', () => {
    const nav = [
      { date: '2025-09-04', price: 10 },
      { date: '2025-12-31', price: 11 },
      { date: '2026-06-30', price: 12 },
      { date: '2026-09-04', price: 13 },
    ];
    const r = periodReturnsFromSeries(nav, { asOf: '2026-09-04' });
    expect(r.y1).toBeCloseTo(13 / 10 - 1, 10);
    expect(r.meta.y1.estimate).toBe(true);
    expect(isThinSample(nav, '2025-09-04', '2026-09-04')).toBe(true);
  });

  it('does not flag a dense daily 1y sample', () => {
    const daily = [];
    const start = new Date(Date.UTC(2025, 8, 4));
    const end = new Date(Date.UTC(2026, 8, 4));
    let i = 0;
    for (let t = +start; t <= +end; t += 86400000) {
      const d = new Date(t);
      const dow = d.getUTCDay();
      if (dow === 0 || dow === 6) continue;
      daily.push({ date: d.toISOString().slice(0, 10), price: 100 + i });
      i++;
    }
    const r = periodReturnsFromSeries(daily, { asOf: '2026-09-04' });
    expect(r.y1).not.toBeNull();
    expect(r.meta.y1.estimate).toBe(false);
  });
});
