// Per-source wait after a 429 or a 5xx. The first miss is short. Later misses
// double, and the wait never exceeds six hours. A stored timestamp in the
// future means that source is skipped until then.

export const BACKOFF_BASE_MS = 5 * 60 * 1000;
export const BACKOFF_RATE_MS = 15 * 60 * 1000;
export const BACKOFF_MAX_MS = 6 * 60 * 60 * 1000;

export function backoffDelayMs({ strikes = 0, status = 500 } = {}) {
  const n = Math.min(6, Math.max(0, Number(strikes) || 0));
  const base = status === 429 ? BACKOFF_RATE_MS : BACKOFF_BASE_MS;
  return Math.min(base * (2 ** n), BACKOFF_MAX_MS);
}

export function nextSourceBackoff(prev, nowMs, status) {
  const strikes = Math.max(0, Number(prev?.strikes) || 0) + 1;
  const delay = backoffDelayMs({ strikes: strikes - 1, status });
  return {
    until: new Date(nowMs + delay).toISOString(),
    strikes,
    status: status || null,
  };
}

export function backoffActive(entry, nowMs) {
  if (!entry?.until) return false;
  const t = Date.parse(entry.until);
  return Number.isFinite(t) && t > nowMs;
}
