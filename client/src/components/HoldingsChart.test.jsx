import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import HoldingsChart from './HoldingsChart.jsx';

afterEach(() => cleanup());

const holdings = {
  status: 'parsed',
  filing: { year: 2025, filedDate: '2026-07-01', kind: 'original', sourceUrl: 'https://example.test/278' },
  totals: {
    count: 3,
    label: 'At least $50,000,000',
    midpoint: 100,
    midpointLabel: '$100',
    openEnded: true,
  },
  classes: [{
    id: 'class-stock',
    kind: 'class',
    label: 'Stock',
    asset: '2 positions',
    pct: 60,
    midpoint: 60,
    count: 2,
    min: 1,
    max: 2,
    valueBound: 'range',
    assetClass: 'stock',
  }],
  positions: [{
    id: 'bucket-50',
    kind: 'bucket',
    label: 'Over $50M each (25 holdings)',
    asset: 'Over $50M each (25 holdings)',
    pct: 40,
    midpoint: 40,
    count: 25,
    min: 50000000,
    max: null,
    valueBound: 'at_least',
    names: ['APPLE INC', 'Trump Tower Commercial LLC'],
  }],
};

describe('holdings chart', () => {
  it('opens on asset class and can switch to a grouped position slice', () => {
    render(<HoldingsChart holdings={holdings} />);
    const assetClass = screen.getByRole('button', { name: 'Asset class' });
    const positions = screen.getByRole('button', { name: 'Positions' });
    expect(assetClass.getAttribute('aria-pressed')).toBe('true');
    expect(positions.getAttribute('aria-pressed')).toBe('false');
    expect(screen.getAllByText('Stock').length).toBeGreaterThan(0);
    expect(screen.queryByText('Over $50M each (25 holdings)')).toBeNull();

    fireEvent.click(positions);
    expect(positions.getAttribute('aria-pressed')).toBe('true');
    expect(assetClass.getAttribute('aria-pressed')).toBe('false');
    expect(screen.getAllByText('Over $50M each (25 holdings)').length).toBeGreaterThan(0);
    expect(screen.getByText('APPLE INC')).toBeTruthy();
    expect(screen.getByText('Trump Tower Commercial LLC')).toBeTruthy();
    expect(screen.queryByText('No ticker')).toBeNull();
  });
});
