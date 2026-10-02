// alerts/http.js — alert routes. The cron endpoint is token-gated so a
// public URL cannot be used to trigger mail. The in-app Check now button
// uses POST /run, same as the rest of this unauthenticated app.

import express from 'express';
import crypto from 'crypto';
import { createAlertCoordinator, isAlertCheckStale } from './runner.js';

export function extractBearer(header) {
  if (!header || typeof header !== 'string') return null;
  const m = header.match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : null;
}

function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || !a || !b) return false;
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

export function cronAuthorized(req, expected) {
  if (!expected || typeof expected !== 'string') return false;
  const q = req?.query?.token;
  const queryToken = typeof q === 'string' ? q : null;
  const bearer = extractBearer(req?.headers?.authorization || req?.headers?.Authorization);
  return safeEqual(queryToken, expected) || safeEqual(bearer, expected);
}

export function createAlertRouter({
  store,
  runCheck,
  refreshPrices,
  sendTestEmail,
  startCheck,
  getStatus,
  token = () => process.env.ALERT_CRON_TOKEN || '',
  budgetMs,
  lockTimeoutMs,
  now,
  schedule,
  clearSchedule,
  logger,
} = {}) {
  const router = express.Router();

  let start = startCheck;
  let status = getStatus;
  if (typeof start !== 'function') {
    const coordinator = createAlertCoordinator({
      store,
      budgetMs,
      lockTimeoutMs,
      now,
      schedule,
      clearSchedule,
      logger,
      runJob: (opts) => {
        if (opts?.kind === 'refresh' && typeof refreshPrices === 'function') return refreshPrices(opts);
        if (typeof runCheck !== 'function') throw new Error('Alert check is not configured');
        return runCheck(opts);
      },
    });
    start = (opts) => coordinator.start(opts);
    status = () => coordinator.status();
  }

  function checkView(check, live) {
    const useLive = Boolean(live && (live.lastRunAt || live.running || live.finishedRunId));
    const lastSuccessAt = useLive
      ? (live.lastSuccessAt || null)
      : (check?.lastSuccessAt
        || (!check?.last_error && !check?.error && check?.at ? check.at : null));
    return {
      lastCheckAt: useLive ? (live.lastRunAt || null) : (check?.at || null),
      lastCheckError: useLive ? (live.lastError || null) : (check?.last_error || check?.error || null),
      lastCheckDurationMs: useLive ? (live.lastDurationMs ?? null) : (check?.durationMs ?? null),
      lastSuccessAt,
      lastCheckSummary: useLive ? (live.lastResult || null) : (check?.summary || null),
      checkRunning: Boolean(live?.running),
      checkStale: useLive ? Boolean(live.checkStale) : isAlertCheckStale(lastSuccessAt),
    };
  }

  router.get('/', async (_req, res) => {
    try {
      const settings = await store.getAlertSettings();
      const events = await store.listAlertEvents();
      const history = await store.listAlertHistory(40);
      const check = await store.getAlertCheckMeta();
      const live = typeof status === 'function' ? status() : null;
      const active = events
        .filter((e) => e.status === 'active')
        .sort((a, b) => (a.currentDrawdown ?? 0) - (b.currentDrawdown ?? 0));
      res.json({
        settings,
        emailConfigured: Boolean(String(process.env.RESEND_API_KEY || '').trim()),
        ...checkView(check, live),
        active,
        history,
        activeCount: active.length,
      });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  router.put('/settings', async (req, res) => {
    try {
      const saved = await store.saveAlertSettings(req.body || {});
      res.json(saved);
    } catch (e) {
      res.status(e.status || 500).json({ error: e.message });
    }
  });

  router.post('/test-email', async (_req, res) => {
    try {
      const result = await sendTestEmail();
      if (!result?.ok) {
        return res.status(502).json({ error: result?.reason || result?.error || 'Email failed' });
      }
      res.json({ ok: true, id: result.id || null });
    } catch (e) {
      res.status(e.status || 500).json({ error: e.message });
    }
  });

  const acknowledge = (res, opts) => {
    try {
      res.status(202).json(start(opts));
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  };

  router.post('/run', (_req, res) => acknowledge(res, {
    refresh: true, kind: 'check', bypassMissBackoff: true,
  }));

  router.post('/refresh-prices', (_req, res) => acknowledge(res, {
    refresh: true, kind: 'refresh', bypassMissBackoff: true,
  }));

  router.get('/status', (_req, res) => {
    try {
      res.json(typeof status === 'function' ? status() : { running: false });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  const guard = (req, res, next) => {
    const expected = typeof token === 'function' ? token() : token;
    if (!cronAuthorized(req, expected)) return res.status(401).json({ error: 'Unauthorized' });
    next();
  };

  const check = (_req, res) => acknowledge(res, { refresh: true, kind: 'check', bypassMissBackoff: false });

  router.get('/check', guard, check);
  router.post('/check', guard, check);

  return router;
}
