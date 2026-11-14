// GitHub Actions entry point. DATABASE_URL is a repository secret.
// This process prints filing keys and timings. It does not print the URL.

import { appendFile } from 'node:fs/promises';
import { POLITICIAN_OCR_SCHEMA } from '../db.js';
import { PgStore } from '../store-pg.js';
import { ocrToolsAvailable } from './ocr.js';
import {
  assertDatabaseUrl,
  exitCodeForOcrRun,
  formatOcrSummary,
  redactSecrets,
  runPresidentialOcr,
} from './presidentialOcr.js';

export async function main(env = process.env, deps = {}) {
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
    if (!deps.store) await store.pool.query(POLITICIAN_OCR_SCHEMA);
    const result = await runPresidentialOcr({
      store,
      fetchImpl: deps.fetchImpl || globalThis.fetch,
      env,
      filingKey: env.OCR_FILING_KEY || '',
      ...(deps.logger ? { logger: deps.logger } : {}),
      ...(deps.now ? { now: deps.now } : {}),
      ...(deps.sleep ? { sleep: deps.sleep } : {}),
      ...(deps.readPdf ? { readPdf: deps.readPdf } : {}),
      ...(deps.download ? { download: deps.download } : {}),
      ...(deps.loadCandidates ? { loadCandidates: deps.loadCandidates } : {}),
    });
    const summary = formatOcrSummary(result);
    console.log(summary);
    if (env.GITHUB_STEP_SUMMARY) await appendFile(env.GITHUB_STEP_SUMMARY, `${summary}\n`);
    return exitCodeForOcrRun(result);
  } catch (err) {
    console.error(redactSecrets(err?.message || String(err), env));
    return 1;
  } finally {
    if (!deps.store) {
      try { await store.pool.end(); } catch { /* pool already closed */ }
    }
  }
}

const invoked = process.argv[1] && process.argv[1].endsWith('presidentialOcrCli.js');
if (invoked) {
  main().then((code) => process.exit(code));
}
