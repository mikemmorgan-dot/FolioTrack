// store-pg.js — durable Postgres backend. Same API as JsonStore.
import { makePool, initSchema, seedIfEmpty } from './db.js';
import { uid, instrumentFromSpec, normalizeBreakdown, currentVersionOf, holdingsEqual } from './util.js';

const numOrNull = (x) => (x == null ? null : Number(x));

function rowToInstrument(r) {
  return {
    id: r.id, symbol: r.symbol, name: r.name, type: r.type, source: r.source,
    currency: r.currency, sector: r.sector, country: r.country,
    mer: numOrNull(r.mer), createdAt: r.created_at,
    sectorBreakdown: r.sector_breakdown || null,
    countryBreakdown: r.country_breakdown || null,
    breakdownUpdatedAt: r.breakdown_updated_at,
  };
}
const d = (x) => (x instanceof Date ? x.toISOString().slice(0, 10) : String(x).slice(0, 10));

export class PgStore {
  constructor() { this.pool = makePool(); }

  async init() {
    await initSchema(this.pool);
    await seedIfEmpty(this.pool);
    return this;
  }

  async listInstruments() {
    const { rows } = await this.pool.query('SELECT * FROM instruments ORDER BY symbol');
    return rows.map(rowToInstrument);
  }
  async getInstrument(id) {
    const { rows } = await this.pool.query('SELECT * FROM instruments WHERE id=$1', [id]);
    return rows[0] ? rowToInstrument(rows[0]) : null;
  }

  async ensureInstrument(spec) {
    const s = instrumentFromSpec(spec);
    const found = await this.pool.query('SELECT * FROM instruments WHERE lower(symbol)=lower($1)', [s.symbol]);
    if (found.rows[0]) return rowToInstrument(found.rows[0]);
    return this.addInstrument(s);
  }
  async addInstrument(input) {
    const s = instrumentFromSpec(input);
    const id = input.id || uid('inst');
    const { rows } = await this.pool.query(
      `INSERT INTO instruments (id,symbol,name,type,source,currency,sector,country,mer)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (lower(symbol)) DO UPDATE SET name=EXCLUDED.name
       RETURNING *`,
      [id, s.symbol, s.name, s.type, s.source, s.currency, s.sector, s.country, s.mer]
    );
    return rowToInstrument(rows[0]);
  }

  async updateInstrument(id, patch) {
    const sets = [];
    const vals = [];
    let n = 1;
    if (patch.sector !== undefined) { sets.push(`sector=$${n++}`); vals.push(patch.sector || null); }
    if (patch.country !== undefined) { sets.push(`country=$${n++}`); vals.push(patch.country || null); }
    if (patch.sectorBreakdown !== undefined) {
      sets.push(`sector_breakdown=$${n++}`);
      vals.push(JSON.stringify(normalizeBreakdown(patch.sectorBreakdown)));
    }
    if (patch.countryBreakdown !== undefined) {
      sets.push(`country_breakdown=$${n++}`);
      vals.push(JSON.stringify(normalizeBreakdown(patch.countryBreakdown)));
    }
    if (patch.sectorBreakdown !== undefined || patch.countryBreakdown !== undefined) {
      sets.push('breakdown_updated_at=now()');
    }
    if (!sets.length) return this.getInstrument(id);
    vals.push(id);
    const { rows } = await this.pool.query(
      `UPDATE instruments SET ${sets.join(', ')} WHERE id=$${n} RETURNING *`, vals
    );
    return rows[0] ? rowToInstrument(rows[0]) : null;
  }

  async addNav(instrumentId, { date, nav }) {
    await this.pool.query(
      `INSERT INTO nav_series (instrument_id,date,nav) VALUES ($1,$2,$3)
       ON CONFLICT (instrument_id,date) DO UPDATE SET nav=EXCLUDED.nav`,
      [instrumentId, date, Number(nav)]
    );
    return this.getNavSeries(instrumentId);
  }
  async getNavSeries(instrumentId) {
    const { rows } = await this.pool.query(
      'SELECT date,nav FROM nav_series WHERE instrument_id=$1 ORDER BY date', [instrumentId]
    );
    return rows.map((r) => ({ date: d(r.date), nav: Number(r.nav) }));
  }
  async latestNav(instrumentId) {
    const { rows } = await this.pool.query(
      'SELECT date,nav FROM nav_series WHERE instrument_id=$1 ORDER BY date DESC LIMIT 1', [instrumentId]
    );
    return rows[0] ? { date: d(rows[0].date), nav: Number(rows[0].nav) } : null;
  }

  async _versionsFor(modelKey) {
    const { rows: vrows } = await this.pool.query(
      'SELECT * FROM versions WHERE model_key=$1 ORDER BY effective_date', [modelKey]
    );
    const versions = [];
    for (const v of vrows) {
      const { rows: hrows } = await this.pool.query(
        'SELECT instrument_id,weight FROM version_holdings WHERE version_id=$1', [v.id]
      );
      versions.push({
        id: v.id, effectiveDate: d(v.effective_date), note: v.note,
        holdings: hrows.map((h) => ({ instrumentId: h.instrument_id, weight: Number(h.weight) })),
      });
    }
    return versions;
  }

  async listModels() {
    const { rows } = await this.pool.query('SELECT * FROM models ORDER BY risk_rank');
    const out = [];
    for (const m of rows) {
      out.push({ key: m.key, name: m.name, riskRank: m.risk_rank, benchmark: m.benchmark, versions: await this._versionsFor(m.key) });
    }
    return out;
  }
  async getModel(key) {
    const { rows } = await this.pool.query('SELECT * FROM models WHERE key=$1', [key]);
    if (!rows[0]) return null;
    const m = rows[0];
    return { key: m.key, name: m.name, riskRank: m.risk_rank, benchmark: m.benchmark, versions: await this._versionsFor(m.key) };
  }

  async addVersion(key, { effectiveDate, note, holdings }) {
    const model = await this.pool.query('SELECT key FROM models WHERE key=$1', [key]);
    if (!model.rows[0]) return null;

    // Resolve instruments (upserting any new tickers) BEFORE opening the tx.
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

    const cur = currentVersionOf({ versions: await this._versionsFor(key) });
    if (cur && holdingsEqual(cur.holdings, resolved)) return { noChange: true };

    const id = uid('ver');
    const eff = effectiveDate || new Date().toISOString().slice(0, 10);
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('INSERT INTO versions (id,model_key,effective_date,note) VALUES ($1,$2,$3,$4)', [id, key, eff, note || '']);
      for (const h of resolved) {
        await client.query('INSERT INTO version_holdings (version_id,instrument_id,weight) VALUES ($1,$2,$3)', [id, h.instrumentId, h.weight]);
      }
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
    return { id, effectiveDate: eff, note: note || '', holdings: resolved };
  }
}
