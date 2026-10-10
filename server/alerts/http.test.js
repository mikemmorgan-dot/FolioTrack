import { describe, it, expect, afterEach } from 'vitest';
import express from 'express';
import { once } from 'node:events';
import { createAlertRouter } from './http.js';
import { applyAlertSettingsPatch, coerceAlertSettings } from './settings.js';
import { startAlertScheduler, alertRunDelayMs, ALERT_INTERVAL_MS } from './schedule.js';
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
      expect(okGet.status).toBe(202);
      const okGetBody = await okGet.json();
      expect(okGetBody.started).toBe(true);
      expect(okGetBody.alreadyRunning).toBe(false);
      expect(okGetBody).toHaveProperty('lastRunAt');
      expect(okGetBody).toHaveProperty('lastResult');
      const okPost = await fetch(`${base}/api/alerts/check`, {
        method: 'POST',
        headers: { Authorization: 'Bearer s3cret' },
      });
      expect(okPost.status).toBe(202);
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
      expect(res.status).toBe(202);
      const ack = await res.json();
      expect(ack.started).toBe(true);
      expect(ctx.refreshes).toBe(1);
      let status;
      for (let i = 0; i < 20; i++) {
        status = await (await fetch(`${base}/api/alerts/status`)).json();
        if (!status.running) break;
        await new Promise((r) => setTimeout(r, 10));
      }
      expect(status.running).toBe(false);
      expect(status.lastResult.refresh.results[0].symbol).toBe('TSLA');
    });
  });
});

describe('background alert check', () => {
  it('answers 202 before the check finishes, and a second call does not overlap', async () => {
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    let calls = 0;
    const app = express();
    app.use(express.json());
    app.use('/api/alerts', createAlertRouter({
      store: memoryStore(),
      runCheck: () => {
        calls += 1;
        return gate.then(() => ({
          ok: true,
          evaluated: 4,
          active: 1,
          checkedAt: '2026-10-02T12:00:00.000Z',
        }));
      },
      sendTestEmail: async () => ({ ok: true }),
      token: () => 's3cret',
      logger: { log() {}, warn() {}, error() {} },
    }));
    await withServer(app, async (base) => {
      const started = Date.now();
      const res = await fetch(`${base}/api/alerts/check?token=s3cret`);
      expect(Date.now() - started).toBeLessThan(1000);
      expect(res.status).toBe(202);
      const body = await res.json();
      expect(body).toMatchObject({ started: true, alreadyRunning: false });
      expect(calls).toBe(1);

      const run = await fetch(`${base}/api/alerts/run`, { method: 'POST' });
      expect(run.status).toBe(202);
      expect(await run.json()).toMatchObject({ started: false, alreadyRunning: true });
      expect(calls).toBe(1);

      const mid = await (await fetch(`${base}/api/alerts/status`)).json();
      expect(mid.running).toBe(true);
      expect(mid.lastResult).toBeNull();

      release();
      let done;
      for (let i = 0; i < 30; i++) {
        done = await (await fetch(`${base}/api/alerts/status`)).json();
        if (!done.running) break;
        await new Promise((r) => setTimeout(r, 10));
      }
      expect(done.running).toBe(false);
      expect(done.lastResult.evaluated).toBe(4);
      expect(done.lastError).toBeNull();
      expect(done.finishedRunId).toBe(body.runId);
    });
  });

  it('releases a timed-out lock so a later check can start', async () => {
    let clock = 0;
    const timers = [];
    let calls = 0;
    const app = express();
    app.use(express.json());
    app.use('/api/alerts', createAlertRouter({
      store: memoryStore(),
      runCheck: () => {
        calls += 1;
        return new Promise(() => {});
      },
      sendTestEmail: async () => ({ ok: true }),
      token: () => 's3cret',
      lockTimeoutMs: 1000,
      now: () => clock,
      schedule: (fn, ms) => {
        const id = timers.push({ fn, ms }) - 1;
        return id;
      },
      clearSchedule: (id) => { if (id != null) timers[id] = null; },
      logger: { log() {}, warn() {}, error() {} },
    }));
    await withServer(app, async (base) => {
      const first = await (await fetch(`${base}/api/alerts/check?token=s3cret`)).json();
      expect(first.started).toBe(true);
      const second = await (await fetch(`${base}/api/alerts/check?token=s3cret`)).json();
      expect(second).toMatchObject({ started: false, alreadyRunning: true });
      expect(calls).toBe(1);
      expect(timers[0].ms).toBe(1000);
      clock = 1000;
      timers[0].fn();
      const mid = await (await fetch(`${base}/api/alerts/status`)).json();
      expect(mid.running).toBe(false);
      expect(mid.lastError).toMatch(/lock timeout/);
      const third = await (await fetch(`${base}/api/alerts/check?token=s3cret`)).json();
      expect(third).toMatchObject({ started: true, alreadyRunning: false });
      expect(calls).toBe(2);
    });
  });

  it('records a thrown check error and keeps serving status', async () => {
    const db = { check: null };
    const store = {
      async getAlertSettings() { return coerceAlertSettings({}); },
      async listAlertEvents() { return []; },
      async listAlertHistory() { return []; },
      async getAlertCheckMeta() { return db.check; },
      async setAlertCheckMeta(meta) { db.check = meta; return meta; },
    };
    const app = express();
    app.use(express.json());
    app.use('/api/alerts', createAlertRouter({
      store,
      runCheck: async () => { throw new Error('db down'); },
      sendTestEmail: async () => ({ ok: true }),
      token: () => 's3cret',
      logger: { log() {}, warn() {}, error() {} },
    }));
    await withServer(app, async (base) => {
      const res = await fetch(`${base}/api/alerts/check?token=s3cret`);
      expect(res.status).toBe(202);
      let status;
      for (let i = 0; i < 30; i++) {
        status = await (await fetch(`${base}/api/alerts/status`)).json();
        if (!status.running && status.lastError) break;
        await new Promise((r) => setTimeout(r, 10));
      }
      expect(status.running).toBe(false);
      expect(status.lastError).toBe('db down');
      expect(status.lastResult.ok).toBe(false);
      expect(db.check.last_error).toBe('db down');
      expect(db.check.error).toBe('db down');
      const again = await fetch(`${base}/api/alerts/status`);
      expect(again.status).toBe(200);
    });
  });
});

describe('manual refresh bypass flag', () => {
  async function settle(base) {
    let status;
    for (let i = 0; i < 30; i++) {
      status = await (await fetch(`${base}/api/alerts/status`)).json();
      if (!status.running) return status;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error('run did not finish');
  }

  it('bypasses holding backoff for Check now and Refresh prices now, not for the cron URL', async () => {
    const seen = [];
    const app = express();
    app.use(express.json());
    app.use('/api/alerts', createAlertRouter({
      store: memoryStore(),
      runCheck: async (opts) => {
        seen.push({ via: 'check', bypass: !!opts?.bypassMissBackoff });
        return { ok: true, evaluated: 0, active: 0 };
      },
      refreshPrices: async (opts) => {
        seen.push({ via: 'refresh', bypass: !!opts?.bypassMissBackoff });
        return { ok: true, evaluated: 0, active: 0 };
      },
      sendTestEmail: async () => ({ ok: true }),
      token: () => 's3cret',
      logger: { log() {}, warn() {}, error() {} },
    }));
    await withServer(app, async (base) => {
      const run = await fetch(`${base}/api/alerts/run`, { method: 'POST' });
      expect(run.status).toBe(202);
      await settle(base);
      const refresh = await fetch(`${base}/api/alerts/refresh-prices`, { method: 'POST' });
      expect(refresh.status).toBe(202);
      await settle(base);
      const cron = await fetch(`${base}/api/alerts/check?token=s3cret`);
      expect(cron.status).toBe(202);
      await settle(base);
    });
    expect(seen).toEqual([
      { via: 'check', bypass: true },
      { via: 'refresh', bypass: true },
      { via: 'check', bypass: false },
    ]);
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

  it('runs immediately when the last run is missing or older than the interval', async () => {
    const now = Date.parse('2026-10-10T11:00:00.000Z');
    expect(alertRunDelayMs(null, now)).toBe(0);
    expect(alertRunDelayMs('', now)).toBe(0);
    expect(alertRunDelayMs('not-a-date', now)).toBe(0);
    expect(alertRunDelayMs(new Date(now - ALERT_INTERVAL_MS).toISOString(), now)).toBe(0);
    expect(alertRunDelayMs(new Date(now - ALERT_INTERVAL_MS - 1).toISOString(), now)).toBe(0);

    vi.useFakeTimers();
    const run = vi.fn(async () => ({ evaluated: 1, active: 0, emailed: 0, pending: 0 }));
    const stop = startAlertScheduler({
      run,
      lastRunAt: new Date(now - 4 * 60 * 60 * 1000).toISOString(),
      now: () => now,
      logger: { log() {}, error() {} },
    });
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));
    stop();
  });

  it('waits out the remainder when the last run is still inside the interval', async () => {
    const now = Date.parse('2026-10-10T11:00:00.000Z');
    const ageMs = 10 * 60 * 1000;
    expect(alertRunDelayMs(new Date(now - ageMs).toISOString(), now)).toBe(ALERT_INTERVAL_MS - ageMs);
    expect(alertRunDelayMs(new Date(now + 60 * 1000).toISOString(), now)).toBe(ALERT_INTERVAL_MS);

    vi.useFakeTimers();
    const run = vi.fn(async () => ({ evaluated: 1, active: 0, emailed: 0, pending: 0 }));
    const stop = startAlertScheduler({
      run,
      lastRunAt: new Date(now - ageMs).toISOString(),
      now: () => now,
      logger: { log() {}, error() {} },
    });
    await Promise.resolve();
    expect(run).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(ALERT_INTERVAL_MS - ageMs - 1);
    expect(run).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(ALERT_INTERVAL_MS);
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(2));
    stop();
  });
});
