import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../api.js';
import { SEARCH_DEBOUNCE_MS } from '../politicianSearch.js';
import PoliticianTrades from './PoliticianTrades.jsx';

vi.mock('../api.js', () => ({
  api: {
    politicianSummary: vi.fn(),
    politicianStatus: vi.fn(),
    politicianSettings: vi.fn(),
    politicianPeople: vi.fn(),
    politician: vi.fn(),
    politicianTrades: vi.fn(),
    savePoliticianSettings: vi.fn(),
    refreshPoliticianTrades: vi.fn(),
  },
}));

const nancy = {
  personKey: 'house:pelosi:nancy',
  personName: 'Nancy Pelosi',
  office: 'house',
  party: 'D',
  state: 'CA',
  filerStatus: 'member',
  tradeCount: 3,
};

function pelosiPage(extra = {}) {
  return {
    person: {
      personKey: nancy.personKey,
      personName: 'Nancy Pelosi',
      office: 'house',
      party: 'D',
      state: 'CA',
      filerStatus: 'member',
    },
    counts: { buy: 2, sell: 1, exchange: 0, trades: 3 },
    topTickers: [{ ticker: 'AAPL', count: 1 }],
    latestDisclosure: '2026-11-06',
    window: { days: 30, from: '2026-10-16', to: '2026-11-14' },
    items: [{
      kind: 'trade',
      id: 'pelosi-1',
      personKey: nancy.personKey,
      personName: 'Nancy Pelosi',
      office: 'house',
      party: 'D',
      state: 'CA',
      ticker: 'NVDA',
      txType: 'sell',
      partial: false,
      asset: 'NVIDIA Corp',
      owner: 'spouse',
      amountRange: '$1,001 - $15,000',
      txDate: '2026-10-20',
      disclosedDate: '2026-11-06',
    }],
    total: 1,
    hasMore: false,
    offset: 0,
    limit: 40,
    ...extra,
  };
}

beforeEach(() => {
  api.politicianSummary.mockResolvedValue({
    bought: [], sold: [], clusters: [], clusterTotal: 0, excludedFilings: 0,
    from: '2026-10-16', to: '2026-11-14',
  });
  api.politicianStatus.mockResolvedValue({});
  api.politicianSettings.mockResolvedValue({
    politicianAlertsEnabled: true,
    politicianAlertsHeldOnly: false,
  });
  api.politicianPeople.mockResolvedValue({ q: 'pelosi', people: [nancy] });
  api.politician.mockResolvedValue(pelosiPage());
  api.politicianTrades.mockResolvedValue({ items: [], total: 0, hasMore: false });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.clearAllMocks();
});

function typeQuery(value) {
  fireEvent.change(screen.getByRole('combobox', { name: 'Find a politician' }), {
    target: { value },
  });
}

describe('politician search bar', () => {
  it('sits above the summary while the filings search stays collapsed', async () => {
    render(<PoliticianTrades onClose={() => {}} />);
    const search = screen.getByRole('combobox', { name: 'Find a politician' });
    const summary = screen.getByRole('region', { name: 'Trade summary' });
    expect(search.compareDocumentPosition(summary) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByRole('button', { name: /Filings/ }).getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByPlaceholderText('Pelosi or AAPL')).toBeNull();
    expect(search.getAttribute('aria-autocomplete')).toBe('list');
    await waitFor(() => expect(api.politicianSummary).toHaveBeenCalled());
  });

  it('waits until typing pauses, then shows name, office, party, state, and count', async () => {
    vi.useFakeTimers();
    render(<PoliticianTrades onClose={() => {}} />);
    typeQuery('pe');
    await act(async () => { await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS - 50); });
    typeQuery('pelosi');
    await act(async () => { await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS - 50); });
    expect(api.politicianPeople).not.toHaveBeenCalled();
    await act(async () => { await vi.advanceTimersByTimeAsync(50); });
    expect(api.politicianPeople).toHaveBeenCalledTimes(1);
    expect(api.politicianPeople).toHaveBeenCalledWith('pelosi');
    const option = screen.getByRole('option', { name: /Nancy Pelosi/ });
    expect(option.textContent).toContain('House');
    expect(option.textContent).toContain('Democrat');
    expect(option.textContent).toContain('CA');
    expect(option.textContent).toContain('3 trades');
  });

  it('opens her page from the suggestion and from enter when she is the only match', async () => {
    render(<PoliticianTrades onClose={() => {}} />);
    typeQuery('pelosi');
    const option = await screen.findByRole('option', { name: /Nancy Pelosi/ });
    fireEvent.mouseDown(option);
    expect(await screen.findByText('NVIDIA Corp')).toBeTruthy();
    expect(screen.getByText('Nancy Pelosi', { selector: '.ed-title' })).toBeTruthy();
    expect(api.politician).toHaveBeenCalledWith('house:pelosi:nancy', expect.objectContaining({ window: 30 }));

    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    typeQuery('pelosi');
    const input = screen.getByRole('combobox', { name: 'Find a politician' });
    await screen.findByRole('option', { name: /Nancy Pelosi/ });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(await screen.findByText('NVIDIA Corp')).toBeTruthy();
  });

  it('offers a ticker feed for AAPL and opens it', async () => {
    api.politicianPeople.mockResolvedValue({ q: 'AAPL', people: [] });
    render(<PoliticianTrades onClose={() => {}} />);
    typeQuery('AAPL');
    const option = await screen.findByRole('option', { name: /Show trades in AAPL/ });
    fireEvent.mouseDown(option);
    expect(screen.getByRole('button', { name: /Filings/ }).getAttribute('aria-expanded')).toBe('true');
    await waitFor(() => expect(api.politicianTrades).toHaveBeenCalled());
    const query = api.politicianTrades.mock.calls.at(-1)[0];
    expect(query.ticker).toBe('AAPL');
    expect(screen.getByRole('button', { name: /Filtered to AAPL/ })).toBeTruthy();
  });

  it('widens an empty 30-day page and names the latest disclosure', async () => {
    api.politicianPeople.mockResolvedValue({
      q: 'trump',
      people: [{
        personKey: 'president:trump:donald',
        personName: 'Donald Trump',
        office: 'president',
        party: 'R',
        state: null,
        tradeCount: 1,
      }],
    });
    api.politician.mockImplementation(async (_key, query) => {
      if (query.window) {
        return {
          person: {
            personKey: 'president:trump:donald',
            personName: 'Donald Trump',
            office: 'president',
            party: 'R',
            state: null,
          },
          counts: { buy: 1, sell: 0, exchange: 0, trades: 1 },
          topTickers: [],
          latestDisclosure: '2026-10-08',
          window: { days: 30, from: '2026-10-16', to: '2026-11-14' },
          items: [],
          total: 0,
          hasMore: false,
        };
      }
      return {
        person: {
          personKey: 'president:trump:donald',
          personName: 'Donald Trump',
          office: 'president',
          party: 'R',
          state: null,
        },
        counts: { buy: 1, sell: 0, exchange: 0, trades: 1 },
        topTickers: [],
        latestDisclosure: '2026-10-08',
        window: null,
        items: [{
          kind: 'trade',
          id: 'trump-1',
          personKey: 'president:trump:donald',
          personName: 'Donald Trump',
          office: 'president',
          party: 'R',
          ticker: 'DJT',
          txType: 'buy',
          partial: false,
          asset: 'Trump Media',
          owner: 'self',
          amountRange: '$1,001 - $15,000',
          txDate: '2026-10-01',
          disclosedDate: '2026-10-08',
        }],
        total: 1,
        hasMore: false,
      };
    });
    render(<PoliticianTrades onClose={() => {}} />);
    typeQuery('trump');
    fireEvent.mouseDown(await screen.findByRole('option', { name: /Donald Trump/ }));
    expect(await screen.findByText(/Latest disclosure was Oct 8, 2026/)).toBeTruthy();
    expect(screen.getByText(/No disclosures in the last 30 days/)).toBeTruthy();
    expect(screen.getByText('Trump Media')).toBeTruthy();
    expect(api.politician.mock.calls[0][1].window).toBe(30);
    expect(api.politician.mock.calls[1][1].window).toBeUndefined();
  });
});
