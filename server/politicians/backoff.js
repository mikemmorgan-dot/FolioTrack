// Per-source wait after a 429 or a 5xx. The first miss is short. Later misses
// double, and the wait never exceeds six hours. A stored timestamp in the
// future means that source is skipped until then.
// A 403 or an Akamai block page is not an outage: it does not add a strike,
// and the wait is BLOCK_BACKOFF_MS.

export const BACKOFF_BASE_MS = 5 * 60 * 1000;
export const BACKOFF_RATE_MS = 15 * 60 * 1000;
export const BACKOFF_MAX_MS = 6 * 60 * 60 * 1000;
// A block is not an outage. Wait half a day instead of climbing the strike ladder.
export const BLOCK_BACKOFF_MS = 12 * 60 * 60 * 1000;

export function backoffDelayMs({ strikes = 0, status = 500 } = {}) {
  const n = Math.min(6, Math.max(0, Number(strikes) || 0));
  const base = status === 429 ? BACKOFF_RATE_MS : BACKOFF_BASE_MS;
  return Math.min(base * (2 ** n), BACKOFF_MAX_MS);
}

export function nextSourceBackoff(prev, nowMs, status, extra = {}) {
  const snippet = extra.snippet || null;
  if (extra.kind === 'blocked') {
    return {
      until: new Date(nowMs + BLOCK_BACKOFF_MS).toISOString(),
      strikes: 0,
      status: status || null,
      kind: 'blocked',
      snippet,
    };
  }
  const strikes = Math.max(0, Number(prev?.strikes) || 0) + 1;
  const delay = backoffDelayMs({ strikes: strikes - 1, status });
  return {
    until: new Date(nowMs + delay).toISOString(),
    strikes,
    status: status || null,
    kind: 'transient',
    snippet,
  };
}

export function annualBackoffActive(entry, nowMs) {
  if (!entry) return false;
  const until = typeof entry === 'string' ? entry : entry.until;
  const t = Date.parse(until || '');
  return Number.isFinite(t) && t > nowMs;
}

export function annualFailureBackoff(nowMs, { kind, status, snippet } = {}) {
  const blocked = kind === 'blocked';
  const wait = blocked ? BLOCK_BACKOFF_MS : ((Number(status) === 429 ? 15 : 5) * 60 * 1000);
  return {
    until: new Date(nowMs + wait).toISOString(),
    kind: blocked ? 'blocked' : 'transient',
    status: Number(status) || null,
    snippet: snippet || null,
  };
}

export function backoffActive(entry, nowMs) {
  if (!entry?.until) return false;
  const t = Date.parse(entry.until);
  return Number.isFinite(t) && t > nowMs;
}
