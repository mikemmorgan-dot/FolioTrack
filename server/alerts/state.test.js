import { describe, it, expect } from 'vitest';
import { transitionAlert, isBreached, isRecovered, band } from './state.js';

const NOW = '2026-09-01T15:00:00.000Z';
const LATER = '2026-09-02T15:00:00.000Z';

function ev(drawdown, extra = {}) {
  return {
    instrumentId: 'inst_nvda',
    symbol: 'NVDA',
    name: 'NVIDIA',
    currency: 'USD',
    currentPrice: 140,
    referencePrice: 200,
    referenceDate: '2026-01-15',
    drawdown,
    basis: '52w',
    covers52w: true,
    basisLabel: 'from 52-week high, using cached closes as of 2026-09-01',
    priceAsOf: '2026-09-01',
    stale: false,
    models: [{ key: 'growth', name: 'Growth' }],
    ...extra,
  };
}

describe('breach and hysteresis bands', () => {
  it('breaches at the threshold and recovers only above threshold minus 2 points', () => {
    expect(band(20)).toEqual({ breach: -20, recover: -18 });
    expect(isBreached(-0.20, 20)).toBe(true);
    expect(isBreached(-0.199, 20)).toBe(false);
    expect(isRecovered(-0.19, 20)).toBe(false);
    expect(isRecovered(-0.18, 20)).toBe(false);
    expect(isRecovered(-0.179, 20)).toBe(true);
  });

  it('collapses the band to the high when a 2 point gap would sit above zero', () => {
    expect(band(1).recover).toBe(0);
    expect(isRecovered(0, 1)).toBe(true);
    expect(isRecovered(-0.005, 1)).toBe(false);
    expect(isBreached(-0.01, 1)).toBe(true);
  });
});

describe('alert state machine', () => {
  it('opens a new episode and asks for one email', () => {
    const step = transitionAlert(null, ev(-0.30), { thresholdPct: 20, now: NOW });
    expect(step.action).toBe('open');
    expect(step.shouldEmail).toBe(true);
    expect(step.next.status).toBe('active');
    expect(step.next.firstBreachedAt).toBe(NOW);
    expect(step.next.lastNotifiedAt).toBeNull();
    expect(step.next.priceAtBreach).toBe(140);
    expect(step.next.drawdownAtBreach).toBeCloseTo(-0.30, 10);
  });

  it('does not email again while the episode stays breached', () => {
    const opened = transitionAlert(null, ev(-0.30), { thresholdPct: 20, now: NOW }).next;
    const notified = { ...opened, lastNotifiedAt: NOW, notifyStatus: 'sent' };
    const again = transitionAlert(notified, ev(-0.28, { currentPrice: 144 }), { thresholdPct: 20, now: LATER });
    expect(again.action).toBe('update');
    expect(again.shouldEmail).toBe(false);
    expect(again.next.firstBreachedAt).toBe(NOW);
    expect(again.next.lastNotifiedAt).toBe(NOW);
    expect(again.next.priceAtBreach).toBe(140);
    expect(again.next.currentPrice).toBe(144);
  });

  it('retries email when the episode is active but was never sent', () => {
    const opened = transitionAlert(null, ev(-0.30), { thresholdPct: 20, now: NOW }).next;
    const pending = { ...opened, notifyStatus: 'pending', notifyDetail: 'pending - email not configured' };
    const retry = transitionAlert(pending, ev(-0.30), { thresholdPct: 20, now: LATER });
    expect(retry.action).toBe('retry');
    expect(retry.shouldEmail).toBe(true);
    expect(retry.next.lastNotifiedAt).toBeNull();
  });

  it('stays active inside the hysteresis band and recovers above it', () => {
    const notified = {
      ...transitionAlert(null, ev(-0.30), { thresholdPct: 20, now: NOW }).next,
      lastNotifiedAt: NOW,
      notifyStatus: 'sent',
    };
    const held = transitionAlert(notified, ev(-0.19), { thresholdPct: 20, now: LATER });
    expect(held.action).toBe('update');
    expect(held.shouldEmail).toBe(false);
    expect(held.next.status).toBe('active');

    const cleared = transitionAlert(notified, ev(-0.17), { thresholdPct: 20, now: LATER });
    expect(cleared.action).toBe('recover');
    expect(cleared.shouldEmail).toBe(false);
    expect(cleared.next.status).toBe('recovered');
    expect(cleared.next.recoveredAt).toBe(LATER);
    expect(cleared.next.lastNotifiedAt).toBe(NOW);
  });

  it('sends a new email when a recovered holding breaches again', () => {
    const recovered = {
      ...transitionAlert(null, ev(-0.30), { thresholdPct: 20, now: NOW }).next,
      status: 'recovered',
      lastNotifiedAt: NOW,
      recoveredAt: LATER,
    };
    const again = transitionAlert(recovered, ev(-0.25), { thresholdPct: 20, now: '2026-10-01T15:00:00.000Z' });
    expect(again.action).toBe('open');
    expect(again.shouldEmail).toBe(true);
    expect(again.next.lastNotifiedAt).toBeNull();
    expect(again.next.firstBreachedAt).toBe('2026-10-01T15:00:00.000Z');
  });

  it('does not spam an already-notified holding when the threshold changes but it is still breached', () => {
    const notified = {
      ...transitionAlert(null, ev(-0.30), { thresholdPct: 20, now: NOW }).next,
      lastNotifiedAt: NOW,
      notifyStatus: 'sent',
    };
    const tighter = transitionAlert(notified, ev(-0.30), { thresholdPct: 15, now: LATER });
    expect(tighter.shouldEmail).toBe(false);
    expect(tighter.next.status).toBe('active');
    expect(tighter.next.threshold).toBe(15);

    const looserButStillIn = transitionAlert(notified, ev(-0.30), { thresholdPct: 25, now: LATER });
    expect(looserButStillIn.shouldEmail).toBe(false);
    expect(looserButStillIn.next.status).toBe('active');

    // -30% is above the new recovery line of -38%, so the episode clears.
    const cleared = transitionAlert(notified, ev(-0.30), { thresholdPct: 40, now: LATER });
    expect(cleared.action).toBe('recover');
    expect(cleared.shouldEmail).toBe(false);
  });

  it('does not open an episode for a drawdown that only sits inside the band', () => {
    const step = transitionAlert(null, ev(-0.19), { thresholdPct: 20, now: NOW });
    expect(step.action).toBe('none');
    expect(step.shouldEmail).toBe(false);
  });
});
