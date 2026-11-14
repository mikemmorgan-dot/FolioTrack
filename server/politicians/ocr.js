// OCR for scanned OGE 278-T PDFs.
//
// tesseract.js was tried on a real presidential page and kept almost no
// validated rows, while using about 380MB inside the Node process. The
// tesseract CLI plus poppler (one page at a time, in a child process) read
// the same page well and leaves the Node heap alone, which matters in a
// 512MB Render instance. The Docker image installs both tools. If they are
// missing, the filing stays "pending OCR" for the GitHub Actions job and
// the rest of the app still runs. A Docker host that has both tools still
// reads the PDF in-process.

import { spawn } from 'node:child_process';
import { access, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rowsFromOcrWords } from './ocrRows.js';

async function commandExists(name) {
  const dirs = String(process.env.PATH || '').split(':').filter(Boolean);
  for (const dir of dirs) {
    try {
      await access(join(dir, name), constants.X_OK);
      return true;
    } catch { /* next */ }
  }
  return false;
}

let toolsPromise = null;
export function ocrToolsAvailable() {
  if (!toolsPromise) {
    toolsPromise = Promise.all([commandExists('tesseract'), commandExists('pdftoppm'), commandExists('pdfinfo')])
      .then(([tess, ppm, info]) => tess && ppm && info);
  }
  return toolsPromise;
}

function run(cmd, args, { timeoutMs = 90_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const out = [];
    const err = [];
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`${cmd} timed out`));
    }, timeoutMs);
    child.stdout.on('data', (chunk) => out.push(chunk));
    child.stderr.on('data', (chunk) => err.push(chunk));
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        const detail = Buffer.concat(err).toString('utf8').trim().slice(0, 240);
        reject(new Error(`${cmd} exited ${code}${detail ? `: ${detail}` : ''}`));
        return;
      }
      resolve(Buffer.concat(out));
    });
  });
}

export function wordsFromTsv(tsv) {
  const lines = String(tsv || '').split(/\n/).filter(Boolean);
  if (!lines.length) return [];
  const header = lines[0].split('\t');
  const col = (name) => header.indexOf(name);
  const textI = col('text');
  const confI = col('conf');
  const leftI = col('left');
  const topI = col('top');
  const widthI = col('width');
  const heightI = col('height');
  const words = [];
  for (const line of lines.slice(1)) {
    const cells = line.split('\t');
    const text = cells[textI] || '';
    const confidence = Number(cells[confI]);
    if (!text.trim() || !(confidence >= 0)) continue;
    const x = Number(cells[leftI]) || 0;
    const y = Number(cells[topI]) || 0;
    const w = Number(cells[widthI]) || 0;
    const h = Number(cells[heightI]) || 0;
    words.push({
      text,
      confidence,
      bbox: { x0: x, y0: y, x1: x + w, y1: y + h },
    });
  }
  return words;
}

async function pageCount(pdfPath) {
  const out = await run('pdfinfo', [pdfPath], { timeoutMs: 30_000 });
  const match = String(out).match(/Pages:\s+(\d+)/);
  return match ? Number(match[1]) : 0;
}

async function renderPage(pdfPath, page, dir) {
  const prefix = join(dir, 'page');
  await run('pdftoppm', ['-f', String(page), '-l', String(page), '-r', '200', '-png', pdfPath, prefix], {
    timeoutMs: 60_000,
  });
  const names = await readdir(dir);
  const png = names.find((name) => name.startsWith('page-') && name.endsWith('.png'));
  if (!png) throw new Error(`pdftoppm did not write page ${page}`);
  return join(dir, png);
}

/**
 * OCR one PDF from disk, one page at a time. `onPage` runs after each page
 * so the caller can checkpoint and drop the page image.
 */
export async function ocrPdfFile(pdfPath, {
  now = new Date(),
  startPage = 1,
  maxPages = 45,
  onPage,
} = {}) {
  const total = await pageCount(pdfPath);
  const last = Math.min(total || startPage, startPage + maxPages - 1);
  const trades = [];
  let rejected = 0;
  let pagesRead = 0;
  const dir = await mkdtemp(join(tmpdir(), 'folio-ocr-'));
  try {
    for (let page = startPage; page <= last; page += 1) {
      const png = await renderPage(pdfPath, page, dir);
      let pageResult = { trades: [], rejected: 0, sawTable: false };
      try {
        // Default page segmentation. PSM 6 glues this form's columns together
        // and the amount tokens stop validating. The default mode keeps the
        // type, date, and amount as separate words.
        const tsv = await run('tesseract', [png, 'stdout', 'tsv'], { timeoutMs: 90_000 });
        pageResult = rowsFromOcrWords(wordsFromTsv(tsv), { now });
      } finally {
        await rm(png, { force: true });
      }
      pagesRead += 1;
      trades.push(...pageResult.trades);
      rejected += pageResult.rejected;
      if (onPage) {
        await onPage({
          page,
          pageCount: total,
          trades: pageResult.trades,
          rejected: pageResult.rejected,
        });
      }
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  return {
    trades,
    rejected,
    pageCount: total,
    pagesRead,
    finished: pagesRead > 0 && startPage + pagesRead - 1 >= (total || 0),
  };
}

// One page at a time, words with positions. Used for scanned 278e asset
// tables. The 278-T trade reader stays on ocrPdfFile.
export async function ocrPdfWords(pdfPath, {
  startPage = 1,
  maxPages = 25,
  onPage,
} = {}) {
  const total = await pageCount(pdfPath);
  const last = Math.min(total || startPage, startPage + maxPages - 1);
  let pagesRead = 0;
  const dir = await mkdtemp(join(tmpdir(), 'folio-ocr-'));
  try {
    for (let page = startPage; page <= last; page += 1) {
      const png = await renderPage(pdfPath, page, dir);
      let words = [];
      try {
        const tsv = await run('tesseract', [png, 'stdout', 'tsv'], { timeoutMs: 90_000 });
        words = wordsFromTsv(tsv);
      } finally {
        await rm(png, { force: true });
      }
      pagesRead += 1;
      if (onPage) await onPage({ page, pageCount: total, words });
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  return {
    pageCount: total,
    pagesRead,
    finished: pagesRead > 0 && startPage + pagesRead - 1 >= (total || 0),
  };
}

export async function writePdfTemp(bytes) {
  const dir = await mkdtemp(join(tmpdir(), 'folio-pdf-'));
  const pdfPath = join(dir, 'filing.pdf');
  await writeFile(pdfPath, bytes);
  return {
    pdfPath,
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}
