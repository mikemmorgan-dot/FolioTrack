// Re-read annual filings stored under an older parser version. Bounded
// slices respect House/OGE rate limits and free-plan memory (one PDF at a
// time, a short wall clock, a small cap). Holdings are not emailed and no
// trade rows are written. Senate paper filings are stamped in place.

import { parseHouseAnnualPdf } from './parseHouseAnnual.js';
import { parseOgeAnnualPdf } from './parseOgeAnnual.js';
import { replaceAnnualParse } from './annualIngest.js';
import { POLITICIAN_UA } from './senateFetch.js';
import {
  ANNUAL_PARSER_REVISIT_BUDGET_MS,
  ANNUAL_PARSER_REVISIT_CAP,
  ANNUAL_PARSER_VERSION,
  formatParserRevisitProgress,
  isStaleParserFiling,
  shouldRefetchStaleParserFiling,
} from './annualParserVersion.js';

function past(deadline) {
  return Number.isFinite(deadline) && Date.now() > deadline;
}

async function http(fetchImpl, url, timeoutMs = 60_000) {
  return fetchImpl(url, {
    method: 'GET',
    headers: {
      'User-Agent': POLITICIAN_UA,
      Accept: '*/*',
    },
    redirect: 'follow',
    signal: typeof AbortSignal !== 'undefined' && AbortSignal.timeout
      ? AbortSignal.timeout(timeoutMs)
      : undefined,
  });
}

async function readBytes(res) {
  if (typeof res.arrayBuffer === 'function') return Buffer.from(await res.arrayBuffer());
  if (typeof res.text === 'function') return Buffer.from(await res.text());
  return Buffer.alloc(0);
}

async function defaultParseFiling(filing, bytes) {
  if (filing.source === 'oge') return parseOgeAnnualPdf(bytes);
  return parseHouseAnnualPdf(bytes);
}

export async function withParserRevisitStatus(store, state = {}) {
  let remaining = state?.parserRevisit?.remaining;
  if (typeof store.countStaleParserAnnualFilings === 'function') {
    remaining = await store.countStaleParserAnnualFilings({ parserVersion: ANNUAL_PARSER_VERSION });
  }
  const n = Number(remaining);
  const count = Number.isFinite(n) ? n : 0;
  return {
    ...state,
    parserVersion: ANNUAL_PARSER_VERSION,
    parserRevisit: {
      ...(state?.parserRevisit || {}),
      version: ANNUAL_PARSER_VERSION,
      remaining: count,
      done: count === 0,
    },
  };
}

export async function runParserRevisitSlice({
  fetchImpl = globalThis.fetch,
  store,
  delayMs = 1200,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  deadline = Date.now() + ANNUAL_PARSER_REVISIT_BUDGET_MS,
  logger = console,
  catalog = null,
  maxPdfBytes = 32 * 1024 * 1024,
  cap = ANNUAL_PARSER_REVISIT_CAP,
  parserVersion = ANNUAL_PARSER_VERSION,
  parseFiling = defaultParseFiling,
} = {}) {
  if (!store || typeof store.listStaleParserAnnualFilings !== 'function') {
    return { remaining: 0, stamped: 0, downloaded: 0, revisited: 0, failed: 0, skipped: true };
  }

  const queue = await store.listStaleParserAnnualFilings({
    parserVersion,
    // Stamp many in-place rows in one slice; refetch is still capped.
    limit: Math.max(80, cap * 4),
  });

  let stamped = 0;
  let downloaded = 0;
  let revisited = 0;
  let failed = 0;
  let parsed = 0;
  let pendingOcr = 0;
  const tradesBefore = Array.isArray(store.db?.politicianTrades)
    ? store.db.politicianTrades.length
    : null;

  for (const filing of queue) {
    if (!isStaleParserFiling(filing, parserVersion)) continue;
    if (shouldRefetchStaleParserFiling(filing)) {
      if (downloaded >= cap || past(deadline)) continue;
      let res;
      try {
        if (delayMs) await sleep(delayMs);
        res = await http(fetchImpl, filing.sourceUrl);
      } catch (err) {
        failed += 1;
        logger.warn(`[annual] parser revisit ${filing.source} ${filing.filingKey} failed: ${err.message}`);
        continue;
      }
      if (res.status !== 200) {
        failed += 1;
        logger.warn(`[annual] parser revisit ${filing.source} ${filing.filingKey} HTTP ${res.status}`);
        continue;
      }
      downloaded += 1;
      const bytes = await readBytes(res);
      let result;
      if (bytes.length > maxPdfBytes) {
        result = {
          status: 'needs_manual_review',
          holdings: [],
          excludedCount: 0,
          note: `The annual PDF is over the ${Math.round(maxPdfBytes / 1e6)} MB cap, so it was not read.`,
          parserVersion,
        };
      } else {
        try {
          result = await parseFiling(filing, bytes);
        } catch (err) {
          result = {
            status: 'needs_manual_review',
            holdings: [],
            excludedCount: 0,
            note: 'The annual PDF could not be read as text, so no holdings were guessed.',
            parserVersion,
          };
          logger.warn(`[annual] parser revisit ${filing.source} ${filing.filingKey} pdf: ${err.message}`);
        }
      }
      result = { ...result, parserVersion };
      await replaceAnnualParse(store, filing, result, catalog);
      revisited += 1;
      if (result.status === 'parsed') parsed += 1;
      else if (result.status === 'pending_ocr') pendingOcr += 1;
      logger.log(`[annual] parser revisit ${filing.source} ${filing.filingKey} status=${result.status} kept=${result.holdings?.length || 0}`);
      continue;
    }

    if (typeof store.touchAnnualFiling === 'function') {
      await store.touchAnnualFiling(filing.id, { parserVersion });
      stamped += 1;
    }
  }

  const remaining = typeof store.countStaleParserAnnualFilings === 'function'
    ? await store.countStaleParserAnnualFilings({ parserVersion })
    : 0;

  const summary = {
    version: parserVersion,
    remaining,
    stamped,
    downloaded,
    revisited,
    failed,
    parsed,
    pendingOcr,
    done: remaining === 0,
    lastRunAt: new Date().toISOString(),
  };

  if (typeof store.mergeAnnualState === 'function') {
    await store.mergeAnnualState((current) => ({
      ...(current || {}),
      parserRevisit: summary,
    }));
  }

  if (tradesBefore != null && (store.db.politicianTrades || []).length !== tradesBefore) {
    logger.error('[annual] parser revisit must not create trade rows');
  }

  logger.log(formatParserRevisitProgress(summary));
  return summary;
}
