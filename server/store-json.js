// store-json.js — file-backed store for local dev (no DATABASE_URL set).
// Same async API as the Postgres store so callers don't care which is active.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { seedData } from './seed.js';
import { uid, instrumentFromSpec, normalizeBreakdown, currentVersionOf, holdingsEqual } from './util.js';

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
    if (patch.sector !== undefined) inst.sector = patch.sector || null;
    if (patch.country !== undefined) inst.country = patch.country || null;
    if (patch.sectorBreakdown !== undefined || patch.countryBreakdown !== undefined) {
      if (patch.sectorBreakdown !== undefined) inst.sectorBreakdown = normalizeBreakdown(patch.sectorBreakdown);
      if (patch.countryBreakdown !== undefined) inst.countryBreakdown = normalizeBreakdown(patch.countryBreakdown);
      inst.breakdownUpdatedAt = new Date().toISOString();
    }
    this._persist();
    return inst;
  }

  async addNav(instrumentId, { date, nav }) {
    if (!this.db.navSeries[instrumentId]) this.db.navSeries[instrumentId] = [];
    const arr = this.db.navSeries[instrumentId].filter((p) => p.date !== date);
    arr.push({ date, nav: Number(nav) });
    arr.sort((a, b) => a.date.localeCompare(b.date));
    this.db.navSeries[instrumentId] = arr;
    this._persist();
    return arr;
  }
  async getNavSeries(instrumentId) { return this.db.navSeries[instrumentId] || []; }
  async latestNav(instrumentId) {
    const s = this.db.navSeries[instrumentId] || [];
    return s.length ? s[s.length - 1] : null;
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
    const cur = currentVersionOf({ versions: m.versions });
    if (cur && holdingsEqual(cur.holdings, resolved)) return { noChange: true };
    const version = {
      id: uid('ver'),
      effectiveDate: effectiveDate || new Date().toISOString().slice(0, 10),
      note: note || '',
      holdings: resolved,
      createdAt: new Date().toISOString(),
    };
    m.versions.push(version);
    this._persist();
    return version;
  }
}
