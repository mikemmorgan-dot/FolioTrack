// Daily politician poll, gated on the last successful run stored in the DB.
// An in-memory timer only decides when to look. Every wake reads that
// timestamp: if the backfill is unfinished, work resumes; if the last success
// is 24 hours old, the daily check runs. A restart cannot skip a due check
// or repeat one that just finished.

export const POLITICIAN_INTERVAL_MS = 24 * 60 * 60 * 1000;
export const POLITICIAN_INITIAL_DELAY_MS = 45 * 1000;
export const BACKFILL_RETRY_MS = 15 * 1000;

export function politicianRunDelayMs(
  lastSuccessAt,
  nowMs = Date.now(),
  intervalMs = POLITICIAN_INTERVAL_MS,
  initialDelayMs = POLITICIAN_INITIAL_DELAY_MS,
) {
  const floor = Math.max(0, initialDelayMs);
  if (lastSuccessAt == null || lastSuccessAt === '') return floor;
  const t = typeof lastSuccessAt === 'number' ? lastSuccessAt : Date.parse(String(lastSuccessAt));
  if (!Number.isFinite(t)) return floor;
  const remaining = intervalMs - (nowMs - t);
  if (remaining <= 0) return floor;
  return Math.max(floor, Math.min(remaining, intervalMs));
}

export function nextPollDelayMs({
  backfillComplete = false,
  lastSuccessAt = null,
  nowMs = Date.now(),
  intervalMs = POLITICIAN_INTERVAL_MS,
  initialDelayMs = POLITICIAN_INITIAL_DELAY_MS,
  boot = false,
} = {}) {
  if (!backfillComplete) return boot ? initialDelayMs : BACKFILL_RETRY_MS;
  return politicianRunDelayMs(lastSuccessAt, nowMs, intervalMs, boot ? initialDelayMs : 0);
}

export function startPoliticianScheduler({
  run,
  getState = async () => ({}),
  intervalMs = POLITICIAN_INTERVAL_MS,
  initialDelayMs = POLITICIAN_INITIAL_DELAY_MS,
  logger = console,
  now = () => Date.now(),
} = {}) {
  if (typeof run !== 'function') throw new Error('startPoliticianScheduler requires run()');

  let timer = null;
  let stopped = false;

  const arm = (delay) => {
    if (stopped) return;
    const wait = Math.max(0, delay);
    timer = setTimeout(() => {
      timer = null;
      tick();
    }, wait);
    if (typeof timer.unref === 'function') timer.unref();
  };

  const tick = () => {
    Promise.resolve()
      .then(() => run())
      .catch((e) => logger.error(`[politicians] poll failed: ${e.message}`))
      .then(async () => {
        if (stopped) return null;
        try {
          return await getState();
        } catch (e) {
          logger.error(`[politicians] could not read poll state: ${e.message}`);
          return {};
        }
      })
      .then((state) => {
        if (stopped || state == null) return;
        const delay = nextPollDelayMs({
          backfillComplete: state.backfillComplete === true,
          lastSuccessAt: state.lastSuccessAt || null,
          nowMs: now(),
          intervalMs,
          initialDelayMs,
          boot: false,
        });
        arm(delay);
      })
      .catch((e) => logger.error(`[politicians] scheduler failed: ${e.message}`));
  };

  Promise.resolve()
    .then(() => getState())
    .catch(() => ({}))
    .then((state) => {
      const delay = nextPollDelayMs({
        backfillComplete: state?.backfillComplete === true,
        lastSuccessAt: state?.lastSuccessAt || null,
        nowMs: now(),
        intervalMs,
        initialDelayMs,
        boot: true,
      });
      arm(delay);
    });

  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}
