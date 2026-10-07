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
import { logEgress } from '../egress.js';
import {
  collectCurrentHoldings,
  evaluateFromSnapshot,
  isPriceStale,
  snapshotFromSeries,
} from './drawdown.js';
import { transitionAlert } from './state.js';
import { buildAlertEmail, buildTestEmail, EMAIL_NOT_CONFIGURED, FOLIOTRACK_URL } from './email.js';
import {
  ALERT_REFRESH_CAP,
  BREACH_PENDING_FRESH,
  describeBackoffHold,
  isRefreshableAutoHolding,
  refreshOneAutoHolding,
  splitRefreshCandidates,
} from './refresh.js';
import { ALERT_RUN_BUDGET_MS } from './runner.js';
import { normalizeMissRecord } from './missBackoff.js';
import { createRunFetchDedupe, withYahooRun } from '../yahooQueue.js';

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
  refreshCap = ALERT_REFRESH_CAP,
} = {}) {
  if (!store) throw new Error('createAlertService requires a store');
  if (!email?.send) throw new Error('createAlertService requires an email sender');

  const liveMissUntil = new Map();

  async function hydrateMisses(nowMs) {
    if (typeof store.getAlertMissUntil !== 'function') return;
    const raw = await store.getAlertMissUntil();
    for (const [sym, value] of Object.entries(raw || {})) {
      const rec = normalizeMissRecord(value, nowMs);
      if (rec) liveMissUntil.set(String(sym).toUpperCase(), rec);
    }
  }

  async function persistMisses(nowMs) {
    if (typeof store.setAlertMissUntil !== 'function') return;
    const obj = {};
    const keepAfter = nowMs - (7 * 24 * 60 * 60 * 1000);
    for (const [sym, rec] of liveMissUntil) {
      if (!rec || rec.until < keepAfter) continue;
      obj[sym] = {
        until: new Date(rec.until).toISOString(),
        strikes: rec.strikes || 0,
        reason: rec.reason || 'total-miss',
      };
    }
    await store.setAlertMissUntil(obj);
  }

  // Latest close + 52-week high (or the NAV peak). Not the daily rows.
  async function readSnapshot(inst) {
    if (typeof store.getAlertSnapshot === 'function') {
      return store.getAlertSnapshot(inst.id, inst.symbol);
    }
    const navSeries = store.getNavSeries ? await store.getNavSeries(inst.id) : [];
    const navSnap = snapshotFromSeries({ navSeries });
    if (navSnap.navCount > 0) {
      return { ...navSnap, price: null, priceCount: 0, priceLastClose: null, historyFetchedAt: null };
    }
    let historySeries = [];
    let historyFetchedAt = null;
    if (store.getPriceHistory) {
      const stored = await store.getPriceHistory(inst.symbol);
      historySeries = stored?.series || [];
      historyFetchedAt = stored?.fetchedAt || null;
    }
    return snapshotFromSeries({ historySeries, historyFetchedAt });
  }

  async function peekHolding(group) {
    const inst = typeof store.getInstrumentCore === 'function'
      ? await store.getInstrumentCore(group.instrumentId)
      : await store.getInstrument(group.instrumentId);
    if (!inst) return { group, inst: null };
    const snap = await readSnapshot(inst);
    const refreshable = isRefreshableAutoHolding(
      inst,
      snap.navCount > 0 ? { hasUsableNav: true } : [],
    );
    return {
      group,
      inst,
      refreshable,
      lastClose: refreshable ? (snap.priceLastClose || null) : null,
      pointCount: refreshable ? (snap.priceCount || 0) : 0,
      snap,
    };
  }

  async function loadEvalContext(peek, refreshed) {
    if (!peek?.inst) return null;
    const { inst, group } = peek;
    let snap = peek.snap;
    let historyFetchedAt = snap?.historyFetchedAt || null;
    const fresh = refreshed?.get(inst.id);
    if (fresh) {
      refreshed.delete(inst.id);
      if (fresh.series?.length) {
        const over = snapshotFromSeries({
          historySeries: fresh.series,
          historyFetchedAt: fresh.fetchedAt || null,
        });
        snap = {
          ...snap,
          price: over.price,
          priceCount: over.priceCount,
          priceLastClose: over.priceLastClose,
          historyFetchedAt: fresh.fetchedAt || over.historyFetchedAt,
        };
        historyFetchedAt = fresh.fetchedAt || null;
      } else if (typeof store.getAlertSnapshot === 'function') {
        snap = await store.getAlertSnapshot(inst.id, inst.symbol);
        historyFetchedAt = fresh.fetchedAt || snap?.historyFetchedAt || null;
      }
    }
    return {
      group,
      inst,
      snap,
      historyFetchedAt,
      refreshable: !!peek.refreshable,
    };
  }

  function missActive(symbol, nowMs) {
    const rec = liveMissUntil.get(String(symbol || '').toUpperCase());
    return !!(rec && nowMs < rec.until);
  }

  async function refreshStaleAutoPrices(peeks, {
    nowMs,
    todayIso,
    cap = refreshCap,
    ensureBudget,
    bypassMissBackoff = false,
  } = {}) {
    const candidates = peeks
      .filter((p) => p?.inst)
      .map((p) => ({
        instrumentId: p.inst.id,
        symbol: p.inst.symbol,
        name: p.inst.name,
        refreshable: p.refreshable,
        lastClose: p.lastClose,
      }));

    const { eligible, cooling } = splitRefreshCandidates(candidates, {
      today: todayIso,
      isCooling: (c) => !bypassMissBackoff && missActive(c.symbol, nowMs),
    });
    const plan = eligible.slice(0, Math.max(0, Number(cap) || 0));
    const deferred = eligible.slice(Math.max(0, Number(cap) || 0));
    const byId = new Map(peeks.filter((p) => p?.inst).map((p) => [p.inst.id, p]));
    const fetchHistory = typeof getHistory === 'function' ? createRunFetchDedupe(getHistory) : getHistory;
    const results = [];
    // Only the capped refresh set (default 8) keeps a series, and each one is
    // dropped after that holding is evaluated.
    const refreshed = new Map();

    await withYahooRun(async () => {
      for (const row of plan) {
        if (ensureBudget) ensureBudget();
        const peek = byId.get(row.instrumentId);
        if (!peek?.inst) continue;
        const result = await refreshOneAutoHolding(peek.inst, {
          getHistory: fetchHistory,
          getPriceHistory: peek.pointCount != null
            ? null
            : (store.getPriceHistory ? (s) => store.getPriceHistory(s) : null),
          lastClose: peek.lastClose,
          pointCount: peek.pointCount,
          nowMs,
          liveMissUntil,
          bypassMissBackoff,
        });
        if (result.status === 'updated' || result.status === 'unchanged') {
          refreshed.set(peek.inst.id, {
            series: result.series?.length ? result.series : null,
            fetchedAt: result.fetchedAt || null,
          });
        }
        const { series, ...publicResult } = result;
        results.push(publicResult);
      }
    });

    for (const row of cooling) {
      const rec = liveMissUntil.get(String(row.symbol || '').toUpperCase());
      const described = describeBackoffHold({
        symbol: row.symbol,
        instrumentId: row.instrumentId,
        lastClose: row.lastClose,
        rec,
      });
      const { series, ...publicResult } = described;
      results.push(publicResult);
    }

    for (const row of deferred) {
      results.push({
        symbol: String(row.symbol || '').toUpperCase(),
        instrumentId: row.instrumentId,
        status: 'skipped',
        error: 'Over per-run refresh cap — will retry next run',
        lastClose: row.lastClose || null,
        priceAsOf: row.lastClose || null,
        line: `${String(row.symbol || '').toUpperCase()}: skipped — Over per-run refresh cap — will retry next run`,
      });
    }

    return {
      attempted: plan.length,
      cap,
      results,
      updated: results.filter((r) => r.status === 'updated').length,
      failed: results.filter((r) => r.status === 'failed' || r.status === 'cooldown').length,
      skipped: results.filter((r) => r.status === 'skipped').length,
      refreshed,
    };
  }

  async function evaluateContexts(contexts, { nowIso, todayIso, settings, summary }) {
    for (const ctx of contexts) {
      if (!ctx) {
        summary.skippedHoldings += 1;
        continue;
      }
      try {
        const { inst, group, snap, historyFetchedAt } = ctx;
        const evaluation = evaluateFromSnapshot({
          inst,
          models: group.models,
          snap,
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

  async function previousSuccessAt() {
    if (typeof store.getAlertCheckMeta !== 'function') return null;
    try {
      const prev = await store.getAlertCheckMeta();
      if (!prev) return null;
      if (prev.lastSuccessAt) return prev.lastSuccessAt;
      if (!prev.last_error && !prev.error && prev.at) return prev.at;
      return null;
    } catch {
      return null;
    }
  }

  async function runAlertCheck(opts) {
    try {
      return await runAlertCheckBody(opts);
    } finally {
      logEgress('alert-check');
    }
  }

  async function runAlertCheckBody({
    refresh = true,
    deadline = null,
    isCurrent = null,
    budgetMs = ALERT_RUN_BUDGET_MS,
    bypassMissBackoff = false,
  } = {}) {
    const startedMs = Date.now();
    const limit = Number.isFinite(deadline) ? deadline : startedMs + budgetMs;
    const nowDate = now();
    const nowIso = nowDate.toISOString();
    const nowMs = nowDate.getTime();
    const todayIso = today();

    const ensureBudget = () => {
      if (typeof isCurrent === 'function' && !isCurrent()) {
        const err = new Error('Alert check superseded');
        err.code = 'ALERT_SUPERSEDED';
        throw err;
      }
      if (Date.now() > limit) {
        const err = new Error(`Alert check exceeded ${budgetMs}ms budget`);
        err.code = 'ALERT_BUDGET';
        throw err;
      }
    };

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
      alertsEnabled: null,
      errors: [],
      refresh: null,
    };

    try {
      ensureBudget();
      await hydrateMisses(nowMs);
      const settings = await store.getAlertSettings();
      summary.alertsEnabled = settings.alertEnabled;
      const models = await store.listModels();
      const groups = collectCurrentHoldings(models);
      const heldIds = new Set(groups.map((g) => g.instrumentId));

      const peeks = [];
      for (const group of groups) {
        ensureBudget();
        peeks.push(await peekHolding(group));
      }

      let refreshed = null;
      if (refresh) {
        const refreshState = await refreshStaleAutoPrices(peeks, {
          nowMs, todayIso, cap: refreshCap, ensureBudget, bypassMissBackoff,
        });
        refreshed = refreshState.refreshed;
        summary.refresh = {
          attempted: refreshState.attempted,
          cap: refreshState.cap,
          results: refreshState.results,
          updated: refreshState.updated,
          failed: refreshState.failed,
          skipped: refreshState.skipped,
        };
      }

      for (const peek of peeks) {
        ensureBudget();
        const ctx = await loadEvalContext(peek, refreshed);
        await evaluateContexts([ctx], { nowIso, todayIso, settings, summary });
        if (ctx) ctx.snap = null;
      }
      refreshed?.clear();

      ensureBudget();
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
      const durationMs = Date.now() - startedMs;
      summary.durationMs = durationMs;
      const holdingError = summary.errors.length ? summary.errors.map((e) => e.error).join('; ') : null;
      await store.setAlertCheckMeta({
        at: nowIso,
        durationMs,
        error: holdingError,
        last_error: holdingError,
        lastSuccessAt: nowIso,
        summary: { ...summary, errors: summary.errors },
      });
      await persistMisses(nowMs);
      return summary;
    } catch (e) {
      if (e?.code === 'ALERT_SUPERSEDED') throw e;
      summary.ok = false;
      summary.error = e.message;
      const durationMs = Date.now() - startedMs;
      summary.durationMs = durationMs;
      try {
        const lastSuccessAt = await previousSuccessAt();
        await store.setAlertCheckMeta({
          at: new Date().toISOString(),
          durationMs,
          error: e.message,
          last_error: e.message,
          lastSuccessAt,
          summary: { ...summary, ok: false, error: e.message },
        });
      } catch {
        // The coordinator still records last_error. A persist failure must not crash the process.
      }
      throw e;
    }
  }

  function runCheck(opts) {
    return runAlertCheck(opts || {});
  }

  /** Refresh stale auto prices and report per-holding results (also re-checks alerts).
   *  Always bypasses the per-holding total-miss timer. Provider cooldowns stay. */
  function refreshPricesNow(opts) {
    return runCheck({ ...(opts || {}), refresh: true, bypassMissBackoff: true });
  }

  async function sendTestEmail() {
    const settings = await store.getAlertSettings();
    const mail = buildTestEmail({ to: settings.alertEmail, appUrl });
    return email.send(mail);
  }

  return { runCheck, refreshPricesNow, sendTestEmail, liveMissUntil };
}
