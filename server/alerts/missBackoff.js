// alerts/missBackoff.js — how long a holding waits after a price lookup misses.
//
// The old timer was a flat 6 hours. While every provider was rate-limited,
// TSX names with no cached history stayed dark for that whole window. The
// wait is now short the first time and doubles, and a confirmed "no such
// symbol" waits much longer than a rate limit.

export const MISS_BACKOFF_BASE_MS = 20 * 60 * 1000;
export const MISS_BACKOFF_MAX_MS = 3 * 60 * 60 * 1000;
export const MISS_BACKOFF_NO_HISTORY_MAX_MS = 30 * 60 * 1000;
export const MISS_NOT_FOUND_MS = 24 * 60 * 60 * 1000;

const STRIKE_CAP = 8;

export function backoffMsForMiss({ strikes = 0, hasHistory = true, reason = 'rate-limit' } = {}) {
  if (reason === 'not-found') return MISS_NOT_FOUND_MS;
  const n = Math.min(STRIKE_CAP, Math.max(0, Number(strikes) || 0));
  const exp = MISS_BACKOFF_BASE_MS * (2 ** n);
  let ms = Math.min(exp, MISS_BACKOFF_MAX_MS);
  if (!hasHistory) ms = Math.min(ms, MISS_BACKOFF_NO_HISTORY_MAX_MS);
  return ms;
}

export function reasonTextFor(reason) {
  switch (reason) {
    case 'not-found':
      return 'Symbol was not found at the price providers';
    case 'rate-limit':
      return 'Providers were rate-limited';
    case 'provider-cooldown':
      return 'Price providers are still cooling down';
    default:
      return 'The last price lookup missed';
  }
}

export function formatRetryClock(iso, timeZone = 'America/Toronto') {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(d);
  const hh = parts.find((p) => p.type === 'hour')?.value;
  const mm = parts.find((p) => p.type === 'minute')?.value;
  if (hh == null || mm == null) return null;
  return `${hh}:${mm}`;
}

export function skippedCooldownHops(attempts = []) {
  return (attempts || []).filter((a) => a && a.skipped).map((a) => ({
    provider: a.provider,
    cooldownUntil: a.cooldownUntil || null,
    error: a.error || 'cooling down after a recent rate-limit',
  }));
}

export function formatSkippedHopSentence(hops) {
  if (!hops?.length) return '';
  const bits = hops.map((h) => {
    const when = h.cooldownUntil ? formatRetryClock(h.cooldownUntil) : null;
    const name = h.provider || 'provider';
    return when ? `${name} until ${when}` : name;
  });
  return `Skipped while cooling down: ${bits.join(', ')}.`;
}

export function formatHoldingRefreshLine(row) {
  const symbol = row?.symbol || '—';
  const asOf = row?.priceAsOf || row?.lastClose || '—';
  const hops = formatSkippedHopSentence(row?.skippedHops);
  if (row?.status === 'updated') {
    const base = `${symbol}: updated (as of ${asOf})`;
    return hops ? `${base}. ${hops}` : base;
  }
  if (row?.status === 'unchanged') {
    const base = `${symbol}: already current (as of ${asOf})`;
    return hops ? `${base}. ${hops}` : base;
  }
  if (row?.status === 'skipped') {
    return `${symbol}: skipped — ${row.error || 'cap'}`;
  }
  if (row?.status === 'cooldown' || row?.retryAfter || row?.retryAfterLabel) {
    const why = row.reasonText || row.error || 'Waiting after a recent miss';
    const when = row.retryAfterLabel || (row.retryAfter ? formatRetryClock(row.retryAfter) : null);
    const retry = when ? ` — retry after ${when}` : '';
    const base = `${symbol}: ${why}${retry}`;
    return hops ? `${base}. ${hops}` : base;
  }
  const fail = `${symbol}: failed — ${row?.error || 'unknown'}`;
  return hops ? `${fail}. ${hops}` : fail;
}

/**
 * Accept the legacy `"SYMBOL": "iso"` map and the richer
 * `{ until, strikes, reason }` records. A leftover 6h timer is pulled back
 * to the first step so a deploy does not keep serving the old wait.
 * Expired records with strikes are kept so the next miss continues the ladder.
 */
export function normalizeMissRecord(value, nowMs = Date.now()) {
  if (value == null) return null;
  if (typeof value === 'string' || typeof value === 'number') {
    const until = typeof value === 'number' ? value : Date.parse(value);
    if (!Number.isFinite(until) || until <= nowMs) return null;
    if (until - nowMs > MISS_BACKOFF_MAX_MS) {
      return { until: nowMs + MISS_BACKOFF_BASE_MS, strikes: 0, reason: 'total-miss' };
    }
    return { until, strikes: 1, reason: 'total-miss' };
  }
  if (typeof value === 'object') {
    const until = Date.parse(value.until);
    if (!Number.isFinite(until)) return null;
    const strikes = Math.max(0, Number(value.strikes) || 0);
    const reason = value.reason || 'total-miss';
    if (until <= nowMs && strikes <= 0) return null;
    if (reason !== 'not-found' && until - nowMs > MISS_BACKOFF_MAX_MS) {
      return { until: nowMs + MISS_BACKOFF_BASE_MS, strikes: 0, reason };
    }
    return { until, strikes, reason };
  }
  return null;
}

export function nextMissState(prev, {
  nowMs,
  hasHistory = true,
  reason = 'total-miss',
  countStrike = true,
  earliestCooldownMs = null,
} = {}) {
  const strikes = Math.max(0, Number(prev?.strikes) || 0);
  const scheduleReason = reason === 'not-found' ? 'not-found' : (reason === 'provider-cooldown' ? 'rate-limit' : reason);
  let delay = backoffMsForMiss({
    strikes,
    hasHistory,
    reason: scheduleReason === 'total-miss' ? 'rate-limit' : scheduleReason,
  });
  if (!countStrike && Number.isFinite(earliestCooldownMs)) {
    const remain = Math.max(0, earliestCooldownMs - nowMs);
    if (remain > 0) delay = Math.min(delay, remain);
  }
  return {
    until: nowMs + delay,
    strikes: countStrike ? strikes + 1 : strikes,
    reason: reason === 'not-found' ? 'not-found' : (reason || 'total-miss'),
  };
}
