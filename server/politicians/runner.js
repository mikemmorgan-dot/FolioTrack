// One politician poll at a time, off the request thread. A hung run releases
// the lock so the next wake can try again. /api/health never enters here.

export const POLITICIAN_LOCK_MS = 150 * 1000;

export function createPoliticianCoordinator({
  runJob,
  lockTimeoutMs = POLITICIAN_LOCK_MS,
  now = () => Date.now(),
  logger = console,
} = {}) {
  if (typeof runJob !== 'function') throw new Error('createPoliticianCoordinator requires runJob()');
  let running = false;
  let startedAt = 0;
  let runId = 0;

  function start() {
    const t = now();
    if (running && (t - startedAt) > lockTimeoutMs) {
      logger.warn('[politicians] releasing a poll that passed the lock timeout');
      running = false;
    }
    if (running) return { started: false, alreadyRunning: true, runId };
    running = true;
    startedAt = t;
    runId += 1;
    const id = runId;
    Promise.resolve()
      .then(() => runJob())
      .catch((err) => logger.error(`[politicians] poll crashed: ${err.message}`))
      .finally(() => {
        if (id === runId) running = false;
      });
    return { started: true, alreadyRunning: false, runId: id };
  }

  return {
    start,
    running: () => running,
  };
}
