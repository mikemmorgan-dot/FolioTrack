// providerCooldown.js — skip a provider for a few minutes after 429 / 403 /
// credit-exhaustion so a retry does not burn the rest of the free-tier chain.
// In-memory: Render free-tier processes are short-lived; the durable history
// cache is what survives a spin-down.

export const COOLDOWN_MS = 20 * 60 * 1000;

const until = new Map();
let nowFn = () => Date.now();

export function setCooldownNow(fn) {
  nowFn = typeof fn === 'function' ? fn : () => Date.now();
}

export function resetCooldowns() {
  until.clear();
}

export function cooldownUntil(id) {
  return until.get(id) || 0;
}

export function isCoolingDown(id) {
  return nowFn() < (until.get(id) || 0);
}

export function markCooldown(id, ms = COOLDOWN_MS) {
  until.set(id, nowFn() + ms);
}

export function isCooldownError(err) {
  if (!err) return false;
  const status = err.status ?? err.statusCode ?? null;
  if (status === 429 || status === 403) return true;
  const msg = String(err.message || '');
  if (/\bHTTP\s*(429|403)\b/i.test(msg)) return true;
  if (/\b(429|403)\b/.test(msg) && /refus|block|rate|limit|forbidden|too many/i.test(msg)) return true;
  if (/rate limit|too many requests|api credits|out of .{0,60}credits|quota exceeded|daily (cap|limit)|requests? per (minute|day)/i.test(msg)) return true;
  // Alpha Vantage returns HTTP 200 with Note/Information when the free key is spent.
  if (/alpha vantage:\s*(note|information|.*limit|.*premium)/i.test(msg)) return true;
  return false;
}

export function markIfCooldownError(id, err) {
  if (isCooldownError(err)) markCooldown(id);
  return isCooldownError(err);
}
