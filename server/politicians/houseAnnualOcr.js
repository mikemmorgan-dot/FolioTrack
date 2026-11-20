// GitHub Actions job: re-parse unreadable House annuals that have a text
// layer, then OCR image-only filings. Holdings are not emailed.

import { ANNUAL_HOLDINGS_SCHEMA } from '../db.js';
import { PgStore } from '../store-pg.js';
import { revisitUnreadableHouseAnnuals } from './annualIngest.js';
import { HOUSE_OCR_PAGES_PER_RUN, runPendingAnnualOcr } from './annualOcr.js';
import { ocrToolsAvailable } from './ocr.js';
import { assertDatabaseUrl, redactSecrets } from './presidentialOcr.js';

export async function downloadPublicPdf(fetchImpl, sourceUrl, maxPdfBytes = 32 * 1024 * 1024) {
  const res = await fetchImpl(sourceUrl, { method: 'GET' });
  if (res.status !== 200) {
    return {
      parsed: {
        status: 'pending_ocr',
        holdings: [],
        excludedCount: 0,
        note: `The Clerk returned HTTP ${res.status} for this annual report.`,
        ocrDone: false,
      },
    };
  }
  const bytes = Buffer.from(await res.arrayBuffer());
  if (bytes.length > maxPdfBytes) {
    return {
      parsed: {
        status: 'needs_manual_review',
        holdings: [],
        excludedCount: 0,
        note: `The annual PDF is over the ${Math.round(maxPdfBytes / 1e6)} MB cap, so it was not read.`,
        ocrDone: true,
      },
    };
  }
  return { bytes };
}

export async function runHouseAnnualOcr({
  store,
  fetchImpl = globalThis.fetch,
  now = new Date(),
  logger = console,
  env = process.env,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  limit = Number(env.HOUSE_OCR_LIMIT) || 8,
  revisitCap = Number(env.HOUSE_REVISIT_CAP) || 15,
  delayMs = Number(env.POLITICIAN_FETCH_DELAY_MS) || 1200,
} = {}) {
  const revisited = await revisitUnreadableHouseAnnuals({
    fetchImpl,
    store,
    cap: revisitCap,
    delayMs,
    sleep,
    logger,
    now,
  });
  const ocr = await runPendingAnnualOcr({
    store,
    fetchImpl,
    download: downloadPublicPdf,
    now,
    logger,
    limit,
    sources: ['house'],
  });
  return { revisited, ocr, pagesPerRun: HOUSE_OCR_PAGES_PER_RUN };
}

export function formatHouseOcrSummary(result) {
  const lines = ['House annual OCR', ''];
  const revisited = result?.revisited || {};
  lines.push(`Revisited text-layer filings: ${revisited.revisited || 0} (downloaded ${revisited.downloaded || 0}, failed ${revisited.failed || 0}).`);
  const filings = result?.ocr?.filings || [];
  if (!filings.length) {
    lines.push('No pending House annual filings to OCR.');
    return lines.join('\n');
  }
  lines.push('Filing | Result | Holdings | Pages');
  for (const row of filings) {
    lines.push(`${row.filingKey} | ${row.action} | ${row.holdings ?? ''} | ${row.pages ?? ''}`);
  }
  return lines.join('\n');
}

export async function runHouseAnnualOcrMain(env = process.env, deps = {}) {
  try {
    assertDatabaseUrl(env);
  } catch (err) {
    console.error(err.message);
    return 1;
  }
  const tools = await (deps.ocrToolsAvailable || ocrToolsAvailable)();
  if (!tools) {
    console.error('tesseract, pdftoppm, and pdfinfo were not found on PATH.');
    console.error('Install them with: sudo apt-get install -y tesseract-ocr poppler-utils');
    return 1;
  }
  const store = deps.store || new PgStore();
  try {
    if (!deps.store) await store.pool.query(ANNUAL_HOLDINGS_SCHEMA);
    const result = await (deps.run || runHouseAnnualOcr)({
      store,
      fetchImpl: deps.fetchImpl || globalThis.fetch,
      env,
      ...(deps.logger ? { logger: deps.logger } : {}),
      ...(deps.now ? { now: deps.now } : {}),
      ...(deps.sleep ? { sleep: deps.sleep } : {}),
    });
    const summary = formatHouseOcrSummary(result);
    console.log(summary);
    return 0;
  } catch (err) {
    console.error(redactSecrets(err?.message || String(err), env));
    return 1;
  } finally {
    if (!deps.store) {
      try { await store.pool.end(); } catch { /* already closed */ }
    }
  }
}
