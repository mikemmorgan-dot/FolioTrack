// alerts/schedule.js — in-process check. An external pinger is still required
// on Render free tier because the process sleeps after ~15 minutes idle and
// this timer sleeps with it. On the next wake, a missed ping is caught up
// when the last run is missing or older than the interval.

export const ALERT_INTERVAL_MS = 30 * 60 * 1000;

/**
 * Milliseconds until the next check. 0 means run now: no last run, an
 * unreadable timestamp, or the last run is already at least one interval old.
 * A newer last run waits out the remainder, capped at one interval.
 */
export function alertRunDelayMs(lastRunAt, nowMs = Date.now(), intervalMs = ALERT_INTERVAL_MS) {
  if (lastRunAt == null || lastRunAt === '') return 0;
  const t = typeof lastRunAt === 'number' ? lastRunAt : Date.parse(String(lastRunAt));
  if (!Number.isFinite(t)) return 0;
  const remaining = intervalMs - (nowMs - t);
  if (remaining <= 0) return 0;
  return Math.min(remaining, intervalMs);
}

export function startAlertScheduler({
  run,
  intervalMs = ALERT_INTERVAL_MS,
  logger = console,
  runOnStart = true,
  lastRunAt = null,
  now = () => Date.now(),
} = {}) {
  if (typeof run !== 'function') throw new Error('startAlertScheduler requires run()');

  const tick = () => {
    Promise.resolve()
      .then(() => run())
      .then((summary) => {
        if (!summary || summary.skipped) return;
        if (summary.started === true) {
          logger.log('[alerts] check started in background');
          return;
        }
        if (summary.alreadyRunning === true) {
          logger.log('[alerts] check already running');
          return;
        }
        logger.log(
          `[alerts] checked ${summary.evaluated ?? 0} holdings, active ${summary.active ?? 0}, emailed ${summary.emailed ?? 0}, pending ${summary.pending ?? 0}`,
        );
      })
      .catch((e) => logger.error(`[alerts] check failed: ${e.message}`));
  };

  const delay = runOnStart ? alertRunDelayMs(lastRunAt, now(), intervalMs) : intervalMs;
  let interval = null;
  let starter = null;

  const armInterval = () => {
    interval = setInterval(tick, intervalMs);
    if (typeof interval.unref === 'function') interval.unref();
  };

  if (delay === 0) {
    tick();
    armInterval();
  } else {
    starter = setTimeout(() => {
      starter = null;
      tick();
      armInterval();
    }, delay);
    if (typeof starter.unref === 'function') starter.unref();
  }

  return () => {
    if (starter) clearTimeout(starter);
    if (interval) clearInterval(interval);
  };
}
