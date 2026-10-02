// alerts/runner.js — start an alert check without holding the HTTP request open.
// One run at a time. A hung run releases the lock after lockTimeoutMs so a
// later ping can start again. Failures are stored on the check meta and never
// escape as an unhandled rejection.

export const ALERT_RUN_BUDGET_MS = 90 * 1000;
export const ALERT_LOCK_TIMEOUT_MS = 95 * 1000;
export const ALERT_SUCCESS_STALE_MS = 2 * 60 * 60 * 1000;

export function isAlertCheckStale(lastSuccessAt, nowMs = Date.now(), staleMs = ALERT_SUCCESS_STALE_MS) {
  if (!lastSuccessAt) return true;
  const t = Date.parse(lastSuccessAt);
  if (!Number.isFinite(t)) return true;
  return nowMs - t > staleMs;
}

export function summarizeAlertResult(result) {
  if (!result || typeof result !== 'object') return null;
  const holdingError = Array.isArray(result.errors) && result.errors.length
    ? result.errors.map((e) => e?.error || e?.message).filter(Boolean).join('; ')
    : null;
  const refresh = result.refresh
    ? {
        attempted: result.refresh.attempted ?? 0,
        cap: result.refresh.cap ?? null,
        updated: result.refresh.updated ?? 0,
        failed: result.refresh.failed ?? 0,
        skipped: result.refresh.skipped ?? 0,
        results: (result.refresh.results || []).map((row) => {
          if (!row || typeof row !== 'object') return row;
          const { series, ...rest } = row;
          return rest;
        }),
      }
    : null;
  return {
    ok: result.ok !== false,
    checkedAt: result.checkedAt || null,
    evaluated: result.evaluated ?? null,
    skippedHoldings: result.skippedHoldings ?? null,
    opened: result.opened ?? null,
    recovered: result.recovered ?? null,
    emailed: result.emailed ?? null,
    pending: result.pending ?? null,
    active: result.active ?? null,
    durationMs: result.durationMs ?? null,
    error: result.error || holdingError,
    refresh,
  };
}

function mb(n) {
  return `${Math.round((Number(n) || 0) / 1048576)}MB`;
}

export function createAlertCoordinator({
  store = null,
  runJob,
  budgetMs = ALERT_RUN_BUDGET_MS,
  lockTimeoutMs = ALERT_LOCK_TIMEOUT_MS,
  now = () => Date.now(),
  schedule = (fn, ms) => setTimeout(fn, ms),
  clearSchedule = (id) => clearTimeout(id),
  logger = console,
  memoryUsage = () => process.memoryUsage(),
} = {}) {
  if (typeof runJob !== 'function') throw new Error('createAlertCoordinator requires runJob()');

  let generation = 0;
  let running = false;
  let runningId = 0;
  let startedAtMs = 0;
  let lastRunAt = null;
  let lastDurationMs = null;
  let lastError = null;
  let lastSuccessAt = null;
  let lastResult = null;
  let finishedRunId = 0;
  let idleWaiters = [];

  function publicStatus() {
    return {
      running,
      runId: running ? runningId : finishedRunId,
      finishedRunId,
      lastRunAt,
      lastDurationMs,
      lastError,
      lastSuccessAt,
      lastResult,
      checkStale: isAlertCheckStale(lastSuccessAt, now()),
    };
  }

  function ack(started, id) {
    return {
      started,
      alreadyRunning: !started,
      runId: id,
      lastRunAt,
      lastResult,
    };
  }

  function settleIdle() {
    if (running) return;
    const waiters = idleWaiters;
    idleWaiters = [];
    for (const resolve of waiters) resolve(publicStatus());
  }

  function whenIdle() {
    if (!running) return Promise.resolve(publicStatus());
    return new Promise((resolve) => {
      idleWaiters.push(resolve);
    });
  }

  async function persist(meta) {
    if (typeof store?.setAlertCheckMeta !== 'function') return;
    try {
      await store.setAlertCheckMeta(meta);
    } catch (e) {
      logger.error(`[alerts] could not record check: ${e.message}`);
    }
  }

  function logRun(durationMs, before, after, error) {
    const heap = after?.heapUsed ?? 0;
    const rss = after?.rss ?? 0;
    const delta = before ? heap - (before.heapUsed || 0) : 0;
    logger.log(
      `[alerts] run ${error ? 'failed' : 'ok'} durationMs=${durationMs} heap=${mb(heap)} rss=${mb(rss)} heapDelta=${mb(delta)}${error ? ` error=${error}` : ''}`,
    );
  }

  async function hydrate() {
    if (typeof store?.getAlertCheckMeta !== 'function') return publicStatus();
    try {
      const meta = await store.getAlertCheckMeta();
      if (meta) {
        lastRunAt = meta.at || null;
        lastDurationMs = Number.isFinite(meta.durationMs) ? meta.durationMs : null;
        lastError = meta.last_error || meta.error || null;
        lastSuccessAt = meta.lastSuccessAt
          || (!lastError && meta.at ? meta.at : null);
        lastResult = meta.summary || null;
      }
    } catch (e) {
      logger.error(`[alerts] could not read last check: ${e.message}`);
    }
    return publicStatus();
  }

  async function finishLocked(myGen, id, beforeMem, timer, apply) {
    if (myGen !== generation) return;
    clearSchedule(timer);
    try {
      await apply();
    } finally {
      if (myGen === generation) {
        running = false;
        finishedRunId = id;
        settleIdle();
      }
    }
  }

  function forceRelease(myGen, id, beforeMem, timer) {
    if (myGen !== generation) return;
    const durationMs = Math.max(0, now() - startedAtMs);
    const error = `Alert check exceeded ${lockTimeoutMs}ms lock timeout`;
    logger.warn(`[alerts] ${error} — releasing lock`);
    // Invalidate before the persist so a new start() is not blocked by the hung run.
    generation += 1;
    if (timer != null) clearSchedule(timer);
    const checkedAt = new Date(now()).toISOString();
    lastError = error;
    lastRunAt = checkedAt;
    lastDurationMs = durationMs;
    lastResult = {
      ok: false,
      error,
      checkedAt,
      durationMs,
      evaluated: null,
      active: null,
      refresh: null,
    };
    running = false;
    finishedRunId = id;
    logRun(durationMs, beforeMem, memoryUsage(), error);
    void persist({
      at: checkedAt,
      durationMs,
      error,
      last_error: error,
      lastSuccessAt,
      summary: lastResult,
    }).finally(() => settleIdle());
  }

  function start({ refresh = true, kind = 'check', bypassMissBackoff = false } = {}) {
    const t = now();
    if (running && (t - startedAtMs) > lockTimeoutMs) {
      forceRelease(generation, runningId, null, null);
    }
    if (running) return ack(false, runningId);

    generation += 1;
    const myGen = generation;
    runningId += 1;
    const id = runningId;
    running = true;
    startedAtMs = t;
    const beforeMem = memoryUsage();
    const timer = schedule(() => forceRelease(myGen, id, beforeMem, timer), lockTimeoutMs);

    const job = (async () => {
      try {
        const result = await runJob({
          refresh,
          kind,
          bypassMissBackoff: !!bypassMissBackoff,
          budgetMs,
          deadline: now() + budgetMs,
          isCurrent: () => myGen === generation,
        });
        if (myGen !== generation) return;
        const durationMs = Math.max(0, now() - startedAtMs);
        const summary = summarizeAlertResult(result) || {
          ok: true,
          checkedAt: new Date(now()).toISOString(),
        };
        summary.durationMs = durationMs;
        const failed = result?.ok === false;
        const errorText = failed
          ? (result?.error || summary.error || 'Alert check failed')
          : (summary.error || null);
        lastError = errorText || null;
        lastResult = { ...summary, ok: !failed, error: errorText, durationMs };
        lastRunAt = result?.checkedAt || new Date(now()).toISOString();
        lastDurationMs = durationMs;
        if (!failed) lastSuccessAt = lastRunAt;
        logRun(durationMs, beforeMem, memoryUsage(), failed ? lastError : null);
        await finishLocked(myGen, id, beforeMem, timer, () => persist({
          at: lastRunAt,
          durationMs,
          error: lastError,
          last_error: lastError,
          lastSuccessAt,
          summary: lastResult,
        }));
      } catch (e) {
        if (myGen !== generation) return;
        if (e?.code === 'ALERT_SUPERSEDED') return;
        const durationMs = Math.max(0, now() - startedAtMs);
        const error = e?.message || 'Alert check failed';
        lastError = error;
        lastRunAt = new Date(now()).toISOString();
        lastDurationMs = durationMs;
        lastResult = {
          ok: false,
          error,
          checkedAt: lastRunAt,
          durationMs,
          evaluated: null,
          active: null,
          refresh: null,
        };
        logRun(durationMs, beforeMem, memoryUsage(), error);
        await finishLocked(myGen, id, beforeMem, timer, () => persist({
          at: lastRunAt,
          durationMs,
          error,
          last_error: error,
          lastSuccessAt,
          summary: lastResult,
        }));
      }
    })();

    job.catch((e) => logger.error(`[alerts] background run crashed: ${e.message}`));
    return ack(true, id);
  }

  return { start, status: publicStatus, hydrate, whenIdle };
}
