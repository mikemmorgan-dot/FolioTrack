// In-process politician poll. Same shape as the price-alert timer: it sleeps
// when the Render free tier sleeps, and a wake whose last run is already due
// catches up. The first wait is at least `initialDelayMs` so the job does not
// run beside port bind or /api/health.

export const POLITICIAN_INTERVAL_MS = 8 * 60 * 60 * 1000;
export const POLITICIAN_INITIAL_DELAY_MS = 45 * 1000;

export function politicianRunDelayMs(
  lastRunAt,
  nowMs = Date.now(),
  intervalMs = POLITICIAN_INTERVAL_MS,
  initialDelayMs = POLITICIAN_INITIAL_DELAY_MS,
) {
  const floor = Math.max(0, initialDelayMs);
  if (lastRunAt == null || lastRunAt === '') return floor;
  const t = typeof lastRunAt === 'number' ? lastRunAt : Date.parse(String(lastRunAt));
  if (!Number.isFinite(t)) return floor;
  const remaining = intervalMs - (nowMs - t);
  if (remaining <= 0) return floor;
  return Math.max(floor, Math.min(remaining, intervalMs));
}

export function startPoliticianScheduler({
  run,
  intervalMs = POLITICIAN_INTERVAL_MS,
  initialDelayMs = POLITICIAN_INITIAL_DELAY_MS,
  logger = console,
  lastRunAt = null,
  now = () => Date.now(),
} = {}) {
  if (typeof run !== 'function') throw new Error('startPoliticianScheduler requires run()');

  const tick = () => {
    Promise.resolve()
      .then(() => run())
      .then((summary) => {
        if (!summary || summary.skipped) return;
        if (summary.started === true) {
          logger.log('[politicians] poll started in background');
          return;
        }
        if (summary.alreadyRunning === true) {
          logger.log('[politicians] poll already running');
        }
      })
      .catch((e) => logger.error(`[politicians] poll failed: ${e.message}`));
  };

  const delay = politicianRunDelayMs(lastRunAt, now(), intervalMs, initialDelayMs);
  let interval = null;
  const starter = setTimeout(() => {
    tick();
    interval = setInterval(tick, intervalMs);
    if (typeof interval.unref === 'function') interval.unref();
  }, delay);
  if (typeof starter.unref === 'function') starter.unref();

  return () => {
    clearTimeout(starter);
    if (interval) clearInterval(interval);
  };
}
