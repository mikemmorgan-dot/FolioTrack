import { describe, expect, it } from 'vitest';
import {
  bodySnippet,
  classifySenateResponse,
  isSenateBlock,
  probeResult,
  probeSenateAccess,
  senateAnnualSearchParams,
} from './senateFetch.js';
import { annualQueueSpot } from './annualQueueSpot.js';

const AKAMAI = '<HTML><HEAD><TITLE>Access Denied</TITLE></HEAD><BODY><H1>Access Denied</H1>You don\'t have permission to access "http://efdsearch.senate.gov/" on this server.<P>Reference #18.1abc.223344.55</BODY></HTML>';

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
  };
}

describe('Senate response class', () => {
  it('treats 403 and an Akamai deny page as a block, including a 503 page', () => {
    expect(isSenateBlock({ status: 403, body: '' })).toBe(true);
    expect(classifySenateResponse({ status: 403, body: AKAMAI }).kind).toBe('blocked');
    expect(classifySenateResponse({ status: 503, body: AKAMAI }).kind).toBe('blocked');
    expect(classifySenateResponse({ status: 503, body: 'upstream connect error' }).kind).toBe('transient');
    expect(classifySenateResponse({ status: 429, body: 'slow down' }).kind).toBe('transient');
    expect(classifySenateResponse({ status: 200, body: '<input name="csrfmiddlewaretoken" value="secret-token">' }).kind).toBe('ok');
  });

  it('keeps the snippet short and redacts the form token', () => {
    const snippet = bodySnippet('<input name="csrfmiddlewaretoken" value="secret-token"> Access Denied Reference #18.2');
    expect(snippet).not.toContain('secret-token');
    expect(snippet.length).toBeLessThanOrEqual(160);
  });
});

describe('Senate probe', () => {
  it('walks the agreement and one annual search', async () => {
    const calls = [];
    const lines = [];
    const fetchImpl = async (url, init = {}) => {
      const method = init.method || 'GET';
      calls.push(`${method} ${url}`);
      const u = String(url);
      if (u.endsWith('/search/') && method === 'GET') {
        return respond(302, '', { location: 'https://efdsearch.senate.gov/search/home/' });
      }
      if (u.endsWith('/search/home/') && method === 'GET') {
        return respond(200, '<input type="hidden" name="csrfmiddlewaretoken" value="token-1">');
      }
      if (u.endsWith('/search/home/') && method === 'POST') {
        return respond(302, '', { 'set-cookie': 'csrftoken=csrf-1; Path=/' });
      }
      if (u.endsWith('/search/report/data/') && method === 'POST') {
        expect(init.headers['X-CSRFToken']).toBe('csrf-1');
        expect(init.body).toContain('report_types=%5B7%5D');
        expect(init.body).toContain('length=100');
        return respond(200, JSON.stringify({ recordsFiltered: 1, data: [] }));
      }
      return respond(404, 'missing');
    };
    const result = await probeSenateAccess({
      fetchImpl,
      logger: { log(line) { lines.push(line); }, warn(line) { lines.push(line); } },
    });
    expect(result.result).toBe('reachable');
    expect(calls).toEqual([
      'GET https://efdsearch.senate.gov/search/',
      'GET https://efdsearch.senate.gov/search/home/',
      'POST https://efdsearch.senate.gov/search/home/',
      'POST https://efdsearch.senate.gov/search/report/data/',
    ]);
    expect(lines.some((line) => line.includes('step=search status=200'))).toBe(true);
    expect(lines.at(-1)).toBe('[senate-probe] result=reachable');
    expect(lines.join('\n')).not.toContain('token-1');
    expect(lines.join('\n')).not.toContain('csrf-1');
    expect(senateAnnualSearchParams(0).report_types).toBe('[7]');
  });

  it('stops after an Akamai block and does not call it reachable', async () => {
    const calls = [];
    const result = await probeSenateAccess({
      fetchImpl: async (url) => {
        calls.push(String(url));
        return respond(503, AKAMAI);
      },
      logger: { log() {}, warn() {} },
    });
    expect(result.result).toBe('blocked');
    expect(calls).toHaveLength(1);
    expect(probeResult([{ step: 'search', status: 200, kind: 'ok' }])).toBe('reachable');
    expect(probeResult([{ step: 'entry', status: 403, kind: 'blocked' }])).toBe('blocked');
  });
});

describe('annual queue spot', () => {
  it('counts unstored filings ahead of a person', () => {
    const queue = [
      { personKey: 'house:a:ann', filingKey: '2025:1' },
      { personKey: 'house:b:bea', filingKey: '2025:2' },
      { personKey: 'house:pelosi:nancy', filingKey: '2025:10075701', reportYear: 2025, filedDate: '2026-05-15', filingKind: 'original', filerStatus: 'member' },
    ];
    expect(annualQueueSpot({
      queue,
      storedKeys: ['2025:1'],
      personKey: 'house:pelosi:nancy',
    })).toMatchObject({
      found: true,
      position: 3,
      queueLength: 3,
      ahead: 1,
      stored: false,
      filingKey: '2025:10075701',
    });
    expect(annualQueueSpot({ queue, storedKeys: [], personKey: 'house:missing:x' }).found).toBe(false);
  });
});
