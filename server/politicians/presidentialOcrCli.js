// GitHub Actions entry point. DATABASE_URL is a repository secret.
// This process prints filing keys and timings. It does not print the URL.

import { appendFile } from 'node:fs/promises';
import { POLITICIAN_OCR_SCHEMA } from '../db.js';
import { PgStore } from '../store-pg.js';
import { ocrToolsAvailable } from './ocr.js';
import {
  assertDatabaseUrl,
  formatOcrSummary,
  redactSecrets,
  runPresidentialOcr,
} from './presidentialOcr.js';

export async function main(env = process.env) {
  try {
    assertDatabaseUrl(env);
  } catch (err) {
    console.error(err.message);
    return 1;
  }
  const tools = await ocrToolsAvailable();
  if (!tools) {
    console.error('tesseract, pdftoppm, and pdfinfo were not found on PATH.');
    console.error('Install them with: sudo apt-get install -y tesseract-ocr poppler-utils');
    return 1;
  }
  const store = new PgStore();
  try {
    await store.pool.query(POLITICIAN_OCR_SCHEMA);
    const result = await runPresidentialOcr({
      store,
      env,
      filingKey: env.OCR_FILING_KEY || '',
    });
    const summary = formatOcrSummary(result);
    console.log(summary);
    if (env.GITHUB_STEP_SUMMARY) await appendFile(env.GITHUB_STEP_SUMMARY, `${summary}\n`);
    if ((result.filings || []).some((row) => row.action === 'missing')) return 1;
    return 0;
  } catch (err) {
    console.error(redactSecrets(err?.message || String(err), env));
    return 1;
  } finally {
    try { await store.pool.end(); } catch { /* pool already closed */ }
  }
}

const invoked = process.argv[1] && process.argv[1].endsWith('presidentialOcrCli.js');
if (invoked) {
  main().then((code) => process.exit(code));
}
