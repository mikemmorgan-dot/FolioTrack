// Read-only look at whether Nancy Pelosi's House annual is stored, queued,
// or filed under a different person_key. Prints a summary. Does not write.

import pg from 'pg';
import { poolOptions } from '../db.js';
import { annualQueueSpot } from './annualQueueSpot.js';
import { redactSecrets } from './presidentialOcr.js';

const PERSON_KEY = 'house:pelosi:nancy';

export async function main(env = process.env, deps = {}) {
  const log = deps.log || ((line) => console.log(line));
  const url = String(env.DATABASE_URL || '').trim();
  if (!url) {
    log('[pelosi] DATABASE_URL is not set. Skipped the database read.');
    return 0;
  }
  const Pool = deps.Pool || pg.Pool;
  const pool = new Pool(poolOptions(env));
  const client = await pool.connect();
  try {
    await client.query('BEGIN READ ONLY');
    const filings = await client.query(
      `SELECT person_key, person_name, filing_key, parse_status, report_year,
              filed_date::text AS filed_date, filing_kind
       FROM politician_annual_filings
       WHERE person_key ILIKE '%pelosi%' OR person_name ILIKE '%pelosi%'
       ORDER BY person_key, filed_date DESC NULLS LAST`,
    );
    const stored = await client.query(
      `SELECT filing_key FROM politician_annual_filings WHERE source = 'house'`,
    );
    const state = await client.query(
      `SELECT value->'house'->'queue' AS queue
       FROM app_settings WHERE key = 'politicianAnnual'`,
    );
    await client.query('COMMIT');
    const queue = Array.isArray(state.rows[0]?.queue) ? state.rows[0].queue : [];
    const spot = annualQueueSpot({
      queue,
      storedKeys: stored.rows.map((row) => row.filing_key),
      personKey: PERSON_KEY,
    });
    log(`[pelosi] filings=${filings.rows.length} spot=${JSON.stringify(spot)}`);
    for (const row of filings.rows) {
      log(`[pelosi] row ${JSON.stringify(row)}`);
    }
    if (!filings.rows.length) log('[pelosi] no annual filing row matches pelosi');
    return 0;
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { /* already closed */ }
    log(`[pelosi] read failed: ${redactSecrets(err?.message || String(err), env)}`);
    return 0;
  } finally {
    client.release();
    await pool.end();
  }
}

const invoked = process.argv[1] && process.argv[1].endsWith('pelosiAnnualCheck.js');
if (invoked) {
  main().then((code) => process.exit(code));
}
