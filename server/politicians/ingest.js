// Scheduled pull of House PTR filings, Senate eFD reports, and presidential
// OGE 278-Ts. Each source is idempotent: a filing id that is already stored
// is not downloaded again. The first runs walk the backfill window in small
// batches and do not email that history.

import { pdfBufferToLayoutText } from '../historyPdf.js';
import { backoffActive, nextSourceBackoff } from './backoff.js';
import { politicianConfig } from './config.js';
import { backfillYearList, isoDate, windowStartIso } from './normalize.js';
import {
  houseIndexUrl,
  parseHouseIndexTxt,
  parseHouseIndexXml,
  parseHousePtrText,
} from './parseHouse.js';
import { OGE_API, parseOge278Text, parseOgeApiRow } from './parseOge.js';
import { parseSenatePtrHtml, parseSenateSearchRow, reviewPaperFiling, SENATE_BASE } from './parseSenate.js';
import { buildFilingRecord, buildTradeRows, heldIndex, splitStateDst } from './records.js';
import { matchHouseParty, matchSenateParty, parseHouseRoster, parseSenateRoster } from './roster.js';
import { readZipEntries, zipText } from './zip.js';
import { buildPoliticianDigest } from './digest.js';

export const POLITICIAN_UA = 'FolioTrack/1.0 (model-portfolio research; +https://foliotrack.onrender.com)';

const HOUSE_ROSTER_URL = 'https://clerk.house.gov/xml/lists/MemberData.xml';
const SENATE_ROSTER_URL = 'https://www.senate.gov/general/contact_information/senators_cfm.xml';
const ROSTER_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export class SourceHttpError extends Error {
  constructor(source, status) {
    super(`${source} returned HTTP ${status}`);
    this.name = 'SourceHttpError';
    this.source = source;
    this.status = status;
  }
}

function past(deadline) {
  return Number.isFinite(deadline) && Date.now() > deadline;
}

async function http(fetchImpl, url, init = {}) {
  const headers = {
    'User-Agent': POLITICIAN_UA,
    Accept: init.accept || '*/*',
    ...(init.headers || {}),
  };
  const res = await fetchImpl(url, {
    method: init.method || 'GET',
    headers,
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
  const list = typeof res.headers?.getSetCookie === 'function'
    ? res.headers.getSetCookie()
    : [];
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

async function acceptSenate(fetchImpl) {
  const jar = {};
  let res = await http(fetchImpl, `${SENATE_BASE}/search/`, { redirect: 'manual' });
  storeCookies(jar, res);
  if (res.status >= 300 && res.status < 400) {
    const loc = new URL(res.headers.get('location'), SENATE_BASE).href;
    res = await http(fetchImpl, loc, { redirect: 'manual', headers: { Cookie: cookieHeader(jar) } });
    storeCookies(jar, res);
  }
  if (res.status === 429 || res.status >= 500) throw new SourceHttpError('senate', res.status);
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
  if (agreed.status === 429 || agreed.status >= 500) throw new SourceHttpError('senate', agreed.status);
  if (!jar.csrftoken) throw new Error('Senate eFD did not set a session cookie');
  return jar;
}

function slashDate(iso) {
  const [y, m, d] = iso.split('-');
  return `${Number(m)}/${Number(d)}/${y}`;
}

function todayIso(now) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

async function saveBundle(store, filing, parsed) {
  const trades = buildTradeRows(filing, parsed);
  const result = await store.insertPoliticianBundle(
    { ...filing, parseStatus: parsed.status, parseNote: parsed.note || null },
    trades,
  );
  return {
    ...result,
    trades: result.created ? trades : [],
    review: result.created && parsed.status !== 'parsed' ? filing : null,
  };
}

async function loadRoster(store, fetchImpl, nowMs, logger) {
  const cached = await store.getPoliticianRoster();
  if (cached?.fetchedAt && nowMs - Date.parse(cached.fetchedAt) < ROSTER_MAX_AGE_MS) {
    return cached;
  }
  try {
    const [houseRes, senateRes] = await Promise.all([
      http(fetchImpl, HOUSE_ROSTER_URL, { accept: 'application/xml,text/xml' }),
      http(fetchImpl, SENATE_ROSTER_URL, { accept: 'application/xml,text/xml' }),
    ]);
    if (!houseRes.ok || !senateRes.ok) throw new Error(`roster HTTP ${houseRes.status}/${senateRes.status}`);
    const roster = {
      fetchedAt: new Date(nowMs).toISOString(),
      house: parseHouseRoster(await houseRes.text()),
      senate: parseSenateRoster(await senateRes.text()),
    };
    await store.setPoliticianRoster(roster);
    logger.log(`[politicians] roster house=${roster.house.length} senate=${roster.senate.length}`);
    return roster;
  } catch (err) {
    logger.warn(`[politicians] roster refresh failed: ${err.message}`);
    return cached || { house: [], senate: [] };
  }
}

async function ingestHouse({ fetchImpl, store, roster, years, cap, delayMs, sleep, deadline, logger }) {
  const candidates = [];
  let indexDone = true;
  for (const year of years) {
    if (past(deadline)) {
      indexDone = false;
      break;
    }
    const res = await http(fetchImpl, houseIndexUrl(year));
    if (res.status === 404) {
      logger.log(`[politicians] house ${year} index is not published`);
      continue;
    }
    if (res.status === 429 || res.status >= 500) throw new SourceHttpError('house', res.status);
    if (res.status !== 200) throw new SourceHttpError('house', res.status);
    const entries = readZipEntries(await readBytes(res));
    const xml = zipText(entries, '.xml');
    const txt = zipText(entries, '.txt');
    const filings = xml ? parseHouseIndexXml(xml) : parseHouseIndexTxt(txt || '');
    candidates.push(...filings);
    logger.log(`[politicians] house ${year} ptr filings in index=${filings.length}`);
    await sleep(delayMs);
  }
  const byKey = new Map();
  for (const candidate of candidates) if (!byKey.has(candidate.filingKey)) byKey.set(candidate.filingKey, candidate);
  const unique = [...byKey.values()];
  unique.sort((a, b) => String(b.filedDate || '').localeCompare(String(a.filedDate || '')));
  const existing = new Set(await store.existingPoliticianKeys('house', unique.map((c) => c.filingKey)));
  const fresh = [];
  const reviews = [];
  let downloaded = 0;
  let caughtUp = indexDone;
  for (const candidate of unique) {
    if (existing.has(candidate.filingKey)) continue;
    if (downloaded >= cap || past(deadline)) {
      caughtUp = false;
      break;
    }
    downloaded += 1;
    await sleep(delayMs);
    const res = await http(fetchImpl, candidate.sourceUrl);
    if (res.status === 429 || res.status >= 500) throw new SourceHttpError('house', res.status);
    const where = splitStateDst(candidate.stateDst);
    const party = matchHouseParty(candidate, roster.house);
    let parsed;
    if (res.status !== 200) {
      parsed = {
        status: 'needs_manual_review',
        trades: [],
        note: `The Clerk returned HTTP ${res.status} for this PDF.`,
      };
    } else {
      try {
        const text = await pdfBufferToLayoutText(await readBytes(res));
        parsed = parseHousePtrText(text);
      } catch (err) {
        parsed = {
          status: 'needs_manual_review',
          trades: [],
          note: 'The PDF could not be read as text, so no amounts were guessed.',
        };
        logger.warn(`[politicians] house ${candidate.filingKey} pdf: ${err.message}`);
      }
    }
    const filing = buildFilingRecord({
      source: 'house',
      filingKey: candidate.filingKey,
      first: candidate.first,
      last: candidate.last,
      office: 'house',
      party: party.party,
      state: party.state || where.state,
      district: party.district || where.district,
      filedDate: candidate.filedDate,
      sourceUrl: candidate.sourceUrl,
      parsed,
    });
    const saved = await saveBundle(store, filing, parsed);
    fresh.push(...saved.trades);
    if (saved.review) reviews.push(saved.review);
  }
  const parsedN = fresh.length ? new Set(fresh.map((t) => t.filingId)).size : 0;
  logger.log(`[politicians] house downloaded=${downloaded} newTrades=${fresh.length} review=${reviews.length} parsedFilings=${parsedN} caughtUp=${caughtUp}`);
  return { newTrades: fresh, newReviews: reviews, caughtUp, downloaded };
}

async function ingestSenate({
  fetchImpl, store, roster, windowStart, today, cap, delayMs, sleep, deadline, logger, cursor = 0,
}) {
  const jar = await acceptSenate(fetchImpl);
  const candidates = [];
  const pageSize = 100;
  const pagesPerRun = 3;
  // Page 0 is always read so a filing posted today is not skipped while the
  // backfill cursor is further down the list. The cursor then walks older pages.
  const offsets = [];
  if (cursor > 0) offsets.push(0);
  for (let i = 0; i < pagesPerRun; i += 1) offsets.push(cursor + i * pageSize);
  const uniqueOffsets = [...new Set(offsets)];
  let pages = 0;
  let indexDone = false;
  let furthest = cursor;
  for (const offset of uniqueOffsets) {
    if (past(deadline)) break;
    const body = new URLSearchParams({
      start: String(offset),
      length: String(pageSize),
      report_types: '[11]',
      filer_types: '[1]',
      submitted_start_date: slashDate(windowStart),
      submitted_end_date: slashDate(today),
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
    if (res.status === 429 || res.status >= 500) throw new SourceHttpError('senate', res.status);
    if (res.status !== 200) throw new SourceHttpError('senate', res.status);
    const payload = JSON.parse(await res.text());
    const rows = Array.isArray(payload.data) ? payload.data : [];
    pages += 1;
    for (const row of rows) {
      const parsed = parseSenateSearchRow(row);
      if (parsed) candidates.push(parsed);
    }
    const end = offset + rows.length;
    if (offset !== 0 || cursor === 0) furthest = Math.max(furthest, end);
    const total = Number(payload.recordsFiltered ?? payload.recordsTotal ?? 0);
    if (!rows.length || end >= total) {
      indexDone = true;
      break;
    }
    await sleep(delayMs);
  }
  const seenFiling = new Set();
  const uniqueCandidates = [];
  for (const candidate of candidates) {
    if (seenFiling.has(candidate.filingKey)) continue;
    seenFiling.add(candidate.filingKey);
    uniqueCandidates.push(candidate);
  }
  logger.log(`[politicians] senate index rows=${uniqueCandidates.length} pages=${pages} cursor=${cursor}`);
  const existing = new Set(await store.existingPoliticianKeys('senate', uniqueCandidates.map((c) => c.filingKey)));
  const fresh = [];
  const reviews = [];
  let downloaded = 0;
  let stoppedEarly = false;
  for (const candidate of uniqueCandidates) {
    if (existing.has(candidate.filingKey)) continue;
    if (past(deadline)) {
      stoppedEarly = true;
      break;
    }
    const party = matchSenateParty(candidate, roster.senate);
    if (candidate.kind === 'paper') {
      const parsed = reviewPaperFiling();
      const filing = buildFilingRecord({
        source: 'senate',
        filingKey: candidate.filingKey,
        first: candidate.first,
        last: candidate.last,
        office: 'senate',
        party: party.party,
        state: party.state,
        filedDate: candidate.filedDate,
        sourceUrl: candidate.sourceUrl,
        parsed,
      });
      const saved = await saveBundle(store, filing, parsed);
      if (saved.review) reviews.push(saved.review);
      continue;
    }
    if (downloaded >= cap) {
      stoppedEarly = true;
      break;
    }
    downloaded += 1;
    await sleep(delayMs);
    const res = await http(fetchImpl, candidate.sourceUrl, {
      headers: { Cookie: cookieHeader(jar), Referer: `${SENATE_BASE}/search/` },
    });
    if (res.status === 429 || res.status >= 500) throw new SourceHttpError('senate', res.status);
    let parsed;
    if (res.status !== 200) {
      parsed = reviewPaperFiling(`The Senate returned HTTP ${res.status} for this report.`);
    } else {
      parsed = parseSenatePtrHtml(await res.text());
    }
    const filing = buildFilingRecord({
      source: 'senate',
      filingKey: candidate.filingKey,
      first: candidate.first,
      last: candidate.last,
      office: 'senate',
      party: party.party,
      state: party.state,
      filedDate: candidate.filedDate,
      sourceUrl: candidate.sourceUrl,
      parsed,
    });
    const saved = await saveBundle(store, filing, parsed);
    fresh.push(...saved.trades);
    if (saved.review) reviews.push(saved.review);
  }
  // A run that stops at the download cap must not skip the filings it did
  // not reach. The next run rereads this slice, skips what is stored, and
  // continues. A finished slice advances the cursor. A finished index
  // resets it so the next poll starts at the newest page.
  const caughtUp = indexDone && !stoppedEarly;
  const nextCursor = stoppedEarly ? cursor : (indexDone ? 0 : furthest);
  logger.log(`[politicians] senate downloaded=${downloaded} newTrades=${fresh.length} review=${reviews.length} caughtUp=${caughtUp} nextCursor=${nextCursor}`);
  return { newTrades: fresh, newReviews: reviews, caughtUp, downloaded, cursor: nextCursor };
}

function ogeQuery(start) {
  const params = new URLSearchParams();
  params.set('draw', '1');
  params.set('start', String(start));
  params.set('length', '100');
  params.set('search[value]', '');
  params.set('order[0][column]', '0');
  params.set('order[0][dir]', 'desc');
  const cols = ['docDate', 'title', 'type', 'name', 'agency', 'level'];
  cols.forEach((name, i) => {
    params.set(`columns[${i}][data]`, name);
    params.set(`columns[${i}][searchable]`, 'true');
    params.set(`columns[${i}][orderable]`, 'true');
    params.set(`columns[${i}][search][regex]`, 'false');
    const value = name === 'type' ? '278 Transaction' : (name === 'title' ? 'President' : '');
    params.set(`columns[${i}][search][value]`, value);
  });
  return params;
}

async function ogePage(fetchImpl, start) {
  const url = `${OGE_API}?${ogeQuery(start).toString()}`;
  const res = await http(fetchImpl, url, { accept: 'application/json' });
  if (res.status === 429 || res.status >= 500) throw new SourceHttpError('oge', res.status);
  if (res.status !== 200) throw new SourceHttpError('oge', res.status);
  const payload = JSON.parse(await res.text());
  return {
    data: Array.isArray(payload.data) ? payload.data : [],
    filtered: Number(payload.recordsFiltered ?? payload.recordsTotal ?? 0),
  };
}

function dateSpan(rows) {
  const dates = rows.map((r) => isoDate(r.docDate)).filter(Boolean).sort();
  return { oldest: dates[0] || null, newest: dates[dates.length - 1] || null };
}

async function ingestOge({ fetchImpl, store, windowStart, cap, maxPdfBytes, delayMs, sleep, deadline, logger }) {
  const page0 = await ogePage(fetchImpl, 0);
  let rows = page0.data.slice();
  const span = dateSpan(page0.data);
  if (span.newest && span.newest < windowStart && page0.filtered > page0.data.length) {
    await sleep(delayMs);
    const last = await ogePage(fetchImpl, Math.max(0, page0.filtered - 100));
    rows = last.data.slice();
  } else if (page0.filtered > page0.data.length && (!span.oldest || span.oldest >= windowStart)) {
    await sleep(delayMs);
    const next = await ogePage(fetchImpl, page0.data.length);
    rows = rows.concat(next.data);
  }
  const candidates = [];
  for (const row of rows) {
    const parsed = parseOgeApiRow(row);
    if (!parsed?.office) continue;
    if (parsed.filedDate && parsed.filedDate < windowStart) continue;
    candidates.push(parsed);
  }
  logger.log(`[politicians] oge index rows=${rows.length} in window=${candidates.length}`);
  const existing = new Set(await store.existingPoliticianKeys('oge', candidates.map((c) => c.filingKey)));
  const fresh = [];
  const reviews = [];
  let downloaded = 0;
  let caughtUp = true;
  for (const candidate of candidates) {
    if (existing.has(candidate.filingKey)) continue;
    if (past(deadline)) {
      caughtUp = false;
      break;
    }
    let parsed;
    if (candidate.request) {
      parsed = {
        status: 'needs_manual_review',
        trades: [],
        note: 'OGE has not posted this 278-T for download. The link requests the document.',
      };
    } else if (downloaded >= cap) {
      caughtUp = false;
      break;
    } else {
      downloaded += 1;
      await sleep(delayMs);
      const head = await http(fetchImpl, candidate.sourceUrl, { method: 'HEAD' });
      const length = Number(head.headers?.get?.('content-length'));
      if (head.status === 429 || head.status >= 500) throw new SourceHttpError('oge', head.status);
      if (!Number.isFinite(length) || length > maxPdfBytes || head.status !== 200) {
        const size = Number.isFinite(length) ? `${Math.max(1, Math.round(length / 1e6))} MB` : 'an unknown size';
        parsed = {
          status: 'needs_manual_review',
          trades: [],
          note: `The 278-T PDF is ${size}. Scanned presidential reports are linked here and not guessed.`,
        };
      } else {
        const res = await http(fetchImpl, candidate.sourceUrl);
        if (res.status === 429 || res.status >= 500) throw new SourceHttpError('oge', res.status);
        try {
          const text = res.status === 200 ? await pdfBufferToLayoutText(await readBytes(res)) : '';
          parsed = res.status === 200
            ? parseOge278Text(text)
            : {
              status: 'needs_manual_review',
              trades: [],
              note: `OGE returned HTTP ${res.status} for this PDF.`,
            };
        } catch (err) {
          parsed = {
            status: 'needs_manual_review',
            trades: [],
            note: 'The 278-T PDF could not be read as text, so no amounts were guessed.',
          };
          logger.warn(`[politicians] oge ${candidate.filingKey} pdf: ${err.message}`);
        }
      }
    }
    const filing = buildFilingRecord({
      source: 'oge',
      filingKey: candidate.filingKey,
      first: candidate.first,
      last: candidate.last,
      office: candidate.office,
      filedDate: candidate.filedDate,
      sourceUrl: candidate.sourceUrl,
      parsed,
    });
    const saved = await saveBundle(store, filing, parsed);
    fresh.push(...saved.trades);
    if (saved.review) reviews.push(saved.review);
  }
  logger.log(`[politicians] oge downloaded=${downloaded} newTrades=${fresh.length} review=${reviews.length} caughtUp=${caughtUp}`);
  return { newTrades: fresh, newReviews: reviews, caughtUp, downloaded };
}

async function sendDigest({ store, email, trades, reviews, heldOnly, enabled, logger }) {
  if (!enabled) return { sent: false, reason: 'alerts off' };
  const symbols = await store.listHeldPoliticianSymbols();
  const heldByNorm = heldIndex(symbols);
  const message = buildPoliticianDigest({ trades, reviews, heldByNorm, heldOnly });
  if (!message) return { sent: false, reason: 'nothing to send' };
  const settings = await store.getAlertSettings();
  const result = await email.send({
    to: settings.alertEmail,
    subject: message.subject,
    text: message.text,
    html: message.html,
  });
  if (!result?.ok) {
    logger.warn(`[politicians] digest not sent: ${result?.reason || 'email failed'}`);
    return { sent: false, reason: result?.reason || 'email failed' };
  }
  logger.log(`[politicians] digest sent id=${result.id || 'ok'} trades=${trades.length} held=${message.held}`);
  return { sent: true, id: result.id || null };
}

export async function runPoliticianPoll({
  store,
  fetchImpl = globalThis.fetch,
  email = null,
  now = () => new Date(),
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  logger = console,
  env = process.env,
  deadline = null,
} = {}) {
  const cfg = politicianConfig(env);
  const clock = now();
  const nowMs = Date.now();
  // The budget is wall-clock. `now` only chooses the filing window, so a test
  // can pin the calendar year without expiring the run immediately.
  const stopAt = deadline ?? (nowMs + cfg.budgetMs);
  const state = { ...(await store.getPoliticianPollState()) };
  const sources = { ...(state.sources || {}) };
  const alertsWereArmed = state.alertsArmed === true;
  const windowStart = windowStartIso(clock, cfg.backfillYears);
  const today = todayIso(clock);
  const years = backfillYearList(clock, cfg.backfillYears);
  const roster = await loadRoster(store, fetchImpl, nowMs, logger);
  const summary = {};
  const newTrades = [];
  const newReviews = [];
  let allCaughtUp = true;

  const jobs = [
    ['house', () => ingestHouse({
      fetchImpl, store, roster, years, cap: cfg.docsPerRun, delayMs: cfg.delayMs, sleep, deadline: stopAt, logger,
    })],
    ['senate', () => ingestSenate({
      fetchImpl, store, roster, windowStart, today, cap: cfg.docsPerRun, delayMs: cfg.delayMs, sleep, deadline: stopAt, logger,
      cursor: Number(sources.senate?.cursor) || 0,
    })],
    ['oge', () => ingestOge({
      fetchImpl, store, windowStart, cap: cfg.docsPerRun, maxPdfBytes: cfg.maxPdfBytes,
      delayMs: cfg.delayMs, sleep, deadline: stopAt, logger,
    })],
  ];

  for (const [name, run] of jobs) {
    if (backoffActive(sources[name], nowMs)) {
      summary[name] = { skipped: 'backoff', until: sources[name].until };
      allCaughtUp = false;
      logger.log(`[politicians] ${name} skipped until ${sources[name].until}`);
      continue;
    }
    if (past(stopAt)) {
      summary[name] = { skipped: 'budget' };
      allCaughtUp = false;
      continue;
    }
    try {
      const result = await run();
      sources[name] = {
        strikes: 0,
        until: null,
        cursor: result.cursor ?? sources[name]?.cursor ?? 0,
      };
      summary[name] = {
        newTrades: result.newTrades.length,
        review: result.newReviews.length,
        caughtUp: result.caughtUp,
        downloaded: result.downloaded,
      };
      newTrades.push(...result.newTrades);
      newReviews.push(...result.newReviews);
      if (!result.caughtUp) allCaughtUp = false;
    } catch (err) {
      const status = err instanceof SourceHttpError ? err.status : 500;
      sources[name] = {
        ...nextSourceBackoff(sources[name], Date.now(), status),
        cursor: sources[name]?.cursor ?? 0,
      };
      summary[name] = { error: err.message, until: sources[name].until };
      allCaughtUp = false;
      logger.error(`[politicians] ${name} failed: ${err.message}`);
    }
  }

  const settings = await store.getPoliticianAlertSettings();
  let digest = { sent: false, reason: 'backfill' };
  if (alertsWereArmed && email) {
    try {
      digest = await sendDigest({
        store,
        email,
        trades: newTrades,
        reviews: newReviews,
        heldOnly: settings.politicianAlertsHeldOnly,
        enabled: settings.politicianAlertsEnabled,
        logger,
      });
    } catch (err) {
      digest = { sent: false, reason: err.message };
      logger.error(`[politicians] digest failed: ${err.message}`);
    }
  } else if (!alertsWereArmed) {
    logger.log('[politicians] digest held until the backfill window has been walked once');
  }

  const finished = new Date().toISOString();
  const next = {
    ...state,
    alertsArmed: alertsWereArmed || allCaughtUp,
    lastRunAt: finished,
    lastSuccessAt: finished,
    lastError: null,
    lastSummary: { ...summary, digest, windowStart, newTrades: newTrades.length, newReviews: newReviews.length },
    sources,
  };
  await store.setPoliticianPollState(next);
  return next.lastSummary;
}
