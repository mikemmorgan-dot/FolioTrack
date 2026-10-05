// historyUpload.js — preview and apply a Yahoo Historical Data PDF / CSV.
//
// Close (not Adj Close) is the NAV. Dividend and split rows are kept off the
// price series. Nothing is written until apply, and the default mode only
// inserts dates that are not already in nav_series.

import { Router } from 'express';
import { isCashInstrument } from './nav.js';
import { loadNavMarket } from './navPrice.js';
import { periodReturnsFromSeries } from './periodReturns.js';
import { looksLikePdf, pdfBufferToLayoutText } from './historyPdf.js';

export const UPLOADED_NAV_SOURCE = 'Yahoo PDF';
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
export const MAX_BODY_BYTES = 14 * 1024 * 1024;
export const MAX_SERIES_POINTS = 20000;

const MONTHS = {
  january: '01', february: '02', march: '03', april: '04', may: '05', june: '06',
  july: '07', august: '08', september: '09', october: '10', november: '11', december: '12',
  jan: '01', feb: '02', mar: '03', apr: '04', jun: '06', jul: '07', aug: '08',
  sep: '09', sept: '09', oct: '10', nov: '11', dec: '12',
};

const CURRENCIES = new Set(['CAD', 'USD', 'EUR', 'GBP', 'AUD', 'CHF', 'JPY', 'NZD', 'HKD', 'CNY', 'CNH', 'SEK', 'NOK', 'DKK']);

const LEADING_DATE = /^((?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+\d{1,2},\s+20\d{2}|\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2}\/20\d{2})/i;

const CHROME = [
  /historical prices/i,
  /related tickers/i,
  /^at close\b/i,
  /currency in\b/i,
  /delayed quote/i,
  /^download\b/i,
  /copyright/i,
  /premium plans/i,
  /all rights reserved/i,
  /^help$/i,
  /^feedback$/i,
  /^about our ads$/i,
  /^daily$/i,
  /^[:|•·.\-–—\s]+$/,
  /^summary\b/i,
  /^news\b/i,
  /^profile$/i,
];

function httpError(message, status) {
  const err = new Error(message);
  err.status = status;
  return err;
}

export function parseLooseDate(raw) {
  const s = String(raw || '').trim();
  if (!s) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return validIso(s) ? s : null;
  const mdY = s.match(
    /^(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+(\d{1,2}),?\s+(20\d{2})$/i
  );
  if (mdY) {
    const mm = MONTHS[mdY[1].toLowerCase()];
    if (!mm) return null;
    return validIso(`${mdY[3]}-${mm}-${String(Number(mdY[2])).padStart(2, '0')}`);
  }
  const dmy = s.match(
    /^(\d{1,2})\s+(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+(20\d{2})$/i
  );
  if (dmy) {
    const mm = MONTHS[dmy[2].toLowerCase()];
    if (!mm) return null;
    return validIso(`${dmy[3]}-${mm}-${String(Number(dmy[1])).padStart(2, '0')}`);
  }
  const us = s.match(/^(\d{1,2})\/(\d{1,2})\/(20\d{2})$/);
  if (us) {
    return validIso(`${us[3]}-${String(Number(us[1])).padStart(2, '0')}-${String(Number(us[2])).padStart(2, '0')}`);
  }
  return null;
}

export function validIso(iso) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return null;
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return iso;
}

export function tickersEqual(a, b) {
  const na = String(a || '').trim().toUpperCase();
  const nb = String(b || '').trim().toUpperCase();
  return !!na && na === nb;
}

function parseNumber(raw) {
  if (raw == null) return null;
  const s = String(raw).replace(/[$,\s]/g, '');
  if (!/^[+-]?(?:\d+\.?\d*|\.\d+)$/.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function extractNumbers(rest) {
  const out = [];
  const re = /[+-]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?/g;
  let m;
  while ((m = re.exec(rest))) {
    const n = parseNumber(m[0]);
    if (n != null) out.push(n);
  }
  return out;
}

// Quote-aware. Used for real CSV rows so `180,182` is two fields, while
// `"900,000"` stays one volume. Layout text (spaces between columns) does
// not go through here — thousands separators there are inside one token.
function splitCsv(line) {
  const out = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quoted) {
      if (c === '"') {
        if (line[i + 1] === '"') { cur += '"'; i += 1; }
        else quoted = false;
      } else cur += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { out.push(cur.trim()); cur = ''; }
    else cur += c;
  }
  out.push(cur.trim());
  return out;
}

function isCsvDataLine(line) {
  if (/^\d{4}-\d{2}-\d{2},/.test(line)) return true;
  if (/^\d{1,2}\/\d{1,2}\/20\d{2},/.test(line)) return true;
  return /^(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\s+\d{1,2},\s+20\d{2},/i.test(line);
}

function mapAligned(values, header) {
  const numericKeys = header?.length ? header.filter((k) => k !== 'date') : null;
  if (!numericKeys) return mapNumbers(values.filter((v) => v != null), null);
  const rec = {};
  numericKeys.forEach((k, i) => {
    if (values[i] != null) rec[k] = values[i];
  });
  if (!(rec.close > 0)) return null;
  return rec;
}

function isHeaderLine(line) {
  if (LEADING_DATE.test(line)) return false;
  return /\bdate\b/i.test(line) && /\bclose\b/i.test(line);
}

function headerKeys(line) {
  const norm = line.replace(/adj\.?\s*close/ig, 'AdjClose');
  const parts = norm.includes(',') && !/\s{2,}/.test(norm)
    ? norm.split(',').map((s) => s.trim()).filter(Boolean)
    : norm.split(/\s+/).filter(Boolean);
  const keys = [];
  for (const part of parts) {
    const s = part.toLowerCase().replace(/[^a-z]/g, '');
    if (s === 'date') keys.push('date');
    else if (s === 'open') keys.push('open');
    else if (s === 'high') keys.push('high');
    else if (s === 'low') keys.push('low');
    else if (s === 'close') keys.push('close');
    else if (s === 'adjclose') keys.push('adj');
    else if (s === 'volume' || s === 'vol') keys.push('volume');
  }
  if (!keys.includes('date') || !keys.includes('close')) return null;
  return keys;
}

function isChrome(line) {
  return CHROME.some((re) => re.test(line));
}

function mapNumbers(nums, header) {
  let numericKeys;
  if (header?.length) numericKeys = header.filter((k) => k !== 'date');
  else if (nums.length >= 6) numericKeys = ['open', 'high', 'low', 'close', 'adj', 'volume'];
  else if (nums.length === 5) numericKeys = ['open', 'high', 'low', 'close', 'adj'];
  else if (nums.length === 4) numericKeys = ['open', 'high', 'low', 'close'];
  else if (nums.length === 2) numericKeys = ['close', 'adj'];
  else if (nums.length === 1) numericKeys = ['close'];
  else return null;

  if (header && nums.length > numericKeys.length) return null;
  if (!header && nums.length > 6) numericKeys = numericKeys.slice(0, 6);
  const use = numericKeys.slice(0, nums.length);
  if (!use.includes('close')) return null;
  const closeAt = use.indexOf('close');
  if (closeAt >= nums.length) return null;
  const rec = {};
  use.forEach((k, i) => { rec[k] = nums[i]; });
  return rec;
}

function amountFrom(rest) {
  const nums = extractNumbers(rest);
  return nums.length ? nums[0] : null;
}

export function detectTicker(text) {
  const found = [];
  const re = /\(([A-Za-z][A-Za-z0-9]{0,5}(?:[.\-][A-Za-z]{1,3})?)\)/g;
  let m;
  while ((m = re.exec(String(text || '')))) {
    const symbol = m[1].toUpperCase();
    if (CURRENCIES.has(symbol)) continue;
    if (!/^[A-Z][A-Z0-9]{0,5}(?:[.\-][A-Z]{1,3})?$/.test(symbol)) continue;
    found.push(symbol);
  }
  return found[0] || null;
}

export function detectCurrency(text) {
  const s = String(text || '');
  const explicit = s.match(/Currency in\s+([A-Z]{3})\b/);
  if (explicit && CURRENCIES.has(explicit[1])) return explicit[1];
  const bullet = s.match(/•\s*([A-Z]{3})\b/);
  if (bullet && CURRENCIES.has(bullet[1])) return bullet[1];
  return null;
}

export function parseHistoryText(text) {
  const raw = String(text || '').replace(/^\uFEFF/, '');
  const ticker = detectTicker(raw);
  const currency = detectCurrency(raw);
  const warnings = [];
  const dividends = [];
  const splits = [];
  const skippedDetail = { dividends: 0, splits: 0, incomplete: 0, duplicates: 0, invalid: 0 };
  const byDate = new Map();
  let header = null;

  const lines = raw.split(/\r?\n/);
  for (const original of lines) {
    const line = original.trim();
    if (!line) continue;
    if (isHeaderLine(line)) {
      header = headerKeys(line) || header;
      continue;
    }
    if (isChrome(line)) continue;

    const dateMatch = line.match(LEADING_DATE);
    if (!dateMatch) continue;
    const date = parseLooseDate(dateMatch[1]);
    const rest = line.slice(dateMatch[0].length);
    if (!date) {
      skippedDetail.invalid += 1;
      continue;
    }
    if (/dividend/i.test(rest) || /dividend/i.test(line)) {
      skippedDetail.dividends += 1;
      dividends.push({ date, amount: amountFrom(rest), raw: line });
      continue;
    }
    if (/split/i.test(rest)) {
      skippedDetail.splits += 1;
      splits.push({ date, raw: rest.trim() || line });
      continue;
    }
    if (/[A-Za-z]/.test(rest)) {
      skippedDetail.incomplete += 1;
      continue;
    }
    let mapped;
    if (isCsvDataLine(line)) {
      const fields = splitCsv(line).slice(1);
      const values = fields.map((f) => (String(f).trim() === '' ? null : parseNumber(f)));
      mapped = mapAligned(values, header);
    } else {
      mapped = mapNumbers(extractNumbers(rest), header);
    }
    if (!mapped || !(mapped.close > 0)) {
      skippedDetail.incomplete += 1;
      continue;
    }
    const point = {
      date,
      close: mapped.close,
      adjClose: mapped.adj != null && mapped.adj > 0 ? mapped.adj : null,
    };
    const prev = byDate.get(date);
    if (prev) {
      skippedDetail.duplicates += 1;
      if (prev.close !== point.close) {
        warnings.push(`${date} appeared twice (${prev.close} and ${point.close}); kept ${point.close}.`);
      }
    }
    byDate.set(date, point);
  }

  const series = [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
  for (let i = 1; i < series.length; i++) {
    const prev = series[i - 1];
    const cur = series[i];
    const gap = Math.round((Date.parse(`${cur.date}T00:00:00Z`) - Date.parse(`${prev.date}T00:00:00Z`)) / 86400000);
    // Adjacent sessions only (weekends and a holiday). A sparse paste is not a one-day move.
    if (gap > 5 || gap < 1) continue;
    const move = Math.abs(cur.close / prev.close - 1);
    if (move > 0.4) {
      warnings.push(`${cur.date} moved ${Math.round(move * 100)}% vs ${prev.date} (${prev.close} → ${cur.close}).`);
    }
  }

  const skipped = skippedDetail.dividends + skippedDetail.splits
    + skippedDetail.incomplete + skippedDetail.duplicates + skippedDetail.invalid;

  return { ticker, currency, series, dividends, splits, skipped, skippedDetail, warnings };
}

export function overlapPlan(existing, incoming) {
  const dates = new Set((existing || []).map((p) => String(p.date).slice(0, 10)));
  let overwriteCount = 0;
  let addedCount = 0;
  for (const p of incoming || []) {
    if (dates.has(p.date)) overwriteCount += 1;
    else addedCount += 1;
  }
  return { existingCount: dates.size, overwriteCount, addedCount };
}

function capWarnings(list, max = 8) {
  if (list.length <= max) return list;
  return [...list.slice(0, max - 1), `${list.length - max + 1} more warnings.`];
}

export function sparklineValues(series, n = 40) {
  if (!series?.length) return [];
  if (series.length <= n) return series.map((p) => p.close);
  const out = [];
  for (let i = 0; i < n; i++) {
    const idx = Math.round((i * (series.length - 1)) / (n - 1));
    out.push(series[idx].close);
  }
  return out;
}

function previewRows(series) {
  const slim = (p) => ({ date: p.date, close: p.close, adjClose: p.adjClose ?? null });
  if (series.length <= 10) return { head: series.map(slim), tail: [] };
  return { head: series.slice(0, 5).map(slim), tail: series.slice(-5).map(slim) };
}

export function currencyWarning(fileCurrency, holdingCurrency) {
  if (!fileCurrency || !holdingCurrency) return null;
  if (String(fileCurrency).toUpperCase() === String(holdingCurrency).toUpperCase()) return null;
  return `File currency is ${fileCurrency}; this holding is ${holdingCurrency}. Prices are saved as printed and are not converted.`;
}

export function buildPreview(parsed, { existing = null, holding = null } = {}) {
  const series = parsed.series || [];
  const first = series[0] || null;
  const last = series[series.length - 1] || null;
  const rows = previewRows(series);
  const overlap = existing ? overlapPlan(existing, series) : null;
  const tickerMatch = holding
    ? (parsed.ticker ? tickersEqual(parsed.ticker, holding.symbol) : null)
    : null;
  const fx = holding ? currencyWarning(parsed.currency, holding.currency) : null;
  const warnings = [...(parsed.warnings || [])];
  if (fx) warnings.unshift(fx);
  if (tickerMatch === false) {
    warnings.unshift(`File ticker is ${parsed.ticker}; this row is ${holding.symbol}. Confirm before applying.`);
  }
  return {
    ticker: parsed.ticker || null,
    currency: parsed.currency || null,
    rows: series.length,
    from: first?.date || null,
    to: last?.date || null,
    firstClose: first?.close ?? null,
    lastClose: last?.close ?? null,
    lastDate: last?.date || null,
    skipped: parsed.skipped || 0,
    skippedDetail: parsed.skippedDetail,
    dividends: parsed.dividends || [],
    splits: parsed.splits || [],
    warnings: capWarnings(warnings),
    head: rows.head,
    tail: rows.tail,
    sparkline: sparklineValues(series),
    series: series.map((p) => ({ date: p.date, close: p.close, adjClose: p.adjClose ?? null })),
    tickerMatch,
    holdingSymbol: holding?.symbol || null,
    currencyMismatch: !!fx,
    overlap,
  };
}

export function coerceSeries(series) {
  const byDate = new Map();
  for (const p of series || []) {
    const date = validIso(String(p?.date || '').slice(0, 10));
    const close = Number(p?.close ?? p?.nav);
    if (!date || !(close > 0)) continue;
    const adj = p?.adjClose == null ? null : Number(p.adjClose);
    byDate.set(date, {
      date,
      close,
      adjClose: Number.isFinite(adj) && adj > 0 ? adj : null,
    });
  }
  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
}

export async function parseUpload({ buffer = null, text = '', filename = '', mime = '' } = {}) {
  let parsed;
  if (buffer && buffer.length && looksLikePdf(buffer, { filename, mime })) {
    let layout;
    try {
      layout = await pdfBufferToLayoutText(buffer);
    } catch (e) {
      throw httpError(
        `Couldn't read that PDF (${e.message || 'parse failed'}). Print the Yahoo Historical Data page to PDF, or paste a CSV.`,
        422
      );
    }
    parsed = parseHistoryText(layout);
  } else if (buffer && buffer.length && !text) {
    parsed = parseHistoryText(buffer.toString('utf8'));
  } else {
    parsed = parseHistoryText(text);
  }
  if (parsed.series.length > MAX_SERIES_POINTS) {
    throw httpError(`That file has ${parsed.series.length} price rows, over the ${MAX_SERIES_POINTS} limit.`, 422);
  }
  return parsed;
}

export async function applyUploadedHistory(store, inst, series, {
  mode = 'missing',
  detectedTicker = null,
  confirmTicker = false,
  navSource = UPLOADED_NAV_SOURCE,
  dryRun = false,
} = {}) {
  if (!inst) throw httpError('Instrument not found', 404);
  if (isCashInstrument(inst)) throw httpError('Cash stays at $1 and does not take a history.', 422);
  if (mode !== 'missing' && mode !== 'overwrite') {
    throw httpError('Choose Only add missing or Overwrite.', 400);
  }
  const clean = coerceSeries(series);
  if (!clean.length) throw httpError('No usable dated prices to apply.', 400);
  if (clean.length > MAX_SERIES_POINTS) {
    throw httpError(`Too many rows (${clean.length}).`, 422);
  }
  const existing = await store.getNavSeries(inst.id);
  const overlap = overlapPlan(existing, clean);
  const needsTickerConfirm = !!(detectedTicker && !tickersEqual(detectedTicker, inst.symbol) && !confirmTicker);
  if (dryRun) {
    return {
      dryRun: true,
      needsTickerConfirm,
      detectedTicker: detectedTicker || null,
      holdingSymbol: inst.symbol,
      currencyWarning: null,
      ...overlap,
    };
  }
  if (needsTickerConfirm) {
    const err = httpError(
      `This file is ${detectedTicker}, not ${inst.symbol}. Confirm to apply it to this holding.`,
      409
    );
    err.details = {
      needsTickerConfirm: true,
      detectedTicker,
      holdingSymbol: inst.symbol,
      ...overlap,
    };
    throw err;
  }

  const existingDates = new Set(existing.map((p) => String(p.date).slice(0, 10)));
  const overwrite = mode === 'overwrite';
  const toWrite = overwrite ? clean : clean.filter((p) => !existingDates.has(p.date));
  let latest = null;
  if (toWrite.length) {
    if (typeof store.applyNavSeries !== 'function') {
      throw httpError('Store cannot apply a history batch.', 500);
    }
    const written = await store.applyNavSeries(
      inst.id,
      toWrite.map((p) => ({ date: p.date, nav: p.close })),
      { overwrite, navSource }
    );
    latest = written.latest || null;
  } else {
    latest = await store.latestNav(inst.id);
  }

  const updated = await store.getInstrument(inst.id);
  const market = await loadNavMarket(store, updated);
  return {
    applied: true,
    dryRun: false,
    mode,
    added: overwrite ? overlap.addedCount : toWrite.length,
    overwritten: overwrite ? overlap.overwriteCount : 0,
    skippedExisting: overwrite ? 0 : overlap.overwriteCount,
    count: market.series.length,
    from: market.series[0]?.date || null,
    to: market.series.at(-1)?.date || null,
    lastClose: market.quote?.price ?? latest?.nav ?? null,
    lastDate: market.quote?.asOf ?? latest?.date ?? null,
    source: updated?.source || 'manual',
    navSource: updated?.navSource || navSource,
    quote: market.quote,
    returns: periodReturnsFromSeries(market.series),
    instrument: updated,
  };
}

function readLimited(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(httpError('File is larger than 10MB.', 413));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export function parseMultipart(buffer, contentType) {
  const m = /boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(contentType || '');
  if (!m) throw httpError('Upload must include a multipart boundary.', 400);
  const boundary = Buffer.from(`--${(m[1] || m[2]).trim()}`);
  const parts = [];
  let start = buffer.indexOf(boundary);
  while (start !== -1) {
    let next = buffer.indexOf(boundary, start + boundary.length);
    if (next === -1) break;
    let part = buffer.subarray(start + boundary.length, next);
    if (part[0] === 13 && part[1] === 10) part = part.subarray(2);
    else if (part[0] === 10) part = part.subarray(1);
    if (part.length && part[part.length - 1] === 10) part = part.subarray(0, part.length - 1);
    if (part.length && part[part.length - 1] === 13) part = part.subarray(0, part.length - 1);
    const sep = part.indexOf(Buffer.from('\r\n\r\n'));
    if (sep >= 0) {
      const headerText = part.subarray(0, sep).toString('utf8');
      const body = part.subarray(sep + 4);
      const name = /name="([^"]+)"/i.exec(headerText)?.[1] || '';
      const filename = /filename="([^"]*)"/i.exec(headerText)?.[1] || '';
      const type = /content-type:\s*([^\r\n]+)/i.exec(headerText)?.[1]?.trim() || '';
      parts.push({ name, filename, type, body });
    }
    start = next;
  }
  return parts;
}

async function payloadFromRequest(req) {
  const ct = String(req.headers['content-type'] || '');
  if (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body) && (req.body.text || req.body.pdfBase64 || req.body.csvBase64)) {
    return jsonPayload(req.body, req.query);
  }
  const buf = await readLimited(req, MAX_BODY_BYTES);
  if (ct.includes('multipart/form-data')) {
    const parts = parseMultipart(buf, ct);
    const file = parts.find((p) => p.filename) || parts.find((p) => p.name === 'file' || p.name === 'pdf');
    const instrumentId = parts.find((p) => p.name === 'instrumentId')?.body.toString('utf8').trim()
      || req.query.instrumentId
      || null;
    const textPart = parts.find((p) => p.name === 'text' && !p.filename);
    const fileBuf = file?.body?.length ? file.body : null;
    if (fileBuf && fileBuf.length > MAX_UPLOAD_BYTES) throw httpError('File is larger than 10MB.', 413);
    return {
      buffer: fileBuf,
      text: textPart ? textPart.body.toString('utf8') : '',
      filename: file?.filename || '',
      mime: file?.type || '',
      instrumentId: instrumentId || null,
    };
  }
  if (ct.includes('application/json') || (buf.length && buf[0] === 0x7b)) {
    let json;
    try { json = JSON.parse(buf.toString('utf8')); } catch { throw httpError('Invalid JSON upload.', 400); }
    return jsonPayload(json, req.query);
  }
  if (buf.length > MAX_UPLOAD_BYTES) throw httpError('File is larger than 10MB.', 413);
  return {
    buffer: buf.length ? buf : null,
    text: '',
    filename: '',
    mime: ct,
    instrumentId: req.query.instrumentId || null,
  };
}

function jsonPayload(body, query) {
  const b64 = body.pdfBase64 || body.csvBase64 || body.dataBase64 || null;
  let buffer = null;
  if (b64) {
    buffer = Buffer.from(String(b64), 'base64');
    if (buffer.length > MAX_UPLOAD_BYTES) throw httpError('File is larger than 10MB.', 413);
  }
  return {
    buffer,
    text: body.text || '',
    filename: body.filename || '',
    mime: body.mime || '',
    instrumentId: body.instrumentId || query?.instrumentId || null,
  };
}

async function holdingFor(store, instrumentId) {
  if (!instrumentId) return null;
  const holding = await store.getInstrument(instrumentId);
  if (!holding) throw httpError('Instrument not found', 404);
  if (isCashInstrument(holding)) throw httpError('Cash stays at $1 and does not take a history.', 422);
  return holding;
}

export function createPriceUploadRouter(store) {
  const router = Router();

  router.post('/api/prices/parse-pdf', async (req, res) => {
    try {
      const payload = await payloadFromRequest(req);
      if (!payload.buffer?.length && !String(payload.text || '').trim()) {
        return res.status(400).json({ error: 'Upload a PDF or CSV, or paste history text.' });
      }
      const holding = await holdingFor(store, payload.instrumentId);
      const parsed = await parseUpload(payload);
      if (!parsed.series.length) {
        return res.status(422).json({
          error: 'No price rows found. Use a Yahoo Historical Data PDF or a Date / Close CSV.',
          skipped: parsed.skipped,
          dividends: parsed.dividends.length,
          warnings: parsed.warnings.slice(0, 8),
        });
      }
      const existing = holding ? await store.getNavSeries(holding.id) : null;
      res.json(buildPreview(parsed, { existing, holding }));
    } catch (e) {
      res.status(e.status || 500).json({ error: e.message });
    }
  });

  router.post('/api/instruments/:id/apply-uploaded-history', async (req, res) => {
    try {
      const inst = await store.getInstrument(req.params.id);
      if (!inst) return res.status(404).json({ error: 'Instrument not found' });
      const body = req.body || {};
      const mode = body.mode === 'overwrite' ? 'overwrite' : 'missing';
      const result = await applyUploadedHistory(store, inst, body.series, {
        mode,
        detectedTicker: body.detectedTicker || null,
        confirmTicker: !!body.confirmTicker,
        dryRun: !!body.dryRun,
      });
      if (!body.dryRun && result.instrument) {
        const { instrument, ...rest } = result;
        return res.json({ ...rest, instrumentId: instrument.id });
      }
      res.json(result);
    } catch (e) {
      res.status(e.status || 500).json({ error: e.message, ...(e.details || {}) });
    }
  });

  return router;
}
