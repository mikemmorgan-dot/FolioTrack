// Knobs for the poll. Defaults are sized for Render's free tier: a few times
// a day, a short batch, and no multi-megabyte scanned PDFs in memory.

export function politicianConfig(env = process.env) {
  const years = Number(env.POLITICIAN_BACKFILL_YEARS);
  const docs = Number(env.POLITICIAN_DOCS_PER_RUN);
  const hours = Number(env.POLITICIAN_POLL_INTERVAL_HOURS);
  const delay = Number(env.POLITICIAN_FETCH_DELAY_MS);
  const maxPdf = Number(env.POLITICIAN_MAX_PDF_BYTES);
  return {
    backfillYears: Number.isFinite(years) && years >= 1 && years <= 5 ? Math.round(years) : 2,
    docsPerRun: Number.isFinite(docs) && docs >= 1 && docs <= 40 ? Math.round(docs) : 12,
    intervalMs: (Number.isFinite(hours) && hours >= 1 && hours <= 48 ? hours : 8) * 60 * 60 * 1000,
    delayMs: Number.isFinite(delay) && delay >= 0 && delay <= 20000 ? Math.round(delay) : 1200,
    maxPdfBytes: Number.isFinite(maxPdf) && maxPdf >= 50_000 ? Math.round(maxPdf) : 1_500_000,
    budgetMs: 110_000,
    initialDelayMs: 45_000,
  };
}
