// Page text items with coordinates, one page at a time. The caller drops each
// page when the callback returns. Annual PDFs (a presidential 278e can be
// hundreds of pages) are not kept as one string.

import { PDFParse } from 'pdf-parse';

export async function forEachPdfPage(buffer, onPage) {
  const parser = new PDFParse({ data: buffer });
  try {
    await parser.getInfo();
    const doc = parser.doc;
    if (!doc) throw new Error('PDF did not load.');
    const pageCount = doc.numPages;
    for (let i = 1; i <= pageCount; i += 1) {
      const page = await doc.getPage(i);
      try {
        const viewport = page.getViewport({ scale: 1 });
        const textContent = await page.getTextContent();
        const items = [];
        for (const item of textContent.items) {
          if (!item?.str || !String(item.str).trim()) continue;
          const tm = item.transform;
          if (!tm) continue;
          const [x, y] = viewport.convertToViewportPoint(tm[4], tm[5]);
          items.push({ str: String(item.str), x, y });
        }
        const stop = await onPage({
          pageNumber: i,
          pageCount,
          width: viewport.width,
          height: viewport.height,
          items,
        });
        if (stop === false) break;
      } finally {
        page.cleanup();
      }
    }
    return { pageCount };
  } finally {
    await parser.destroy().catch(() => {});
  }
}

export function itemsToRows(items, yTolerance = 3) {
  const sorted = [...(items || [])].sort((a, b) => a.y - b.y || a.x - b.x);
  const rows = [];
  for (const item of sorted) {
    const last = rows[rows.length - 1];
    if (!last || Math.abs(last.y - item.y) > yTolerance) rows.push({ y: item.y, items: [item] });
    else last.items.push(item);
  }
  return rows;
}

export function bandText(items, x0, x1) {
  return (items || [])
    .filter((item) => item.x >= x0 && item.x < x1)
    .sort((a, b) => a.x - b.x)
    .map((item) => item.str)
    .join(' ')
    .replace(/\u0000/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function rowText(items) {
  return (items || [])
    .slice()
    .sort((a, b) => a.x - b.x)
    .map((item) => item.str)
    .join(' ')
    .replace(/\u0000/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}
