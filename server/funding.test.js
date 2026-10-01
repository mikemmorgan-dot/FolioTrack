import { describe, it, expect } from 'vitest';
import {
  FUND_CASH,
  FUND_MANUAL,
  FUND_PROPORTIONAL,
  addDisabled,
  allocationState,
  applyFunding,
  fundAllocation,
  largestRemainder,
  previewGate,
  roundPercent,
} from '../client/src/funding.js';

const sumUnits = (rows) => rows.reduce((s, r) => s + Math.round(r.weightPct * 100), 0);

const book = (pairs) => pairs.map(([symbol, weightPct, isCash]) => ({
  key: symbol,
  uiKey: symbol,
  symbol,
  name: symbol,
  weightPct,
  type: isCash ? 'cash' : 'stock',
  isCash: !!isCash,
}));

describe('largestRemainder', () => {
  it('repairs a penny so the rounded weights sum to the target', () => {
    const out = largestRemainder([29.997, 29.997, 30.006], 90, 2);
    expect(sumUnits(out.map((weightPct) => ({ weightPct })))).toBe(9000);
    expect(out.reduce((s, n) => s + n, 0)).toBeCloseTo(90, 10);
  });
});

describe('proportional funding', () => {
  it('scales non-cash holdings by (100 - newWeight) / 100 and sums to 100.00', () => {
    const out = fundAllocation({
      holdings: book([['VFV', 70], ['XEF', 30]]),
      newHolding: { key: 'n', symbol: 'AVGO' },
      mode: FUND_PROPORTIONAL,
      allocationPct: 25,
    });
    expect(out.canAdd).toBe(true);
    expect(out.rows.find((r) => r.symbol === 'VFV').weightPct).toBe(52.5);
    expect(out.rows.find((r) => r.symbol === 'XEF').weightPct).toBe(22.5);
    expect(out.rows.find((r) => r.symbol === 'AVGO').weightPct).toBe(25);
    expect(sumUnits(out.rows)).toBe(10000);
    expect(out.total).toBe(100);
  });

  it('scales cash by the same factor when the book is already 100%', () => {
    const out = fundAllocation({
      holdings: book([['VFV', 80], ['CASH', 20, true]]),
      newHolding: { key: 'n', symbol: 'AVGO' },
      mode: FUND_PROPORTIONAL,
      allocationPct: 10,
    });
    expect(out.rows.find((r) => r.symbol === 'VFV').weightPct).toBe(72);
    expect(out.rows.find((r) => r.symbol === 'CASH').weightPct).toBe(18);
    expect(out.rows.find((r) => r.symbol === 'AVGO').weightPct).toBe(10);
    expect(sumUnits(out.rows)).toBe(10000);
  });

  it('largest-remainder rounding still sums to exactly 100.00', () => {
    const out = fundAllocation({
      holdings: book([['A', 33.33], ['B', 33.33], ['C', 33.34]]),
      newHolding: { key: 'n', symbol: 'AVGO' },
      mode: FUND_PROPORTIONAL,
      allocationPct: 10,
    });
    expect(out.newWeightPct).toBe(10);
    expect(sumUnits(out.rows)).toBe(10000);
    expect(out.total).toBe(100);
    for (const r of out.rows) expect(r.weightPct).toBe(roundPercent(r.weightPct));
  });

  it('keeps an awkward allocation on the new holding and parks pennies on the existing book', () => {
    const out = fundAllocation({
      holdings: book([['A', 10.1], ['B', 20.2], ['C', 69.7]]),
      newHolding: { key: 'n', symbol: 'AVGO' },
      mode: FUND_PROPORTIONAL,
      allocationPct: 7.77,
    });
    expect(out.rows.find((r) => r.symbol === 'AVGO').weightPct).toBe(7.77);
    expect(sumUnits(out.rows)).toBe(10000);
  });
});

describe('cash funding', () => {
  it('takes the new weight from cash and leaves other holdings put', () => {
    const out = fundAllocation({
      holdings: book([['VFV', 80], ['CASH', 20, true]]),
      newHolding: { key: 'n', symbol: 'AVGO' },
      mode: FUND_CASH,
      allocationPct: 10,
    });
    expect(out.canAdd).toBe(true);
    expect(out.cashNegative).toBe(false);
    expect(out.rows.find((r) => r.symbol === 'VFV').weightPct).toBe(80);
    expect(out.rows.find((r) => r.symbol === 'CASH').weightPct).toBe(10);
    expect(out.rows.find((r) => r.symbol === 'AVGO').weightPct).toBe(10);
    expect(sumUnits(out.rows)).toBe(10000);
  });

  it('warns and refuses to add when cash would go negative', () => {
    const out = fundAllocation({
      holdings: book([['VFV', 92], ['CASH', 8, true]]),
      newHolding: { key: 'n', symbol: 'AVGO' },
      mode: FUND_CASH,
      allocationPct: 10,
    });
    expect(out.canAdd).toBe(false);
    expect(out.cashNegative).toBe(true);
    expect(out.warning).toMatch(/negative/i);
    expect(out.rows.find((r) => r.symbol === 'CASH').weightPct).toBe(-2);
    expect(out.rows.find((r) => r.symbol === 'VFV').weightPct).toBe(92);
  });

  it('refuses when the model has no cash holding', () => {
    const out = fundAllocation({
      holdings: book([['VFV', 100]]),
      newHolding: { key: 'n', symbol: 'AVGO' },
      mode: FUND_CASH,
      allocationPct: 5,
    });
    expect(out.canAdd).toBe(false);
    expect(out.warning).toMatch(/no cash/i);
  });
});

describe('manual funding', () => {
  it('adds the new weight and does not touch existing holdings', () => {
    const out = fundAllocation({
      holdings: book([['VFV', 60], ['XEF', 40]]),
      newHolding: { key: 'n', symbol: 'AVGO' },
      mode: FUND_MANUAL,
      allocationPct: 10,
    });
    expect(out.canAdd).toBe(true);
    expect(out.rows.find((r) => r.symbol === 'VFV').weightPct).toBe(60);
    expect(out.rows.find((r) => r.symbol === 'XEF').weightPct).toBe(40);
    expect(out.rows.find((r) => r.symbol === 'AVGO').weightPct).toBe(10);
    expect(out.total).toBe(110);
  });
});

describe('applyFunding', () => {
  it('writes funded weights onto the draft rows', () => {
    const rows = book([['VFV', 70], ['XEF', 30]]);
    const result = applyFunding(rows, {
      symbol: 'AVGO', name: 'Broadcom', type: 'stock', source: 'auto',
    }, { mode: FUND_PROPORTIONAL, allocationPct: 10 });
    expect(result.applied).not.toBeNull();
    expect(result.applied.find((r) => r.symbol === 'VFV').weightPct).toBe(63);
    expect(result.applied.find((r) => r.symbol === 'XEF').weightPct).toBe(27);
    expect(result.applied.find((r) => r.symbol === 'AVGO').weightPct).toBe(10);
    expect(result.applied.find((r) => r.symbol === 'VFV').name).toBe('VFV');
  });

  it('does not apply a negative-cash funding', () => {
    const rows = book([['VFV', 95], ['CASH', 5, true]]);
    const result = applyFunding(rows, { symbol: 'AVGO', name: 'Broadcom', type: 'stock' }, {
      mode: FUND_CASH, allocationPct: 10,
    });
    expect(result.applied).toBeNull();
    expect(result.canAdd).toBe(false);
  });
});

describe('allocation and disabled state', () => {
  it('accepts decimals between 0 and 100 and rejects empty, zero, and out of range', () => {
    expect(allocationState('').valid).toBe(false);
    expect(allocationState('0').valid).toBe(false);
    expect(allocationState('0.0').valid).toBe(false);
    expect(allocationState('-1').valid).toBe(false);
    expect(allocationState('101').valid).toBe(false);
    expect(allocationState('abc').valid).toBe(false);
    expect(allocationState('0.004').valid).toBe(false);
    expect(allocationState('0.01').valid).toBe(true);
    expect(allocationState('0.01').value).toBe(0.01);
    expect(allocationState('12.5').valid).toBe(true);
    expect(allocationState('12.5').value).toBe(12.5);
    expect(allocationState('100').valid).toBe(true);
    expect(allocationState('12.345').value).toBe(12.35);
  });

  it('blocks preview while adding until weight and ticker are present', () => {
    expect(previewGate({ adding: false, allocationRaw: '' }).blocked).toBe(false);
    expect(previewGate({ adding: true, allocationRaw: '', symbol: 'AVGO' }).blocked).toBe(true);
    expect(previewGate({ adding: true, allocationRaw: '0', symbol: 'AVGO' }).blocked).toBe(true);
    expect(previewGate({ adding: true, allocationRaw: '5', symbol: '' }).blocked).toBe(true);
    expect(previewGate({ adding: true, allocationRaw: '5', symbol: 'AVGO' }).blocked).toBe(false);
    expect(previewGate({ adding: true, allocationRaw: '5', symbol: 'CASH', isCash: true }).blocked).toBe(false);
    expect(previewGate({ adding: true, allocationRaw: '', symbol: '' }).message).toMatch(/allocation above 0%/i);
  });

  it('blocks add until the allocation is valid and funding can be applied', () => {
    expect(addDisabled({ allocationRaw: '' }).disabled).toBe(true);
    expect(addDisabled({ allocationRaw: '0' }).disabled).toBe(true);
    const badCash = fundAllocation({
      holdings: book([['CASH', 4, true], ['VFV', 96]]),
      newHolding: { symbol: 'AVGO' },
      mode: FUND_CASH,
      allocationPct: 10,
    });
    expect(addDisabled({ allocationRaw: '10', funding: badCash, needsName: false }).disabled).toBe(true);
    const ok = fundAllocation({
      holdings: book([['VFV', 100]]),
      newHolding: { symbol: 'AVGO' },
      mode: FUND_PROPORTIONAL,
      allocationPct: 10,
    });
    expect(addDisabled({ allocationRaw: '10', funding: ok, needsName: true }).disabled).toBe(true);
    expect(addDisabled({ allocationRaw: '10', funding: ok, needsName: false }).disabled).toBe(false);
    expect(addDisabled({ allocationRaw: '10', funding: ok, duplicate: true }).disabled).toBe(true);
  });
});
