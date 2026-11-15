// Backlog of annual disclosures. Runs once shortly after boot, then every
// 30 minutes, until the queue is covered. After that it stops. The daily
// politician poll keeps looking for a new or amended filing.

import {
  ANNUAL_BACKFILL_INITIAL_DELAY_MS,
  ANNUAL_BACKFILL_INTERVAL_MS,
} from './annualIngest.js';

export function nextAnnualIngestDelay({
  backfillComplete = false,
  boot = false,
  intervalMs = ANNUAL_BACKFILL_INTERVAL_MS,
  initialDelayMs = ANNUAL_BACKFILL_INITIAL_DELAY_MS,
} = {}) {
  if (backfillComplete) return null;
  return boot ? initialDelayMs : intervalMs;
}

export function startAnnualIngest({
  run,
  getState = async () => ({}),
  intervalMs = ANNUAL_BACKFILL_INTERVAL_MS,
  initialDelayMs = ANNUAL_BACKFILL_INITIAL_DELAY_MS,
  logger = console,
} = {}) {
  if (typeof run !== 'function') throw new Error('startAnnualIngest requires run()');
  let timer = null;
  let stopped = false;

  const arm = (delay) => {
    if (stopped) return;
    timer = setTimeout(() => {
      timer = null;
      tick();
    }, Math.max(0, delay));
    if (typeof timer.unref === 'function') timer.unref();
  };

  const tick = () => {
    Promise.resolve()
      .then(() => run())
      .catch((err) => logger.error(`[annual] ingest failed: ${err.message}`))
      .then(async () => {
        if (stopped) return null;
        try {
          return await getState();
        } catch (err) {
          logger.error(`[annual] could not read ingest state: ${err.message}`);
          return {};
        }
      })
      .then((state) => {
        if (stopped || state == null) return;
        const delay = nextAnnualIngestDelay({
          backfillComplete: state.backfillComplete === true,
          boot: false,
          intervalMs,
          initialDelayMs,
        });
        if (delay == null) {
          logger.log('[annual] backlog covered; new and amended filings stay on the daily poll');
          return;
        }
        arm(delay);
      })
      .catch((err) => logger.error(`[annual] scheduler failed: ${err.message}`));
  };

  Promise.resolve()
    .then(() => getState())
    .catch(() => ({}))
    .then((state) => {
      if (stopped) return;
      const delay = nextAnnualIngestDelay({
        backfillComplete: state?.backfillComplete === true,
        boot: true,
        intervalMs,
        initialDelayMs,
      });
      if (delay == null) {
        logger.log('[annual] backlog covered; new and amended filings stay on the daily poll');
        return;
      }
      arm(delay);
    });

  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}
