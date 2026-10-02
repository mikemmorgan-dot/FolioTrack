// alerts/schedule.js — in-process check. An external pinger is still required
// on Render free tier because the process sleeps after ~15 minutes idle and
// this timer sleeps with it.

export const ALERT_INTERVAL_MS = 30 * 60 * 1000;

export function startAlertScheduler({
  run,
  intervalMs = ALERT_INTERVAL_MS,
  logger = console,
  runOnStart = true,
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

  if (runOnStart) tick();
  const timer = setInterval(tick, intervalMs);
  if (typeof timer.unref === 'function') timer.unref();
  return () => clearInterval(timer);
}
