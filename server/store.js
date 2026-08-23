// store.js
// Single storage seam for the whole app. Everything reads/writes through this.
// Dev/default: a JSON file on disk. This is the ONE module to replace when you
// move to Postgres (Neon/Supabase) — the API surface below stays identical so
// nothing upstream changes. See README "Persistence" for why this matters on Render.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { seedData } from './seed.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'data', 'store.json');

function nowISO() {
  return new Date().toISOString();
}

function uid(prefix) {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}`;
}

class Store {
  constructor(file) {
    this.file = file;
    this.db = null;
  }

  load() {
    try {
      const raw = fs.readFileSync(this.file, 'utf8');
      this.db = JSON.parse(raw);
    } catch {
      // First boot (or ephemeral disk wiped it) → seed a working dataset.
      this.db = structuredClone(seedData);
      this.persist();
    }
    return this;
  }

  persist() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(this.db, null, 2));
  }

  // ---- instruments ----
  listInstruments() {
    return Object.values(this.db.instruments);
  }

  getInstrument(id) {
    return this.db.instruments[id] || null;
  }

  addInstrument(input) {
    const id = input.id || uid('inst');
    const inst = {
      id,
      symbol: (input.symbol || '').trim(),
      name: input.name || input.symbol || id,
      type: input.type || 'stock', // stock | etf | mutualfund | alt
      source: input.source || 'auto', // auto (Yahoo) | manual
      currency: input.currency || 'CAD',
      sector: input.sector || null,
      country: input.country || null,
      mer: input.mer ?? null,
      createdAt: nowISO(),
    };
    this.db.instruments[id] = inst;
    this.persist();
    return inst;
  }

  // Manual NAV / return points for instruments Yahoo can't cover.
  addNav(instrumentId, { date, nav }) {
    if (!this.db.navSeries[instrumentId]) this.db.navSeries[instrumentId] = [];
    this.db.navSeries[instrumentId].push({ date, nav: Number(nav) });
    this.db.navSeries[instrumentId].sort((a, b) => a.date.localeCompare(b.date));
    this.persist();
    return this.db.navSeries[instrumentId];
  }

  getNavSeries(instrumentId) {
    return this.db.navSeries[instrumentId] || [];
  }

  latestNav(instrumentId) {
    const s = this.getNavSeries(instrumentId);
    return s.length ? s[s.length - 1] : null;
  }

  // ---- models ----
  listModels() {
    return Object.values(this.db.models).sort((a, b) => a.riskRank - b.riskRank);
  }

  getModel(key) {
    return this.db.models[key] || null;
  }

  currentVersion(key) {
    const m = this.getModel(key);
    if (!m || !m.versions.length) return null;
    // Latest by effectiveDate that is <= today.
    const today = nowISO().slice(0, 10);
    const applicable = m.versions
      .filter((v) => v.effectiveDate <= today)
      .sort((a, b) => a.effectiveDate.localeCompare(b.effectiveDate));
    return applicable.length ? applicable[applicable.length - 1] : m.versions[0];
  }

  // A "model change" = a new effective-dated version. This is what powers
  // change-attribution later: we keep every version, never mutate in place.
  addVersion(key, { effectiveDate, note, holdings }) {
    const m = this.getModel(key);
    if (!m) return null;
    const version = {
      id: uid('ver'),
      effectiveDate: effectiveDate || nowISO().slice(0, 10),
      note: note || '',
      holdings: (holdings || []).map((h) => ({
        instrumentId: h.instrumentId,
        weight: Number(h.weight),
      })),
      createdAt: nowISO(),
    };
    m.versions.push(version);
    this.persist();
    return version;
  }
}

let singleton = null;
export function getStore() {
  if (!singleton) singleton = new Store(DATA_FILE).load();
  return singleton;
}
