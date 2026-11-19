// GitHub Actions entry point. DATABASE_URL is a repository secret.
// This process prints filing keys and timings. It does not print the URL.

import { appendFile } from 'node:fs/promises';
import { runHouseAnnualOcrMain } from './houseAnnualOcr.js';

export async function main(env = process.env, deps = {}) {
  return runHouseAnnualOcrMain(env, deps);
}

const invoked = process.argv[1] && process.argv[1].endsWith('houseAnnualOcrCli.js');
if (invoked) {
  main().then(async (code) => {
    if (process.env.GITHUB_STEP_SUMMARY && code === 0) {
      try { await appendFile(process.env.GITHUB_STEP_SUMMARY, 'House annual OCR finished.\n'); } catch { /* ignore */ }
    }
    process.exit(code);
  });
}
