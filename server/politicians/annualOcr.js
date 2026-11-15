// OCR for a scanned presidential or vice-presidential 278e. Text-layer
// reports are parsed by the poll and never reach this queue. Each run reads
// a bounded number of pages and resumes from ocr_page. Rows that do not
// validate are not guessed. Holdings are not emailed.

import { downloadOgePdf } from './ingest.js';
import { consumeOgeAnnualPage, createOgeAnnualParse, ogeAnnualResult } from './parseOgeAnnual.js';
import { ocrPdfWords, writePdfTemp } from './ocr.js';
import { buildHoldingRows } from './annualRecords.js';

const PAGES_PER_RUN = 25;

function wordsToItems(words) {
  return (words || []).map((word) => ({
    str: word.text,
    x: word.bbox?.x0 || 0,
    y: word.bbox?.y0 || 0,
  }));
}

export async function ocrAnnualPdf(pdfPath, { startPage = 1, maxPages = PAGES_PER_RUN } = {}) {
  const state = createOgeAnnualParse();
  const read = await ocrPdfWords(pdfPath, {
    startPage,
    maxPages,
    onPage: ({ words }) => {
      consumeOgeAnnualPage(state, wordsToItems(words));
    },
  });
  const parsed = ogeAnnualResult(state);
  const finished = read.finished === true;
  return {
    ...parsed,
    status: finished ? parsed.status : (parsed.holdings.length ? 'partial' : 'pending_ocr'),
    ocrDone: finished,
    ocrPage: startPage + read.pagesRead - 1,
    pageCount: read.pageCount,
    note: finished
      ? parsed.note
      : `OCR read pages ${startPage}–${startPage + read.pagesRead - 1} of ${read.pageCount || '?'}. Later pages were not guessed.`,
  };
}

export async function runPendingAnnualOcr({
  store,
  fetchImpl = globalThis.fetch,
  download = downloadOgePdf,
  readPdf = null,
  now = new Date(),
  logger = console,
  maxPdfBytes = 32 * 1024 * 1024,
  limit = 2,
} = {}) {
  if (typeof store.listPendingAnnualOcr !== 'function') return { filings: [] };
  const pending = await store.listPendingAnnualOcr({ limit, now });
  const filings = [];
  for (const filing of pending) {
    const started = Date.now();
    try {
      await store.touchAnnualFiling?.(filing.id, {
        parseStatus: 'ocr_running',
        parseNote: 'OCR in progress',
        ocrClaimedAt: (now instanceof Date ? now : new Date(now)).toISOString(),
      });
      const pdf = await download(fetchImpl, filing.sourceUrl, maxPdfBytes);
      if (pdf?.parsed && !pdf.bytes) {
        await store.insertAnnualBundle({
          ...filing,
          parseStatus: pdf.parsed.status,
          parseNote: pdf.parsed.note,
          ocrDone: true,
        }, []);
        filings.push({ filingKey: filing.filingKey, action: 'skipped-download', status: pdf.parsed.status });
        continue;
      }
      const temp = await writePdfTemp(pdf.bytes);
      try {
        const startPage = (Number(filing.ocrPage) || 0) + 1;
        const parsed = readPdf
          ? await readPdf(temp.pdfPath, { startPage })
          : await ocrAnnualPdf(temp.pdfPath, { startPage });
        const rows = buildHoldingRows(filing, parsed, null).map((row) => ({ ...row, ocr: true }));
        if (startPage > 1 && typeof store.appendAnnualHoldings === 'function') {
          await store.appendAnnualHoldings(filing.id, rows);
          await store.touchAnnualFiling(filing.id, {
            parseStatus: parsed.status,
            parseNote: parsed.note,
            ocrDone: parsed.ocrDone === true,
            ocrPage: parsed.ocrPage,
            pageCount: parsed.pageCount,
            excludedCount: (Number(filing.excludedCount) || 0) + (parsed.excludedCount || 0),
            unreadableCount: (Number(filing.unreadableCount) || 0) + (parsed.unreadableCount || 0),
            reportYear: parsed.reportYear || filing.reportYear,
          });
        } else {
          await store.insertAnnualBundle({
            ...filing,
            parseStatus: parsed.status,
            parseNote: parsed.note,
            ocrDone: parsed.ocrDone === true,
            ocrPage: parsed.ocrPage,
            pageCount: parsed.pageCount,
            excludedCount: parsed.excludedCount || 0,
            unreadableCount: parsed.unreadableCount || 0,
            reportYear: parsed.reportYear || filing.reportYear,
          }, rows);
        }
        logger.log(`[annual-ocr] ${filing.filingKey} status=${parsed.status} kept=${parsed.holdings?.length || rows.length} pages=${parsed.ocrPage} ms=${Date.now() - started}`);
        filings.push({
          filingKey: filing.filingKey,
          action: 'ocr',
          status: parsed.status,
          holdings: rows.length,
          pages: parsed.ocrPage,
        });
      } finally {
        await temp.cleanup();
      }
    } catch (err) {
      logger.error(`[annual-ocr] ${filing.filingKey} failed: ${err.message}`);
      await store.touchAnnualFiling?.(filing.id, {
        parseStatus: 'pending_ocr',
        parseNote: filing.parseNote,
        ocrDone: false,
        ocrClaimedAt: null,
      });
      filings.push({ filingKey: filing.filingKey, action: 'retry' });
    }
  }
  return { filings };
}
