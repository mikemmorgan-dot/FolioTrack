// providerStats.js — last success / last error for /api/diagnostics.
// In-memory, same lifetime as the provider cooldown map.

const stats = new Map();

function blank() {
  return {
    lastSuccessAt: null,
    lastSuccessSymbol: null,
    lastError: null,
    lastAttemptAt: null,
  };
}

export function noteProviderResult(id, { ok = false, symbol = null, error = null, now = () => Date.now() } = {}) {
  const prev = stats.get(id) || blank();
  const at = new Date(now()).toISOString();
  const next = { ...prev, lastAttemptAt: at };
  if (ok) {
    next.lastSuccessAt = at;
    next.lastSuccessSymbol = symbol || null;
    next.lastError = null;
  } else if (error) {
    next.lastError = String(error).slice(0, 300);
  }
  stats.set(id, next);
  return next;
}

export function providerStat(id) {
  return stats.get(id) || blank();
}

export function resetProviderStats() {
  stats.clear();
}
