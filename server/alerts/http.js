// alerts/http.js — alert routes. The cron endpoint is token-gated so a
// public URL cannot be used to trigger mail. The in-app Check now button
// uses POST /run, same as the rest of this unauthenticated app.

import express from 'express';
import crypto from 'crypto';

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
  sendTestEmail,
  token = () => process.env.ALERT_CRON_TOKEN || '',
} = {}) {
  const router = express.Router();

  router.get('/', async (_req, res) => {
    try {
      const settings = await store.getAlertSettings();
      const events = await store.listAlertEvents();
      const history = await store.listAlertHistory(40);
      const check = await store.getAlertCheckMeta();
      const active = events
        .filter((e) => e.status === 'active')
        .sort((a, b) => (a.currentDrawdown ?? 0) - (b.currentDrawdown ?? 0));
      res.json({
        settings,
        emailConfigured: Boolean(String(process.env.RESEND_API_KEY || '').trim()),
        lastCheckAt: check?.at || null,
        lastCheckError: check?.error || null,
        lastCheckSummary: check?.summary || null,
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

  router.post('/run', async (_req, res) => {
    try {
      res.json(await runCheck());
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  const guard = (req, res, next) => {
    const expected = typeof token === 'function' ? token() : token;
    if (!cronAuthorized(req, expected)) return res.status(401).json({ error: 'Unauthorized' });
    next();
  };

  const check = async (_req, res) => {
    try {
      res.json(await runCheck());
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  };

  router.get('/check', guard, check);
  router.post('/check', guard, check);

  return router;
}
