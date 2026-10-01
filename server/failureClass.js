// failureClass.js — separate "providers are cooling down" from "no such ticker".
// A rate-limit cooldown used to collapse into the same "not found" path, which
// saved the holding as manual and asked for a NAV.

import { isCooldownError } from './providerCooldown.js';

const TRANSIENT = new Set(['rate-limit', 'missing-key', 'unreachable']);

export function classifyAttempt({ error, notFound = false, skipped = false, status = null } = {}) {
  if (skipped) return 'rate-limit';
  const msg = String(error || '');
  if (/cooling down/i.test(msg)) return 'rate-limit';
  if (status === 429 || status === 403 || /\bHTTP\s*(429|403)\b/i.test(msg)) return 'rate-limit';
  if (isCooldownError({ message: msg, status })) return 'rate-limit';
  if (/_API_KEY not configured|api key not configured|missing api key/i.test(msg)) return 'missing-key';
  if (notFound) return 'not-found';
  if (/no data|not\s*found|does not know|no close price|no quote data|no candle|no rows|unknown symbol/i.test(msg)) {
    return 'not-found';
  }
  if (/network|unreachable|timeout|econn|enotfound|fetch failed|block page|non-json|aborted|socket/i.test(msg)) {
    return 'unreachable';
  }
  return 'other';
}

export function classifyAttempts(attempts = []) {
  const kinds = (attempts || []).map((a) => a.kind || classifyAttempt(a));
  const anyNotFound = kinds.includes('not-found');
  const anyRateLimit = kinds.includes('rate-limit');
  const allTransient = kinds.length > 0 && kinds.every((k) => TRANSIENT.has(k));
  const allowAuto = allTransient && anyRateLimit && !anyNotFound;
  return {
    kinds,
    anyNotFound,
    anyRateLimit,
    allTransient,
    allowAuto,
    rateLimited: allowAuto,
    allNotFound: kinds.length > 0 && kinds.every((k) => k === 'not-found'),
  };
}

// Entered NAV always wins. Otherwise a confirmed quote, or a failure that was
// only rate-limits / missing keys / unreachable hosts, stays on the live chain.
export function decideAddSource({ found = false, allowAuto = false, manualNav = false } = {}) {
  if (manualNav) return 'manual';
  if (found || allowAuto) return 'auto';
  return 'manual';
}
