// alerts/state.js — breach / recovery state machine.
//
// Breach when drawdown <= -threshold.
// Recover when drawdown is back above -(threshold) + 2 percentage points.
// One email per episode: already-notified active rows are not emailed again
// when the threshold changes but the holding is still inside the band.
// A recovered row that breaches again is a new episode and may email.

export const HYSTERESIS_POINTS = 2;

export function band(thresholdPct) {
  const threshold = Number(thresholdPct);
  const breach = -threshold;
  let recover = -threshold + HYSTERESIS_POINTS;
  // A +2pt band at or above zero can never be cleared, because the reference
  // high already includes the latest close (drawdown <= 0). Collapse to
  // "back at the high" so a 1–2% threshold can still recover.
  if (recover > 0) recover = 0;
  return { breach, recover };
}

export function isBreached(drawdown, thresholdPct) {
  if (drawdown == null || !Number.isFinite(drawdown)) return false;
  const { breach } = band(thresholdPct);
  return drawdown * 100 <= breach + 1e-9;
}

export function isRecovered(drawdown, thresholdPct) {
  if (drawdown == null || !Number.isFinite(drawdown)) return false;
  const { recover } = band(thresholdPct);
  const pct = drawdown * 100;
  if (recover >= 0) return pct >= -1e-9;
  return pct > recover + 1e-9;
}

function snapshot(prev, evaluation, thresholdPct, now) {
  return {
    instrumentId: evaluation.instrumentId,
    symbol: evaluation.symbol,
    name: evaluation.name,
    currency: evaluation.currency || prev?.currency || null,
    status: 'active',
    firstBreachedAt: prev?.status === 'active' ? prev.firstBreachedAt : now,
    lastNotifiedAt: prev?.status === 'active' ? (prev.lastNotifiedAt || null) : null,
    recoveredAt: null,
    referencePrice: evaluation.referencePrice,
    referenceDate: evaluation.referenceDate,
    priceAtBreach: prev?.status === 'active' ? prev.priceAtBreach : evaluation.currentPrice,
    drawdownAtBreach: prev?.status === 'active' ? prev.drawdownAtBreach : evaluation.drawdown,
    currentPrice: evaluation.currentPrice,
    currentDrawdown: evaluation.drawdown,
    threshold: thresholdPct,
    notifyStatus: prev?.status === 'active' ? (prev.notifyStatus || 'pending') : 'pending',
    notifyDetail: prev?.status === 'active' ? (prev.notifyDetail || null) : null,
    basis: evaluation.basis,
    basisLabel: evaluation.basisLabel,
    priceAsOf: evaluation.priceAsOf,
    historyFetchedAt: evaluation.historyFetchedAt || null,
    stale: !!evaluation.stale,
    models: evaluation.models || [],
    lastEvalNote: null,
    updatedAt: now,
  };
}

/**
 * @returns {{ action: 'none'|'open'|'retry'|'update'|'recover', shouldEmail: boolean, next: object|null }}
 */
export function transitionAlert(prev, evaluation, { thresholdPct, now }) {
  const breached = isBreached(evaluation.drawdown, thresholdPct);
  const recovered = isRecovered(evaluation.drawdown, thresholdPct);
  const active = prev?.status === 'active';

  if (!active) {
    if (!breached) return { action: 'none', shouldEmail: false, next: prev || null };
    return {
      action: 'open',
      shouldEmail: true,
      next: snapshot(null, evaluation, thresholdPct, now),
    };
  }

  if (recovered) {
    return {
      action: 'recover',
      shouldEmail: false,
      next: {
        ...snapshot(prev, evaluation, thresholdPct, now),
        status: 'recovered',
        firstBreachedAt: prev.firstBreachedAt,
        lastNotifiedAt: prev.lastNotifiedAt || null,
        notifyStatus: prev.notifyStatus || null,
        notifyDetail: prev.notifyDetail || null,
        priceAtBreach: prev.priceAtBreach,
        drawdownAtBreach: prev.drawdownAtBreach,
        recoveredAt: now,
      },
    };
  }

  // Still breached, or sitting in the hysteresis band. Keep the episode.
  // Email only if this episode has never been sent.
  const alreadyNotified = !!prev.lastNotifiedAt;
  const next = snapshot(prev, evaluation, thresholdPct, now);
  return {
    action: alreadyNotified ? 'update' : 'retry',
    shouldEmail: !alreadyNotified,
    next,
  };
}
