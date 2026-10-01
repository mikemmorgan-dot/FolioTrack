import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { JsonStore } from '../store-json.js';

const files = [];
function tmpStore() {
  const file = path.join(os.tmpdir(), `foliotrack-alerts-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  files.push(file);
  return new JsonStore(file).init();
}
afterEach(() => {
  for (const f of files) try { fs.unlinkSync(f); } catch { /* already gone */ }
  files.length = 0;
});

describe('JsonStore alert settings and events', () => {
  it('defaults, persists, and reloads threshold, recipient, and the on/off switch', async () => {
    const store = await tmpStore();
    expect(await store.getAlertSettings()).toEqual({
      alertThreshold: 20,
      alertEmail: 'mikemmorgan@gmail.com',
      alertEnabled: true,
    });
    await store.saveAlertSettings({ alertThreshold: 15.5, alertEmail: 'mike@example.com', alertEnabled: false });
    const reopened = await new JsonStore(store.file).init();
    expect(await reopened.getAlertSettings()).toEqual({
      alertThreshold: 15.5,
      alertEmail: 'mike@example.com',
      alertEnabled: false,
    });
    await expect(reopened.saveAlertSettings({ alertThreshold: 0 })).rejects.toMatchObject({ status: 400 });
    await expect(reopened.saveAlertSettings({ alertThreshold: 91 })).rejects.toMatchObject({ status: 400 });
    await expect(reopened.saveAlertSettings({ alertEmail: 'not-an-email' })).rejects.toMatchObject({ status: 400 });
    expect((await reopened.getAlertSettings()).alertThreshold).toBe(15.5);
  });

  it('round-trips an alert event and history row', async () => {
    const store = await tmpStore();
    const event = {
      instrumentId: 'inst_ry',
      symbol: 'RY.TO',
      name: 'Royal Bank',
      status: 'active',
      firstBreachedAt: '2026-09-01T15:00:00.000Z',
      lastNotifiedAt: null,
      recoveredAt: null,
      referencePrice: 200,
      referenceDate: '2026-01-15',
      priceAtBreach: 150,
      drawdownAtBreach: -0.25,
      currentPrice: 150,
      currentDrawdown: -0.25,
      threshold: 20,
      notifyStatus: 'pending',
      notifyDetail: 'pending - email not configured',
      basis: '52w',
      basisLabel: 'from 52-week high, using cached closes as of 2026-09-01',
      priceAsOf: '2026-09-01',
      stale: true,
      models: [{ key: 'growth', name: 'Growth' }],
      currency: 'CAD',
      updatedAt: '2026-09-01T15:00:00.000Z',
    };
    await store.upsertAlertEvent(event);
    await store.appendAlertHistory({
      id: 'alrt_1', instrumentId: 'inst_ry', symbol: 'RY.TO', name: 'Royal Bank',
      kind: 'pending', at: '2026-09-01T15:00:00.000Z', drawdown: -0.25, price: 150,
      referencePrice: 200, referenceDate: '2026-01-15', detail: event.notifyDetail, models: event.models,
    });
    await store.setAlertCheckMeta({ at: '2026-09-01T15:00:00.000Z', error: null, summary: { active: 1 } });
    const reopened = await new JsonStore(store.file).init();
    expect(await reopened.getAlertEvent('inst_ry')).toMatchObject({
      symbol: 'RY.TO', notifyDetail: 'pending - email not configured', stale: true,
    });
    expect(await reopened.listAlertHistory(10)).toHaveLength(1);
    expect(await reopened.getAlertCheckMeta()).toMatchObject({ summary: { active: 1 } });
    await reopened.setAlertMissUntil({ 'RY.TO': '2026-09-01T18:00:00.000Z' });
    const again = await new JsonStore(store.file).init();
    expect(await again.getAlertMissUntil()).toEqual({ 'RY.TO': '2026-09-01T18:00:00.000Z' });
  });
});
