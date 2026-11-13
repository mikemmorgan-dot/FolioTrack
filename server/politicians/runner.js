// One politician job at a time, off the request thread. Backfill can run for
// hours, so the lock is not released on a short timer. A process restart
// clears it and the DB cursor resumes the work. /api/health never enters here.

export const POLITICIAN_LOCK_MS = 6 * 60 * 60 * 1000;

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
  let idleWaiters = [];

  function settle() {
    const waiters = idleWaiters;
    idleWaiters = [];
    for (const resolve of waiters) resolve();
  }

  function whenIdle() {
    if (!running) return Promise.resolve();
    return new Promise((resolve) => idleWaiters.push(resolve));
  }

  function start({ force = false } = {}) {
    const t = now();
    if (running && (t - startedAt) > lockTimeoutMs) {
      logger.warn('[politicians] releasing a poll that passed the lock timeout');
      running = false;
      settle();
    }
    if (running) return { started: false, alreadyRunning: true, runId };
    running = true;
    startedAt = t;
    runId += 1;
    const id = runId;
    Promise.resolve()
      .then(() => runJob({ force }))
      .catch((err) => logger.error(`[politicians] poll crashed: ${err.message}`))
      .finally(() => {
        if (id === runId) {
          running = false;
          settle();
        }
      });
    return { started: true, alreadyRunning: false, runId: id };
  }

  return {
    start,
    whenIdle,
    running: () => running,
  };
}
