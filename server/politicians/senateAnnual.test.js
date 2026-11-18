import { describe, expect, it } from 'vitest';
import { memoryMethods, politicianBucket } from './memoryStore.js';
import {
  mergeAnnualSlice,
  runAnnualSlice,
  runSenateAnnualSlice,
} from './annualIngest.js';
import { exitCodeForSenateAnnual, formatSenateAnnualSummary, main } from './senateAnnualCli.js';
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
    expect(exitCodeForSenateAnnual({ senate: { error: 'senate returned HTTP 400', kind: 'other' } })).toBe(0);
    expect(exitCodeForSenateAnnual({ senate: { error: 'boom' } })).toBe(1);
  });
});

const DENIED = '<html><title>Access Denied</title><body>Access Denied</body></html>';
const JUSTICE_ID = '5a069df5-928e-4ce3-b505-e0b2312823c8';
const COLLINS_ID = '11111111-2222-4333-8444-555555555555';

function captureLogger() {
  const lines = [];
  const write = (line) => lines.push(String(line));
  return { lines, log: write, warn: write, error: write };
}

function annualRow(first, last, id, date = '09/08/2026') {
  return [
    first,
    last,
    'Senator',
    `<a href="/search/view/annual/${id}/">Annual Report for CY 2025</a>`,
    date,
  ];
}

function searchJson(rows, recordsFiltered = 1619, recordsTotal = recordsFiltered) {
  return JSON.stringify({ recordsTotal, recordsFiltered, data: rows });
}

function justiceFiling() {
  return {
    source: 'senate',
    filingKey: JUSTICE_ID,
    first: 'James',
    last: 'Justice',
    kind: 'annual',
    filedDate: '2026-09-08',
    reportYear: 2025,
    filingKind: 'original',
    personKey: 'senate:justice:james',
    office: 'senate',
    party: 'R',
    state: 'WV',
    filerStatus: 'member',
    sourceUrl: `https://efdsearch.senate.gov/search/view/annual/${JUSTICE_ID}/`,
  };
}

function withSession(onRest, calls) {
  return async (url, init = {}) => {
    const method = init.method || 'GET';
    const u = String(url);
    calls.push(`${method} ${u}`);
    if (u.endsWith('/search/') && method === 'GET') {
      return respond(302, '', { location: 'https://efdsearch.senate.gov/search/home/' });
    }
    if (u.endsWith('/search/home/') && method === 'GET') {
      return respond(200, '<input type="hidden" name="csrfmiddlewaretoken" value="token-1">', { 'content-type': 'text/html' });
    }
    if (u.endsWith('/search/home/') && method === 'POST') {
      return respond(302, '', { 'set-cookie': 'csrftoken=csrf-1; Path=/' });
    }
    return onRest(u, method, init);
  };
}

const twoRoster = {
  house: [],
  senate: parseSenateRoster(`
    <member><last_name>Justice</last_name><first_name>James</first_name><party>R</party><state>WV</state></member>
    <member><last_name>Collins</last_name><first_name>Susan</first_name><party>R</party><state>ME</state></member>
  `),
};

function runSlice({ store, fetchImpl, logger, indexPages, roster: useRoster = roster, deadline }) {
  return runSenateAnnualSlice({
    store,
    roster: useRoster,
    delayMs: 0,
    sleep: async () => {},
    deadline: deadline === undefined ? Date.now() + 5000 : deadline,
    logger,
    fetchImpl,
    cap: 5,
    ...(indexPages == null ? {} : { indexPages }),
  });
}

describe('Senate annual index at offset 300', () => {
  function scripted(pages) {
    const calls = [];
    const posts = [];
    const fetchImpl = withSession((u, method, init) => {
      if (u.endsWith('/search/report/data/') && method === 'POST') {
        const start = Number(new URLSearchParams(init.body).get('start'));
        posts.push(start);
        const page = pages(start, posts.length);
        return respond(page.status, page.body, { 'content-type': page.contentType || 'application/json' });
      }
      if (u.includes('/search/view/annual/')) return respond(200, ANNUAL_HTML, { 'content-type': 'text/html' });
      return respond(404, 'missing');
    }, calls);
    return { calls, posts, fetchImpl };
  }

  it.each([
    ['other', 400, 'text/plain', 'bad request', 'other', 'http', 2],
    ['blocked', 403, 'text/html', DENIED, 'blocked', 'http', 1],
    ['transient', 503, 'text/html', 'WEBSITE TEMPORARILY UNAVAILABLE DUE TO MAINTENANCE', 'transient', 'http', 1],
    ['unparseable', 200, 'text/html', '<html>not json</html>', 'other', 'unparseable', 2],
  ])('stops at offset 300 on a %s response and records it', async (_label, status, contentType, body, kind, reason, searches) => {
    const store = memoryStore({ senate: { offset: 300, done: false, indexedAt: null, queue: [justiceFiling()] } });
    const logger = captureLogger();
    const { posts, calls, fetchImpl } = scripted(() => ({ status, body, contentType }));
    const result = await runSlice({ store, fetchImpl, logger });
    expect(posts).toEqual(Array(searches).fill(300));
    expect(posts).not.toContain(0);
    expect(result.senate.indexDone).toBe(false);
    expect(result.senate.downloaded).toBe(0);
    expect(result.senate.kind).toBe(kind);
    expect(result.senate.stop).toBe(reason);
    const saved = store.db.politicianAnnual.senate;
    expect(saved.done).toBe(false);
    expect(saved.offset).toBe(300);
    expect(saved.indexedAt).toBeNull();
    expect(saved.stop).toMatchObject({ reason, offset: 300, status, kind });
    expect(saved.stop.contentType).toContain(contentType);
    expect(store.db.politicianAnnual.backoff.senate.kind).toBe(kind);
    const stopped = logger.lines.find((line) => line.startsWith('[annual] senate index stopped:'));
    expect(stopped).toContain(`status=${status}`);
    expect(stopped).toContain('content-type=');
    expect(stopped).toContain('recordsTotal=');
    expect(stopped).toContain('recordsFiltered=');
    expect(stopped).toContain('rows=');
    expect(stopped).toContain('body=');
    expect(logger.lines.join('\n')).not.toContain('token-1');
    expect(logger.lines.join('\n')).not.toContain('csrf-1');
    expect(calls.some((line) => line.includes('/search/view/annual/'))).toBe(false);
    if (kind === 'blocked') {
      const wait = Date.parse(store.db.politicianAnnual.backoff.senate.until) - Date.now();
      expect(wait).toBeGreaterThan(11 * 60 * 60 * 1000);
    } else {
      const wait = Date.parse(store.db.politicianAnnual.backoff.senate.until) - Date.now();
      expect(wait).toBeGreaterThan(4 * 60 * 1000);
      expect(wait).toBeLessThan(6 * 60 * 1000);
    }
  });

  it('does not treat an empty page before recordsFiltered as the end of the index', async () => {
    const store = memoryStore({ senate: { offset: 300, done: false, indexedAt: null, queue: [] } });
    const logger = captureLogger();
    const { posts, fetchImpl } = scripted(() => ({
      status: 200,
      body: searchJson([], 1619),
    }));
    const result = await runSlice({ store, fetchImpl, logger });
    expect(posts).toEqual([300]);
    expect(result.senate.indexDone).toBe(false);
    expect(result.senate.kind).toBe('other');
    expect(result.senate.stop).toBe('empty-page');
    expect(store.db.politicianAnnual.senate.done).toBe(false);
    expect(store.db.politicianAnnual.senate.offset).toBe(300);
    const stopped = logger.lines.find((line) => line.startsWith('[annual] senate index stopped:'));
    expect(stopped).toContain('reason=empty-page');
    expect(stopped).toContain('status=200');
    expect(stopped).toContain('recordsTotal=1619');
    expect(stopped).toContain('recordsFiltered=1619');
    expect(stopped).toContain('rows=0');
    expect(stopped).toContain('content-type="application/json"');
  });

  it('completes when offset is already at recordsFiltered and then downloads', async () => {
    const store = memoryStore({ senate: { offset: 300, done: false, indexedAt: null, queue: [justiceFiling()] } });
    const logger = captureLogger();
    const { posts, calls, fetchImpl } = scripted(() => ({
      status: 200,
      body: searchJson([], 300),
    }));
    const result = await runSlice({ store, fetchImpl, logger });
    expect(posts).toEqual([300]);
    expect(result.senate.indexDone).toBe(true);
    expect(result.senate.downloaded).toBe(1);
    expect(result.senate.stop).toBeNull();
    expect(store.db.politicianAnnual.senate.done).toBe(true);
    expect(store.db.politicianAnnual.senate.stop).toBeNull();
    expect(logger.lines.some((line) => line.startsWith('[annual] senate index stopped:'))).toBe(false);
    expect(calls.filter((line) => line.includes('/search/view/annual/'))).toHaveLength(1);
    expect(Object.values(store.db.politicianAnnualFilings)).toHaveLength(1);
  });

  it('resumes at the saved offset when indexedAt is missing, then downloads once the index is done', async () => {
    const store = memoryStore({ senate: { offset: 300, done: false, indexedAt: null, queue: [] } });
    const logger = captureLogger();
    const script = scripted((start) => ({
      status: 200,
      body: searchJson([annualRow('James', 'Justice', JUSTICE_ID)], start + 1),
    }));
    const first = await runSlice({ store, fetchImpl: script.fetchImpl, logger });
    expect(script.posts).toEqual([300]);
    expect(first.senate.indexDone).toBe(true);
    expect(first.senate.downloaded).toBe(1);
    expect(store.db.politicianAnnual.senate.done).toBe(true);
    expect(store.db.politicianAnnual.senate.offset).toBe(301);
    expect(store.db.politicianAnnual.senate.indexedAt).toEqual(expect.any(String));
    expect(store.db.politicianHoldings[0]).toMatchObject({ ticker: 'CAT' });

    const secondPosts = [];
    const second = await runSlice({
      store,
      logger: captureLogger(),
      fetchImpl: withSession((u, method, init) => {
        if (u.endsWith('/search/report/data/') && method === 'POST') {
          secondPosts.push(Number(new URLSearchParams(init.body).get('start')));
        }
        return respond(500, 'should not fetch');
      }, []),
    });
    expect(second.senate.downloaded).toBe(0);
    expect(secondPosts).toEqual([]);
  });

  it('keeps a page-cap cursor and continues on the next run', async () => {
    const store = memoryStore({ senate: { offset: 300, done: false, indexedAt: null, queue: [] } });
    const logger = captureLogger();
    let posts = [];
    const fetchImpl = () => withSession((u, method, init) => {
      if (u.endsWith('/search/report/data/') && method === 'POST') {
        const start = Number(new URLSearchParams(init.body).get('start'));
        posts.push(start);
        const row = start >= 301
          ? annualRow('Susan', 'Collins', COLLINS_ID, '05/15/2026')
          : annualRow('James', 'Justice', JUSTICE_ID);
        return respond(200, searchJson([row], 302), { 'content-type': 'application/json' });
      }
      if (u.includes('/search/view/annual/')) return respond(200, ANNUAL_HTML, { 'content-type': 'text/html' });
      return respond(404, '');
    }, []);
    const first = await runSlice({
      store,
      fetchImpl: fetchImpl(),
      logger,
      indexPages: 1,
      roster: twoRoster,
    });
    expect(posts).toEqual([300]);
    expect(first.senate.indexDone).toBe(false);
    expect(first.senate.downloaded).toBe(0);
    expect(first.senate.stop).toBe('page-cap');
    expect(store.db.politicianAnnual.senate.offset).toBe(301);
    expect(store.db.politicianAnnual.senate.done).toBe(false);
    const stopped = logger.lines.find((line) => line.startsWith('[annual] senate index stopped:'));
    expect(stopped).toContain('reason=page-cap');
    expect(stopped).toContain('status=200');
    expect(stopped).toContain('recordsFiltered=302');
    expect(stopped).toContain('rows=1');
    expect(stopped).toContain('content-type="application/json"');

    posts = [];
    const second = await runSlice({
      store,
      fetchImpl: fetchImpl(),
      logger: captureLogger(),
      indexPages: 1,
      roster: twoRoster,
    });
    expect(posts).toEqual([301]);
    expect(second.senate.indexDone).toBe(true);
    expect(second.senate.downloaded).toBe(2);
    expect(store.db.politicianAnnual.senate.done).toBe(true);
    expect(Object.keys(store.db.politicianAnnualFilings)).toHaveLength(2);
  });

  it('walks more than three pages from the saved offset on the Actions run', async () => {
    const store = memoryStore({ senate: { offset: 300, done: false, indexedAt: null, queue: [] } });
    const { posts, fetchImpl } = scripted(() => ({
      status: 200,
      body: searchJson([annualRow('James', 'Justice', JUSTICE_ID)], 10000),
    }));
    const result = await runSlice({ store, fetchImpl, logger: captureLogger() });
    expect(posts[0]).toBe(300);
    expect(posts).toHaveLength(40);
    expect(posts).not.toContain(0);
    expect(result.senate.indexDone).toBe(false);
    expect(result.senate.downloaded).toBe(0);
    expect(store.db.politicianAnnual.senate.offset).toBe(340);
    expect(store.db.politicianAnnual.senate.stop.reason).toBe('page-cap');
  });

  it('reads only three pages when the shared annual slice is pacing the backlog', async () => {
    const store = memoryStore();
    const posts = [];
    const logger = captureLogger();
    await runAnnualSlice({
      store,
      roster,
      delayMs: 0,
      sleep: async () => {},
      deadline: Date.now() + 5000,
      logger,
      fetchImpl: withSession((u, method, init) => {
        if (u.endsWith('/search/report/data/') && method === 'POST') {
          posts.push(Number(new URLSearchParams(init.body).get('start')));
          return respond(200, searchJson([annualRow('James', 'Justice', JUSTICE_ID)], 10000), { 'content-type': 'application/json' });
        }
        return respond(404, '');
      }, []),
    });
    expect(posts).toEqual([0, 1, 2]);
    expect(store.db.politicianAnnual.senate.offset).toBe(3);
    expect(store.db.politicianAnnual.senate.done).toBe(false);
    expect(store.db.politicianAnnual.senate.stop.reason).toBe('page-cap');
    expect(logger.lines.some((line) => line.includes('reason=page-cap') && line.includes('recordsFiltered=10000'))).toBe(true);
  });

  it('restarts a finished index once it is a day old', async () => {
    const store = memoryStore({
      senate: {
        offset: 500,
        done: true,
        indexedAt: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(),
        queue: [],
      },
    });
    const { posts, fetchImpl } = scripted(() => ({ status: 200, body: searchJson([], 0) }));
    const result = await runSlice({ store, fetchImpl, logger: captureLogger() });
    expect(posts).toEqual([0]);
    expect(result.senate.indexDone).toBe(true);
  });

  it('downloads filings already indexed after the same offset fails twice', async () => {
    const store = memoryStore({
      senate: { offset: 300, done: false, indexedAt: null, stalls: 1, queue: [justiceFiling()] },
    });
    const logger = captureLogger();
    const { calls, fetchImpl } = scripted(() => ({ status: 400, contentType: 'text/plain', body: 'bad request' }));
    const result = await runSlice({ store, fetchImpl, logger });
    expect(result.senate.indexDone).toBe(false);
    expect(result.senate.downloaded).toBe(1);
    expect(result.senate.kind).toBe('other');
    expect(store.db.politicianAnnual.senate.done).toBe(false);
    expect(store.db.politicianAnnual.senate.stalls).toBe(2);
    expect(logger.lines.some((line) => line.includes('downloading filings already indexed'))).toBe(true);
    expect(calls.filter((line) => line.includes('/search/view/annual/'))).toHaveLength(1);
    expect(formatSenateAnnualSummary(result)).toContain('stop=http');
    expect(formatSenateAnnualSummary(result)).toContain('indexDone=false');
  });

  it('refreshes the agreement once and continues when the next search succeeds', async () => {
    const store = memoryStore({ senate: { offset: 300, done: false, indexedAt: null, queue: [] } });
    const logger = captureLogger();
    const { posts, calls, fetchImpl } = scripted((_start, nth) => (
      nth === 1
        ? { status: 400, contentType: 'text/plain', body: 'bad request' }
        : { status: 200, body: searchJson([annualRow('James', 'Justice', JUSTICE_ID)], 301) }
    ));
    const result = await runSlice({ store, fetchImpl, logger });
    expect(posts).toEqual([300, 300]);
    expect(result.senate.indexDone).toBe(true);
    expect(result.senate.downloaded).toBe(1);
    expect(result.senate.error).toBeUndefined();
    expect(store.db.politicianAnnual.backoff.senate).toBeNull();
    expect(logger.lines.some((line) => line.includes('refreshing the agreement after HTTP 400 at offset=300'))).toBe(true);
    expect(calls.filter((line) => line === 'POST https://efdsearch.senate.gov/search/home/')).toHaveLength(3);
  });
});
