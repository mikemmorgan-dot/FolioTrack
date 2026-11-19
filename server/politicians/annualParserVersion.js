// Bump this when an annual parser change can recover filings that were
// stored as needs_manual_review or partial. Existing rows with a lower or
// missing version are re-read once, then stamped so the pass is idempotent.
export const ANNUAL_PARSER_VERSION = 1;
export const STALE_PARSER_STATUSES = Object.freeze(['needs_manual_review', 'partial']);

export const ANNUAL_PARSER_REVISIT_INTERVAL_MS = 60 * 1000;
export const ANNUAL_PARSER_REVISIT_BUDGET_MS = 45 * 1000;
export const ANNUAL_PARSER_REVISIT_CAP = 5;

export function isSenatePaperAnnual(filing) {
  if (filing?.source !== 'senate') return false;
  if (/\/paper\//i.test(String(filing.sourceUrl || ''))) return true;
  return /^Paper annual report/i.test(String(filing.parseNote || ''));
}

export function isStaleParserFiling(filing, parserVersion = ANNUAL_PARSER_VERSION) {
  if (!filing || !STALE_PARSER_STATUSES.includes(filing.parseStatus)) return false;
  const seen = Number(filing.parserVersion);
  if (!Number.isFinite(seen)) return true;
  return seen < parserVersion;
}

// Senate paper (and other Senate annuals) are stamped in place. Paper
// reports stay needs_manual_review and must not be refetched in a loop.
// OCR that already finished is also left in place so it is not reset to
// pending_ocr. House and OGE PDFs are re-downloaded and parsed.
export function shouldRefetchStaleParserFiling(filing) {
  if (!filing?.sourceUrl) return false;
  if (filing.source === 'senate') return false;
  if (filing.ocrDone === true) return false;
  return filing.source === 'house' || filing.source === 'oge';
}

export function formatParserRevisitProgress(summary = {}) {
  return [
    '[annual] parser revisit',
    `version=${summary.version ?? ANNUAL_PARSER_VERSION}`,
    `remaining=${summary.remaining ?? 0}`,
    `stamped=${summary.stamped ?? 0}`,
    `downloaded=${summary.downloaded ?? 0}`,
    `revisited=${summary.revisited ?? 0}`,
    `failed=${summary.failed ?? 0}`,
    `parsed=${summary.parsed ?? 0}`,
    `pending_ocr=${summary.pendingOcr ?? 0}`,
  ].join(' ');
}
