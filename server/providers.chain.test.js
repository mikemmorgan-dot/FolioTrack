import { describe, it, expect } from 'vitest';
import { PROVIDERS, getHistory, getQuote, providersForSymbol } from './providers.js';

describe('TSX provider hop order', () => {
  it('tries TMX first for .TO and .V, then Yahoo, and skips free-tier gaps', () => {
    const tsx = providersForSymbol('ENB.TO').map((p) => p.id);
    expect(tsx).toEqual(['tmx', 'yahoo-query2', 'yahoo', 'stooq', 'alphavantage']);
    expect(tsx).not.toContain('twelvedata');
    expect(tsx).not.toContain('finnhub');
    expect(providersForSymbol('vfv.to').map((p) => p.id)).toEqual(tsx);
    expect(providersForSymbol('TECK.B.TO').map((p) => p.id)).toEqual(tsx);
    expect(providersForSymbol('AUMB.V').map((p) => p.id)).toEqual([
      'tmx', 'yahoo-query2', 'yahoo', 'stooq',
    ]);

    for (const symbol of ['NEO.NE', 'CSE.CN']) {
      expect(providersForSymbol(symbol).map((p) => p.id)).toEqual([
        'yahoo-query2', 'yahoo', 'stooq',
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
