// db.js — Postgres pool, schema bootstrap, and one-time seed.
import pg from 'pg';
import { seedData } from './seed.js';
import {
  PRICE_POINTS_TABLE_SQL,
  PRICE_POINTS_BACKFILL_SQL,
  PRICE_SERIES_CLEAR_SQL,
} from './seriesSql.js';

const { Pool } = pg;

// Neon drops idle server connections. Release ours first so the pool does
// not keep handing out a dead socket and reconnecting on every query.
// max stays small: the free tier has a low connection cap, and this app is
// one process.
export function poolOptions(env = process.env) {
  return {
    connectionString: env.DATABASE_URL,
    ssl: env.PGSSL === 'disable' ? false : { rejectUnauthorized: false },
    max: 5,
    idleTimeoutMillis: 20_000,
    connectionTimeoutMillis: 10_000,
    keepAlive: true,
  };
}

export function makePool() {
  return new Pool(poolOptions());
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
-- Unverified add: suggested name/sector/region and which fields the user edited.
ALTER TABLE instruments ADD COLUMN IF NOT EXISTS meta jsonb;

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

-- One row per close. Replaces the price_history.series JSON blob, which
-- had to be sent in full on every read and rewritten in full on every refresh.
${PRICE_POINTS_TABLE_SQL}

-- Politician trade filings. A periodic report that cannot be parsed is a row
-- here with parse_status 'needs_manual_review' and no guessed trade rows.
CREATE TABLE IF NOT EXISTS politician_filings (
  id text PRIMARY KEY,
  source text NOT NULL,
  filing_key text NOT NULL,
  person_key text NOT NULL,
  person_name text NOT NULL,
  office text NOT NULL,
  party text,
  filer_status text,
  state text,
  district text,
  filed_date date,
  source_url text NOT NULL,
  parse_status text NOT NULL,
  parse_note text,
  ocr_done boolean NOT NULL DEFAULT false,
  ocr_page int,
  page_count int,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS politician_filings_source_key ON politician_filings (source, filing_key);
CREATE INDEX IF NOT EXISTS politician_filings_person ON politician_filings (person_key);

CREATE TABLE IF NOT EXISTS politician_trades (
  id text PRIMARY KEY,
  filing_id text NOT NULL REFERENCES politician_filings(id) ON DELETE CASCADE,
  row_index int NOT NULL,
  person_key text NOT NULL,
  person_name text NOT NULL,
  office text NOT NULL,
  party text,
  filer_status text,
  state text,
  owner text NOT NULL,
  ticker text,
  ticker_norm text,
  asset text NOT NULL,
  asset_class text NOT NULL,
  tx_type text NOT NULL,
  partial boolean NOT NULL DEFAULT false,
  tx_date date,
  disclosed_date date,
  lag_days int,
  amount_range text NOT NULL,
  source_url text NOT NULL,
  ocr boolean NOT NULL DEFAULT false,
  ocr_confidence int,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (filing_id, row_index)
);
CREATE INDEX IF NOT EXISTS politician_trades_disclosed ON politician_trades (disclosed_date DESC, id DESC);
CREATE INDEX IF NOT EXISTS politician_trades_person ON politician_trades (person_key, disclosed_date DESC);
CREATE INDEX IF NOT EXISTS politician_trades_ticker ON politician_trades (ticker_norm) WHERE ticker_norm IS NOT NULL;
-- Summary rankings and cluster buys filter this date range and side, then GROUP BY ticker.
CREATE INDEX IF NOT EXISTS politician_trades_window
  ON politician_trades (disclosed_date, tx_type)
  WHERE ticker_norm IS NOT NULL;
CREATE INDEX IF NOT EXISTS politician_filings_filed ON politician_filings (filed_date);
ALTER TABLE politician_filings ADD COLUMN IF NOT EXISTS ocr_done boolean NOT NULL DEFAULT false;
ALTER TABLE politician_filings ADD COLUMN IF NOT EXISTS ocr_page int;
ALTER TABLE politician_filings ADD COLUMN IF NOT EXISTS page_count int;
ALTER TABLE politician_trades ADD COLUMN IF NOT EXISTS ocr boolean NOT NULL DEFAULT false;
ALTER TABLE politician_trades ADD COLUMN IF NOT EXISTS ocr_confidence int;
ALTER TABLE politician_filings ADD COLUMN IF NOT EXISTS filer_status text;
ALTER TABLE politician_trades ADD COLUMN IF NOT EXISTS filer_status text;
ALTER TABLE politician_filings ADD COLUMN IF NOT EXISTS ocr_claimed_at timestamptz;
ALTER TABLE politician_trades ADD COLUMN IF NOT EXISTS digest_pending boolean NOT NULL DEFAULT false;
CREATE INDEX IF NOT EXISTS politician_trades_digest_pending
  ON politician_trades (disclosed_date DESC, id DESC)
  WHERE digest_pending;
`;

export const POLITICIAN_OCR_SCHEMA = `
ALTER TABLE politician_filings ADD COLUMN IF NOT EXISTS ocr_claimed_at timestamptz;
ALTER TABLE politician_trades ADD COLUMN IF NOT EXISTS digest_pending boolean NOT NULL DEFAULT false;
CREATE INDEX IF NOT EXISTS politician_trades_digest_pending
  ON politician_trades (disclosed_date DESC, id DESC)
  WHERE digest_pending;
`;

export async function initSchema(pool) {
  await pool.query(SCHEMA);
}

// Copy any leftover JSON histories into price_points, then empty the blob
// so later reads cannot ship it. Safe to run on every boot: the copy is
// ON CONFLICT DO NOTHING and the clear matches zero rows once series is [].
export async function migratePricePoints(pool) {
  await pool.query(PRICE_POINTS_BACKFILL_SQL);
  await pool.query(PRICE_SERIES_CLEAR_SQL);
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
