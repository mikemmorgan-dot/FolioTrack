// Latest annual disclosure per current member, plus the President and Vice
// President. A slice downloads a few filings, saves a cursor, and stops.
// Holdings never enter the trade digest.

import { houseIndexUrl } from './parseHouse.js';
import {
  parseHouseAnnualIndexTxt,
  parseHouseAnnualIndexXml,
  parseHouseAnnualPdf,
} from './parseHouseAnnual.js';
import { parseOgeAnnualApiRow, parseOgeAnnualPdf } from './parseOgeAnnual.js';
import { OGE_API } from './parseOge.js';
import {
  parseSenateAnnualHtml,
  parseSenateAnnualSearchRow,
  reviewPaperAnnual,
} from './parseSenateAnnual.js';
import { SENATE_BASE } from './parseSenate.js';
import { readZipEntries, zipText } from './zip.js';
import { buildAnnualFiling, buildHoldingRows, selectCurrentAnnual } from './annualRecords.js';
import { classifyHouseFiler, matchHouseParty, matchSenateParty } from './roster.js';
import { personKey } from './normalize.js';
import { splitStateDst } from './records.js';

const POLITICIAN_UA = 'FolioTrack/1.0 (model-portfolio research; +https://foliotrack.onrender.com)';

const INDEX_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const SENATE_PAGE = 100;

export function annualCoverage(filings) {
  const byPerson = new Map();
  for (const filing of filings || []) {
    const list = byPerson.get(filing.personKey) || [];
    list.push(filing);
    byPerson.set(filing.personKey, list);
  }
  let parsed = 0;
  let partial = 0;
  let unreadable = 0;
  let pendingOcr = 0;
  let excludedRows = 0;
  for (const list of byPerson.values()) {
    const { current } = selectCurrentAnnual(list);
    if (!current) continue;
    excludedRows += Number(current.excludedCount) || 0;
    if (current.parseStatus === 'parsed') parsed += 1;
    else if (current.parseStatus === 'partial') partial += 1;
    else if (current.parseStatus === 'pending_ocr') pendingOcr += 1;
    else unreadable += 1;
  }
  return {
    people: byPerson.size,
    parsed,
    partial,
    unreadable,
    pendingOcr,
    excludedRows,
  };
}

function past(deadline) {
  return Number.isFinite(deadline) && Date.now() > deadline;
}

async function http(fetchImpl, url, init = {}) {
  const res = await fetchImpl(url, {
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
  return res;
}

async function readBytes(res) {
  if (typeof res.arrayBuffer === 'function') return Buffer.from(await res.arrayBuffer());
  if (typeof res.text === 'function') return Buffer.from(await res.text());
  return Buffer.alloc(0);
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

function cookieHeader(jar) {
  return Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
}

function fresher(a, b) {
  const date = String(a.filedDate || '').localeCompare(String(b.filedDate || ''));
  if (date) return date > 0 ? a : b;
  const year = (Number(a.reportYear) || 0) - (Number(b.reportYear) || 0);
  if (year) return year > 0 ? a : b;
  if (a.filingKind === 'amendment' && b.filingKind !== 'amendment') return a;
  if (b.filingKind === 'amendment' && a.filingKind !== 'amendment') return b;
  return String(a.filingKey) >= String(b.filingKey) ? a : b;
}

function stale(indexedAt, nowMs) {
  const at = Date.parse(indexedAt || '');
  return !Number.isFinite(at) || nowMs - at > INDEX_MAX_AGE_MS;
}

function annualYears(now) {
  const year = Number(new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric',
  }).format(now));
  return [year, year - 1, year - 2];
}

async function saveAnnual(store, filing, parsed, catalog) {
  const record = buildAnnualFiling({ ...filing, parsed });
  const rows = buildHoldingRows(record, parsed, catalog);
  return store.insertAnnualBundle(record, rows);
}

async function acceptSenate(fetchImpl) {
  const jar = {};
  let res = await http(fetchImpl, `${SENATE_BASE}/search/`, { redirect: 'manual' });
  storeCookies(jar, res);
  if (res.status >= 300 && res.status < 400) {
    const loc = new URL(res.headers.get('location'), SENATE_BASE).href;
    res = await http(fetchImpl, loc, { redirect: 'manual', headers: { Cookie: cookieHeader(jar) } });
    storeCookies(jar, res);
  }
  if (res.status === 429 || res.status >= 500) {
    const err = new Error(`senate returned HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  const html = typeof res.text === 'function' ? await res.text() : '';
  const token = /name="csrfmiddlewaretoken"\s+value="([^"]+)"/i.exec(html);
  if (!token) throw new Error('Senate eFD did not return the agreement form');
  const agreed = await http(fetchImpl, `${SENATE_BASE}/search/home/`, {
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
  });
  storeCookies(jar, agreed);
  if (agreed.status === 429 || agreed.status >= 500) {
    const err = new Error(`senate returned HTTP ${agreed.status}`);
    err.status = agreed.status;
    throw err;
  }
  if (!jar.csrftoken) throw new Error('Senate eFD did not set a session cookie');
  return jar;
}

function houseMember(candidate, roster) {
  const party = matchHouseParty(candidate, roster?.house || []);
  const filerStatus = classifyHouseFiler({
    filing: candidate,
    matched: party.matched === true,
  });
  if (filerStatus !== 'member') return null;
  const where = splitStateDst(candidate.stateDst);
  return {
    ...candidate,
    personKey: personKey('house', candidate.last, candidate.first),
    office: 'house',
    party: party.party,
    filerStatus: 'member',
    state: party.state || where.state,
    district: party.district || where.district,
  };
}

async function ensureHouseQueue({ fetchImpl, state, roster, years, sleep, delayMs, deadline, logger }) {
  const house = state.house || {};
  if (Array.isArray(house.queue) && !stale(house.indexedAt, Date.now())) return house;
  const candidates = [];
  for (const year of years) {
    if (past(deadline)) break;
    const res = await http(fetchImpl, houseIndexUrl(year));
    if (res.status === 404) continue;
    if (res.status === 429 || res.status >= 500) {
      const err = new Error(`house returned HTTP ${res.status}`);
      err.status = res.status;
      throw err;
    }
    if (res.status !== 200) continue;
    const entries = readZipEntries(await readBytes(res));
    const xml = zipText(entries, '.xml');
    const txt = zipText(entries, '.txt');
    const filings = xml ? parseHouseAnnualIndexXml(xml) : parseHouseAnnualIndexTxt(txt || '');
    candidates.push(...filings);
    logger.log(`[annual] house ${year} annual filings in index=${filings.length}`);
    await sleep(delayMs);
  }
  const best = new Map();
  for (const candidate of candidates) {
    const member = houseMember(candidate, roster);
    if (!member?.personKey) continue;
    const prev = best.get(member.personKey);
    if (!prev || fresher(member, prev) === member) best.set(member.personKey, member);
  }
  return {
    indexedAt: new Date().toISOString(),
    queue: [...best.values()],
  };
}

async function downloadHouse({ fetchImpl, store, queue, cap, delayMs, sleep, deadline, logger, catalog, maxPdfBytes }) {
  const existing = new Set(await store.existingAnnualKeys('house', queue.map((row) => row.filingKey)));
  let downloaded = 0;
  for (const candidate of queue) {
    if (existing.has(candidate.filingKey)) continue;
    if (downloaded >= cap || past(deadline)) break;
    downloaded += 1;
    await sleep(delayMs);
    const res = await http(fetchImpl, candidate.sourceUrl, { timeoutMs: 60_000 });
    if (res.status === 429 || res.status >= 500) {
      const err = new Error(`house returned HTTP ${res.status}`);
      err.status = res.status;
      throw err;
    }
    let parsed;
    if (res.status !== 200) {
      parsed = {
        status: 'needs_manual_review',
        holdings: [],
        excludedCount: 0,
        note: `The Clerk returned HTTP ${res.status} for this annual report.`,
      };
    } else {
      const bytes = await readBytes(res);
      if (bytes.length > maxPdfBytes) {
        parsed = {
          status: 'needs_manual_review',
          holdings: [],
          excludedCount: 0,
          note: `The annual PDF is over the ${Math.round(maxPdfBytes / 1e6)} MB cap, so it was not read.`,
        };
      } else {
        try {
          parsed = await parseHouseAnnualPdf(bytes);
        } catch (err) {
          parsed = {
            status: 'needs_manual_review',
            holdings: [],
            excludedCount: 0,
            note: 'The annual PDF could not be read as text, so no holdings were guessed.',
          };
          logger.warn(`[annual] house ${candidate.filingKey} pdf: ${err.message}`);
        }
      }
    }
    await saveAnnual(store, {
      source: 'house',
      filingKey: candidate.filingKey,
      first: candidate.first,
      last: candidate.last,
      office: 'house',
      party: candidate.party,
      filerStatus: 'member',
      state: candidate.state,
      district: candidate.district,
      reportYear: candidate.reportYear,
      filedDate: candidate.filedDate,
      filingKind: candidate.filingKind,
      sourceUrl: candidate.sourceUrl,
    }, parsed, catalog);
  }
  return downloaded;
}

async function ensureSenateQueue({ fetchImpl, state, roster, sleep, delayMs, deadline, logger }) {
  const senate = state.senate || {};
  if (senate.done && !stale(senate.indexedAt, Date.now()) && senate.queue) return senate;
  const jar = await acceptSenate(fetchImpl);
  const people = new Map((senate.queue || []).map((row) => [row.personKey, row]));
  let offset = senate.done ? 0 : (Number(senate.offset) || 0);
  if (stale(senate.indexedAt, Date.now())) offset = 0;
  let done = false;
  let pages = 0;
  while (pages < 3 && !past(deadline)) {
    const body = new URLSearchParams({
      start: String(offset),
      length: String(SENATE_PAGE),
      report_types: '[7]',
      filer_types: '[1]',
    });
    const res = await http(fetchImpl, `${SENATE_BASE}/search/report/data/`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'X-CSRFToken': jar.csrftoken,
        Cookie: cookieHeader(jar),
        Referer: `${SENATE_BASE}/search/`,
      },
      body: body.toString(),
    });
    if (res.status === 429 || res.status >= 500) {
      const err = new Error(`senate returned HTTP ${res.status}`);
      err.status = res.status;
      throw err;
    }
    if (res.status !== 200) break;
    const payload = JSON.parse(await res.text());
    const rows = Array.isArray(payload.data) ? payload.data : [];
    pages += 1;
    for (const row of rows) {
      const parsed = parseSenateAnnualSearchRow(row);
      if (!parsed) continue;
      const party = matchSenateParty(parsed, roster?.senate || []);
      if (!party.state && !(roster?.senate || []).length) continue;
      if (!party.party && (roster?.senate || []).length) continue;
      const key = personKey('senate', parsed.last, parsed.first);
      const candidate = {
        ...parsed,
        personKey: key,
        office: 'senate',
        party: party.party,
        state: party.state,
        filerStatus: 'member',
      };
      const prev = people.get(personKey);
      if (!prev || fresher(candidate, prev) === candidate) people.set(personKey, candidate);
    }
    const total = Number(payload.recordsFiltered ?? payload.recordsTotal ?? 0);
    offset += rows.length;
    if (!rows.length || offset >= total) {
      done = true;
      break;
    }
    await sleep(delayMs);
  }
  logger.log(`[annual] senate index people=${people.size} offset=${offset} done=${done}`);
  return {
    indexedAt: done ? new Date().toISOString() : (senate.indexedAt || null),
    offset,
    done,
    queue: [...people.values()],
  };
}

async function downloadSenate({ fetchImpl, store, queue, cap, delayMs, sleep, deadline, logger, catalog }) {
  const existing = new Set(await store.existingAnnualKeys('senate', queue.map((row) => row.filingKey)));
  const pending = queue.filter((row) => !existing.has(row.filingKey));
  if (!pending.length) return 0;
  const jar = await acceptSenate(fetchImpl);
  let downloaded = 0;
  for (const candidate of pending) {
    if (downloaded >= cap || past(deadline)) break;
    if (candidate.kind === 'paper') {
      await saveAnnual(store, candidate, reviewPaperAnnual(), catalog);
      continue;
    }
    downloaded += 1;
    await sleep(delayMs);
    const res = await http(fetchImpl, candidate.sourceUrl, {
      headers: { Cookie: cookieHeader(jar), Referer: `${SENATE_BASE}/search/` },
    });
    if (res.status === 429 || res.status >= 500) {
      const err = new Error(`senate returned HTTP ${res.status}`);
      err.status = res.status;
      throw err;
    }
    const parsed = res.status === 200
      ? parseSenateAnnualHtml(await res.text())
      : reviewPaperAnnual(`The Senate returned HTTP ${res.status} for this annual report.`);
    await saveAnnual(store, candidate, parsed, catalog);
  }
  return downloaded;
}

function ogeAnnualQuery(start) {
  const params = new URLSearchParams();
  params.set('draw', '1');
  params.set('start', String(start));
  params.set('length', '100');
  params.set('order[0][column]', '0');
  params.set('order[0][dir]', 'desc');
  const cols = ['docDate', 'title', 'type', 'name', 'agency', 'level'];
  cols.forEach((name, i) => {
    params.set(`columns[${i}][data]`, name);
    params.set(`columns[${i}][searchable]`, 'true');
    params.set(`columns[${i}][orderable]`, 'true');
    params.set(`columns[${i}][search][regex]`, 'false');
    const value = name === 'type' ? 'Annual' : (name === 'title' ? 'President' : '');
    params.set(`columns[${i}][search][value]`, value);
  });
  return params;
}

async function ensureOgeQueue({ fetchImpl, state, sleep, delayMs, deadline, logger }) {
  const oge = state.oge || {};
  if (Array.isArray(oge.queue) && !stale(oge.indexedAt, Date.now())) return oge;
  const best = new Map();
  let start = 0;
  let pages = 0;
  while (pages < 4 && !past(deadline)) {
    const res = await http(fetchImpl, `${OGE_API}?${ogeAnnualQuery(start)}`, { accept: 'application/json' });
    if (res.status === 429 || res.status >= 500) {
      const err = new Error(`oge returned HTTP ${res.status}`);
      err.status = res.status;
      throw err;
    }
    if (res.status !== 200) break;
    const payload = JSON.parse(await res.text());
    const rows = Array.isArray(payload.data) ? payload.data : [];
    pages += 1;
    for (const row of rows) {
      const parsed = parseOgeAnnualApiRow(row);
      if (!parsed?.office) continue;
      const prev = best.get(parsed.office);
      if (!prev || fresher(parsed, prev) === parsed) best.set(parsed.office, parsed);
    }
    const total = Number(payload.recordsFiltered ?? payload.recordsTotal ?? 0);
    start += rows.length;
    if (!rows.length || start >= total) break;
    await sleep(delayMs);
  }
  logger.log(`[annual] oge annual filings=${best.size}`);
  return { indexedAt: new Date().toISOString(), queue: [...best.values()] };
}

async function downloadOge({ fetchImpl, store, queue, cap, delayMs, sleep, deadline, logger, catalog, maxPdfBytes }) {
  const existing = new Set(await store.existingAnnualKeys('oge', queue.map((row) => row.filingKey)));
  let downloaded = 0;
  for (const candidate of queue) {
    if (existing.has(candidate.filingKey)) continue;
    if (past(deadline)) break;
    if (candidate.request) {
      await saveAnnual(store, {
        ...candidate,
        filerStatus: 'member',
      }, {
        status: 'needs_manual_review',
        holdings: [],
        excludedCount: 0,
        note: 'OGE has not posted this 278e for download.',
        ocrDone: true,
      }, catalog);
      continue;
    }
    if (downloaded >= cap) break;
    downloaded += 1;
    await sleep(delayMs);
    const res = await http(fetchImpl, candidate.sourceUrl, { timeoutMs: 120_000 });
    if (res.status === 429 || res.status >= 500) {
      const err = new Error(`oge returned HTTP ${res.status}`);
      err.status = res.status;
      throw err;
    }
    let parsed;
    if (res.status !== 200) {
      parsed = {
        status: 'needs_manual_review',
        holdings: [],
        excludedCount: 0,
        note: `OGE returned HTTP ${res.status} for this 278e.`,
        ocrDone: true,
      };
    } else {
      const bytes = await readBytes(res);
      if (bytes.length > maxPdfBytes) {
        parsed = {
          status: 'needs_manual_review',
          holdings: [],
          excludedCount: 0,
          note: `The 278e PDF is over the ${Math.round(maxPdfBytes / 1e6)} MB cap, so it was not read.`,
          ocrDone: true,
        };
      } else {
        try {
          parsed = await parseOgeAnnualPdf(bytes);
          if (parsed.reportYear) candidate.reportYear = parsed.reportYear;
        } catch (err) {
          parsed = {
            status: 'needs_manual_review',
            holdings: [],
            excludedCount: 0,
            note: 'The 278e could not be read, so no holdings were guessed.',
            ocrDone: true,
          };
          logger.warn(`[annual] oge ${candidate.filingKey}: ${err.message}`);
        }
      }
    }
    await saveAnnual(store, { ...candidate, filerStatus: 'member' }, parsed, catalog);
  }
  return downloaded;
}

export async function runAnnualSlice({
  fetchImpl = globalThis.fetch,
  store,
  roster = { house: [], senate: [] },
  now = new Date(),
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  delayMs = 1200,
  deadline = null,
  logger = console,
  catalog = null,
  maxPdfBytes = 32 * 1024 * 1024,
  docsPerRun = 3,
} = {}) {
  const state = { ...(await store.getAnnualState()) };
  const years = annualYears(now);
  const summary = {};
  const jobs = [
    ['house', async () => {
      const house = await ensureHouseQueue({
        fetchImpl, state, roster, years, sleep, delayMs, deadline, logger,
      });
      state.house = house;
      const downloaded = await downloadHouse({
        fetchImpl, store, queue: house.queue || [], cap: docsPerRun, delayMs, sleep, deadline, logger, catalog, maxPdfBytes,
      });
      return { queued: (house.queue || []).length, downloaded };
    }],
    ['senate', async () => {
      const senate = await ensureSenateQueue({
        fetchImpl, state, roster, sleep, delayMs, deadline, logger,
      });
      state.senate = senate;
      const downloaded = senate.done
        ? await downloadSenate({
          fetchImpl, store, queue: senate.queue || [], cap: docsPerRun, delayMs, sleep, deadline, logger, catalog,
        })
        : 0;
      return { queued: (senate.queue || []).length, downloaded, indexDone: senate.done === true };
    }],
    ['oge', async () => {
      const oge = await ensureOgeQueue({ fetchImpl, state, sleep, delayMs, deadline, logger });
      state.oge = oge;
      const downloaded = await downloadOge({
        fetchImpl, store, queue: oge.queue || [], cap: 1, delayMs, sleep, deadline, logger, catalog, maxPdfBytes,
      });
      return { queued: (oge.queue || []).length, downloaded };
    }],
  ];

  for (const [name, run] of jobs) {
    if (past(deadline)) {
      summary[name] = { skipped: 'budget' };
      continue;
    }
    const until = Date.parse(state.backoff?.[name] || '');
    if (Number.isFinite(until) && until > Date.now()) {
      summary[name] = { skipped: 'backoff' };
      continue;
    }
    try {
      summary[name] = await run();
      state.backoff = { ...(state.backoff || {}), [name]: null };
    } catch (err) {
      const status = Number(err.status) || 500;
      const wait = (status === 429 ? 15 : 5) * 60 * 1000;
      state.backoff = { ...(state.backoff || {}), [name]: new Date(Date.now() + wait).toISOString() };
      summary[name] = { error: err.message };
      logger.error(`[annual] ${name} failed: ${err.message}`);
    }
  }

  let coverage = null;
  try {
    coverage = annualCoverage(await store.listAnnualFilingSummaries());
  } catch (err) {
    logger.warn(`[annual] coverage failed: ${err.message}`);
  }
  const houseDone = summary.house && !summary.house.error && !summary.house.skipped;
  const senateDone = state.senate?.done === true && summary.senate && !summary.senate.error;
  const ogeDone = summary.oge && !summary.oge.error && !summary.oge.skipped;
  const caughtUp = houseDone && senateDone && ogeDone
    && (summary.house.downloaded || 0) === 0
    && (summary.senate.downloaded || 0) === 0
    && (summary.oge.downloaded || 0) === 0;
  const next = {
    ...state,
    backfillComplete: caughtUp ? true : state.backfillComplete === true,
    lastRunAt: new Date().toISOString(),
    lastSummary: summary,
    coverage,
  };
  if (caughtUp) next.backfillComplete = true;
  await store.setAnnualState(next);
  return { ...summary, coverage, backfillComplete: next.backfillComplete === true };
}
