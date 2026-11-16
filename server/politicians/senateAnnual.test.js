import { describe, expect, it } from 'vitest';
import { memoryMethods, politicianBucket } from './memoryStore.js';
import {
  mergeAnnualSlice,
  runAnnualSlice,
  runSenateAnnualSlice,
} from './annualIngest.js';
import { exitCodeForSenateAnnual, main } from './senateAnnualCli.js';
import { parseSenateRoster } from './roster.js';

function memoryStore(state = {}) {
  const db = politicianBucket({});
  db.politicianAnnual = state;
  const store = { db };
  for (const [name, fn] of Object.entries(memoryMethods)) {
    store[name] = (...args) => fn.apply({ db, persist() {} }, args);
  }
  return store;
}

function hdrs(extra = {}) {
  return {
    get: (name) => extra[String(name).toLowerCase()] ?? null,
    getSetCookie: () => (extra['set-cookie'] ? [extra['set-cookie']] : []),
  };
}

function respond(status, body, extra = {}) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: hdrs(extra),
    text: async () => body,
    arrayBuffer: async () => Buffer.from(body),
  };
}

const ANNUAL_HTML = `<table><thead><tr>
  <th></th><th>Asset</th><th>Asset Type</th><th>Owner</th><th>Value</th><th>Income Type</th><th>Income</th>
</tr></thead><tbody>
  <tr><td>1</td>
    <td><strong><a href="http://finance.yahoo.com/q?s=CAT">CAT</a> - Caterpillar</strong></td>
    <td>Corporate Securities<div class="muted">Stock</div></td>
    <td>Self</td><td>$100,001 - $250,000</td><td>Dividends</td><td>None</td></tr>
</tbody></table>`;

const SEARCH = JSON.stringify({
  recordsFiltered: 1,
  data: [[
    'James',
    'Justice',
    'Senator',
    '<a href="/search/view/annual/5a069df5-928e-4ce3-b505-e0b2312823c8/">Annual Report for CY 2025</a>',
    '09/08/2026',
  ]],
});

function senateFetch(calls) {
  return async (url, init = {}) => {
    const method = init.method || 'GET';
    const u = String(url);
    calls.push(`${method} ${u}`);
    if (u.endsWith('/search/') && method === 'GET') {
      return respond(302, '', { location: 'https://efdsearch.senate.gov/search/home/' });
    }
    if (u.endsWith('/search/home/') && method === 'GET') {
      return respond(200, '<input type="hidden" name="csrfmiddlewaretoken" value="token-1">');
    }
    if (u.endsWith('/search/home/') && method === 'POST') {
      return respond(302, '', { 'set-cookie': 'csrftoken=csrf-1; Path=/' });
    }
    if (u.endsWith('/search/report/data/')) return respond(200, SEARCH);
    if (u.includes('/search/view/annual/')) return respond(200, ANNUAL_HTML);
    return respond(404, '');
  };
}

const roster = {
  house: [],
  senate: parseSenateRoster('<member><last_name>Justice</last_name><first_name>James</first_name><party>R</party><state>WV</state></member>'),
};

describe('Senate annual ingest', () => {
  it('keeps another writer\'s senate queue when this run only touched the House', () => {
    const merged = mergeAnnualSlice({
      senate: { offset: 1200, done: false, queue: [{ filingKey: 'keep' }] },
      house: { queue: [] },
      backoff: { senate: '2026-11-16T13:58:45.173Z' },
    }, {
      house: { queue: [{ filingKey: 'house-1' }] },
      backoff: { house: null },
      lastSummary: { house: { downloaded: 1 } },
    }, { house: true });
    expect(merged.senate.offset).toBe(1200);
    expect(merged.senate.queue).toHaveLength(1);
    expect(merged.house.queue[0].filingKey).toBe('house-1');
    expect(merged.backoff.senate).toBe('2026-11-16T13:58:45.173Z');
  });

  it('does not call Senate when Actions owns that source', async () => {
    const store = memoryStore({
      senate: { offset: 1200, done: false, queue: [{ filingKey: 'keep', personKey: 'senate:keep:kee' }] },
    });
    const calls = [];
    const result = await runAnnualSlice({
      store,
      env: { SENATE_ANNUAL_SOURCE: 'actions' },
      delayMs: 0,
      sleep: async () => {},
      deadline: Date.now() + 5000,
      logger: { log() {}, warn() {}, error() {} },
      fetchImpl: async (url) => {
        calls.push(String(url));
        if (String(url).includes('efdsearch.senate.gov')) throw new Error('fetched senate');
        return respond(404, '');
      },
    });
    expect(result.senate.skipped).toBe('actions');
    expect(calls.some((url) => url.includes('efdsearch.senate.gov'))).toBe(false);
    expect(store.db.politicianAnnual.senate.offset).toBe(1200);
  });

  it('stores one annual filing once and classifies the holding', async () => {
    const store = memoryStore();
    const calls = [];
    const quiet = { log() {}, warn() {}, error() {} };
    const first = await runSenateAnnualSlice({
      store,
      roster,
      delayMs: 0,
      sleep: async () => {},
      deadline: Date.now() + 5000,
      logger: quiet,
      fetchImpl: senateFetch(calls),
      cap: 5,
    });
    expect(first.senate.downloaded).toBe(1);
    expect(first.senate.indexDone).toBe(true);
    const filing = Object.values(store.db.politicianAnnualFilings)[0];
    expect(filing.personKey).toBe('senate:justice:james');
    expect(filing.parseStatus).toBe('parsed');
    expect(store.db.politicianHoldings[0]).toMatchObject({ ticker: 'CAT', assetClass: 'stock' });
    const reportCalls = calls.filter((line) => line.includes('/search/view/annual/'));
    expect(reportCalls).toHaveLength(1);

    calls.length = 0;
    const second = await runSenateAnnualSlice({
      store,
      roster,
      delayMs: 0,
      sleep: async () => {},
      deadline: Date.now() + 5000,
      logger: quiet,
      fetchImpl: senateFetch(calls),
      cap: 5,
    });
    expect(second.senate.downloaded).toBe(0);
    expect(calls.some((line) => line.includes('/search/view/annual/'))).toBe(false);
    expect(store.db.politicianHoldings).toHaveLength(1);
  });

  it('treats a maintenance page as transient and still exits 0', async () => {
    const store = memoryStore();
    const code = await main({
      DATABASE_URL: 'postgres://example.invalid/folio',
      POLITICIAN_FETCH_DELAY_MS: '0',
    }, {
      store,
      roster,
      catalog: null,
      sleep: async () => {},
      logger: { log() {}, warn() {}, error() {} },
      fetchImpl: async () => respond(503, 'WEBSITE TEMPORARILY UNAVAILABLE DUE TO MAINTENANCE'),
    });
    expect(code).toBe(0);
    expect(store.db.politicianAnnual.backoff.senate).toMatchObject({ kind: 'transient', status: 503 });
    expect(exitCodeForSenateAnnual({ senate: { error: 'senate returned HTTP 503', kind: 'transient' } })).toBe(0);
    expect(exitCodeForSenateAnnual({ senate: { error: 'boom' } })).toBe(1);
  });
});
