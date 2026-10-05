import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { once } from 'node:events';
import express from 'express';
import { JsonStore } from './store-json.js';
import {
  parseHistoryText,
  buildPreview,
  overlapPlan,
  applyUploadedHistory,
  createPriceUploadRouter,
  UPLOADED_NAV_SOURCE,
} from './historyUpload.js';
import { pdfBufferToLayoutText } from './historyPdf.js';
import { periodReturnsFromSeries } from './periodReturns.js';
import { filterSeriesByRange } from './holdingHistory.js';
import { loadNavMarket } from './navPrice.js';
import { decidePricePath } from './navPrice.js';
import { resolveDrawdown } from './alerts/drawdown.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const layoutText = fs.readFileSync(path.join(__dirname, 'fixtures/yahoo-history-layout.txt'), 'utf8');
const variantText = fs.readFileSync(path.join(__dirname, 'fixtures/yahoo-history-variant.txt'), 'utf8');
const samplePdf = path.join(__dirname, 'fixtures/atd-history-sample.pdf');

const files = [];
function tmpStore() {
  const file = path.join(os.tmpdir(), `foliotrack-pdf-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  files.push(file);
  return new JsonStore(file).init();
}
afterEach(() => {
  for (const f of files) try { fs.unlinkSync(f); } catch { /* already gone */ }
  files.length = 0;
});

describe('parseHistoryText layout fixture (sample PDF text)', () => {
  const parsed = parseHistoryText(layoutText);

  it('reads Close, not Adj Close, and keeps thousands separators intact', () => {
    expect(parsed.ticker).toBe('ATD.TO');
    expect(parsed.currency).toBe('CAD');
    expect(parsed.series.map((p) => [p.date, p.close, p.adjClose])).toEqual([
      ['2021-10-05', 48.5, 46.26],
      ['2026-09-10', 80, 79.78],
      ['2026-09-29', 77.96, 77.96],
      ['2026-09-30', 77.49, 77.49],
      ['2026-10-01', 77.2, 77.2],
      ['2026-10-02', 76.9, 76.9],
    ]);
  });

  it('skips dividend rows, page-break noise, duplicates, and rows with no numbers', () => {
    expect(parsed.dividends).toEqual([{ date: '2026-09-11', amount: 0.215, raw: 'Sep 11, 2026   0.215 Dividend' }]);
    expect(parsed.splits).toEqual([]);
    expect(parsed.skippedDetail.dividends).toBe(1);
    expect(parsed.skippedDetail.duplicates).toBe(1);
    expect(parsed.skippedDetail.incomplete).toBe(1);
    expect(parsed.skipped).toBe(3);
    expect(parsed.warnings.some((w) => /moved/.test(w))).toBe(false);
  });
});

describe('parseHistoryText other layouts', () => {
  it('parses a spaced Yahoo header, a split row, and a one-day outlier for a US ticker', () => {
    const parsed = parseHistoryText(variantText);
    expect(parsed.ticker).toBe('AAPL');
    expect(parsed.currency).toBe('USD');
    expect(parsed.splits).toHaveLength(1);
    expect(parsed.splits[0].date).toBe('2022-02-04');
    expect(parsed.dividends[0]).toMatchObject({ date: '2022-02-08', amount: 0.22 });
    const jan4 = parsed.series.find((p) => p.date === '2022-01-04');
    expect(jan4).toEqual({ date: '2022-01-04', close: 182.5, adjClose: 180.1 });
    expect(parsed.series.find((p) => p.date === '2022-01-05').close).toBe(100);
    expect(parsed.warnings.some((w) => w.includes('2022-01-05') && /moved/.test(w))).toBe(true);
    expect(parsed.series.some((p) => p.date === '2022-02-04')).toBe(false);
  });

  it('reads a CSV with quoted volume and prefers the Close column', () => {
    const csv = [
      'Date,Open,High,Low,Close,Adj Close,Volume',
      '2022-01-03,180,182,179,181.00,179.50,1000000',
      '2022-01-04,181,183,180.5,182.50,180.10,"900,000"',
      '2022-02-08,0.22,Dividend',
      '2022-03-02,,,,,',
      '2022-02-31,1,1,1,1,1,1',
    ].join('\n');
    const parsed = parseHistoryText(csv);
    expect(parsed.series).toEqual([
      { date: '2022-01-03', close: 181, adjClose: 179.5 },
      { date: '2022-01-04', close: 182.5, adjClose: 180.1 },
    ]);
    expect(parsed.skippedDetail.dividends).toBe(1);
    expect(parsed.skippedDetail.incomplete).toBe(1);
    expect(parsed.skippedDetail.invalid).toBe(1);
  });

  it('accepts a Date, Close paste', () => {
    const parsed = parseHistoryText('Date,Close\n2024-01-02,128.00\n2024-01-03,130');
    expect(parsed.series).toEqual([
      { date: '2024-01-02', close: 128, adjClose: null },
      { date: '2024-01-03', close: 130, adjClose: null },
    ]);
  });
});

describe('preview', () => {
  it('summarizes rows, sparkline, and overlap without writing', () => {
    const parsed = parseHistoryText(layoutText);
    const preview = buildPreview(parsed, {
      existing: [{ date: '2026-10-02', nav: 70 }, { date: '2026-09-01', nav: 75 }],
      holding: { symbol: 'RY.TO', currency: 'USD' },
    });
    expect(preview.rows).toBe(6);
    expect(preview.from).toBe('2021-10-05');
    expect(preview.to).toBe('2026-10-02');
    expect(preview.lastClose).toBe(76.9);
    expect(preview.lastDate).toBe('2026-10-02');
    expect(preview.firstClose).toBe(48.5);
    expect(preview.head[0].date).toBe('2021-10-05');
    expect((preview.tail.at(-1) || preview.head.at(-1)).close).toBe(76.9);
    expect(preview.sparkline[0]).toBe(48.5);
    expect(preview.sparkline.at(-1)).toBe(76.9);
    expect(preview.tickerMatch).toBe(false);
    expect(preview.currencyMismatch).toBe(true);
    expect(preview.overlap).toEqual({ existingCount: 2, overwriteCount: 1, addedCount: 5 });
    expect(preview.warnings[0]).toMatch(/RY\.TO/);
    expect(overlapPlan([{ date: '2026-10-02' }], preview.series).overwriteCount).toBe(1);
  });
});

describe('apply uploaded history', () => {
  it('batch-writes once, only adds missing unless overwrite is explicit, and feeds returns, history, and drawdown', async () => {
    const store = await tmpStore();
    const inst = await store.getInstrument('inst_enb');
    expect(inst.source).toBe('auto');

    const lines = ['Date,Close'];
    const start = Date.parse('2020-10-02T00:00:00Z');
    for (let i = 0; i <= 220; i++) {
      const dt = new Date(start + i * 10 * 86400000);
      const iso = dt.toISOString().slice(0, 10);
      if (iso > '2026-10-02') break;
      let price = 100 + i * 0.4;
      if (iso >= '2025-06-01') price = 200 - (i - 170) * 0.3;
      lines.push(`${iso},${price.toFixed(2)}`);
    }
    lines.push('2026-09-30,160.00');
    lines.push('2026-10-02,150.00');
    const parsed = parseHistoryText(lines.join('\n'));
    expect(parsed.series.length).toBeGreaterThan(100);

    let persists = 0;
    const orig = store._persist.bind(store);
    store._persist = () => { persists += 1; orig(); };

    const applied = await applyUploadedHistory(store, inst, parsed.series, { mode: 'missing' });
    expect(persists).toBe(1);
    expect(applied.added).toBe(parsed.series.length);
    expect(applied.overwritten).toBe(0);
    expect(applied.navSource).toBe(UPLOADED_NAV_SOURCE);
    expect(applied.source).toBe('manual');
    expect(applied.lastClose).toBe(150);
    expect(applied.lastDate).toBe('2026-10-02');
    expect((await store.getNavSeries(inst.id)).length).toBe(parsed.series.length);

    const again = await applyUploadedHistory(store, inst, [
      { date: '2026-10-02', close: 1 },
      { date: '2019-01-15', close: 99 },
    ], { mode: 'missing' });
    expect(again.added).toBe(1);
    expect(again.overwritten).toBe(0);
    expect(again.skippedExisting).toBe(1);
    const kept = (await store.getNavSeries(inst.id)).find((p) => p.date === '2026-10-02');
    expect(kept.nav).toBe(150);

    const overwritten = await applyUploadedHistory(store, inst, [
      { date: '2026-10-02', close: 151 },
    ], { mode: 'overwrite' });
    expect(overwritten.overwritten).toBe(1);
    expect(overwritten.added).toBe(0);
    expect((await store.getNavSeries(inst.id)).find((p) => p.date === '2026-10-02').nav).toBe(151);

    const updated = await store.getInstrument(inst.id);
    const market = await loadNavMarket(store, updated);
    expect(market.path).toBe('nav_series');
    expect(market.quote.price).toBe(151);
    const full = filterSeriesByRange(market.series, { mode: 'full' });
    const since = filterSeriesByRange(market.series, { mode: 'since-added', addedAt: '2024-01-01' });
    expect(full.length).toBeGreaterThan(since.length);
    expect(since[0].date <= '2024-01-01').toBe(true);
    expect(since.at(-1).date).toBe('2026-10-02');

    const returns = periodReturnsFromSeries(full);
    expect(returns.mtd).not.toBeNull();
    expect(returns.qtd).not.toBeNull();
    expect(returns.ytd).not.toBeNull();
    expect(returns.y1).not.toBeNull();
    expect(returns.y5ann).not.toBeNull();
    expect(returns.y20ann).toBeNull();
    expect(applied.returns.y5ann).not.toBeNull();

    await store.putPriceHistory('ENB.TO', {
      series: [{ date: '2026-10-02', close: 10 }],
      provider: 'yahoo',
    });
    const navSeries = await store.getNavSeries(inst.id);
    const path = decidePricePath(updated, navSeries);
    expect(path.path).toBe('nav_series');
    const useNav = path.path === 'nav_series' && path.series.length > 0;
    const resolved = resolveDrawdown({
      historySeries: useNav ? [] : [{ date: '2026-10-02', close: 10 }],
      navSeries,
      today: '2026-10-05',
    });
    expect(resolved.basis).toBe('nav');
    expect(resolved.currentPrice).toBe(151);
    expect(resolved.referencePrice).toBeGreaterThan(151);
    expect(resolved.drawdown).toBeLessThan(0);
  });

  it('refuses a ticker mismatch until confirm, and does not write', async () => {
    const store = await tmpStore();
    const inst = await store.getInstrument('inst_ry');
    await expect(applyUploadedHistory(store, inst, [{ date: '2026-10-02', close: 76.9 }], {
      detectedTicker: 'ATD.TO',
      mode: 'overwrite',
    })).rejects.toMatchObject({ status: 409 });
    expect(await store.getNavSeries(inst.id)).toEqual([]);

    const ok = await applyUploadedHistory(store, inst, [{ date: '2026-10-02', close: 76.9 }], {
      detectedTicker: 'ATD.TO',
      confirmTicker: true,
      mode: 'missing',
    });
    expect(ok.applied).toBe(true);
    expect(ok.lastClose).toBe(76.9);
    expect((await store.getInstrument(inst.id)).source).toBe('manual');
  });
});

function multipart(fileBuf, filename, fields = {}) {
  const boundary = '----foliotracktest';
  const chunks = [];
  for (const [name, value] of Object.entries(fields)) {
    chunks.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`
    ));
  }
  chunks.push(Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: application/pdf\r\n\r\n`
  ));
  chunks.push(fileBuf);
  chunks.push(Buffer.from(`\r\n--${boundary}--\r\n`));
  return { body: Buffer.concat(chunks), contentType: `multipart/form-data; boundary=${boundary}` };
}

async function withServer(store, fn) {
  const app = express();
  const jsonParser = express.json({ limit: '2mb' });
  app.use((req, res, next) => {
    if (req.path === '/api/prices/parse-pdf') return next();
    return jsonParser(req, res, next);
  });
  app.use(createPriceUploadRouter(store));
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    server.close();
    await once(server, 'close');
  }
}

describe('sample PDF extraction and preview/apply HTTP', () => {
  it('extracts the attached ATD history and does not save until apply', async () => {
    const text = await pdfBufferToLayoutText(fs.readFileSync(samplePdf));
    const parsed = parseHistoryText(text);
    expect(parsed.ticker).toBe('ATD.TO');
    expect(parsed.currency).toBe('CAD');
    // 1,276 price lines in the print; 22 dates are repeated identically across
    // page breaks, so the saved series is the 1,254 unique dates.
    expect(parsed.series.length + parsed.skippedDetail.duplicates).toBe(1276);
    expect(parsed.series.length).toBe(1254);
    expect(parsed.skippedDetail.duplicates).toBe(22);
    expect(parsed.series[0]).toMatchObject({ date: '2021-10-05', close: 48.5 });
    expect(parsed.series.at(-1)).toMatchObject({ date: '2026-10-02', close: 76.9 });
    expect(parsed.series[0].adjClose).toBe(46.26);
    expect(parsed.dividends.length).toBe(22);
    expect(parsed.dividends.some((d) => d.date === '2026-09-11' && d.amount === 0.215)).toBe(true);

    const store = await tmpStore();
    const inst = await store.addInstrument({
      symbol: 'ATD.TO', name: 'Alimentation Couche-Tard', type: 'stock', source: 'auto', currency: 'CAD',
    });
    await withServer(store, async (base) => {
      const pdf = fs.readFileSync(samplePdf);
      const body = multipart(pdf, 'atd-history-sample.pdf', { instrumentId: inst.id });
      const previewRes = await fetch(`${base}/api/prices/parse-pdf`, {
        method: 'POST',
        headers: { 'Content-Type': body.contentType },
        body: body.body,
      });
      expect(previewRes.status).toBe(200);
      const preview = await previewRes.json();
      expect(preview.rows).toBe(1254);
      expect(preview.ticker).toBe('ATD.TO');
      expect(preview.currency).toBe('CAD');
      expect(preview.lastClose).toBe(76.9);
      expect(preview.lastDate).toBe('2026-10-02');
      expect(preview.firstClose).toBe(48.5);
      expect(preview.from).toBe('2021-10-05');
      expect(preview.tickerMatch).toBe(true);
      expect(preview.overlap).toEqual({ existingCount: 0, overwriteCount: 0, addedCount: 1254 });
      expect(await store.getNavSeries(inst.id)).toEqual([]);

      const mismatch = await fetch(`${base}/api/instruments/inst_ry/apply-uploaded-history`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          series: [{ date: '2026-10-02', close: 76.9 }],
          detectedTicker: 'ATD.TO',
          mode: 'overwrite',
        }),
      });
      expect(mismatch.status).toBe(409);
      expect(await store.getNavSeries('inst_ry')).toEqual([]);

      const applyRes = await fetch(`${base}/api/instruments/${inst.id}/apply-uploaded-history`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ series: preview.series, detectedTicker: preview.ticker, mode: 'missing' }),
      });
      expect(applyRes.status).toBe(200);
      const applied = await applyRes.json();
      expect(applied.added).toBe(1254);
      expect(applied.overwritten).toBe(0);
      expect(applied.lastClose).toBe(76.9);
      // First close is 2021-10-05, three days after the 5y anchor (2021-10-02),
      // so 5y/20y stay empty while the windows the series does cover are filled.
      expect(applied.returns.mtd).not.toBeNull();
      expect(applied.returns.qtd).not.toBeNull();
      expect(applied.returns.ytd).not.toBeNull();
      expect(applied.returns.y1).not.toBeNull();
      expect(applied.returns.y5ann).toBeNull();
      expect(applied.returns.y20ann).toBeNull();

      const second = await fetch(`${base}/api/instruments/${inst.id}/apply-uploaded-history`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          series: [{ date: '2026-10-02', close: 1 }, { date: '2023-01-01', close: 60 }],
          detectedTicker: 'ATD.TO',
          mode: 'missing',
        }),
      });
      const missing = await second.json();
      expect(missing.added).toBe(1);
      expect(missing.skippedExisting).toBe(1);
      expect((await store.getNavSeries(inst.id)).find((p) => p.date === '2026-10-02').nav).toBe(76.9);

      const third = await fetch(`${base}/api/instruments/${inst.id}/apply-uploaded-history`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          series: [{ date: '2026-10-02', close: 77.1 }],
          detectedTicker: 'ATD.TO',
          mode: 'overwrite',
        }),
      });
      expect(third.status).toBe(200);
      expect((await store.getNavSeries(inst.id)).find((p) => p.date === '2026-10-02').nav).toBe(77.1);
      expect((await store.getInstrument(inst.id)).source).toBe('manual');
      expect((await store.getInstrument(inst.id)).navSource).toBe(UPLOADED_NAV_SOURCE);
    });
  });

  it('previews pasted CSV text through the same route', async () => {
    const store = await tmpStore();
    await withServer(store, async (base) => {
      const res = await fetch(`${base}/api/prices/parse-pdf`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: 'Date,Close\n2024-01-02,10\n2024-01-03,11\n',
          instrumentId: 'inst_ry',
        }),
      });
      expect(res.status).toBe(200);
      const preview = await res.json();
      expect(preview.rows).toBe(2);
      expect(preview.lastClose).toBe(11);
      expect(await store.getNavSeries('inst_ry')).toEqual([]);
    });
  });
});
