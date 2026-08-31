// util.test.js — see perf.test.js's header note on verification method.
import { describe, it, expect } from 'vitest';
import { holdingsEqual } from './util.js';

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
