import { describe, expect, it } from 'vitest';
import { officeShort, searchKeyAction, tickerSymbol } from './politicianSearch.js';

const pelosi = { kind: 'person', key: 'house:pelosi:nancy' };
const aapl = { kind: 'ticker', key: 'ticker:AAPL', symbol: 'AAPL' };

describe('politician search keyboard and tickers', () => {
  it('labels offices the way the suggestion row does', () => {
    expect(officeShort('house')).toBe('House');
    expect(officeShort('senate')).toBe('Senate');
    expect(officeShort('president')).toBe('President');
    expect(officeShort('vice-president')).toBe('VP');
  });

  it('treats AAPL as a ticker and a longer name as a person', () => {
    expect(tickerSymbol('AAPL')).toBe('AAPL');
    expect(tickerSymbol('aapl', { settled: true, hasPeople: false })).toBe('AAPL');
    expect(tickerSymbol('brk.b')).toBe('BRK.B');
    expect(tickerSymbol('pelosi')).toBeNull();
    expect(tickerSymbol('nancy', { settled: true, hasPeople: true })).toBeNull();
    expect(tickerSymbol('nancy', { settled: false, hasPeople: false })).toBeNull();
    expect(tickerSymbol('TRUMP', { settled: true, hasPeople: true })).toBe('TRUMP');
  });

  it('opens the only match on enter and moves with the arrows', () => {
    expect(searchKeyAction({
      key: 'Enter', options: [pelosi], activeIndex: -1, open: true,
    })).toMatchObject({ activate: pelosi });
    expect(searchKeyAction({
      key: 'Enter', options: [pelosi, aapl], activeIndex: -1, open: true,
    }).activate).toBeNull();
    const down = searchKeyAction({
      key: 'ArrowDown', options: [pelosi, aapl], activeIndex: -1, open: false,
    });
    expect(down).toMatchObject({ open: true, activeIndex: 0, activate: null });
    expect(searchKeyAction({
      key: 'Enter', options: [pelosi, aapl], activeIndex: 1, open: true,
    })).toMatchObject({ activate: aapl });
    expect(searchKeyAction({
      key: 'Escape', options: [pelosi], activeIndex: 0, open: true,
    })).toMatchObject({ open: false, activeIndex: -1, activate: null });
  });
});
