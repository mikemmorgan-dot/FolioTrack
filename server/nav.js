// nav.js — manual NAV helpers. Instruments are shared across models; a NAV
// point is instrument data, not an allocation change, so writing one never
// creates a model version.
import { currentVersionOf } from './util.js';

export function todayToronto() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Toronto' });
}

export function isCashInstrument(inst) {
  if (!inst) return false;
  return inst.type === 'cash' || String(inst.symbol || '').toUpperCase() === 'CASH';
}

export const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// Calendar-day cadences, not trading days. Cash is never stale and is
// excluded from the manual NAV workflow entirely.
export const NAV_CADENCE_DAYS = {
  stock: 7,
  etf: 7,
  mutualfund: 40,
  alt: 100,
  cash: Infinity,
};

export function calendarDaysBetween(fromISO, toISO) {
  const a = Date.parse(`${String(fromISO).slice(0, 10)}T00:00:00Z`);
  const b = Date.parse(`${String(toISO).slice(0, 10)}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.round((b - a) / 86400000);
}

export function isNavStale(type, asOf, today = todayToronto()) {
  if (!asOf || type === 'cash') return false;
  const cadence = NAV_CADENCE_DAYS[type] ?? 7;
  if (!Number.isFinite(cadence)) return false;
  const age = calendarDaysBetween(asOf, today);
  return age != null && age > cadence;
}

// Plan writes for POST /api/nav/batch.
// Skip: missing/non-finite nav, cash (type or symbol).
// Reject: unknown instrument ids (among points that weren't skipped), bad dates.
// Same instrument+date in one payload: last write wins.
export function planNavBatch(points, { asOf, instrumentsById, fallbackDate } = {}) {
  if (asOf != null && asOf !== '' && !DATE_RE.test(asOf)) {
    return { error: 'asOf must be YYYY-MM-DD' };
  }
  const defaultDate = (asOf && DATE_RE.test(asOf) ? asOf : null) || fallbackDate;
  const unknown = [];
  const byKey = new Map();

  for (const p of points || []) {
    if (p == null || p.instrumentId == null || p.instrumentId === '') continue;
    if (p.nav == null || (typeof p.nav === 'string' && p.nav.trim() === '')) continue;
    const nav = typeof p.nav === 'number' ? p.nav : Number(p.nav);
    if (!Number.isFinite(nav)) continue;

    const rawDate = p.date != null && String(p.date).trim() !== '' ? String(p.date).trim() : defaultDate;
    if (!rawDate || !DATE_RE.test(rawDate)) {
      return { error: 'Each NAV date must be YYYY-MM-DD' };
    }

    const id = p.instrumentId;
    const inst = instrumentsById?.get(id);
    if (!inst) {
      unknown.push(id);
      continue;
    }
    if (isCashInstrument(inst)) continue;
    byKey.set(`${id}|${rawDate}`, { instrumentId: id, date: rawDate, nav });
  }

  if (unknown.length) {
    const uniq = [...new Set(unknown)];
    return { error: `Unknown instrument id${uniq.length > 1 ? 's' : ''}: ${uniq.join(', ')}` };
  }
  return { writes: [...byKey.values()] };
}

export function batchError(message) {
  const err = new Error(message);
  err.status = 400;
  return err;
}

// Unique manual instruments in any model's *current* version. Cash excluded.
// Attaches latest NAV + which models use each name so the Prices panel
// doesn't have to N+1 fetch five models.
export async function listInUseManualInstruments(store) {
  const models = await store.listModels();
  const usage = new Map();
  for (const m of models) {
    const cv = currentVersionOf(m);
    if (!cv) continue;
    for (const h of cv.holdings) {
      const id = h.instrumentId;
      if (!usage.has(id)) usage.set(id, []);
      usage.get(id).push({ key: m.key, name: m.name });
    }
  }

  const out = [];
  for (const [id, modelsUsing] of usage) {
    const inst = await store.getInstrument(id);
    if (!inst || inst.source !== 'manual' || isCashInstrument(inst)) continue;
    const latest = await store.latestNav(id);
    out.push({
      id: inst.id,
      symbol: inst.symbol,
      name: inst.name,
      type: inst.type,
      currency: inst.currency,
      latestNav: latest?.nav ?? null,
      latestDate: latest?.date ?? null,
      models: modelsUsing,
    });
  }
  return out;
}
