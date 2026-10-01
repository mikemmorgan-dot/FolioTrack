// db.js — Postgres pool, schema bootstrap, and one-time seed.
import pg from 'pg';
import { seedData } from './seed.js';

const { Pool } = pg;

export function makePool() {
  return new Pool({
    connectionString: process.env.DATABASE_URL,
    // Neon (and most hosted PG) require SSL. Local PG can opt out with PGSSL=disable.
    ssl: process.env.PGSSL === 'disable' ? false : { rejectUnauthorized: false },
    max: 5,
  });
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS instruments (
  id text PRIMARY KEY,
  symbol text NOT NULL,
  name text NOT NULL,
  type text NOT NULL,
  source text NOT NULL,
  currency text NOT NULL DEFAULT 'CAD',
  sector text,
  country text,
  mer numeric,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS instruments_symbol_lower ON instruments (lower(symbol));

-- Fund look-through: optional [{label, weight}] breakdowns entered from a
-- fund's factsheet, used instead of the single sector/country above when
-- present. ADD COLUMN IF NOT EXISTS because the live table already exists —
-- CREATE TABLE IF NOT EXISTS above is a no-op against it.
ALTER TABLE instruments ADD COLUMN IF NOT EXISTS sector_breakdown jsonb;
ALTER TABLE instruments ADD COLUMN IF NOT EXISTS country_breakdown jsonb;
ALTER TABLE instruments ADD COLUMN IF NOT EXISTS breakdown_updated_at timestamptz;
-- Factsheet as-of (the date on the sheet) vs last-saved timestamp above.
ALTER TABLE instruments ADD COLUMN IF NOT EXISTS breakdown_as_of date;
ALTER TABLE instruments ADD COLUMN IF NOT EXISTS breakdown_note text;
-- Manufacturer published returns (Fund Facts / FundPulse / issuer factsheet). Not NAV-derived.
ALTER TABLE instruments ADD COLUMN IF NOT EXISTS published_returns jsonb;
-- Where the current nav_series came from: 'Yahoo Finance' | 'manual' | null.
ALTER TABLE instruments ADD COLUMN IF NOT EXISTS nav_source text;

CREATE TABLE IF NOT EXISTS models (
  key text PRIMARY KEY,
  name text NOT NULL,
  risk_rank int NOT NULL,
  benchmark jsonb NOT NULL DEFAULT '[]'::jsonb
);

CREATE TABLE IF NOT EXISTS versions (
  id text PRIMARY KEY,
  model_key text NOT NULL REFERENCES models(key) ON DELETE CASCADE,
  effective_date date NOT NULL,
  note text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS versions_model ON versions (model_key);

CREATE TABLE IF NOT EXISTS version_holdings (
  version_id text NOT NULL REFERENCES versions(id) ON DELETE CASCADE,
  instrument_id text NOT NULL REFERENCES instruments(id),
  weight numeric NOT NULL,
  PRIMARY KEY (version_id, instrument_id)
);

CREATE TABLE IF NOT EXISTS nav_series (
  instrument_id text NOT NULL REFERENCES instruments(id) ON DELETE CASCADE,
  date date NOT NULL,
  nav numeric NOT NULL,
  PRIMARY KEY (instrument_id, date)
);

-- Cached auto-instrument EOD series. Separate from nav_series (user-entered
-- NAVs for manual names). One row per symbol — the longest series we have.
CREATE TABLE IF NOT EXISTS price_history (
  symbol text PRIMARY KEY,
  series jsonb NOT NULL,
  provider text,
  range text NOT NULL DEFAULT 'max',
  fetched_at timestamptz NOT NULL DEFAULT now()
);

-- Key-value app settings (alert threshold, recipient, on/off). One row per key.
CREATE TABLE IF NOT EXISTS app_settings (
  key text PRIMARY KEY,
  value jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- One row per instrument: the current breach episode (active or recovered).
CREATE TABLE IF NOT EXISTS alert_events (
  instrument_id text PRIMARY KEY REFERENCES instruments(id) ON DELETE CASCADE,
  symbol text NOT NULL,
  name text,
  status text NOT NULL,
  first_breached_at timestamptz,
  last_notified_at timestamptz,
  recovered_at timestamptz,
  reference_price numeric,
  reference_date date,
  price_at_breach numeric,
  drawdown_at_breach numeric,
  current_price numeric,
  current_drawdown numeric,
  threshold numeric,
  notify_status text,
  notify_detail text,
  basis text,
  basis_label text,
  price_as_of date,
  history_fetched_at timestamptz,
  stale boolean NOT NULL DEFAULT false,
  models jsonb NOT NULL DEFAULT '[]'::jsonb,
  currency text,
  last_eval_note text,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS alert_events_status ON alert_events (status);

-- Append-only log of breach / notify / recovery episodes for the Alerts panel.
CREATE TABLE IF NOT EXISTS alert_history (
  id text PRIMARY KEY,
  instrument_id text NOT NULL,
  symbol text NOT NULL,
  name text,
  kind text NOT NULL,
  at timestamptz NOT NULL,
  drawdown numeric,
  price numeric,
  reference_price numeric,
  reference_date date,
  detail text,
  models jsonb
);
CREATE INDEX IF NOT EXISTS alert_history_at ON alert_history (at DESC);
`;

export async function initSchema(pool) {
  await pool.query(SCHEMA);
}

// Seed only when empty, so restarts/redeploys never clobber real data.
export async function seedIfEmpty(pool) {
  const { rows } = await pool.query('SELECT count(*)::int AS n FROM models');
  if (rows[0].n > 0) return false;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const i of Object.values(seedData.instruments)) {
      await client.query(
        `INSERT INTO instruments (id,symbol,name,type,source,currency,sector,country,mer)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (id) DO NOTHING`,
        [i.id, i.symbol, i.name, i.type, i.source, i.currency, i.sector, i.country, i.mer]
      );
    }
    for (const [instrumentId, series] of Object.entries(seedData.navSeries)) {
      for (const p of series) {
        await client.query(
          `INSERT INTO nav_series (instrument_id,date,nav) VALUES ($1,$2,$3)
           ON CONFLICT (instrument_id,date) DO UPDATE SET nav = EXCLUDED.nav`,
          [instrumentId, p.date, p.nav]
        );
      }
    }
    for (const m of Object.values(seedData.models)) {
      await client.query(
        `INSERT INTO models (key,name,risk_rank,benchmark) VALUES ($1,$2,$3,$4)`,
        [m.key, m.name, m.riskRank, JSON.stringify(m.benchmark || [])]
      );
      for (const v of m.versions) {
        await client.query(
          `INSERT INTO versions (id,model_key,effective_date,note) VALUES ($1,$2,$3,$4)`,
          [v.id, m.key, v.effectiveDate, v.note || '']
        );
        for (const h of v.holdings) {
          await client.query(
            `INSERT INTO version_holdings (version_id,instrument_id,weight) VALUES ($1,$2,$3)`,
            [v.id, h.instrumentId, h.weight]
          );
        }
      }
    }
    await client.query('COMMIT');
    return true;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}
