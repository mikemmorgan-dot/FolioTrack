// Trades first stored before the 8:57:36pm ET digest on Nov 13, 2026 were
// already mailed, or are backfill history that must not be mailed later.
// 7:54pm ET that evening was the first copy; this cutoff is the second.
export const DIGEST_ALREADY_SENT_BEFORE = '2026-11-14T01:57:36.000Z';

// Boot runs this once the emailed_at column exists. A second run matches no
// rows: emailed_at is already set, and rows first seen at or after the cutoff
// are left alone so a later digest can still send them.
export const HISTORICAL_DIGEST_SQL = `
ALTER TABLE politician_trades ADD COLUMN IF NOT EXISTS emailed_at timestamptz;
CREATE INDEX IF NOT EXISTS politician_trades_unemailed
  ON politician_trades (disclosed_date DESC, id DESC)
  WHERE digest_pending AND emailed_at IS NULL;
UPDATE politician_trades
SET emailed_at = created_at,
    digest_pending = false
WHERE emailed_at IS NULL
  AND created_at < TIMESTAMPTZ '2026-11-14 01:57:36+00';
`;

// Same rule as HISTORICAL_DIGEST_SQL, for tests and the JSON store.
// `createdAt` is when the row was first stored. Returns how many rows changed.
export function markHistoricalTradesEmailed(trades, cutoff = DIGEST_ALREADY_SENT_BEFORE) {
  const cut = Date.parse(cutoff);
  let marked = 0;
  for (const trade of trades || []) {
    if (!trade || trade.emailedAt) continue;
    const seen = Date.parse(trade.createdAt || '');
    if (!Number.isFinite(seen) || seen >= cut) continue;
    trade.emailedAt = trade.createdAt;
    trade.digestPending = false;
    marked += 1;
  }
  return marked;
}
