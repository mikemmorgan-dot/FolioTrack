// Scheduled OCR for presidential and vice-presidential OGE 278-Ts.
// The Render Node service leaves these filings pending. This job runs where
// tesseract and pdftoppm exist, then writes the same rows the app would.

import { politicianConfig } from './config.js';
import {
  SourceHttpError,
  downloadOgePdf,
  loadOgeCandidates,
  readOgePdf,
  saveBundle,
} from './ingest.js';
import { windowStartIso } from './normalize.js';
import { OCR_FAILED_NOTE, claimFresh, ocrSettled } from './ocrPending.js';
import { buildFilingRecord } from './records.js';

export function missingDatabaseUrlMessage() {
  return [
    'DATABASE_URL is not set.',
    'Add the Neon connection string the Render service uses as a repository secret named DATABASE_URL.',
    'GitHub: Settings → Secrets and variables → Actions → New repository secret.',
    'Name: DATABASE_URL',
    'Do not commit the URL or print it in the workflow log.',
  ].join('\n');
}

export function assertDatabaseUrl(env = process.env) {
  const url = String(env.DATABASE_URL || '').trim();
  if (!url) {
    const err = new Error(missingDatabaseUrlMessage());
    err.code = 'MISSING_DATABASE_URL';
    throw err;
  }
  return url;
}

export function redactSecrets(text, env = process.env) {
  let out = String(text ?? '');
  const url = String(env.DATABASE_URL || '').trim();
  if (url.length >= 8 && out.includes(url)) out = out.split(url).join('[redacted]');
  return out.replace(/postgres(?:ql)?:\/\/\S+/gi, '[redacted]');
}

export function normalizeFilingKey(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const stripped = raw.replace(/^oge:/i, '');
  if (!/^[A-F0-9]{16,64}$/i.test(stripped)) {
    const err = new Error('filing_key must be the OGE document id (the hex id in the PDF URL).');
    err.code = 'BAD_FILING_KEY';
    throw err;
  }
  return stripped.toUpperCase();
}

function withDigest(parsed) {
  return {
    ...parsed,
    trades: (parsed?.trades || []).map((trade) => ({ ...trade, digestPending: true })),
  };
}

const PROGRAMMING_ERROR_NAMES = new Set(['TypeError', 'ReferenceError', 'SyntaxError', 'RangeError']);

// A TypeError is a bug in this job, not a bad PDF. Leave the filing pending
// so a later run can read it after the code is fixed.
function isProgrammingError(err) {
  if (!err || (typeof err !== 'object' && typeof err !== 'function')) return false;
  if (PROGRAMMING_ERROR_NAMES.has(err.name)) return true;
  return err instanceof TypeError
    || err instanceof ReferenceError
    || err instanceof SyntaxError
    || err instanceof RangeError;
}

function isRetryable(err) {
  if (isProgrammingError(err)) return true;
  if (err instanceof SourceHttpError) return true;
  const name = err?.name || '';
  if (name === 'AbortError' || name === 'TimeoutError') return true;
  return /timed out|ECONNRESET|EAI_AGAIN|fetch failed|network/i.test(String(err?.message || ''));
}

function failureDetail(err, env) {
  const status = err?.status ? ` HTTP ${err.status}` : '';
  const message = redactSecrets(err?.message || String(err ?? 'unknown error'), env);
  const name = err?.name && err.name !== 'Error' && !message.startsWith(`${err.name}:`)
    ? `${err.name}: `
    : '';
  return `${status}: ${name}${message}`;
}

function filingDraft(candidate) {
  return buildFilingRecord({
    source: 'oge',
    filingKey: candidate.filingKey,
    first: candidate.first,
    last: candidate.last,
    office: candidate.office,
    filedDate: candidate.filedDate,
    sourceUrl: candidate.sourceUrl,
    parsed: { status: 'ocr_running', note: 'OCR in progress', ocrDone: false },
  });
}

async function processOne({
  key,
  candidate,
  store,
  fetchImpl,
  readPdf,
  download,
  force,
  maxPdfBytes,
  now,
  logger,
  env,
}) {
  let stored = null;
  if (!candidate) {
    stored = await store.getPresidentialFiling(key);
    if (!stored) return { filingKey: key, action: 'missing' };
    if (stored.sourceUrl && !/\$FILE|%24FILE/i.test(stored.sourceUrl)) {
      return { filingKey: key, action: 'request' };
    }
    if (!force && (ocrSettled(stored, true, now.getTime()) || claimFresh(stored, now.getTime()))) {
      return { filingKey: key, action: 'skipped' };
    }
  } else if (candidate.request) {
    return { filingKey: key, action: 'request' };
  }

  const draft = candidate ? filingDraft(candidate) : stored;
  const claim = await store.claimPoliticianOcr(
    { ...draft, source: 'oge', filingKey: key },
    { force, now },
  );
  if (!claim.claimed) return { filingKey: key, action: 'skipped' };

  const sourceUrl = candidate?.sourceUrl || stored?.sourceUrl;
  const started = Date.now();
  try {
    const pdf = await download(fetchImpl, sourceUrl, maxPdfBytes);
    const parsed = withDigest(pdf.parsed || await readPdf(pdf.bytes, now));
    await saveBundle(store, draft, parsed);
    const ms = Date.now() - started;
    logger.log(`[presidential-ocr] ${key} status=${parsed.status} kept=${parsed.trades.length} pages=${parsed.pageCount ?? ''} ms=${ms}`);
    return {
      filingKey: key,
      action: 'ocr',
      status: parsed.status,
      trades: parsed.trades.length,
      pages: parsed.pageCount ?? null,
      ms,
    };
  } catch (err) {
    logger.error(`[presidential-ocr] ${key} failed${failureDetail(err, env)}`);
    if (isRetryable(err)) {
      await store.releasePoliticianOcrClaim(draft.id);
      return { filingKey: key, action: 'retry', ms: Date.now() - started };
    }
    await saveBundle(store, draft, {
      status: 'needs_manual_review',
      trades: [],
      note: OCR_FAILED_NOTE,
      ocrDone: true,
    });
    return { filingKey: key, action: 'failed', ms: Date.now() - started };
  }
}

export async function runPresidentialOcr({
  store,
  fetchImpl = globalThis.fetch,
  readPdf = readOgePdf,
  download = downloadOgePdf,
  loadCandidates = loadOgeCandidates,
  now = new Date(),
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  logger = console,
  env = process.env,
  filingKey = '',
  maxFilings = 20,
} = {}) {
  const forceKey = normalizeFilingKey(filingKey);
  const cfg = politicianConfig(env);
  const clock = now instanceof Date ? now : new Date(now);
  const windowStart = windowStartIso(clock, cfg.backfillYears);
  if (typeof store?.recoverFailedPresidentialOcr === 'function') {
    const recovered = await store.recoverFailedPresidentialOcr();
    if (recovered) {
      logger.log(`[presidential-ocr] restored ${recovered} presidential filing${recovered === 1 ? '' : 's'} to pending OCR`);
    }
  }
  let candidates = [];
  try {
    candidates = await loadCandidates({
      fetchImpl,
      windowStart,
      sleep,
      delayMs: cfg.delayMs,
    });
  } catch (err) {
    logger.error(`[presidential-ocr] OGE index failed${failureDetail(err, env)}`);
  }
  const byKey = new Map(candidates.map((row) => [row.filingKey, row]));
  let queue = [];
  if (forceKey) {
    queue = [forceKey];
  } else {
    const pending = await store.listPendingPresidentialFilings({ limit: maxFilings, now: clock });
    const seen = new Set();
    for (const row of pending) {
      if (!row?.filingKey || seen.has(row.filingKey)) continue;
      seen.add(row.filingKey);
      queue.push(row.filingKey);
    }
    const freshKeys = candidates
      .filter((row) => row?.filingKey && !row.request && !seen.has(row.filingKey))
      .map((row) => row.filingKey);
    const known = freshKeys.length ? await store.getPoliticianFilings('oge', freshKeys) : [];
    const knownMap = new Map(known.map((row) => [row.filingKey, row]));
    for (const key of freshKeys) {
      const row = knownMap.get(key);
      if (row && (ocrSettled(row, true, clock.getTime()) || claimFresh(row, clock.getTime()))) continue;
      seen.add(key);
      queue.push(key);
      if (queue.length >= maxFilings) break;
    }
    queue = queue.slice(0, maxFilings);
  }

  const filings = [];
  for (const key of queue) {
    const outcome = await processOne({
      key,
      candidate: byKey.get(key) || null,
      store,
      fetchImpl,
      readPdf,
      download,
      force: Boolean(forceKey),
      maxPdfBytes: cfg.maxPdfBytes,
      now: clock,
      logger,
      env,
    });
    filings.push(outcome);
    if (outcome.action === 'ocr' || outcome.action === 'failed' || outcome.action === 'retry') {
      await sleep(cfg.delayMs);
    }
  }
  return { filings, windowStart };
}

const ATTEMPTED = new Set(['ocr', 'failed', 'retry']);

export function everyAttemptedFilingFailed(result) {
  const attempted = (result?.filings || []).filter((row) => ATTEMPTED.has(row.action));
  return attempted.length > 0 && attempted.every((row) => row.action === 'failed' || row.action === 'retry');
}

export function exitCodeForOcrRun(result) {
  const filings = result?.filings || [];
  if (filings.some((row) => row.action === 'missing')) return 1;
  if (everyAttemptedFilingFailed(result)) return 1;
  return 0;
}

export function formatOcrSummary(result) {
  const lines = ['Presidential 278-T OCR', ''];
  const filings = result?.filings || [];
  if (!filings.length) {
    lines.push('No pending presidential filings.');
    return lines.join('\n');
  }
  lines.push('Filing | Result | Rows kept | Pages | Seconds');
  for (const row of filings) {
    const seconds = row.ms == null ? '' : (row.ms / 1000).toFixed(1);
    lines.push(`${row.filingKey} | ${row.action} | ${row.trades ?? ''} | ${row.pages ?? ''} | ${seconds}`);
  }
  if (everyAttemptedFilingFailed(result)) {
    lines.push('', 'Every attempted filing failed.');
  }
  return lines.join('\n');
}
