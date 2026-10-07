// egress.js — approximate rows and bytes Neon sent back, per request.
// Bytes are JSON size of the result rows (an estimate of the payload, not
// the exact wire size). Queries outside a request scope are not logged.

import { AsyncLocalStorage } from 'node:async_hooks';

export const egressAls = new AsyncLocalStorage();

export function noteEgress(rows, bytes) {
  const bucket = egressAls.getStore();
  if (!bucket) return;
  bucket.queries += 1;
  bucket.rows += rows || 0;
  bucket.bytes += bytes || 0;
}

export function approxJsonBytes(rows) {
  if (!rows || !rows.length) return 0;
  try {
    return Buffer.byteLength(JSON.stringify(rows));
  } catch {
    return 0;
  }
}

export function logEgress(label) {
  const bucket = egressAls.getStore();
  if (!bucket || bucket.logged) return;
  bucket.logged = true;
  if (!bucket.queries) return;
  const name = label || bucket.label || 'request';
  console.log(`[egress] ${name} queries=${bucket.queries} rows=${bucket.rows} bytes~${bucket.bytes}`);
}

// Start a scope only when the caller is not already inside one (the HTTP
// middleware and the in-process scheduler both enter here).
export function openEgressScope(label, fn) {
  if (egressAls.getStore()) return fn();
  const bucket = { label, queries: 0, rows: 0, bytes: 0, logged: false };
  return egressAls.run(bucket, fn);
}

export function egressMiddleware(req, res, next) {
  const bucket = {
    label: `${req.method} ${req.path}`,
    queries: 0,
    rows: 0,
    bytes: 0,
    logged: false,
  };
  egressAls.run(bucket, () => {
    res.on('finish', () => {
      // The cron handler returns before the check finishes. The check logs
      // itself when the run ends, with the full query total.
      if (req.path === '/api/alerts/check') return;
      logEgress(bucket.label);
    });
    next();
  });
}
