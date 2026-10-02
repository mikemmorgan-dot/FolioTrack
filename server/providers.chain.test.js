import { describe, it, expect } from 'vitest';
import { PROVIDERS, getHistory, getQuote, providersForSymbol } from './providers.js';

describe('TSX provider hop order', () => {
  it('tries Yahoo query1 then query2, keeps Stooq, and skips free-tier gaps', () => {
    const tsx = providersForSymbol('ENB.TO').map((p) => p.id);
    expect(tsx).toEqual(['yahoo', 'yahoo-query2', 'stooq', 'alphavantage']);
    expect(tsx).not.toContain('twelvedata');
    expect(tsx).not.toContain('finnhub');
    expect(providersForSymbol('vfv.to').map((p) => p.id)).toEqual(tsx);
    expect(providersForSymbol('TECK.B.TO').map((p) => p.id)).toEqual(tsx);

    for (const symbol of ['ABC.V', 'NEO.NE', 'CSE.CN']) {
      expect(providersForSymbol(symbol).map((p) => p.id)).toEqual([
        'yahoo', 'yahoo-query2', 'stooq',
      ]);
    }

    expect(providersForSymbol('AAPL').map((p) => p.id)).toEqual(PROVIDERS.map((p) => p.id));
    expect(providersForSymbol('BRK.B').map((p) => p.id)).toEqual(PROVIDERS.map((p) => p.id));
  });

  it('wires quote and history through that per-symbol list', () => {
    expect(getQuote.toString()).toContain('providersForSymbol');
    expect(getHistory.toString()).toContain('providersForSymbol');
  });
});
