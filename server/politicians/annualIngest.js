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
import { annualBackoffActive, annualFailureBackoff } from './backoff.js';
import {
  bodySnippet,
  fetchSenatePage,
  logSenateResponse,
  openSenateSession,
  POLITICIAN_UA,
  postSenateSearch,
} from './senateFetch.js';
import { readZipEntries, zipText } from './zip.js';
import { buildAnnualFiling, buildHoldingRows, selectCurrentAnnual } from './annualRecords.js';
import { classifyHouseFiler, matchHouseParty, matchSenateParty } from './roster.js';
import { personKey } from './normalize.js';
import { splitStateDst } from './records.js';

const INDEX_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const SENATE_PAGE = 100;
// Render's annual slice shares a 45s budget with House and OGE, so it reads
// a few pages and saves the offset. Actions has its own 15 minute deadline
// and walks far enough to finish. On 2026-11-18 the senator annual search
// reported 1,619 rows, which is 17 pages.
const SENATE_INDEX_PAGES = 3;
const SENATE_INDEX_PAGES_ACTIONS = 40;
const INDEX_STALL_DOWNLOADS = 2;
const DOC_FAIL_STREAK = 2;
export const SENATE_ANNUAL_CAP = 20;

export function senateAnnualHandledElsewhere(env = process.env) {
  const value = String(env.SENATE_ANNUAL_SOURCE || env.POLITICIAN_SENATE_ANNUAL || '').trim().toLowerCase();
  return value === 'actions' || value === 'github' || value === 'external';
}

export function senateAnnualCap(env = process.env) {
  const n = Number(env.SENATE_ANNUAL_CAP);
  if (Number.isFinite(n) && n >= 1 && n <= 40) return Math.round(n);
  return SENATE_ANNUAL_CAP;
}

// Backlog pace for the free Render instance. One document at a time, at most
// 5 House + 2 Senate + 1 OGE filing, and a 45s wall clock. About 520 current
// annuals / 8 per run is 65 runs. Every 30 minutes while the process stays
// awake is about 33 hours. That is an estimate: a large 278e can use most of
// one run, and the first runs also walk the indexes.
export const ANNUAL_BACKFILL_INTERVAL_MS = 30 * 60 * 1000;
export const ANNUAL_BACKFILL_INITIAL_DELAY_MS = 20 * 1000;
export const ANNUAL_BACKFILL_BUDGET_MS = 45 * 1000;
export const ANNUAL_BACKFILL_HOUSE = 5;
export const ANNUAL_BACKFILL_SENATE = 2;
export const ANNUAL_BACKFILL_OGE = 1;

export function annualProgress({ queues = [], storedKeys = [], docBackoff = {}, now = Date.now() } = {}) {
  const stored = new Set(storedKeys);
  const unique = [];
  const seen = new Set();
  for (const queue of queues) {
    for (const row of queue || []) {
      if (!row?.filingKey || seen.has(row.filingKey)) continue;
      seen.add(row.filingKey);
      unique.push(row.filingKey);
    }
  }
  let done = 0;
  let failed = 0;
  for (const key of unique) {
    if (stored.has(key)) done += 1;
    else if (docBlocked(docBackoff, key, now)) failed += 1;
  }
  return {
    queued: unique.length,
    done,
    failed,
    remaining: unique.length - done - failed,
  };
}

export function mergeAnnualSlice(current, local, touched = {}) {
  const next = { ...(current || {}) };
  const backoff = { ...(current?.backoff || {}) };
  for (const name of ['house', 'senate', 'oge']) {
    const mark = touched[name];
    if (mark === true) {
      if (local?.[name]) next[name] = local[name];
      backoff[name] = local?.backoff?.[name] ?? null;
    } else if (mark === 'backoff') {
      backoff[name] = local?.backoff?.[name] ?? null;
    }
  }
  next.backoff = backoff;
  const doc = { ...(current?.docBackoff || {}), ...(local?.docBackoff || {}) };
  const pruned = {};
  for (const [key, until] of Object.entries(doc)) {
    if (Date.parse(until) > Date.now()) pruned[key] = until;
  }
  next.docBackoff = pruned;
  if (local?.lastRunAt) next.lastRunAt = local.lastRunAt;
  next.lastSummary = { ...(current?.lastSummary || {}), ...(local?.lastSummary || {}) };
  if (local?.coverage) next.coverage = local.coverage;
  if (local?.backfillComplete === true) next.backfillComplete = true;
  return next;
}

export function formatAnnualProgress(progress, extra = {}) {
  const downloaded = extra.downloaded ?? 0;
  return `[annual] progress done=${progress.done} remaining=${progress.remaining} failed=${progress.failed} downloaded=${downloaded}`;
}

function docBlocked(docBackoff, key, nowMs) {
  const until = Date.parse(docBackoff?.[key] || '');
  return Number.isFinite(until) && until > nowMs;
}

function blockDoc(state, key, status) {
  const wait = (Number(status) === 429 ? 15 : 5) * 60 * 1000;
  state.docBackoff = { ...(state.docBackoff || {}), [key]: new Date(Date.now() + wait).toISOString() };
}

function pruneDocBackoff(state) {
  const next = {};
  for (const [key, until] of Object.entries(state.docBackoff || {})) {
    if (Date.parse(until) > Date.now()) next[key] = until;
  }
  state.docBackoff = next;
}

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

function failureKind(kind) {
  if (kind === 'blocked' || kind === 'other' || kind === 'transient') return kind;
  return 'transient';
}

function senateFailure(failure) {
  const kind = failureKind(failure.kind);
  const snippet = String(failure.snippet || '').trim();
  const verb = kind === 'blocked' ? 'blocked' : 'returned';
  const err = new Error(`senate ${verb} HTTP ${failure.status}${snippet ? `: ${snippet}` : ''}`);
  err.status = failure.status;
  err.kind = kind;
  err.snippet = snippet;
  return err;
}

function finiteCount(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function responseContentType(searched) {
  const headers = searched?.res?.headers;
  if (!headers || typeof headers.get !== 'function') return '';
  return String(headers.get('content-type') || '').slice(0, 80);
}

function indexStop(fields) {
  return {
    at: new Date().toISOString(),
    reason: fields.reason,
    offset: fields.offset,
    status: Number(fields.status) || 0,
    kind: fields.kind || null,
    contentType: fields.contentType || '',
    recordsTotal: finiteCount(fields.recordsTotal),
    recordsFiltered: finiteCount(fields.recordsFiltered),
    rows: finiteCount(fields.rows),
    snippet: bodySnippet(fields.snippet || ''),
  };
}

function formatIndexStop(stop) {
  const count = (n) => (Number.isFinite(n) ? String(n) : 'null');
  return [
    '[annual] senate index stopped:',
    `reason=${stop.reason}`,
    `offset=${stop.offset}`,
    `status=${stop.status}`,
    `kind=${stop.kind || ''}`,
    `content-type=${JSON.stringify(stop.contentType || '')}`,
    `recordsTotal=${count(stop.recordsTotal)}`,
    `recordsFiltered=${count(stop.recordsFiltered)}`,
    `rows=${count(stop.rows)}`,
    `body=${JSON.stringify(stop.snippet || '')}`,
  ].join(' ');
}

function logIndexStop(logger, stop) {
  if (!stop || !logger) return;
  const line = formatIndexStop(stop);
  if (typeof logger.warn === 'function') logger.warn(line);
  else if (typeof logger.log === 'function') logger.log(line);
}

function unfinishedSenate({ base, people, offset, stop, startOffset, blockDownloads }) {
  const advanced = offset > startOffset;
  const stalls = advanced ? 0 : (Number(base?.stalls) || 0) + 1;
  const downloadIndexed = stalls >= INDEX_STALL_DOWNLOADS && people.size > 0 && !blockDownloads;
  return {
    indexedAt: base?.indexedAt || null,
    offset,
    done: false,
    queue: [...people.values()],
    stop,
    stalls,
    downloadIndexed,
  };
}

function readSearchPayload(searched) {
  if (Number(searched?.verdict?.status) !== 200) return { ok: false, payload: null };
  try {
    const payload = JSON.parse(searched.text);
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return { ok: false, payload: null };
    return { ok: true, payload };
  } catch {
    return { ok: false, payload: null };
  }
}

function shouldRefreshSession(searched, parsed) {
  const kind = searched?.verdict?.kind;
  if (kind === 'blocked' || kind === 'transient') return false;
  if (Number(searched?.verdict?.status) !== 200) return true;
  return !parsed?.ok;
}

async function acceptSenate(fetchImpl, logger) {
  const session = await openSenateSession(fetchImpl, {
    onResponse: (row) => logSenateResponse(logger, row.step, row),
  });
  if (session.failure) throw senateFailure(session.failure);
  return session.jar;
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

async function saveAnnual(store, filing, parsed, catalog, { replace = false } = {}) {
  const record = buildAnnualFiling({ ...filing, parsed });
  const rows = buildHoldingRows(record, parsed, catalog);
  return store.insertAnnualBundle(record, rows, { replace });
}

async function replaceAnnualParse(store, filing, parsed, catalog) {
  const record = {
    ...filing,
    parseStatus: parsed?.status || 'needs_manual_review',
    parseNote: parsed?.note || null,
    excludedCount: Number(parsed?.excludedCount) || 0,
    unreadableCount: Number(parsed?.unreadableCount) || 0,
    ocrDone: parsed?.ocrDone === true,
    ocrPage: parsed?.ocrPage ?? filing.ocrPage ?? null,
    pageCount: parsed?.pageCount ?? filing.pageCount ?? null,
  };
  const rows = buildHoldingRows(record, parsed, catalog);
  return store.insertAnnualBundle(record, rows, { replace: true });
}

// Re-download House filings that were marked unreadable under the old
// parser. Text-layer "None disclosed" and letter-size value columns are
// parsed here. Image-only scans are stored as pending_ocr for Actions.
export async function revisitUnreadableHouseAnnuals({
  fetchImpl,
  store,
  cap = 10,
  delayMs = 0,
  sleep = async () => {},
  deadline = Infinity,
  logger = console,
  catalog = null,
  maxPdfBytes = 32 * 1024 * 1024,
  state,
} = {}) {
  if (typeof store.listRevisitableAnnualFilings !== 'function') {
    return { downloaded: 0, failed: 0, revisited: 0 };
  }
  const queue = await store.listRevisitableAnnualFilings({ source: 'house', limit: cap });
  let downloaded = 0;
  let failed = 0;
  let revisited = 0;
  for (const filing of queue) {
    if (downloaded >= cap || past(deadline)) break;
    if (!filing.sourceUrl) continue;
    let res;
    try {
      await sleep(delayMs);
      res = await http(fetchImpl, filing.sourceUrl, { timeoutMs: 60_000 });
    } catch (err) {
      failed += 1;
      logger.warn(`[annual] house revisit ${filing.filingKey} failed: ${err.message}`);
      continue;
    }
    if (res.status !== 200) {
      failed += 1;
      logger.warn(`[annual] house revisit ${filing.filingKey} HTTP ${res.status}`);
      continue;
    }
    downloaded += 1;
    const bytes = await readBytes(res);
    let parsed;
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
        logger.warn(`[annual] house revisit ${filing.filingKey} pdf: ${err.message}`);
      }
    }
    await replaceAnnualParse(store, filing, parsed, catalog);
    revisited += 1;
    logger.log(`[annual] house revisit ${filing.filingKey} status=${parsed.status} kept=${parsed.holdings?.length || 0}`);
  }
  return { downloaded, failed, revisited };
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

async function downloadHouse({
  fetchImpl, store, queue, cap, delayMs, sleep, deadline, logger, catalog, maxPdfBytes, state,
}) {
  const existing = new Set(await store.existingAnnualKeys('house', queue.map((row) => row.filingKey)));
  let downloaded = 0;
  let failed = 0;
  let streak = 0;
  for (const candidate of queue) {
    if (existing.has(candidate.filingKey)) continue;
    if (docBlocked(state?.docBackoff, candidate.filingKey, Date.now())) continue;
    if (downloaded >= cap || past(deadline)) break;
    let res;
    try {
      await sleep(delayMs);
      res = await http(fetchImpl, candidate.sourceUrl, { timeoutMs: 60_000 });
    } catch (err) {
      blockDoc(state, candidate.filingKey, err.status || 500);
      failed += 1;
      streak += 1;
      logger.warn(`[annual] house ${candidate.filingKey} failed: ${err.message}`);
      if (streak >= DOC_FAIL_STREAK) break;
      continue;
    }
    if (res.status === 429 || res.status >= 500) {
      blockDoc(state, candidate.filingKey, res.status);
      failed += 1;
      streak += 1;
      logger.warn(`[annual] house ${candidate.filingKey} HTTP ${res.status}`);
      if (streak >= DOC_FAIL_STREAK) break;
      continue;
    }
    streak = 0;
    downloaded += 1;
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
  return { downloaded, failed };
}

async function ensureSenateQueue({
  fetchImpl, state, roster, sleep, delayMs, deadline, logger, indexPages = SENATE_INDEX_PAGES,
}) {
  const senate = state.senate || {};
  // A finished index is reused for a day. An unfinished one keeps its offset.
  // indexedAt is written only when the walk finishes, so a missing timestamp
  // used to look stale and send every run back to offset 0. Three pages then
  // stopped at 300 forever, and downloads never started.
  if (senate.done && !stale(senate.indexedAt, Date.now()) && senate.queue) return senate;
  const restart = senate.done === true;
  const people = new Map((senate.queue || []).map((row) => [row.personKey, row]));
  let offset = restart ? 0 : (Number(senate.offset) || 0);
  const startOffset = offset;
  const pageLimit = Math.min(100, Math.max(1, Number(indexPages) || SENATE_INDEX_PAGES));
  let jar = await acceptSenate(fetchImpl, logger);
  let done = false;
  let pages = 0;
  let last = {
    status: 0,
    kind: null,
    contentType: '',
    recordsTotal: null,
    recordsFiltered: null,
    rows: null,
    snippet: '',
  };

  function noteStall(partial) {
    logger.log(`[annual] senate index people=${partial.queue.length} offset=${partial.offset} done=false`);
    logIndexStop(logger, partial.stop);
    if (partial.downloadIndexed) {
      logger.warn(`[annual] senate index stalled at offset=${partial.offset} stalls=${partial.stalls}; downloading filings already indexed`);
    }
  }

  function failIndex(err, stop, blockDownloads) {
    const kind = failureKind(err.kind || stop?.kind);
    err.kind = kind;
    err.status = Number(err.status) || stop?.status || 500;
    err.snippet = err.snippet || stop?.snippet || '';
    const partial = unfinishedSenate({
      base: senate,
      people,
      offset,
      stop,
      startOffset,
      blockDownloads: blockDownloads || kind === 'blocked' || kind === 'transient',
    });
    err.partial = partial;
    noteStall(partial);
    throw err;
  }

  function failSearch(searched, kind, reason, counts = {}) {
    const stop = indexStop({
      reason,
      offset,
      status: searched?.verdict?.status || 0,
      kind,
      contentType: responseContentType(searched),
      recordsTotal: counts.recordsTotal,
      recordsFiltered: counts.recordsFiltered,
      rows: counts.rows,
      snippet: counts.snippet || searched?.verdict?.snippet || '',
    });
    const err = senateFailure({ kind, status: stop.status, snippet: stop.snippet });
    failIndex(err, stop, kind === 'blocked' || kind === 'transient');
  }

  while (pages < pageLimit && !past(deadline)) {
    const params = {
      start: String(offset),
      length: String(SENATE_PAGE),
      report_types: '[7]',
      filer_types: '[1]',
    };
    const onResponse = (row) => logSenateResponse(logger, 'search', row);
    let searched = await postSenateSearch(fetchImpl, jar, params, { onResponse });
    let parsed = readSearchPayload(searched);
    if (shouldRefreshSession(searched, parsed)) {
      logger.warn(`[annual] senate index refreshing the agreement after HTTP ${searched.verdict.status} at offset=${offset}`);
      try {
        jar = await acceptSenate(fetchImpl, logger);
      } catch (err) {
        const stop = indexStop({
          reason: 'http',
          offset,
          status: Number(err.status) || 0,
          kind: failureKind(err.kind),
          contentType: '',
          snippet: err.snippet || err.message,
        });
        failIndex(err, stop);
      }
      searched = await postSenateSearch(fetchImpl, jar, params, { onResponse });
      parsed = readSearchPayload(searched);
    }
    if (searched.verdict.kind === 'blocked' || searched.verdict.kind === 'transient') {
      failSearch(searched, searched.verdict.kind, 'http');
    }
    if (searched.verdict.status !== 200) failSearch(searched, 'other', 'http');
    if (!parsed.ok) failSearch(searched, 'other', 'unparseable', { snippet: bodySnippet(searched.text) });

    const payload = parsed.payload;
    const rows = Array.isArray(payload.data) ? payload.data : [];
    const recordsTotal = finiteCount(payload.recordsTotal);
    const recordsFiltered = finiteCount(payload.recordsFiltered);
    const total = recordsFiltered ?? recordsTotal;
    last = {
      status: 200,
      kind: 'ok',
      contentType: responseContentType(searched),
      recordsTotal,
      recordsFiltered,
      rows: rows.length,
      snippet: bodySnippet(searched.text),
    };
    if (!rows.length) {
      if (total != null && offset >= total) {
        done = true;
        break;
      }
      failSearch(searched, 'other', 'empty-page', {
        recordsTotal,
        recordsFiltered,
        rows: 0,
        snippet: searched.text,
      });
    }
    pages += 1;
    for (const row of rows) {
      const parsedRow = parseSenateAnnualSearchRow(row);
      if (!parsedRow) continue;
      const party = matchSenateParty(parsedRow, roster?.senate || []);
      if (!party.state && !(roster?.senate || []).length) continue;
      if (!party.party && (roster?.senate || []).length) continue;
      const key = personKey('senate', parsedRow.last, parsedRow.first);
      const candidate = {
        ...parsedRow,
        personKey: key,
        office: 'senate',
        party: party.party,
        state: party.state,
        filerStatus: 'member',
      };
      const prev = people.get(key);
      if (!prev || fresher(candidate, prev) === candidate) people.set(key, candidate);
    }
    offset += rows.length;
    if (total != null && offset >= total) {
      done = true;
      break;
    }
    if (pages >= pageLimit || past(deadline)) break;
    await sleep(delayMs);
  }

  if (!done) {
    const stop = indexStop({
      reason: past(deadline) ? 'deadline' : 'page-cap',
      offset,
      status: last.status,
      kind: last.kind || 'ok',
      contentType: last.contentType,
      recordsTotal: last.recordsTotal,
      recordsFiltered: last.recordsFiltered,
      rows: last.rows,
      snippet: last.snippet,
    });
    const partial = unfinishedSenate({
      base: senate,
      people,
      offset,
      stop,
      startOffset,
      blockDownloads: false,
    });
    noteStall(partial);
    return partial;
  }

  logger.log(`[annual] senate index people=${people.size} offset=${offset} done=true`);
  return {
    indexedAt: new Date().toISOString(),
    offset,
    done: true,
    queue: [...people.values()],
    stop: null,
    stalls: 0,
    downloadIndexed: false,
  };
}

async function downloadSenate({
  fetchImpl, store, queue, cap, delayMs, sleep, deadline, logger, catalog, state,
}) {
  const existing = new Set(await store.existingAnnualKeys('senate', queue.map((row) => row.filingKey)));
  const pending = queue.filter((row) => !existing.has(row.filingKey) && !docBlocked(state?.docBackoff, row.filingKey, Date.now()));
  if (!pending.length) return { downloaded: 0, failed: 0 };
  const jar = await acceptSenate(fetchImpl, logger);
  let downloaded = 0;
  let failed = 0;
  let streak = 0;
  for (const candidate of pending) {
    if (downloaded >= cap || past(deadline)) break;
    if (candidate.kind === 'paper') {
      downloaded += 1;
      await saveAnnual(store, candidate, reviewPaperAnnual(), catalog);
      continue;
    }
    let res;
    try {
      await sleep(delayMs);
      const page = await fetchSenatePage(fetchImpl, candidate.sourceUrl, {
        jar,
        onResponse: (row) => logSenateResponse(logger, 'report', row),
      });
      if (page.verdict.kind === 'blocked') throw senateFailure(page.verdict);
      if (page.verdict.kind === 'transient') {
        blockDoc(state, candidate.filingKey, page.verdict.status);
        failed += 1;
        streak += 1;
        logger.warn(`[annual] senate ${candidate.filingKey} HTTP ${page.verdict.status} body=${JSON.stringify(page.verdict.snippet || '')}`);
        if (streak >= DOC_FAIL_STREAK) break;
        continue;
      }
      res = { status: page.verdict.status, text: page.text };
    } catch (err) {
      if (err.kind === 'blocked') throw err;
      blockDoc(state, candidate.filingKey, err.status || 500);
      failed += 1;
      streak += 1;
      logger.warn(`[annual] senate ${candidate.filingKey} failed: ${err.message}`);
      if (streak >= DOC_FAIL_STREAK) break;
      continue;
    }
    streak = 0;
    downloaded += 1;
    const parsed = res.status === 200
      ? parseSenateAnnualHtml(res.text)
      : reviewPaperAnnual(`The Senate returned HTTP ${res.status} for this annual report.`);
    await saveAnnual(store, candidate, parsed, catalog);
  }
  return { downloaded, failed };
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

async function downloadOge({
  fetchImpl, store, queue, cap, delayMs, sleep, deadline, logger, catalog, maxPdfBytes, state,
}) {
  const existing = new Set(await store.existingAnnualKeys('oge', queue.map((row) => row.filingKey)));
  let downloaded = 0;
  let failed = 0;
  for (const candidate of queue) {
    if (existing.has(candidate.filingKey)) continue;
    if (docBlocked(state?.docBackoff, candidate.filingKey, Date.now())) continue;
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
    let res;
    try {
      await sleep(delayMs);
      res = await http(fetchImpl, candidate.sourceUrl, { timeoutMs: 120_000 });
    } catch (err) {
      blockDoc(state, candidate.filingKey, err.status || 500);
      failed += 1;
      logger.warn(`[annual] oge ${candidate.filingKey} failed: ${err.message}`);
      continue;
    }
    if (res.status === 429 || res.status >= 500) {
      blockDoc(state, candidate.filingKey, res.status);
      failed += 1;
      logger.warn(`[annual] oge ${candidate.filingKey} HTTP ${res.status}`);
      continue;
    }
    downloaded += 1;
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
  return { downloaded, failed };
}

let annualSliceRunning = false;

function paceCaps(pace, docsPerRun) {
  if (pace === 'backfill') {
    return { house: ANNUAL_BACKFILL_HOUSE, senate: ANNUAL_BACKFILL_SENATE, oge: ANNUAL_BACKFILL_OGE };
  }
  return { house: docsPerRun, senate: docsPerRun, oge: 1 };
}

export async function runAnnualSlice(options = {}) {
  if (annualSliceRunning) {
    const logger = options.logger || console;
    logger.log('[annual] progress skipped=running');
    return { skipped: true, reason: 'already running' };
  }
  annualSliceRunning = true;
  try {
    return await runAnnualSliceBody(options);
  } finally {
    annualSliceRunning = false;
  }
}

async function commitAnnualState(store, local, touched, storedKeys) {
  const produce = (current) => {
    const next = mergeAnnualSlice(current, local, touched);
    next.progress = annualProgress({
      queues: [next.house?.queue, next.senate?.queue, next.oge?.queue],
      storedKeys,
      docBackoff: next.docBackoff,
    });
    return next;
  };
  if (typeof store.mergeAnnualState === 'function') return store.mergeAnnualState(produce);
  const next = produce(await store.getAnnualState());
  await store.setAnnualState(next);
  return next;
}

async function runAnnualSliceBody({
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
  pace = 'daily',
  env = process.env,
} = {}) {
  const state = { ...(await store.getAnnualState()) };
  pruneDocBackoff(state);
  const years = annualYears(now);
  const summary = {};
  const caps = paceCaps(pace, docsPerRun);
  const queueTouched = { house: false, senate: false, oge: false };
  let spare = 0;
  const jobs = [
    ['house', async (cap) => {
      const house = await ensureHouseQueue({
        fetchImpl, state, roster, years, sleep, delayMs, deadline, logger,
      });
      state.house = house;
      queueTouched.house = true;
      const revisited = await revisitUnreadableHouseAnnuals({
        fetchImpl, store, cap, delayMs, sleep, deadline, logger, catalog, maxPdfBytes, state,
      });
      const remaining = Math.max(0, cap - (revisited.downloaded || 0));
      const result = await downloadHouse({
        fetchImpl, store, queue: house.queue || [], cap: remaining, delayMs, sleep, deadline, logger, catalog, maxPdfBytes, state,
      });
      return { queued: (house.queue || []).length, ...result, revisited: revisited.revisited || 0 };
    }],
    ['senate', async (cap) => {
      const senate = await ensureSenateQueue({
        fetchImpl, state, roster, sleep, delayMs, deadline, logger,
        indexPages: SENATE_INDEX_PAGES,
      });
      state.senate = senate;
      queueTouched.senate = true;
      const result = (senate.done || senate.downloadIndexed)
        ? await downloadSenate({
          fetchImpl, store, queue: senate.queue || [], cap, delayMs, sleep, deadline, logger, catalog, state,
        })
        : { downloaded: 0, failed: 0 };
      return {
        queued: (senate.queue || []).length,
        ...result,
        indexDone: senate.done === true,
        stop: senate.stop?.reason || null,
      };
    }],
    ['oge', async (cap) => {
      const oge = await ensureOgeQueue({ fetchImpl, state, sleep, delayMs, deadline, logger });
      state.oge = oge;
      const result = await downloadOge({
        fetchImpl, store, queue: oge.queue || [], cap, delayMs, sleep, deadline, logger, catalog, maxPdfBytes, state,
      });
      return { queued: (oge.queue || []).length, ...result };
    }],
  ];

  const touched = { house: false, senate: false, oge: false };
  for (const [name, run] of jobs) {
    if (name === 'senate' && senateAnnualHandledElsewhere(env)) {
      summary.senate = { skipped: 'actions', downloaded: 0, failed: 0 };
      continue;
    }
    if (past(deadline)) {
      summary[name] = { skipped: 'budget', downloaded: 0, failed: 0 };
      continue;
    }
    if (annualBackoffActive(state.backoff?.[name], Date.now())) {
      const entry = state.backoff?.[name];
      summary[name] = {
        skipped: 'backoff',
        downloaded: 0,
        failed: 0,
        kind: typeof entry === 'object' ? entry.kind : null,
        until: typeof entry === 'object' ? entry.until : entry,
      };
      continue;
    }
    const cap = name === 'oge' ? caps.oge : caps[name] + (pace === 'backfill' ? spare : 0);
    try {
      summary[name] = await run(cap);
      state.backoff = { ...(state.backoff || {}), [name]: null };
      touched[name] = true;
      if (pace === 'backfill' && name !== 'oge') spare = Math.max(0, cap - (summary[name].downloaded || 0));
    } catch (err) {
      if (name === 'senate' && err.partial) {
        state.senate = err.partial;
        queueTouched.senate = true;
      }
      let downloaded = 0;
      let failed = 0;
      if (name === 'senate' && err.partial?.downloadIndexed && err.kind !== 'blocked' && err.kind !== 'transient') {
        try {
          const result = await downloadSenate({
            fetchImpl, store, queue: err.partial.queue || [], cap, delayMs, sleep, deadline, logger, catalog, state,
          });
          downloaded = result.downloaded || 0;
          failed = result.failed || 0;
        } catch (downloadErr) {
          if (downloadErr.kind === 'blocked' || downloadErr.kind === 'transient') err = downloadErr;
          else logger.warn(`[annual] senate indexed download failed: ${downloadErr.message}`);
        }
      }
      const status = Number(err.status) || 500;
      const kind = failureKind(err.kind);
      const backoff = annualFailureBackoff(Date.now(), { kind, status, snippet: err.snippet || '' });
      state.backoff = { ...(state.backoff || {}), [name]: backoff };
      summary[name] = {
        error: err.message,
        downloaded,
        failed,
        kind,
        status,
        until: backoff.until,
      };
      if (name === 'senate') {
        summary.senate.queued = (state.senate?.queue || []).length;
        summary.senate.indexDone = false;
        summary.senate.stop = state.senate?.stop?.reason || null;
      }
      touched[name] = queueTouched[name] ? true : 'backoff';
      logger.error(`[annual] ${name} failed: ${err.message}`);
      if (pace === 'backfill' && name !== 'oge') spare = Math.max(0, cap);
    }
  }

  let coverage = null;
  let storedKeys = [];
  try {
    const summaries = await store.listAnnualFilingSummaries();
    coverage = annualCoverage(summaries);
    storedKeys = summaries.map((row) => row.filingKey);
  } catch (err) {
    logger.warn(`[annual] coverage failed: ${err.message}`);
  }
  const downloaded = ['house', 'senate', 'oge'].reduce((sum, name) => sum + (summary[name]?.downloaded || 0), 0);
  const progressNow = annualProgress({
    queues: [state.house?.queue, state.senate?.queue, state.oge?.queue],
    storedKeys,
    docBackoff: state.docBackoff,
  });
  const houseDone = summary.house && !summary.house.error && !summary.house.skipped;
  const senateExternal = summary.senate?.skipped === 'actions';
  const senateDone = senateExternal || (state.senate?.done === true && summary.senate && !summary.senate.error && !summary.senate.skipped);
  const ogeDone = summary.oge && !summary.oge.error && !summary.oge.skipped;
  const caughtUp = houseDone && senateDone && ogeDone
    && (summary.house.downloaded || 0) === 0
    && (senateExternal || (summary.senate.downloaded || 0) === 0)
    && (summary.oge.downloaded || 0) === 0
    && progressNow.failed === 0;
  const saved = await commitAnnualState(store, {
    ...state,
    backfillComplete: caughtUp ? true : state.backfillComplete === true,
    lastRunAt: new Date().toISOString(),
    lastSummary: summary,
    coverage,
  }, touched, storedKeys);
  const progress = saved.progress;
  logger.log(formatAnnualProgress(progress, { downloaded }));
  return { ...summary, coverage, progress, downloaded, backfillComplete: saved.backfillComplete === true };
}

export async function runSenateAnnualSlice({
  fetchImpl = globalThis.fetch,
  store,
  roster = { house: [], senate: [] },
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  delayMs = 1200,
  deadline = null,
  logger = console,
  catalog = null,
  cap = SENATE_ANNUAL_CAP,
  indexPages = SENATE_INDEX_PAGES_ACTIONS,
} = {}) {
  const state = { ...(await store.getAnnualState()) };
  pruneDocBackoff(state);
  const summary = {};
  let queueTouched = false;
  if (annualBackoffActive(state.backoff?.senate, Date.now())) {
    const entry = state.backoff.senate;
    summary.senate = {
      skipped: 'backoff',
      downloaded: 0,
      failed: 0,
      kind: typeof entry === 'object' ? entry.kind : null,
      until: typeof entry === 'object' ? entry.until : entry,
    };
  } else {
    try {
      const senate = await ensureSenateQueue({
        fetchImpl, state, roster, sleep, delayMs, deadline, logger, indexPages,
      });
      state.senate = senate;
      queueTouched = true;
      const result = (senate.done || senate.downloadIndexed)
        ? await downloadSenate({
          fetchImpl, store, queue: senate.queue || [], cap, delayMs, sleep, deadline, logger, catalog, state,
        })
        : { downloaded: 0, failed: 0 };
      state.backoff = { ...(state.backoff || {}), senate: null };
      summary.senate = {
        queued: (senate.queue || []).length,
        ...result,
        indexDone: senate.done === true,
        stop: senate.stop?.reason || null,
      };
    } catch (err) {
      if (err.partial) {
        state.senate = err.partial;
        queueTouched = true;
      }
      let downloaded = 0;
      let failed = 0;
      if (err.partial?.downloadIndexed && err.kind !== 'blocked' && err.kind !== 'transient') {
        try {
          const result = await downloadSenate({
            fetchImpl, store, queue: err.partial.queue || [], cap, delayMs, sleep, deadline, logger, catalog, state,
          });
          downloaded = result.downloaded || 0;
          failed = result.failed || 0;
        } catch (downloadErr) {
          if (downloadErr.kind === 'blocked' || downloadErr.kind === 'transient') err = downloadErr;
          else logger.warn(`[annual] senate indexed download failed: ${downloadErr.message}`);
        }
      }
      const status = Number(err.status) || 500;
      const kind = failureKind(err.kind);
      const backoff = annualFailureBackoff(Date.now(), { kind, status, snippet: err.snippet || '' });
      state.backoff = { ...(state.backoff || {}), senate: backoff };
      summary.senate = {
        error: err.message,
        downloaded,
        failed,
        kind,
        status,
        until: backoff.until,
        queued: (state.senate?.queue || []).length,
        indexDone: false,
        stop: state.senate?.stop?.reason || null,
      };
      logger.error(`[annual] senate failed: ${err.message}`);
    }
  }
  let coverage = null;
  let storedKeys = [];
  try {
    const summaries = await store.listAnnualFilingSummaries();
    coverage = annualCoverage(summaries);
    storedKeys = summaries.map((row) => row.filingKey);
  } catch (err) {
    logger.warn(`[annual] coverage failed: ${err.message}`);
  }
  const mark = summary.senate?.error ? (queueTouched ? true : 'backoff') : (queueTouched ? true : false);
  const saved = await commitAnnualState(store, {
    ...state,
    lastRunAt: new Date().toISOString(),
    lastSummary: summary,
    coverage,
  }, { senate: mark }, storedKeys);
  logger.log(formatAnnualProgress(saved.progress, { downloaded: summary.senate?.downloaded || 0 }));
  return { ...summary, coverage, progress: saved.progress };
}
