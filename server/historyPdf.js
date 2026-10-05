// historyPdf.js — turn a Yahoo "Historical Data" print-to-PDF into layout lines.
//
// iOS Safari "Save as PDF" does not draw table rules, and the content stream
// paints the date column separately from the numbers. pdf-parse's plain text
// therefore lists every close, then every date. Clustering text items by
// vertical position puts Date, Open, High, Low, Close, Adj Close, and Volume
// back on one line. No poppler / pdftotext — pdfjs via pdf-parse, which
// already runs on Render for factsheets.

import { PDFParse } from 'pdf-parse';

const ROW_Y = 4;

function itemsToLines(items) {
  const sorted = [...items].sort((a, b) => a.y - b.y || a.x - b.x);
  const rows = [];
  for (const it of sorted) {
    const last = rows[rows.length - 1];
    if (!last || Math.abs(last.y - it.y) > ROW_Y) rows.push({ y: it.y, items: [it] });
    else last.items.push(it);
  }
  const lines = [];
  for (const row of rows) {
    const cells = [...row.items].sort((a, b) => a.x - b.x);
    let line = '';
    let right = null;
    for (const it of cells) {
      const gap = right == null ? 0 : it.x - right;
      if (line && gap > 8) line += '  ';
      else if (line && !line.endsWith(' ')) line += ' ';
      line += it.str;
      right = it.x + (Number(it.w) > 0 ? it.w : String(it.str).length * 4.5);
    }
    const trimmed = line.replace(/\s+/g, ' ').replace(/ {2,}/g, '  ').trim();
    if (trimmed) lines.push(trimmed);
  }
  return lines;
}

export async function pdfBufferToLayoutText(buffer) {
  const parser = new PDFParse({ data: buffer });
  try {
    await parser.getInfo();
    const doc = parser.doc;
    if (!doc) throw new Error('PDF did not load.');
    const lines = [];
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const viewport = page.getViewport({ scale: 1 });
      const textContent = await page.getTextContent();
      const items = [];
      for (const item of textContent.items) {
        if (!item || !item.str || !String(item.str).trim()) continue;
        const tm = item.transform;
        if (!tm) continue;
        const [x, y] = viewport.convertToViewportPoint(tm[4], tm[5]);
        items.push({ str: String(item.str), x, y, w: item.width || 0 });
      }
      lines.push(...itemsToLines(items));
      page.cleanup();
    }
    return lines.join('\n');
  } finally {
    await parser.destroy().catch(() => {});
  }
}

export function looksLikePdf(buffer, { filename = '', mime = '' } = {}) {
  if (/application\/pdf/i.test(mime) || /\.pdf$/i.test(filename)) return true;
  return Buffer.isBuffer(buffer) && buffer.length >= 4 && buffer.slice(0, 4).toString('latin1') === '%PDF';
}
