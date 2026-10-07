// seriesSql.js — queries that keep Neon from shipping whole histories.
//
// price_history.series is one JSON blob per symbol (a Yahoo/TMX "max"
// history). Selecting it sends every daily close to the app. Alert checks
// only need the latest close and the 52-week high, and a 1y chart only
// needs that window. These statements return those aggregates or a bounded
// date range. They do not select the blob.
//
// price_points is the row form of that blob. Writes upsert one row per
// date and skip the update when the close did not change, so a refresh
// does not rewrite the dates that stayed the same.

export const PRICE_POINTS_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS price_points (
  symbol text NOT NULL,
  date date NOT NULL,
  close numeric NOT NULL,
  PRIMARY KEY (symbol, date)
);
`;

// Copy the JSON blob into rows once. First array element wins on a
// duplicate date (same rule as normalizeSeries). No RETURNING: the blob
// stays inside Neon.
export const PRICE_POINTS_BACKFILL_SQL = `
INSERT INTO price_points (symbol, date, close)
SELECT symbol, date, close
FROM (
  SELECT DISTINCT ON (sym, dt)
    sym AS symbol,
    dt::date AS date,
    close
  FROM (
    SELECT
      upper(p.symbol) AS sym,
      (e.value->>'date') AS dt,
      CASE
        WHEN COALESCE(e.value->>'close', e.value->>'price', e.value->>'nav')
             ~ '^[0-9]+([.][0-9]+)?$'
        THEN COALESCE(e.value->>'close', e.value->>'price', e.value->>'nav')::numeric
        ELSE NULL
      END AS close,
      e.ord
    FROM price_history p
    CROSS JOIN LATERAL jsonb_array_elements(p.series) WITH ORDINALITY AS e(value, ord)
    WHERE jsonb_typeof(p.series) = 'array'
      AND p.series <> '[]'::jsonb
  ) raw
  WHERE dt ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
    AND close > 0
  ORDER BY sym, dt, ord
) dedup
ON CONFLICT (symbol, date) DO NOTHING
`;

// After the copy, drop the blob so a later SELECT cannot ship it again.
export const PRICE_SERIES_CLEAR_SQL = `
UPDATE price_history p
SET series = '[]'::jsonb
WHERE p.series IS DISTINCT FROM '[]'::jsonb
  AND EXISTS (
    SELECT 1 FROM price_points pts WHERE pts.symbol = upper(p.symbol)
  )
`;

// One symbol, used only when the boot copy stored zero rows but the blob
// is still there. The app then writes price_points and the blob is cleared.
export const PRICE_LEGACY_SERIES_SQL = `
SELECT series
FROM price_history
WHERE symbol = $1
  AND series IS NOT NULL
  AND series <> '[]'::jsonb
`;

export const INSTRUMENT_COLUMNS = `
  id, symbol, name, type, source, currency, sector, country, mer, created_at,
  sector_breakdown, country_breakdown, breakdown_updated_at, breakdown_as_of,
  breakdown_note, published_returns, nav_source, meta
`;

export const INSTRUMENT_CORE_SQL = `
SELECT id, symbol, name, type, source, currency, nav_source
FROM instruments
WHERE id = $1
`;

// $1 symbol, $2 = 52-week window in days (latest close minus this many days).
export const PRICE_SNAPSHOT_SQL = `
WITH pts AS (
  SELECT date, close
  FROM price_points
  WHERE symbol = $1
    AND close > 0
),
latest AS (
  SELECT date, close
  FROM pts
  ORDER BY date DESC
  LIMIT 1
)
SELECT
  (SELECT count(*)::int FROM pts) AS n,
  (SELECT min(date) FROM pts) AS first_date,
  l.date AS latest_date,
  l.close AS latest_close,
  pk.date AS peak_date,
  pk.close AS peak_close,
  h.provider,
  h.range,
  h.fetched_at
FROM latest l
LEFT JOIN price_history h ON h.symbol = $1
LEFT JOIN LATERAL (
  SELECT p.date, p.close
  FROM pts p
  WHERE p.date >= (l.date - $2::int)
  ORDER BY p.close DESC, p.date DESC
  LIMIT 1
) pk ON true
`;

export const NAV_SNAPSHOT_SQL = `
WITH pts AS (
  SELECT date, nav
  FROM nav_series
  WHERE instrument_id = $1
    AND nav > 0
),
latest AS (
  SELECT date, nav
  FROM pts
  ORDER BY date DESC
  LIMIT 1
),
peak AS (
  SELECT date, nav
  FROM pts
  ORDER BY nav DESC, date DESC
  LIMIT 1
)
SELECT
  (SELECT count(*)::int FROM pts) AS n,
  (SELECT min(date) FROM pts) AS first_date,
  l.date AS latest_date,
  l.nav AS latest_nav,
  pk.date AS peak_date,
  pk.nav AS peak_nav
FROM latest l
JOIN peak pk ON true
`;

// $2/$3 are inclusive bounds. NULL means "no bound" (full history for a
// chart that asked for max, or a return engine that needs the whole series).
export const PRICE_WINDOW_SQL = `
SELECT date, close
FROM price_points
WHERE symbol = $1
  AND ($2::date IS NULL OR date >= $2::date)
  AND ($3::date IS NULL OR date <= $3::date)
ORDER BY date
`;

export const NAV_WINDOW_SQL = `
SELECT date, nav
FROM nav_series
WHERE instrument_id = $1
  AND ($2::date IS NULL OR date >= $2::date)
  AND ($3::date IS NULL OR date <= $3::date)
ORDER BY date
`;

export const PRICE_META_SQL = `
SELECT
  h.symbol,
  h.provider,
  h.range,
  h.fetched_at,
  (SELECT max(date) FROM price_points p WHERE p.symbol = h.symbol) AS last_date,
  (SELECT count(*)::int FROM price_points p WHERE p.symbol = h.symbol) AS n,
  (h.series IS NOT NULL AND h.series <> '[]'::jsonb) AS has_legacy
FROM price_history h
WHERE h.symbol = $1
`;

// Metadata only. series stays an empty array so the column cannot grow back.
export const PRICE_META_UPSERT_SQL = `
INSERT INTO price_history (symbol, series, provider, range, fetched_at)
VALUES ($1, '[]'::jsonb, $2, $3, $4)
ON CONFLICT (symbol) DO UPDATE SET
  provider = EXCLUDED.provider,
  range = EXCLUDED.range,
  fetched_at = EXCLUDED.fetched_at,
  series = '[]'::jsonb
`;

// Unchanged closes are not rewritten (WHERE … IS DISTINCT FROM).
export const PRICE_POINTS_UPSERT_SQL = `
INSERT INTO price_points (symbol, date, close)
SELECT $1, u.date::date, u.close
FROM unnest($2::text[], $3::numeric[]) AS u(date, close)
ON CONFLICT (symbol, date) DO UPDATE SET close = EXCLUDED.close
WHERE price_points.close IS DISTINCT FROM EXCLUDED.close
`;

export const NAV_UPSERT_SQL = `
INSERT INTO nav_series (instrument_id, date, nav)
VALUES ($1, $2, $3)
ON CONFLICT (instrument_id, date) DO UPDATE SET nav = EXCLUDED.nav
WHERE nav_series.nav IS DISTINCT FROM EXCLUDED.nav
`;

export const NAV_UPSERT_BATCH_SQL = `
INSERT INTO nav_series (instrument_id, date, nav)
SELECT $1, u.date::date, u.nav
FROM unnest($2::text[], $3::numeric[]) AS u(date, nav)
`;
