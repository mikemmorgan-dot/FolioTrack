// Knobs for the poll. After the backfill finishes, the check is once a day.
// Until then the backfill keeps going in the background.

export const DEFAULT_MAX_PDF_BYTES = 32 * 1024 * 1024;

export function politicianConfig(env = process.env) {
  const years = Number(env.POLITICIAN_BACKFILL_YEARS);
  const docs = Number(env.POLITICIAN_DOCS_PER_RUN);
  const hours = Number(env.POLITICIAN_POLL_INTERVAL_HOURS);
  const delay = Number(env.POLITICIAN_FETCH_DELAY_MS);
  const maxPdf = Number(env.POLITICIAN_MAX_PDF_BYTES);
  return {
    backfillYears: Number.isFinite(years) && years >= 1 && years <= 5 ? Math.round(years) : 2,
    docsPerRun: Number.isFinite(docs) && docs >= 1 && docs <= 80 ? Math.round(docs) : 12,
    // Daily check. Backfill does not use this interval.
    intervalMs: (Number.isFinite(hours) && hours >= 1 && hours <= 168 ? hours : 24) * 60 * 60 * 1000,
    delayMs: Number.isFinite(delay) && delay >= 0 && delay <= 20000 ? Math.round(delay) : 1200,
    // Largest presidential 278-T measured in Nov 2026 was about 27MB.
    // 32MB keeps those in range and refuses anything larger.
    maxPdfBytes: Number.isFinite(maxPdf) && maxPdf >= 50_000 ? Math.round(maxPdf) : DEFAULT_MAX_PDF_BYTES,
    // How many House/Senate documents one backfill slice stores before it
    // checkpoints and continues. Daily mode uses docsPerRun instead.
    backfillSlice: 25,
    budgetMs: 110_000,
    initialDelayMs: 45_000,
  };
}
