import { describe, it, expect } from 'vitest';
import express from 'express';
import { once } from 'node:events';
import { listenThenStart, registerHealthRoute } from './boot.js';
import { isAlertCheckStale, ALERT_SUCCESS_STALE_MS } from './alerts/runner.js';

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

describe('GET and HEAD /api/health', () => {
  it('returns 200 JSON immediately and does not run later middleware', async () => {
    const app = express();
    registerHealthRoute(app, {
      now: () => new Date('2026-10-02T15:00:00.000Z'),
      uptimeSec: () => 12,
    });
    let slow = 0;
    app.use((_req, _res, next) => {
      slow += 1;
      next();
    });
    await withServer(app, async (base) => {
      const get = await fetch(`${base}/api/health`);
      expect(get.status).toBe(200);
      expect(await get.json()).toEqual({
        ok: true,
        uptimeSec: 12,
        time: '2026-10-02T15:00:00.000Z',
      });
      const head = await fetch(`${base}/api/health`, { method: 'HEAD' });
      expect(head.status).toBe(200);
      expect(slow).toBe(0);
    });
  });

  it('listens before the store opens and answers health while startup is still running', async () => {
    let releaseStore;
    const storeGate = new Promise((resolve) => { releaseStore = resolve; });
    const order = [];
    const app = express();
    let slow = 0;
    const boot = listenThenStart({
      app,
      port: 0,
      host: '127.0.0.1',
      logger: { log() {}, error(message) { order.push(`err:${message}`); } },
      getStore: async () => {
        order.push('store');
        await storeGate;
        order.push('store-done');
        return { ready: true };
      },
      mount: async (expressApp, store) => {
        order.push('mount');
        expect(store.ready).toBe(true);
        expressApp.use((_req, _res, next) => {
          slow += 1;
          next();
        });
        expressApp.get('/api/models', (_req, res) => res.json({ ok: true }));
      },
      warmup: async () => { order.push('warmup'); },
    });

    try {
      await boot.listening;
      const { port } = boot.server.address();
      const base = `http://127.0.0.1:${port}`;
      const health = await fetch(`${base}/api/health`);
      expect(health.status).toBe(200);
      const body = await health.json();
      expect(body.ok).toBe(true);
      expect(body.uptimeSec).toEqual(expect.any(Number));
      expect(Number.isNaN(Date.parse(body.time))).toBe(false);
      expect(order).toEqual(['store']);
      expect((await fetch(`${base}/api/models`)).status).toBe(404);

      releaseStore();
      await boot.started;
      expect(order).toEqual(['store', 'store-done', 'mount', 'warmup']);
      const healthAfter = await fetch(`${base}/api/health`);
      expect(healthAfter.status).toBe(200);
      expect(slow).toBe(0);
      expect((await fetch(`${base}/api/models`)).status).toBe(200);
    } finally {
      boot.server.close();
      await once(boot.server, 'close');
    }
  });
});

describe('alert check staleness', () => {
  it('is stale when the last success is missing or older than 2 hours', () => {
    const now = Date.parse('2026-10-02T15:00:00.000Z');
    expect(ALERT_SUCCESS_STALE_MS).toBe(2 * 60 * 60 * 1000);
    expect(isAlertCheckStale(null, now)).toBe(true);
    expect(isAlertCheckStale('2026-10-02T14:00:00.000Z', now)).toBe(false);
    expect(isAlertCheckStale('2026-10-02T12:00:00.000Z', now)).toBe(true);
  });
});
