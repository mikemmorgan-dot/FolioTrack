// alerts/check.js — evaluate every current holding and advance alert state.
//
// Auto-priced stock/ETF holdings (no NAV series) whose last close is more
// than about one trading day old are refreshed through the history cache
// before drawdown runs — oldest first, capped per run. Manual NAV, Cash,
// and private/alt names are never refreshed. Live quote points appended by
// the cache are labeled as today's close.
//
// A breach based on closes older than 5 days does not send email; it is
// stored as "breach pending fresh data" and retried next run. Fresh data
// that no longer breaches recovers without another email.

import { uid } from '../util.js';
import { todayToronto } from '../nav.js';
import { decidePricePath } from '../navPrice.js';
import { lastCloseNeedsRefresh, lastCloseDate } from '../historyCache.js';
import { collectCurrentHoldings, evaluateHolding, isPriceStale } from './drawdown.js';
import { transitionAlert } from './state.js';
import { buildAlertEmail, buildTestEmail, EMAIL_NOT_CONFIGURED, FOLIOTRACK_URL } from './email.js';
import {
  ALERT_REFRESH_CAP,
  BREACH_PENDING_FRESH,
  isRefreshableAutoHolding,
  planAutoPriceRefresh,
  refreshOneAutoHolding,
} from './refresh.js';

export const ALERT_MISS_BACKOFF_MS = 6 * 60 * 60 * 1000;
export { ALERT_REFRESH_CAP, BREACH_PENDING_FRESH };

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
  refreshCap = ALERT_REFRESH_CAP,
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

  async function loadHoldingContext(group) {
    const inst = await store.getInstrument(group.instrumentId);
    if (!inst) return null;
    const stored = store.getPriceHistory ? await store.getPriceHistory(inst.symbol) : null;
    const navSeries = store.getNavSeries ? await store.getNavSeries(inst.id) : [];
    const path = decidePricePath(inst, navSeries || []);
    // NAV-backed instruments (manual or auto-with-NAV) use nav_series only —
    // never prefer a frozen leftover price_history over entered NAV.
    const useNav = path.path === 'nav_series' && path.series.length > 0;
    return {
      group,
      inst,
      historySeries: useNav ? [] : (stored?.series || []),
      historyFetchedAt: useNav ? null : (stored?.fetchedAt || null),
      navSeries: navSeries || [],
      refreshable: isRefreshableAutoHolding(inst, navSeries),
    };
  }

  async function refreshStaleAutoPrices(contexts, { nowMs, todayIso, cap = refreshCap } = {}) {
    const candidates = contexts
      .filter(Boolean)
      .map((c) => ({
        instrumentId: c.inst.id,
        symbol: c.inst.symbol,
        name: c.inst.name,
        refreshable: c.refreshable,
        historySeries: c.historySeries,
      }));

    const plan = planAutoPriceRefresh(candidates, { today: todayIso, cap });
    const byId = new Map(contexts.filter(Boolean).map((c) => [c.inst.id, c]));
    const results = [];

    for (const row of plan) {
      const ctx = byId.get(row.instrumentId);
      if (!ctx) continue;
      const result = await refreshOneAutoHolding(ctx.inst, {
        getHistory,
        getPriceHistory: store.getPriceHistory ? (s) => store.getPriceHistory(s) : null,
        nowMs,
        liveMissUntil,
        missBackoffMs,
      });
      results.push(result);
      if (result.series?.length && (result.status === 'updated' || result.status === 'unchanged')) {
        ctx.historySeries = result.series;
        ctx.historyFetchedAt = result.fetchedAt || ctx.historyFetchedAt;
      } else if (result.status === 'failed' || result.status === 'cooldown') {
        // Re-read store in case a quote-append from another path landed.
        if (store.getPriceHistory) {
          const stored = await store.getPriceHistory(ctx.inst.symbol);
          if (stored?.series?.length) {
            ctx.historySeries = stored.series;
            ctx.historyFetchedAt = stored.fetchedAt || ctx.historyFetchedAt;
          }
        }
      }
    }

    // Holdings not in the capped plan that still need refresh: report skipped.
    const planned = new Set(plan.map((p) => p.instrumentId));
    for (const c of candidates) {
      if (!c.refreshable) continue;
      if (planned.has(c.instrumentId)) continue;
      const lastClose = lastCloseDate(c.historySeries);
      if (!lastCloseNeedsRefresh(lastClose, todayIso)) continue;
      results.push({
        symbol: String(c.symbol || '').toUpperCase(),
        instrumentId: c.instrumentId,
        status: 'skipped',
        error: 'Over per-run refresh cap — will retry next run',
        lastClose: lastClose || null,
        priceAsOf: lastClose || null,
      });
    }

    return {
      attempted: plan.length,
      cap,
      results,
      updated: results.filter((r) => r.status === 'updated').length,
      failed: results.filter((r) => r.status === 'failed' || r.status === 'cooldown').length,
      skipped: results.filter((r) => r.status === 'skipped').length,
    };
  }

  async function evaluateContexts(contexts, { nowIso, todayIso, settings, summary }) {
    for (const ctx of contexts) {
      if (!ctx) {
        summary.skippedHoldings += 1;
        continue;
      }
      try {
        const { inst, group, historySeries, navSeries, historyFetchedAt } = ctx;
        const evaluation = evaluateHolding({
          inst,
          models: group.models,
          historySeries,
          navSeries,
          today: todayIso,
          historyFetchedAt,
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

        // Could not refresh and close is old → surface Data stale; never email
        // a new breach on data older than 5 days.
        if (evaluation.stale && ctx.refreshable) {
          evaluation.lastEvalNote = 'Data stale';
        }

        summary.evaluated += 1;
        const prev = await store.getAlertEvent(inst.id);
        const step = transitionAlert(prev, evaluation, { thresholdPct: settings.alertThreshold, now: nowIso });
        if (step.action === 'none') continue;

        let next = {
          ...step.next,
          lastEvalNote: evaluation.lastEvalNote || step.next.lastEvalNote || null,
        };

        if (step.action === 'open') {
          summary.opened += 1;
          await store.appendAlertHistory(historyEntry('breach', next, nowIso, next.basisLabel));
        }
        if (step.action === 'recover') {
          summary.recovered += 1;
          await store.appendAlertHistory(historyEntry('recovered', next, nowIso, 'Back above the threshold plus 2 point hysteresis'));
        }

        const staleBlocksEmail = step.shouldEmail && evaluation.stale && isPriceStale(evaluation.priceAsOf, todayIso);

        if (staleBlocksEmail) {
          next = {
            ...next,
            notifyStatus: 'pending',
            notifyDetail: BREACH_PENDING_FRESH,
            lastNotifiedAt: prev?.status === 'active' ? (prev.lastNotifiedAt || null) : null,
            lastEvalNote: 'Data stale',
            stale: true,
          };
          summary.pending += 1;
          if (prev?.notifyDetail !== BREACH_PENDING_FRESH || step.action === 'open') {
            await store.appendAlertHistory(historyEntry('pending', next, nowIso, BREACH_PENDING_FRESH));
          }
        } else if (step.shouldEmail) {
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
        } else if (evaluation.stale && next.status === 'active') {
          next = { ...next, lastEvalNote: next.lastEvalNote || 'Data stale', stale: true };
        }

        await store.upsertAlertEvent(next);
      } catch (e) {
        summary.errors.push({ instrumentId: ctx.group?.instrumentId, error: e.message });
      }
    }
  }

  async function runAlertCheck({ refresh = true } = {}) {
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
      refresh: null,
    };

    const contexts = [];
    for (const group of groups) {
      contexts.push(await loadHoldingContext(group));
    }

    if (refresh) {
      summary.refresh = await refreshStaleAutoPrices(contexts, { nowMs, todayIso, cap: refreshCap });
    }

    await evaluateContexts(contexts, { nowIso, todayIso, settings, summary });

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

  function runCheck(opts) {
    if (inflight) return inflight;
    inflight = runAlertCheck(opts).finally(() => { inflight = null; });
    return inflight;
  }

  /** Refresh stale auto prices and report per-holding results (also re-checks alerts). */
  async function refreshPricesNow() {
    return runCheck({ refresh: true });
  }

  async function sendTestEmail() {
    const settings = await store.getAlertSettings();
    const mail = buildTestEmail({ to: settings.alertEmail, appUrl });
    return email.send(mail);
  }

  return { runCheck, refreshPricesNow, sendTestEmail, liveMissUntil };
}
