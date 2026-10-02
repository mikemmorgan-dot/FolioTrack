// yahooQueue.js — one Yahoo chart request at a time, about every 1.5s.
// Jitter is added on top of the minimum gap so the pace is not a metronome.
// Retry-After is honored up to a cap so one 429 cannot stall a whole refresh.

import { AsyncLocalStorage } from 'node:async_hooks';

export const YAHOO_MIN_INTERVAL_MS = 1500;
export const YAHOO_JITTER_MS = 400;
export const YAHOO_RETRY_CAP_MS = 30_000;

const runStore = new AsyncLocalStorage();
const inflight = new Map();

export function paceGapMs({
  minIntervalMs = YAHOO_MIN_INTERVAL_MS,
  jitterMs = YAHOO_JITTER_MS,
  random = Math.random,
} = {}) {
  const span = Math.max(0, jitterMs);
  const jitter = span > 0 ? Math.floor(Number(random()) * (span + 1)) : 0;
  return minIntervalMs + (Number.isFinite(jitter) ? jitter : 0);
}

export function createPaceQueue({
  minIntervalMs = YAHOO_MIN_INTERVAL_MS,
  jitterMs = YAHOO_JITTER_MS,
  now = () => Date.now(),
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  random = Math.random,
} = {}) {
  let tail = Promise.resolve();
  let nextAt = 0;
  let active = 0;
  let maxActive = 0;

  function enqueue(task) {
    const run = tail.then(async () => {
      active += 1;
      if (active > maxActive) maxActive = active;
      try {
        const wait = Math.max(0, nextAt - now());
        if (wait > 0) await sleep(wait);
        const start = now();
        nextAt = start + paceGapMs({ minIntervalMs, jitterMs, random });
        return await task();
      } finally {
        active -= 1;
      }
    });
    tail = run.then(() => {}, () => {});
    return run;
  }

  return {
    enqueue,
    stats: () => ({ maxActive }),
  };
}

export function parseRetryAfter(header, nowMs = Date.now()) {
  if (header == null) return null;
  const raw = String(header).trim();
  if (!raw) return null;
  if (/^\d+(\.\d+)?$/.test(raw)) return Math.max(0, Number(raw) * 1000);
  const when = Date.parse(raw);
  if (!Number.isFinite(when)) return null;
  return Math.max(0, when - nowMs);
}

export function retryDelayMs({
  attempt = 0,
  retryAfterMs = null,
  random = Math.random,
  capMs = YAHOO_RETRY_CAP_MS,
  baseMs = YAHOO_MIN_INTERVAL_MS,
} = {}) {
  const jitter = Math.floor(Number(random()) * 250);
  const extra = Number.isFinite(jitter) ? jitter : 0;
  let ms;
  if (retryAfterMs != null && Number.isFinite(Number(retryAfterMs))) {
    ms = Number(retryAfterMs) + extra;
  } else {
    ms = baseMs * (2 ** Math.max(0, attempt)) + extra;
  }
  if (!Number.isFinite(ms) || ms < 0) ms = baseMs;
  return Math.min(capMs, ms);
}

export function formatRetryHint(ms, nowMs = Date.now()) {
  if (ms == null || !Number.isFinite(Number(ms))) return null;
  const n = Number(ms);
  if (n <= 0) return '0s';
  if (n < 90_000) return `${Math.max(1, Math.ceil(n / 1000))}s`;
  const when = new Date(nowMs + n);
  const hh = String(when.getUTCHours()).padStart(2, '0');
  const mm = String(when.getUTCMinutes()).padStart(2, '0');
  return `${when.toISOString().slice(0, 10)} ${hh}:${mm} UTC`;
}

export function withYahooRun(fn) {
  return runStore.run(new Map(), fn);
}

// Identical work shares one promise: in-flight always, and for the whole
// withYahooRun scope even after the first call settles.
export function dedupeYahoo(key, fn) {
  const scoped = runStore.getStore();
  if (scoped?.has(key)) return scoped.get(key);
  if (inflight.has(key)) {
    const pending = inflight.get(key);
    if (scoped) scoped.set(key, pending);
    return pending;
  }
  const pending = Promise.resolve().then(fn);
  inflight.set(key, pending);
  const done = pending.finally(() => {
    if (inflight.get(key) === pending) inflight.delete(key);
  });
  if (scoped) scoped.set(key, done);
  return done;
}

export function resetYahooDedupeForTests() {
  inflight.clear();
}

// One alert check / Refresh prices now should not fetch the same symbol twice.
export function createRunFetchDedupe(fetchHistory) {
  const seen = new Map();
  return (symbol, range, opts) => {
    const key = `${String(symbol || '').trim().toUpperCase()}|${range ?? ''}|${opts?.force ? '1' : '0'}`;
    if (seen.has(key)) return seen.get(key);
    const pending = Promise.resolve().then(() => fetchHistory(symbol, range, opts));
    seen.set(key, pending);
    return pending;
  };
}
