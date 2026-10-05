// store-json.js — file-backed store for local dev (no DATABASE_URL set).
// Same async API as the Postgres store so callers don't care which is active.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { seedData } from './seed.js';
import { uid, instrumentFromSpec, currentVersionOf, holdingsEqual, breakdownPatchPresent, nextBreakdownFields } from './util.js';
import { planNavBatch, todayToronto, batchError } from './nav.js';
import { normalizePublishedReturns } from './factsheet/publishedReturns.js';
import { coerceAlertSettings, applyAlertSettingsPatch } from './alerts/settings.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'data', 'store.json');

export class JsonStore {
  constructor(file = DATA_FILE) { this.file = file; this.db = null; }

  async init() {
    try {
      this.db = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch {
      this.db = structuredClone(seedData);
      this._persist();
    }
    return this;
  }
  _persist() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(this.db, null, 2));
  }

  async listInstruments() { return Object.values(this.db.instruments); }
  async getInstrument(id) { return this.db.instruments[id] || null; }

  async ensureInstrument(spec) {
    const s = instrumentFromSpec(spec);
    const existing = Object.values(this.db.instruments)
      .find((i) => i.symbol.toLowerCase() === s.symbol.toLowerCase());
    if (existing) return existing;
    return this.addInstrument(s);
  }
  async addInstrument(input) {
    const s = instrumentFromSpec(input);
    const id = input.id || uid('inst');
    const inst = { id, ...s, createdAt: new Date().toISOString() };
    this.db.instruments[id] = inst;
    this._persist();
    return inst;
  }

  async updateInstrument(id, patch) {
    const inst = this.db.instruments[id];
    if (!inst) return null;
    const next = breakdownPatchPresent(patch) ? nextBreakdownFields(inst, patch) : null;
    if (patch.name !== undefined && patch.name) inst.name = String(patch.name);
    if (patch.sector !== undefined) inst.sector = patch.sector || null;
    if (patch.country !== undefined) inst.country = patch.country || null;
    if (patch.meta !== undefined) inst.meta = patch.meta || null;
    if (patch.mer !== undefined) inst.mer = patch.mer === null || patch.mer === '' ? null : Number(patch.mer);
    if (patch.publishedReturns !== undefined) {
      inst.publishedReturns = normalizePublishedReturns(patch.publishedReturns);
    }
    if (patch.navSource !== undefined) {
      inst.navSource = patch.navSource ? String(patch.navSource).slice(0, 40) : null;
    }
    if (next) {
      inst.sectorBreakdown = next.sectorBreakdown;
      inst.countryBreakdown = next.countryBreakdown;
      inst.breakdownAsOf = next.breakdownAsOf;
      inst.breakdownNote = next.breakdownNote;
      if (next.rowsTouched) inst.breakdownUpdatedAt = new Date().toISOString();
    }
    this._persist();
    return inst;
  }

  _markSourceManual(instrumentId) {
    const inst = this.db.instruments[instrumentId];
    if (inst && inst.source !== 'manual') inst.source = 'manual';
  }

  async addNav(instrumentId, { date, nav }) {
    if (!this.db.navSeries[instrumentId]) this.db.navSeries[instrumentId] = [];
    const arr = this.db.navSeries[instrumentId].filter((p) => p.date !== date);
    arr.push({ date, nav: Number(nav) });
    arr.sort((a, b) => a.date.localeCompare(b.date));
    this.db.navSeries[instrumentId] = arr;
    this._markSourceManual(instrumentId);
    this._persist();
    return arr;
  }

  // One persist for the whole payload — not a model version.
  async addNavBatch({ asOf, points, navSource } = {}) {
    const instrumentsById = new Map();
    for (const p of points || []) {
      if (!p?.instrumentId || instrumentsById.has(p.instrumentId)) continue;
      const inst = this.db.instruments[p.instrumentId];
      if (inst) instrumentsById.set(p.instrumentId, inst);
    }
    const planned = planNavBatch(points, { asOf, instrumentsById, fallbackDate: todayToronto() });
    if (planned.error) throw batchError(planned.error);

    for (const w of planned.writes) {
      if (!this.db.navSeries[w.instrumentId]) this.db.navSeries[w.instrumentId] = [];
      const arr = this.db.navSeries[w.instrumentId].filter((p) => p.date !== w.date);
      arr.push({ date: w.date, nav: w.nav });
      arr.sort((a, b) => a.date.localeCompare(b.date));
      this.db.navSeries[w.instrumentId] = arr;
      this._markSourceManual(w.instrumentId);
      if (navSource !== undefined) {
        const inst = this.db.instruments[w.instrumentId];
        if (inst) inst.navSource = navSource ? String(navSource).slice(0, 40) : null;
      }
    }
    if (planned.writes.length) this._persist();

    const latest = [];
    for (const id of new Set(planned.writes.map((w) => w.instrumentId))) {
      const nav = await this.latestNav(id);
      latest.push({ instrumentId: id, date: nav?.date ?? null, nav: nav?.nav ?? null });
    }
    return { latest };
  }

  // One merge and one persist for a whole uploaded history. `overwrite` false
  // leaves dates that are already stored (Only add missing).
  async applyNavSeries(instrumentId, points, { navSource, overwrite = false } = {}) {
    const inst = this.db.instruments[instrumentId];
    if (!inst) {
      const err = new Error('Unknown instrument');
      err.status = 404;
      throw err;
    }
    if (!this.db.navSeries[instrumentId]) this.db.navSeries[instrumentId] = [];
    const byDate = new Map(this.db.navSeries[instrumentId].map((p) => [p.date, Number(p.nav)]));
    let written = 0;
    for (const p of points || []) {
      const date = String(p?.date || '').slice(0, 10);
      const nav = Number(p?.nav ?? p?.close);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !(nav > 0)) continue;
      if (byDate.has(date) && !overwrite) continue;
      byDate.set(date, nav);
      written += 1;
    }
    const series = [...byDate.entries()]
      .map(([date, nav]) => ({ date, nav }))
      .sort((a, b) => a.date.localeCompare(b.date));
    this.db.navSeries[instrumentId] = series;
    if (written) {
      this._markSourceManual(instrumentId);
      if (navSource !== undefined) inst.navSource = navSource ? String(navSource).slice(0, 40) : null;
      this._persist();
    }
    const latest = series.length ? series[series.length - 1] : null;
    return {
      written,
      latest: latest ? { instrumentId, date: latest.date, nav: latest.nav } : null,
    };
  }

  async getNavSeries(instrumentId) { return this.db.navSeries[instrumentId] || []; }
  async latestNav(instrumentId) {
    const s = this.db.navSeries[instrumentId] || [];
    return s.length ? s[s.length - 1] : null;
  }

  _priceHistoryMap() {
    if (!this.db.priceHistory) this.db.priceHistory = {};
    return this.db.priceHistory;
  }
  async getPriceHistory(symbol) {
    const key = String(symbol || '').trim().toUpperCase();
    return this._priceHistoryMap()[key] || null;
  }
  async putPriceHistory(symbol, { series, provider, range, fetchedAt } = {}) {
    const key = String(symbol || '').trim().toUpperCase();
    const rec = {
      symbol: key,
      series: series || [],
      provider: provider || null,
      range: range || 'max',
      fetchedAt: fetchedAt || new Date().toISOString(),
    };
    this._priceHistoryMap()[key] = rec;
    this._persist();
    return rec;
  }

  async getAlertSettings() {
    return coerceAlertSettings(this.db.alertSettings || {});
  }
  async saveAlertSettings(patch) {
    const next = applyAlertSettingsPatch(await this.getAlertSettings(), patch);
    this.db.alertSettings = next;
    this._persist();
    return next;
  }
  async getAlertCheckMeta() {
    return this.db.alertCheck || null;
  }
  async setAlertCheckMeta(meta) {
    this.db.alertCheck = meta;
    this._persist();
    return meta;
  }
  async getAlertMissUntil() {
    return this.db.alertMissUntil || {};
  }
  async setAlertMissUntil(obj) {
    this.db.alertMissUntil = obj || {};
    this._persist();
    return this.db.alertMissUntil;
  }
  async getAlertEvent(instrumentId) {
    return this.db.alertEvents?.[instrumentId] || null;
  }
  async listAlertEvents() {
    return Object.values(this.db.alertEvents || {});
  }
  async upsertAlertEvent(event) {
    if (!this.db.alertEvents) this.db.alertEvents = {};
    const next = { ...event, updatedAt: event.updatedAt || new Date().toISOString() };
    this.db.alertEvents[event.instrumentId] = next;
    this._persist();
    return next;
  }
  async appendAlertHistory(entry) {
    if (!Array.isArray(this.db.alertHistory)) this.db.alertHistory = [];
    this.db.alertHistory.push(entry);
    if (this.db.alertHistory.length > 200) {
      this.db.alertHistory.splice(0, this.db.alertHistory.length - 200);
    }
    this._persist();
    return entry;
  }
  async listAlertHistory(limit = 40) {
    const all = this.db.alertHistory || [];
    const n = Math.max(1, Number(limit) || 40);
    return all.slice(-n).reverse();
  }

  async listModels() {
    return Object.values(this.db.models).sort((a, b) => a.riskRank - b.riskRank);
  }
  async getModel(key) { return this.db.models[key] || null; }

  async addVersion(key, { effectiveDate, note, holdings }) {
    const m = this.db.models[key];
    if (!m) return null;
    const resolved = [];
    for (const h of holdings || []) {
      let instrumentId = h.instrumentId;
      if (!instrumentId && h.instrument) {
        const inst = await this.ensureInstrument(h.instrument);
        instrumentId = inst.id;
        if (h.initialNav?.nav != null) await this.addNav(instrumentId, h.initialNav);
      }
      if (instrumentId) resolved.push({ instrumentId, weight: Number(h.weight) });
    }
    const eff = effectiveDate || new Date().toISOString().slice(0, 10);
    const cur = currentVersionOf({ versions: m.versions });
    if (cur && cur.effectiveDate === eff && cur.note === (note || '') && holdingsEqual(cur.holdings, resolved)) {
      return { noChange: true };
    }
    const version = {
      id: uid('ver'),
      effectiveDate: eff,
      note: note || '',
      holdings: resolved,
      createdAt: new Date().toISOString(),
    };
    m.versions.push(version);
    this._persist();
    return version;
  }
}
