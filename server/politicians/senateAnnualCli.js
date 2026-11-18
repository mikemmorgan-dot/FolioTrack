// GitHub Actions entry point for Senate annual holdings.
// DATABASE_URL is a repository secret. This process does not print it,
// and it does not send email.

import { appendFile } from 'node:fs/promises';
import { ANNUAL_HOLDINGS_SCHEMA } from '../db.js';
import { PgStore } from '../store-pg.js';
import { runSenateAnnualSlice, senateAnnualCap } from './annualIngest.js';
import { loadPoliticianRoster } from './ingest.js';
import { loadTickerCatalog } from './nameMatch.js';
import { assertDatabaseUrl, redactSecrets } from './presidentialOcr.js';

export function formatSenateAnnualSummary(result) {
  const senate = result?.senate || {};
  const bits = [
    `queued=${senate.queued ?? 0}`,
    `downloaded=${senate.downloaded ?? 0}`,
    `failed=${senate.failed ?? 0}`,
    `indexDone=${senate.indexDone === true}`,
  ];
  if (senate.skipped) bits.push(`skipped=${senate.skipped}`);
  if (senate.kind) bits.push(`kind=${senate.kind}`);
  if (senate.status) bits.push(`status=${senate.status}`);
  if (senate.stop) bits.push(`stop=${senate.stop}`);
  if (senate.error) bits.push(`error=${senate.error}`);
  return `[senate-annual] ${bits.join(' ')}`;
}

export function exitCodeForSenateAnnual(result) {
  const senate = result?.senate;
  if (!senate?.error) return 0;
  if (senate.kind === 'blocked' || senate.kind === 'transient' || senate.kind === 'other') return 0;
  return 1;
}

export async function main(env = process.env, deps = {}) {
  const logger = deps.logger || console;
  try {
    assertDatabaseUrl(env);
  } catch (err) {
    logger.error(err.message);
    return 1;
  }
  const store = deps.store || new PgStore();
  try {
    if (!deps.store) await store.pool.query(ANNUAL_HOLDINGS_SCHEMA);
    const fetchImpl = deps.fetchImpl || globalThis.fetch;
    const roster = deps.roster || await loadPoliticianRoster(store, fetchImpl, Date.now(), logger);
    let catalog = null;
    if ('catalog' in deps) catalog = deps.catalog;
    else {
      try {
        catalog = await loadTickerCatalog({ store, fetchImpl, logger });
      } catch (err) {
        logger.warn(`[senate-annual] name catalog failed: ${err.message}`);
      }
    }
    const delay = Number(env.POLITICIAN_FETCH_DELAY_MS);
    const result = await runSenateAnnualSlice({
      store,
      fetchImpl,
      roster,
      catalog,
      logger,
      delayMs: Number.isFinite(delay) && delay >= 0 ? delay : 1200,
      deadline: Date.now() + 15 * 60 * 1000,
      cap: senateAnnualCap(env),
      ...(deps.sleep ? { sleep: deps.sleep } : {}),
    });
    const summary = formatSenateAnnualSummary(result);
    logger.log(summary);
    if (env.GITHUB_STEP_SUMMARY) {
      await appendFile(env.GITHUB_STEP_SUMMARY, `${redactSecrets(summary, env)}\n`);
    }
    return exitCodeForSenateAnnual(result);
  } catch (err) {
    logger.error(redactSecrets(err?.message || String(err), env));
    return 1;
  } finally {
    if (!deps.store) {
      try { await store.pool.end(); } catch { /* pool already closed */ }
    }
  }
}

const invoked = process.argv[1] && process.argv[1].endsWith('senateAnnualCli.js');
if (invoked) {
  main().then((code) => process.exit(code));
}
