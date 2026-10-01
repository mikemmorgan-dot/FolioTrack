import { describe, it, expect, afterEach } from 'vitest';
import express from 'express';
import { once } from 'node:events';
import { createAlertRouter } from './http.js';
import { applyAlertSettingsPatch, coerceAlertSettings } from './settings.js';
import { startAlertScheduler, ALERT_INTERVAL_MS } from './schedule.js';
import { vi } from 'vitest';

function memoryStore() {
  const db = { settings: null, events: [], history: [], check: null };
  return {
    async getAlertSettings() { return coerceAlertSettings(db.settings || {}); },
    async saveAlertSettings(patch) {
      db.settings = applyAlertSettingsPatch(await this.getAlertSettings(), patch);
      return db.settings;
    },
    async listAlertEvents() { return db.events; },
    async listAlertHistory() { return db.history; },
    async getAlertCheckMeta() { return db.check; },
  };
}

async function withServer(app, fn) {
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const { port } = server.address();
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    server.close();
    await once(server, 'close');
  }
}

function appWith(token, runCheck, refreshPrices) {
  const app = express();
  app.use(express.json());
  const store = memoryStore();
  let tests = 0;
  let refreshes = 0;
  app.use('/api/alerts', createAlertRouter({
    store,
    runCheck: runCheck || (async () => { tests += 1; return { ok: true, evaluated: 0, active: 0, emailed: 0, pending: 0 }; }),
    refreshPrices: refreshPrices || (async () => {
      refreshes += 1;
      return { ok: true, evaluated: 0, active: 0, refresh: { updated: 1, failed: 0, skipped: 0, results: [{ symbol: 'TSLA', status: 'updated' }] } };
    }),
    sendTestEmail: async () => ({ ok: false, reason: 'pending - email not configured' }),
    token: () => token,
  }));
  return { app, store, get tests() { return tests; }, get refreshes() { return refreshes; } };
}

describe('alert check token guard', () => {
  it('rejects a missing token, a wrong token, and an unset secret', async () => {
    const { app, get } = (() => {
      const box = appWith('s3cret');
      return { app: box.app, get: () => box.tests };
    })();
    await withServer(app, async (base) => {
      const open = await fetch(`${base}/api/alerts/check`);
      expect(open.status).toBe(401);
      const wrong = await fetch(`${base}/api/alerts/check?token=nope`);
      expect(wrong.status).toBe(401);
      const badBearer = await fetch(`${base}/api/alerts/check`, { headers: { Authorization: 'Bearer nope' } });
      expect(badBearer.status).toBe(401);
      expect(get()).toBe(0);

      const okGet = await fetch(`${base}/api/alerts/check?token=s3cret`);
      expect(okGet.status).toBe(200);
      const okPost = await fetch(`${base}/api/alerts/check`, {
        method: 'POST',
        headers: { Authorization: 'Bearer s3cret' },
      });
      expect(okPost.status).toBe(200);
      expect(get()).toBe(2);
    });

    const closed = appWith('');
    await withServer(closed.app, async (base) => {
      const res = await fetch(`${base}/api/alerts/check?token=`);
      expect(res.status).toBe(401);
      expect(closed.tests).toBe(0);
    });
  });

  it('rejects a threshold outside 1–90', async () => {
    const { app } = appWith('s3cret');
    await withServer(app, async (base) => {
      const res = await fetch(`${base}/api/alerts/settings`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ alertThreshold: 0 }),
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toMatch(/1 and 90/);
      const high = await fetch(`${base}/api/alerts/settings`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ alertThreshold: 91 }),
      });
      expect(high.status).toBe(400);
    });
  });

  it('returns the provider error from the test-email endpoint', async () => {
    const { app } = appWith('s3cret');
    await withServer(app, async (base) => {
      const res = await fetch(`${base}/api/alerts/test-email`, { method: 'POST' });
      expect(res.status).toBe(502);
      const body = await res.json();
      expect(body.error).toBe('pending - email not configured');
    });
  });

  it('exposes refresh-prices without a cron token and reports per-holding results', async () => {
    const ctx = appWith('s3cret');
    await withServer(ctx.app, async (base) => {
      const res = await fetch(`${base}/api/alerts/refresh-prices`, { method: 'POST' });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.refresh.results[0].symbol).toBe('TSLA');
      expect(ctx.refreshes).toBe(1);
    });
  });
});

describe('alert scheduler', () => {
  afterEach(() => { vi.useRealTimers(); });

  it('runs once after start and again on the 30 minute interval', async () => {
    vi.useFakeTimers();
    const run = vi.fn(async () => ({ evaluated: 1, active: 0, emailed: 0, pending: 0 }));
    const stop = startAlertScheduler({ run, logger: { log() {}, error() {} } });
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(ALERT_INTERVAL_MS);
    expect(run).toHaveBeenCalledTimes(2);
    expect(ALERT_INTERVAL_MS).toBe(30 * 60 * 1000);
    stop();
  });
});
