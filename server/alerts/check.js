// alerts/check.js — evaluate every current holding and advance alert state.
//
// Prices come from the stored price_history cache. A market name whose cache
// is missing or older than the history TTL is refreshed through the existing
// history cache (no force flag), which already skips providers that are
// cooling down. A total miss backs off for several hours so a 30-minute
// tick does not walk the provider chain again. Cash is skipped. Names with
// no cached close and no NAV are skipped. Private/illiquid names are
// included only when a NAV series (or a cached close) actually exists.

import { uid } from '../util.js';
import { todayToronto } from '../nav.js';
import { HISTORY_TTL_MS } from '../historyCache.js';
import { collectCurrentHoldings, evaluateHolding } from './drawdown.js';
import { transitionAlert } from './state.js';
import { buildAlertEmail, buildTestEmail, EMAIL_NOT_CONFIGURED, FOLIOTRACK_URL } from './email.js';

export const ALERT_MISS_BACKOFF_MS = 6 * 60 * 60 * 1000;

function isMarketName(inst) {
  return inst?.type === 'stock' || inst?.type === 'etf';
}

async function loadPrices(store, inst, { getHistory, nowMs, liveMissUntil, missBackoffMs }) {
  const stored = store.getPriceHistory ? await store.getPriceHistory(inst.symbol) : null;
  const navSeries = store.getNavSeries ? await store.getNavSeries(inst.id) : [];
  let historySeries = stored?.series || [];
  let historyFetchedAt = stored?.fetchedAt || null;
  const ageMs = historyFetchedAt ? nowMs - Date.parse(historyFetchedAt) : Infinity;
  const fresh = historySeries.length > 0 && Number.isFinite(ageMs) && ageMs >= 0 && ageMs < HISTORY_TTL_MS;
  const symbol = String(inst.symbol || '').toUpperCase();

  if (isMarketName(inst) && typeof getHistory === 'function' && !fresh && nowMs >= (liveMissUntil.get(symbol) || 0)) {
    try {
      const h = await getHistory(inst.symbol, 'max');
      if (h?.series?.length) {
        historySeries = h.series;
        historyFetchedAt = h.fetchedAt || new Date(nowMs).toISOString();
        liveMissUntil.delete(symbol);
      } else {
        liveMissUntil.set(symbol, nowMs + missBackoffMs);
      }
    } catch {
      liveMissUntil.set(symbol, nowMs + missBackoffMs);
    }
  }

  return { historySeries, historyFetchedAt, navSeries: navSeries || [] };
}

function historyEntry(kind, event, now, detail) {
  return {
    id: uid('alrt'),
    instrumentId: event.instrumentId,
    symbol: event.symbol,
    name: event.name || null,
    kind,
    at: now,
    drawdown: event.currentDrawdown ?? event.drawdownAtBreach ?? null,
    price: event.currentPrice ?? event.priceAtBreach ?? null,
    referencePrice: event.referencePrice ?? null,
    referenceDate: event.referenceDate ?? null,
    detail: detail || null,
    models: event.models || [],
  };
}

export function createAlertService({
  store,
  getHistory = null,
  email,
  now = () => new Date(),
  today = () => todayToronto(),
  appUrl = FOLIOTRACK_URL,
  missBackoffMs = ALERT_MISS_BACKOFF_MS,
} = {}) {
  if (!store) throw new Error('createAlertService requires a store');
  if (!email?.send) throw new Error('createAlertService requires an email sender');

  const liveMissUntil = new Map();
  let inflight = null;

  async function hydrateMisses(nowMs) {
    if (typeof store.getAlertMissUntil !== 'function') return;
    const raw = await store.getAlertMissUntil();
    for (const [sym, until] of Object.entries(raw || {})) {
      const t = Date.parse(until);
      if (Number.isFinite(t) && t > nowMs) liveMissUntil.set(sym, t);
    }
  }

  async function persistMisses(nowMs) {
    if (typeof store.setAlertMissUntil !== 'function') return;
    const obj = {};
    for (const [sym, until] of liveMissUntil) {
      if (until > nowMs) obj[sym] = new Date(until).toISOString();
    }
    await store.setAlertMissUntil(obj);
  }

  async function runAlertCheck() {
    const nowDate = now();
    const nowIso = nowDate.toISOString();
    const nowMs = nowDate.getTime();
    const todayIso = today();
    await hydrateMisses(nowMs);
    const settings = await store.getAlertSettings();
    const models = await store.listModels();
    const groups = collectCurrentHoldings(models);
    const heldIds = new Set(groups.map((g) => g.instrumentId));

    const summary = {
      ok: true,
      checkedAt: nowIso,
      evaluated: 0,
      skippedHoldings: 0,
      opened: 0,
      recovered: 0,
      emailed: 0,
      pending: 0,
      active: 0,
      alertsEnabled: settings.alertEnabled,
      errors: [],
    };

    for (const group of groups) {
      try {
        const inst = await store.getInstrument(group.instrumentId);
        if (!inst) {
          summary.skippedHoldings += 1;
          continue;
        }
        const prices = await loadPrices(store, inst, { getHistory, nowMs, liveMissUntil, missBackoffMs });
        const evaluation = evaluateHolding({
          inst,
          models: group.models,
          historySeries: prices.historySeries,
          navSeries: prices.navSeries,
          today: todayIso,
          historyFetchedAt: prices.historyFetchedAt,
        });
        if (evaluation.skip) {
          summary.skippedHoldings += 1;
          if (evaluation.skip === 'no-price') {
            const prev = await store.getAlertEvent(inst.id);
            if (prev?.status === 'active') {
              await store.upsertAlertEvent({
                ...prev,
                models: group.models,
                lastEvalNote: 'No cached price this check — drawdown not updated',
                updatedAt: nowIso,
              });
            }
          }
          continue;
        }

        summary.evaluated += 1;
        const prev = await store.getAlertEvent(inst.id);
        const step = transitionAlert(prev, evaluation, { thresholdPct: settings.alertThreshold, now: nowIso });
        if (step.action === 'none') continue;

        let next = step.next;
        if (step.action === 'open') {
          summary.opened += 1;
          await store.appendAlertHistory(historyEntry('breach', next, nowIso, next.basisLabel));
        }
        if (step.action === 'recover') {
          summary.recovered += 1;
          await store.appendAlertHistory(historyEntry('recovered', next, nowIso, 'Back above the threshold plus 2 point hysteresis'));
        }

        if (step.shouldEmail) {
          if (!settings.alertEnabled) {
            next = { ...next, notifyStatus: 'pending', notifyDetail: 'pending - alerts disabled', lastNotifiedAt: null };
            summary.pending += 1;
            if (prev?.notifyDetail !== next.notifyDetail) {
              await store.appendAlertHistory(historyEntry('pending', next, nowIso, next.notifyDetail));
            }
          } else {
            const mail = buildAlertEmail(
              { ...evaluation, currentPrice: next.currentPrice, models: next.models },
              { threshold: settings.alertThreshold, appUrl },
            );
            const sent = await email.send({ ...mail, to: settings.alertEmail });
            if (sent.ok) {
              next = { ...next, notifyStatus: 'sent', notifyDetail: null, lastNotifiedAt: nowIso };
              summary.emailed += 1;
              await store.appendAlertHistory(historyEntry('notified', next, nowIso, `Sent to ${settings.alertEmail}`));
            } else {
              const reason = sent.reason || EMAIL_NOT_CONFIGURED;
              next = { ...next, notifyStatus: 'pending', notifyDetail: reason, lastNotifiedAt: null };
              summary.pending += 1;
              if (prev?.notifyDetail !== reason || step.action === 'open') {
                await store.appendAlertHistory(historyEntry('pending', next, nowIso, reason));
              }
            }
          }
        }

        await store.upsertAlertEvent(next);
      } catch (e) {
        summary.errors.push({ instrumentId: group.instrumentId, error: e.message });
      }
    }

    const events = await store.listAlertEvents();
    for (const prev of events) {
      if (prev.status !== 'active') continue;
      if (heldIds.has(prev.instrumentId)) continue;
      const next = {
        ...prev,
        status: 'recovered',
        recoveredAt: nowIso,
        lastEvalNote: 'Removed from current model versions',
        updatedAt: nowIso,
      };
      await store.upsertAlertEvent(next);
      await store.appendAlertHistory(historyEntry('recovered', next, nowIso, next.lastEvalNote));
      summary.recovered += 1;
    }

    const after = await store.listAlertEvents();
    summary.active = after.filter((e) => e.status === 'active').length;
    await store.setAlertCheckMeta({
      at: nowIso,
      error: summary.errors.length ? summary.errors.map((e) => e.error).join('; ') : null,
      summary: { ...summary, errors: summary.errors },
    });
    await persistMisses(nowMs);
    return summary;
  }

  function runCheck() {
    if (inflight) return inflight;
    inflight = runAlertCheck().finally(() => { inflight = null; });
    return inflight;
  }

  async function sendTestEmail() {
    const settings = await store.getAlertSettings();
    const mail = buildTestEmail({ to: settings.alertEmail, appUrl });
    return email.send(mail);
  }

  return { runCheck, sendTestEmail, liveMissUntil };
}
