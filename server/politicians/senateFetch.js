// Senate eFD session. Search works only after the prohibition agreement.
// A 403, or an Akamai "Access Denied" page on any status, is a block of this
// client IP. A 429 or a 5xx without that page is a transient outage.

import { SENATE_BASE } from './parseSenate.js';

export const POLITICIAN_UA = 'FolioTrack/1.0 (model-portfolio research; +https://foliotrack.onrender.com)';

export const SENATE_PAGE = 100;

export function senateAnnualSearchParams(offset = 0) {
  return {
    start: String(offset),
    length: String(SENATE_PAGE),
    report_types: '[7]',
    filer_types: '[1]',
  };
}

export function bodySnippet(body, limit = 160) {
  const text = String(body || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/name="csrfmiddlewaretoken"\s+value="[^"]*"/gi, 'name="csrfmiddlewaretoken" value="[redacted]"')
    .replace(/csrfmiddlewaretoken["'\s:=]+[^"'&\s<]+/gi, 'csrfmiddlewaretoken=[redacted]')
    .replace(/csrftoken=[^;\s]+/gi, 'csrftoken=[redacted]')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return text.slice(0, limit);
}

function headerValue(headers, name) {
  if (!headers || typeof headers.get !== 'function') return '';
  return String(headers.get(name) || '');
}

export function isSenateBlock({ status, body, headers } = {}) {
  const code = Number(status) || 0;
  if (code === 403) return true;
  const text = String(body || '');
  const server = headerValue(headers, 'server');
  const denied = /access denied/i.test(text) || /you don't have permission to access/i.test(text);
  const akamai = /akamai|edgesuite|akamaighost/i.test(text)
    || /akamai|akamaighost/i.test(server)
    || /reference\s*#\s*\d/i.test(text);
  if (denied && akamai) return true;
  if (denied && (code === 403 || code === 503)) return true;
  return false;
}

export function classifySenateResponse({ status, body, headers } = {}) {
  const code = Number(status) || 0;
  const snippet = bodySnippet(body);
  if (isSenateBlock({ status: code, body, headers })) {
    return { kind: 'blocked', status: code, snippet };
  }
  if (code === 429 || code >= 500) return { kind: 'transient', status: code, snippet };
  return { kind: 'ok', status: code, snippet };
}

export function logSenateResponse(logger, step, verdict) {
  if (!logger || !verdict || verdict.kind === 'ok') return;
  const body = verdict.snippet ? ` body=${JSON.stringify(verdict.snippet)}` : '';
  const warn = typeof logger.warn === 'function' ? logger.warn.bind(logger) : logger.log.bind(logger);
  warn(`[senate] ${step} HTTP ${verdict.status} ${verdict.kind}${body}`);
}

async function http(fetchImpl, url, init = {}) {
  return fetchImpl(url, {
    method: init.method || 'GET',
    headers: {
      'User-Agent': POLITICIAN_UA,
      Accept: init.accept || '*/*',
      ...(init.headers || {}),
    },
    body: init.body,
    redirect: init.redirect || 'follow',
    signal: typeof AbortSignal !== 'undefined' && AbortSignal.timeout
      ? AbortSignal.timeout(init.timeoutMs || 30_000)
      : undefined,
  });
}

async function readText(res) {
  try {
    return typeof res.text === 'function' ? await res.text() : '';
  } catch {
    return '';
  }
}

function storeCookies(jar, res) {
  const list = typeof res.headers?.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
  const single = res.headers?.get?.('set-cookie');
  const all = list.length ? list : (single ? [single] : []);
  for (const cookie of all) {
    const pair = String(cookie).split(';')[0];
    const eq = pair.indexOf('=');
    if (eq > 0) jar[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim();
  }
}

export function cookieHeader(jar) {
  return Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
}

async function takeResponse(fetchImpl, step, url, init, onResponse) {
  const res = await http(fetchImpl, url, init);
  const body = await readText(res);
  const verdict = classifySenateResponse({ status: res.status, body, headers: res.headers });
  if (onResponse) onResponse({ step, ...verdict });
  return { res, body, verdict };
}

function failureOf(step, verdict) {
  return { ...verdict, step };
}

export async function openSenateSession(fetchImpl = globalThis.fetch, { onResponse } = {}) {
  const jar = {};
  let seen = await takeResponse(fetchImpl, 'entry', `${SENATE_BASE}/search/`, { redirect: 'manual' }, onResponse);
  storeCookies(jar, seen.res);
  if (seen.verdict.kind === 'blocked' || seen.verdict.kind === 'transient') {
    return { jar, failure: failureOf('home', seen.verdict) };
  }
  if (seen.res.status >= 300 && seen.res.status < 400) {
    const loc = new URL(seen.res.headers.get('location'), SENATE_BASE).href;
    seen = await takeResponse(fetchImpl, 'home', loc, {
      redirect: 'manual',
      headers: { Cookie: cookieHeader(jar) },
    }, onResponse);
    storeCookies(jar, seen.res);
    if (seen.verdict.kind === 'blocked' || seen.verdict.kind === 'transient') {
      return { jar, failure: failureOf('home', seen.verdict) };
    }
  }
  const token = /name="csrfmiddlewaretoken"\s+value="([^"]+)"/i.exec(seen.body);
  if (!token) {
    const verdict = classifySenateResponse({ status: seen.res.status, body: seen.body, headers: seen.res.headers });
    if (verdict.kind === 'blocked') return { jar, failure: failureOf('home', verdict) };
    const err = new Error('Senate eFD did not return the agreement form');
    err.step = 'home';
    err.snippet = bodySnippet(seen.body);
    err.status = seen.res.status;
    throw err;
  }
  const agreed = await takeResponse(fetchImpl, 'agreement', `${SENATE_BASE}/search/home/`, {
    method: 'POST',
    redirect: 'manual',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Cookie: cookieHeader(jar),
      Referer: `${SENATE_BASE}/search/home/`,
      Origin: SENATE_BASE,
    },
    body: new URLSearchParams({
      prohibition_agreement: '1',
      csrfmiddlewaretoken: token[1],
    }).toString(),
  }, onResponse);
  storeCookies(jar, agreed.res);
  if (agreed.verdict.kind === 'blocked' || agreed.verdict.kind === 'transient') {
    return { jar, failure: failureOf('agreement', agreed.verdict) };
  }
  if (!jar.csrftoken) {
    const err = new Error('Senate eFD did not set a session cookie');
    err.step = 'agreement';
    err.snippet = bodySnippet(agreed.body);
    err.status = agreed.res.status;
    throw err;
  }
  return { jar, failure: null };
}

export async function postSenateSearch(fetchImpl, jar, params, { onResponse } = {}) {
  const seen = await takeResponse(fetchImpl, 'search', `${SENATE_BASE}/search/report/data/`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'X-CSRFToken': jar.csrftoken,
      Cookie: cookieHeader(jar),
      Referer: `${SENATE_BASE}/search/`,
    },
    body: new URLSearchParams(params).toString(),
  }, onResponse);
  return { text: seen.body, verdict: seen.verdict, res: seen.res };
}

export function probeResult(steps) {
  const blocked = steps.find((step) => step.kind === 'blocked');
  if (blocked) return 'blocked';
  const search = [...steps].reverse().find((step) => step.step === 'search');
  if (search?.status === 200 && search.kind === 'ok') return 'reachable';
  if (steps.some((step) => step.kind === 'transient')) return 'transient';
  return 'unreachable';
}

export async function probeSenateAccess({ fetchImpl = globalThis.fetch, logger = console } = {}) {
  const steps = [];
  const onResponse = (row) => {
    steps.push(row);
    const body = row.snippet ? ` body=${JSON.stringify(row.snippet)}` : '';
    logger.log(`[senate-probe] step=${row.step} status=${row.status} kind=${row.kind}${body}`);
  };
  try {
    const session = await openSenateSession(fetchImpl, { onResponse });
    if (!session.failure) {
      await postSenateSearch(fetchImpl, session.jar, senateAnnualSearchParams(0), { onResponse });
    }
  } catch (err) {
    const snippet = err.snippet ? ` body=${JSON.stringify(err.snippet)}` : '';
    logger.log(`[senate-probe] step=${err.step || 'request'} status=${err.status || 'none'} kind=error message=${JSON.stringify(String(err.message || err))}${snippet}`);
    steps.push({
      step: err.step || 'request',
      status: Number(err.status) || 0,
      kind: 'error',
      snippet: err.snippet || bodySnippet(err.message),
    });
  }
  const result = probeResult(steps);
  logger.log(`[senate-probe] result=${result}`);
  return { result, steps };
}
