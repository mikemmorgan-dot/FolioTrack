// Presidential 278-Ts that this host cannot OCR stay pending for the
// GitHub Actions job. A fresh claim means another worker is reading the PDF.

export const PENDING_OCR_STATUS = 'pending_ocr';
export const OCR_RUNNING_STATUS = 'ocr_running';
export const OCR_CLAIM_MS = 3 * 60 * 60 * 1000;

export const TOOLS_MISSING_NOTE = 'Scanned 278-T. OCR tools are not installed on this host, so no rows were guessed.';
export const PENDING_OCR_NOTE = 'Pending OCR. This host has no tesseract, so the 278-T is left for the scheduled GitHub Actions job. No rows were guessed.';
// Written when a presidential PDF could not be read. The apostrophe is
// U+2019, matching the rows the failed job already stored.
export const OCR_FAILED_NOTE = 'The 278-T could not be OCR\u2019d, so no rows were guessed.';

export function toolsMissingFiling(filing) {
  return /OCR tools are not installed/.test(filing?.parseNote || '');
}

export function isOgePdfUrl(url) {
  return /\$FILE|%24FILE/i.test(String(url || ''));
}

export function claimFresh(filing, nowMs = Date.now(), staleMs = OCR_CLAIM_MS) {
  if (!filing || filing.parseStatus !== OCR_RUNNING_STATUS) return false;
  const at = Date.parse(filing.ocrClaimedAt || '');
  if (!Number.isFinite(at)) return false;
  return nowMs - at < staleMs;
}

// The in-app poll skips a filing when this is true.
// Pending OCR is settled only on a host that cannot read it.
// A fresh claim belongs to whichever worker set it.
export function ocrSettled(filing, tools, nowMs = Date.now()) {
  if (!filing) return false;
  if (claimFresh(filing, nowMs)) return true;
  if (filing.parseStatus === PENDING_OCR_STATUS || toolsMissingFiling(filing)) {
    return !tools && filing.parseStatus === PENDING_OCR_STATUS;
  }
  if (filing.ocrDone !== true) return false;
  return true;
}

export function pendingOcrResult() {
  return {
    status: PENDING_OCR_STATUS,
    trades: [],
    note: PENDING_OCR_NOTE,
    ocrDone: false,
  };
}

export function filingNeedsPresidentialOcr(filing, nowMs = Date.now()) {
  if (!filing || filing.source !== 'oge') return false;
  if (filing.office !== 'president' && filing.office !== 'vice-president') return false;
  if (!isOgePdfUrl(filing.sourceUrl)) return false;
  if (filing.parseStatus === PENDING_OCR_STATUS) return true;
  if (filing.parseStatus === OCR_RUNNING_STATUS && !claimFresh(filing, nowMs)) return true;
  if (filing.ocrDone === true && toolsMissingFiling(filing)) return true;
  return false;
}
