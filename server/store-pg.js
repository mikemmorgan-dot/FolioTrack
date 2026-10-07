// store-pg.js — durable Postgres backend. Same API as JsonStore.
import { makePool, initSchema, seedIfEmpty, migratePricePoints } from './db.js';
import { uid, instrumentFromSpec, currentVersionOf, holdingsEqual, breakdownPatchPresent, nextBreakdownFields } from './util.js';
import { planNavBatch, todayToronto, batchError } from './nav.js';
import { normalizePublishedReturns } from './factsheet/publishedReturns.js';
import { coerceAlertSettings, applyAlertSettingsPatch } from './alerts/settings.js';
import { WEEKS_52_DAYS } from './alerts/drawdown.js';
import { noteEgress, approxJsonBytes } from './egress.js';
import {
  INSTRUMENT_COLUMNS,
  INSTRUMENT_CORE_SQL,
  PRICE_SNAPSHOT_SQL,
  NAV_SNAPSHOT_SQL,
  PRICE_WINDOW_SQL,
  NAV_WINDOW_SQL,
  PRICE_META_SQL,
  PRICE_META_UPSERT_SQL,
  PRICE_LEGACY_SERIES_SQL,
  PRICE_POINTS_UPSERT_SQL,
  NAV_UPSERT_SQL,
} from './seriesSql.js';

const numOrNull = (x) => (x == null ? null : Number(x));
const d = (x) => (x instanceof Date ? x.toISOString().slice(0, 10) : String(x).slice(0, 10));
const isoTs = (x) => {
  if (x == null) return null;
  if (x instanceof Date) return x.toISOString();
  const t = Date.parse(x);
  return Number.isFinite(t) ? new Date(t).toISOString() : String(x);
};

function rowToInstrument(r) {
  return {
    id: r.id, symbol: r.symbol, name: r.name, type: r.type, source: r.source,
    currency: r.currency, sector: r.sector, country: r.country,
    mer: numOrNull(r.mer), createdAt: r.created_at,
    sectorBreakdown: r.sector_breakdown || null,
    countryBreakdown: r.country_breakdown || null,
    breakdownUpdatedAt: r.breakdown_updated_at,
    breakdownAsOf: r.breakdown_as_of ? d(r.breakdown_as_of) : null,
    breakdownNote: r.breakdown_note || null,
    publishedReturns: r.published_returns || null,
    navSource: r.nav_source || null,
    meta: r.meta || null,
  };
}

const MEM_CAP = 64;

function priceSymbol(symbol) {
  return String(symbol || '').trim().toUpperCase();
}

function boundOrNull(value) {
  if (!value) return null;
  const s = String(value).slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
}

// First close on a duplicate date wins. Non-positive closes are dropped.
function normalizeCloses(series) {
  const seen = new Set();
  const out = [];
  for (const p of series || []) {
    const date = String(p?.date || '').slice(0, 10);
    const close = Number(p?.close ?? p?.price ?? p?.nav);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !(close > 0)) continue;
    if (seen.has(date)) continue;
    seen.add(date);
    out.push({ date, close });
  }
  out.sort((a, b) => a.date.localeCompare(b.date));
  return out;
}

function aggDate(value) {
  if (value == null) return null;
  return d(value);
}

export class PgStore {
  constructor() {
    this.pool = makePool();
    this._mem = new Map();
  }

  async q(text, params) {
    return this.qOn(this.pool, text, params);
  }

  async qOn(runner, text, params) {
    const result = await runner.query(text, params);
    noteEgress(result.rows?.length || 0, approxJsonBytes(result.rows));
    return result;
  }

  _remember(key, value) {
    if (this._mem.has(key)) this._mem.delete(key);
    this._mem.set(key, value);
    while (this._mem.size > MEM_CAP) {
      const oldest = this._mem.keys().next().value;
      this._mem.delete(oldest);
    }
    return value;
  }

  _recall(key) {
    if (!this._mem.has(key)) return undefined;
    const value = this._mem.get(key);
    this._mem.delete(key);
    this._mem.set(key, value);
    return value;
  }

  _forgetPrice(symbol) {
    const key = priceSymbol(symbol);
    const prefix = `px:${key}:`;
    for (const k of [...this._mem.keys()]) {
      if (k === `meta:${key}` || k.startsWith(prefix) || k.startsWith(`snap:${key}`)) this._mem.delete(k);
    }
  }

  _forgetNav(instrumentId) {
    for (const k of [...this._mem.keys()]) {
      if (k.startsWith(`nav:${instrumentId}:`) || k === `nsnap:${instrumentId}`) this._mem.delete(k);
    }
  }

  async init() {
    await initSchema(this.pool);
    await migratePricePoints(this.pool);
    await seedIfEmpty(this.pool);
    return this;
  }

  async listInstruments() {
    const { rows } = await this.q(`SELECT ${INSTRUMENT_COLUMNS} FROM instruments ORDER BY symbol`);
    return rows.map(rowToInstrument);
  }
  async getInstrument(id) {
    const { rows } = await this.q(`SELECT ${INSTRUMENT_COLUMNS} FROM instruments WHERE id=$1`, [id]);
    return rows[0] ? rowToInstrument(rows[0]) : null;
  }

  async ensureInstrument(spec) {
    const s = instrumentFromSpec(spec);
    const found = await this.q(`SELECT ${INSTRUMENT_COLUMNS} FROM instruments WHERE lower(symbol)=lower($1)`, [s.symbol]);
    if (found.rows[0]) return rowToInstrument(found.rows[0]);
    return this.addInstrument(s);
  }
  async addInstrument(input) {
    const s = instrumentFromSpec(input);
    const id = input.id || uid('inst');
    const { rows } = await this.q(
      `INSERT INTO instruments (id,symbol,name,type,source,currency,sector,country,mer,meta)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT (lower(symbol)) DO UPDATE SET name=EXCLUDED.name
       RETURNING ${INSTRUMENT_COLUMNS}`,
      [id, s.symbol, s.name, s.type, s.source, s.currency, s.sector, s.country, s.mer, s.meta ? JSON.stringify(s.meta) : null]
    );
    return rowToInstrument(rows[0]);
  }

  async updateInstrument(id, patch) {
    const sets = [];
    const vals = [];
    let n = 1;
    if (patch.name !== undefined && patch.name) { sets.push(`name=$${n++}`); vals.push(String(patch.name)); }
    if (patch.sector !== undefined) { sets.push(`sector=$${n++}`); vals.push(patch.sector || null); }
    if (patch.country !== undefined) { sets.push(`country=$${n++}`); vals.push(patch.country || null); }
    if (patch.meta !== undefined) {
      sets.push(`meta=$${n++}`);
      vals.push(patch.meta ? JSON.stringify(patch.meta) : null);
    }
    if (patch.mer !== undefined) {
      sets.push(`mer=$${n++}`);
      vals.push(patch.mer === null || patch.mer === '' ? null : Number(patch.mer));
    }
    if (patch.publishedReturns !== undefined) {
      sets.push(`published_returns=$${n++}`);
      const pub = normalizePublishedReturns(patch.publishedReturns);
      vals.push(pub ? JSON.stringify(pub) : null);
    }
    if (patch.navSource !== undefined) {
      sets.push(`nav_source=$${n++}`);
      vals.push(patch.navSource ? String(patch.navSource).slice(0, 40) : null);
    }
    if (breakdownPatchPresent(patch)) {
      const current = await this.getInstrument(id);
      if (!current) return null;
      const next = nextBreakdownFields(current, patch);
      sets.push(`sector_breakdown=$${n++}`);
      vals.push(next.sectorBreakdown ? JSON.stringify(next.sectorBreakdown) : null);
      sets.push(`country_breakdown=$${n++}`);
      vals.push(next.countryBreakdown ? JSON.stringify(next.countryBreakdown) : null);
      sets.push(`breakdown_as_of=$${n++}`);
      vals.push(next.breakdownAsOf);
      sets.push(`breakdown_note=$${n++}`);
      vals.push(next.breakdownNote);
      if (next.rowsTouched) sets.push('breakdown_updated_at=now()');
    }
    if (!sets.length) return this.getInstrument(id);
    vals.push(id);
    const { rows } = await this.q(
      `UPDATE instruments SET ${sets.join(', ')} WHERE id=$${n} RETURNING ${INSTRUMENT_COLUMNS}`, vals
    );
    return rows[0] ? rowToInstrument(rows[0]) : null;
  }

  async addNav(instrumentId, { date, nav }) {
    await this.q(NAV_UPSERT_SQL, [instrumentId, date, Number(nav)]);
    this._forgetNav(instrumentId);
    await this.q(
      `UPDATE instruments SET source='manual' WHERE id=$1 AND source IS DISTINCT FROM 'manual'`,
      [instrumentId]
    );
    return this.getNavSeries(instrumentId);
  }

  // One transaction for the whole payload — not a model version.
  async addNavBatch({ asOf, points, navSource } = {}) {
    const ids = [...new Set((points || []).map((p) => p?.instrumentId).filter(Boolean))];
    const instrumentsById = new Map();
    if (ids.length) {
      const { rows } = await this.q(`SELECT ${INSTRUMENT_COLUMNS} FROM instruments WHERE id = ANY($1)`, [ids]);
      for (const r of rows) instrumentsById.set(r.id, rowToInstrument(r));
    }
    const planned = planNavBatch(points, { asOf, instrumentsById, fallbackDate: todayToronto() });
    if (planned.error) throw batchError(planned.error);
    if (!planned.writes.length) return { latest: [] };

    const client = await this.pool.connect();
    try {
      await this.qOn(client, 'BEGIN');
      for (const w of planned.writes) {
        await this.qOn(client, NAV_UPSERT_SQL, [w.instrumentId, w.date, w.nav]);
      }
      const writtenIds = [...new Set(planned.writes.map((w) => w.instrumentId))];
      await this.qOn(client, 
        `UPDATE instruments SET source='manual' WHERE id = ANY($1) AND source IS DISTINCT FROM 'manual'`,
        [writtenIds]
      );
      if (navSource !== undefined) {
        await this.qOn(client, 
          `UPDATE instruments SET nav_source=$2 WHERE id = ANY($1)`,
          [writtenIds, navSource ? String(navSource).slice(0, 40) : null]
        );
      }
      await this.qOn(client, 'COMMIT');
    } catch (e) {
      await this.qOn(client, 'ROLLBACK');
      throw e;
    } finally {
      client.release();
    }

    const latest = [];
    for (const id of new Set(planned.writes.map((w) => w.instrumentId))) {
      this._forgetNav(id);
      const nav = await this.latestNav(id);
      latest.push({ instrumentId: id, date: nav?.date ?? null, nav: nav?.nav ?? null });
    }
    return { latest };
  }

  // One INSERT … unnest for the whole upload, not a round-trip per date.
  async applyNavSeries(instrumentId, points, { navSource, overwrite = false } = {}) {
    const inst = await this.getInstrument(instrumentId);
    if (!inst) {
      const err = new Error('Unknown instrument');
      err.status = 404;
      throw err;
    }
    const byDate = new Map();
    for (const p of points || []) {
      const date = String(p?.date || '').slice(0, 10);
      const nav = Number(p?.nav ?? p?.close);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !(nav > 0)) continue;
      byDate.set(date, nav);
    }
    const dates = [...byDate.keys()];
    const navs = dates.map((date) => byDate.get(date));
    if (!dates.length) {
      const latest = await this.latestNav(instrumentId);
      return { written: 0, latest: latest ? { instrumentId, ...latest } : null };
    }
    const conflict = overwrite
      ? `ON CONFLICT (instrument_id, date) DO UPDATE SET nav = EXCLUDED.nav
         WHERE nav_series.nav IS DISTINCT FROM EXCLUDED.nav`
      : 'ON CONFLICT (instrument_id, date) DO NOTHING';
    const client = await this.pool.connect();
    let written = 0;
    try {
      await this.qOn(client, 'BEGIN');
      const result = await this.qOn(client, 
        `INSERT INTO nav_series (instrument_id, date, nav)
         SELECT $1, u.date::date, u.nav
         FROM unnest($2::text[], $3::numeric[]) AS u(date, nav)
         ${conflict}`,
        [instrumentId, dates, navs]
      );
      written = result.rowCount || 0;
      // Identical closes are not rewritten, but a re-upload should still
      // stamp nav source. That is one small instrument row, not the series.
      const stamp = written > 0 || (overwrite && dates.length > 0);
      if (stamp) {
        await this.qOn(client, 
          `UPDATE instruments SET source='manual' WHERE id=$1 AND source IS DISTINCT FROM 'manual'`,
          [instrumentId]
        );
        if (navSource !== undefined) {
          await this.qOn(client, 
            `UPDATE instruments SET nav_source=$2 WHERE id=$1`,
            [instrumentId, navSource ? String(navSource).slice(0, 40) : null]
          );
        }
      }
      await this.qOn(client, 'COMMIT');
    } catch (e) {
      await this.qOn(client, 'ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
    this._forgetNav(instrumentId);
    const latest = await this.latestNav(instrumentId);
    return { written, latest: latest ? { instrumentId, ...latest } : null };
  }

  async getNavSeries(instrumentId, opts = {}) {
    const since = boundOrNull(opts?.since);
    const until = boundOrNull(opts?.until);
    const { rows } = await this.q(NAV_WINDOW_SQL, [instrumentId, since, until]);
    return rows.map((r) => ({ date: d(r.date), nav: Number(r.nav) }));
  }
  async latestNav(instrumentId) {
    const { rows } = await this.q(
      'SELECT date,nav FROM nav_series WHERE instrument_id=$1 ORDER BY date DESC LIMIT 1', [instrumentId]
    );
    return rows[0] ? { date: d(rows[0].date), nav: Number(rows[0].nav) } : null;
  }

  async getInstrumentCore(id) {
    const { rows } = await this.q(INSTRUMENT_CORE_SQL, [id]);
    if (!rows[0]) return null;
    const r = rows[0];
    return {
      id: r.id,
      symbol: r.symbol,
      name: r.name,
      type: r.type,
      source: r.source,
      currency: r.currency,
      navSource: r.nav_source || null,
    };
  }

  _navSnap(row) {
    if (!row || !Number(row.n)) return null;
    return {
      n: Number(row.n),
      firstDate: aggDate(row.first_date),
      latestDate: aggDate(row.latest_date),
      latestNav: numOrNull(row.latest_nav),
      peakDate: aggDate(row.peak_date),
      peakNav: numOrNull(row.peak_nav),
    };
  }

  _priceSnap(row) {
    if (!row || !Number(row.n)) return null;
    return {
      n: Number(row.n),
      firstDate: aggDate(row.first_date),
      latestDate: aggDate(row.latest_date),
      latestClose: numOrNull(row.latest_close),
      peakDate: aggDate(row.peak_date),
      peakClose: numOrNull(row.peak_close),
      fetchedAt: row.fetched_at ? isoTs(row.fetched_at) : null,
    };
  }

  async getAlertSnapshot(instrumentId, symbol) {
    const { rows: navRows } = await this.q(NAV_SNAPSHOT_SQL, [instrumentId]);
    const nav = this._navSnap(navRows[0]);
    if (nav?.n > 0) {
      return {
        navCount: nav.n,
        priceCount: 0,
        priceLastClose: null,
        historyFetchedAt: null,
        price: null,
        nav,
      };
    }
    const key = priceSymbol(symbol);
    let priceRows = key
      ? (await this.q(PRICE_SNAPSHOT_SQL, [key, WEEKS_52_DAYS])).rows
      : [];
    let price = this._priceSnap(priceRows[0]);
    if (key && !price?.n) {
      const meta = await this.getPriceHistoryMeta(key);
      if (meta?.hasLegacy && !meta.pointCount) {
        const promoted = await this._promoteLegacySeries(key, meta);
        if (promoted?.length) {
          priceRows = (await this.q(PRICE_SNAPSHOT_SQL, [key, WEEKS_52_DAYS])).rows;
          price = this._priceSnap(priceRows[0]);
        }
      }
    }
    return {
      navCount: 0,
      priceCount: price?.n || 0,
      priceLastClose: price?.latestDate || null,
      historyFetchedAt: price?.fetchedAt || null,
      price,
      nav: null,
    };
  }

  async getPriceHistoryMeta(symbol) {
    const key = priceSymbol(symbol);
    if (!key) return null;
    const cacheKey = `meta:${key}`;
    const hit = this._recall(cacheKey);
    if (hit !== undefined) return hit;
    const { rows } = await this.q(PRICE_META_SQL, [key]);
    if (!rows[0]) return this._remember(cacheKey, null);
    const r = rows[0];
    return this._remember(cacheKey, {
      symbol: r.symbol,
      provider: r.provider,
      range: r.range,
      fetchedAt: r.fetched_at ? isoTs(r.fetched_at) : null,
      lastClose: aggDate(r.last_date),
      pointCount: Number(r.n) || 0,
      hasLegacy: !!r.has_legacy,
    });
  }

  // Boot copies the JSON blob into price_points. If that copy stored nothing
  // but the blob is still present, read it once, write rows, and stop.
  async _promoteLegacySeries(key, meta) {
    const { rows } = await this.q(PRICE_LEGACY_SERIES_SQL, [key]);
    const points = normalizeCloses(rows[0]?.series);
    if (!points.length) return null;
    await this.putPriceHistory(key, {
      series: points,
      provider: meta.provider,
      range: meta.range,
      fetchedAt: meta.fetchedAt || new Date().toISOString(),
    });
    return points;
  }

  async getPriceHistory(symbol, opts = {}) {
    const key = priceSymbol(symbol);
    if (!key) return null;
    const since = boundOrNull(opts?.since);
    const until = boundOrNull(opts?.until);
    const cacheKey = `px:${key}:${since || ''}:${until || ''}`;
    const hit = this._recall(cacheKey);
    if (hit !== undefined) return hit;
    const meta = await this.getPriceHistoryMeta(key);
    if (!meta) return this._remember(cacheKey, null);
    if (!meta.pointCount && meta.hasLegacy) {
      const points = await this._promoteLegacySeries(key, meta);
      if (points) {
        const series = points.filter((p) => {
          if (since && p.date < since) return false;
          if (until && p.date > until) return false;
          return true;
        });
        return this._remember(cacheKey, {
          symbol: meta.symbol || key,
          series,
          provider: meta.provider,
          range: meta.range,
          fetchedAt: meta.fetchedAt,
        });
      }
    }
    const { rows } = await this.q(PRICE_WINDOW_SQL, [key, since, until]);
    return this._remember(cacheKey, {
      symbol: meta.symbol || key,
      series: rows.map((r) => ({ date: d(r.date), close: Number(r.close) })),
      provider: meta.provider,
      range: meta.range,
      fetchedAt: meta.fetchedAt,
    });
  }

  async putPriceHistory(symbol, { series, provider, range, fetchedAt } = {}) {
    const key = priceSymbol(symbol);
    const at = fetchedAt || new Date().toISOString();
    const points = normalizeCloses(series);
    this._forgetPrice(key);
    await this.q(PRICE_META_UPSERT_SQL, [key, provider || null, range || 'max', at]);
    if (points.length) {
      await this.q(
        PRICE_POINTS_UPSERT_SQL,
        [key, points.map((p) => p.date), points.map((p) => p.close)],
      );
    }
    // The series we were handed is already in memory. Do not read it back.
    return {
      symbol: key,
      series: points,
      provider: provider || null,
      range: range || 'max',
      fetchedAt: at,
    };
  }

  async getAlertSettings() {
    const { rows } = await this.q(`SELECT value FROM app_settings WHERE key='alerts'`);
    return coerceAlertSettings(rows[0]?.value || {});
  }
  async saveAlertSettings(patch) {
    const next = applyAlertSettingsPatch(await this.getAlertSettings(), patch);
    await this.q(
      `INSERT INTO app_settings (key, value, updated_at) VALUES ('alerts', $1::jsonb, now())
       ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_at=now()`,
      [JSON.stringify(next)],
    );
    return next;
  }
  async getAlertCheckMeta() {
    const { rows } = await this.q(`SELECT value FROM app_settings WHERE key='alertCheck'`);
    return rows[0]?.value || null;
  }
  async setAlertCheckMeta(meta) {
    await this.q(
      `INSERT INTO app_settings (key, value, updated_at) VALUES ('alertCheck', $1::jsonb, now())
       ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_at=now()`,
      [JSON.stringify(meta)],
    );
    return meta;
  }
  async getAlertMissUntil() {
    const { rows } = await this.q(`SELECT value FROM app_settings WHERE key='alertMissUntil'`);
    return rows[0]?.value || {};
  }
  async setAlertMissUntil(obj) {
    await this.q(
      `INSERT INTO app_settings (key, value, updated_at) VALUES ('alertMissUntil', $1::jsonb, now())
       ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_at=now()`,
      [JSON.stringify(obj || {})],
    );
    return obj || {};
  }

  _rowToAlertEvent(r) {
    if (!r) return null;
    return {
      instrumentId: r.instrument_id,
      symbol: r.symbol,
      name: r.name,
      status: r.status,
      firstBreachedAt: isoTs(r.first_breached_at),
      lastNotifiedAt: isoTs(r.last_notified_at),
      recoveredAt: isoTs(r.recovered_at),
      referencePrice: numOrNull(r.reference_price),
      referenceDate: r.reference_date ? d(r.reference_date) : null,
      priceAtBreach: numOrNull(r.price_at_breach),
      drawdownAtBreach: numOrNull(r.drawdown_at_breach),
      currentPrice: numOrNull(r.current_price),
      currentDrawdown: numOrNull(r.current_drawdown),
      threshold: numOrNull(r.threshold),
      notifyStatus: r.notify_status,
      notifyDetail: r.notify_detail,
      basis: r.basis,
      basisLabel: r.basis_label,
      priceAsOf: r.price_as_of ? d(r.price_as_of) : null,
      historyFetchedAt: isoTs(r.history_fetched_at),
      stale: !!r.stale,
      models: r.models || [],
      currency: r.currency,
      lastEvalNote: r.last_eval_note,
      updatedAt: isoTs(r.updated_at),
    };
  }
  async getAlertEvent(instrumentId) {
    const { rows } = await this.q('SELECT * FROM alert_events WHERE instrument_id=$1', [instrumentId]);
    return this._rowToAlertEvent(rows[0]);
  }
  async listAlertEvents() {
    const { rows } = await this.q('SELECT * FROM alert_events ORDER BY first_breached_at DESC NULLS LAST');
    return rows.map((r) => this._rowToAlertEvent(r));
  }
  async upsertAlertEvent(event) {
    const e = event;
    const { rows } = await this.q(
      `INSERT INTO alert_events (
         instrument_id, symbol, name, status, first_breached_at, last_notified_at, recovered_at,
         reference_price, reference_date, price_at_breach, drawdown_at_breach, current_price,
         current_drawdown, threshold, notify_status, notify_detail, basis, basis_label,
         price_as_of, history_fetched_at, stale, models, currency, last_eval_note, updated_at
       ) VALUES (
         $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22::jsonb,$23,$24,$25
       )
       ON CONFLICT (instrument_id) DO UPDATE SET
         symbol=EXCLUDED.symbol, name=EXCLUDED.name, status=EXCLUDED.status,
         first_breached_at=EXCLUDED.first_breached_at, last_notified_at=EXCLUDED.last_notified_at,
         recovered_at=EXCLUDED.recovered_at, reference_price=EXCLUDED.reference_price,
         reference_date=EXCLUDED.reference_date, price_at_breach=EXCLUDED.price_at_breach,
         drawdown_at_breach=EXCLUDED.drawdown_at_breach, current_price=EXCLUDED.current_price,
         current_drawdown=EXCLUDED.current_drawdown, threshold=EXCLUDED.threshold,
         notify_status=EXCLUDED.notify_status, notify_detail=EXCLUDED.notify_detail,
         basis=EXCLUDED.basis, basis_label=EXCLUDED.basis_label, price_as_of=EXCLUDED.price_as_of,
         history_fetched_at=EXCLUDED.history_fetched_at, stale=EXCLUDED.stale,
         models=EXCLUDED.models, currency=EXCLUDED.currency, last_eval_note=EXCLUDED.last_eval_note,
         updated_at=EXCLUDED.updated_at
       RETURNING *`,
      [
        e.instrumentId, e.symbol, e.name || null, e.status,
        e.firstBreachedAt || null, e.lastNotifiedAt || null, e.recoveredAt || null,
        e.referencePrice ?? null, e.referenceDate || null, e.priceAtBreach ?? null,
        e.drawdownAtBreach ?? null, e.currentPrice ?? null, e.currentDrawdown ?? null,
        e.threshold ?? null, e.notifyStatus || null, e.notifyDetail || null,
        e.basis || null, e.basisLabel || null, e.priceAsOf || null, e.historyFetchedAt || null,
        !!e.stale, JSON.stringify(e.models || []), e.currency || null, e.lastEvalNote || null,
        e.updatedAt || new Date().toISOString(),
      ],
    );
    return this._rowToAlertEvent(rows[0]);
  }

  _rowToAlertHistory(r) {
    if (!r) return null;
    return {
      id: r.id,
      instrumentId: r.instrument_id,
      symbol: r.symbol,
      name: r.name,
      kind: r.kind,
      at: isoTs(r.at),
      drawdown: numOrNull(r.drawdown),
      price: numOrNull(r.price),
      referencePrice: numOrNull(r.reference_price),
      referenceDate: r.reference_date ? d(r.reference_date) : null,
      detail: r.detail,
      models: r.models || [],
    };
  }
  async appendAlertHistory(entry) {
    await this.q(
      `INSERT INTO alert_history (
         id, instrument_id, symbol, name, kind, at, drawdown, price, reference_price, reference_date, detail, models
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb)`,
      [
        entry.id, entry.instrumentId, entry.symbol, entry.name || null, entry.kind, entry.at,
        entry.drawdown ?? null, entry.price ?? null, entry.referencePrice ?? null,
        entry.referenceDate || null, entry.detail || null, JSON.stringify(entry.models || []),
      ],
    );
    return entry;
  }
  async listAlertHistory(limit = 40) {
    const { rows } = await this.q(
      'SELECT * FROM alert_history ORDER BY at DESC LIMIT $1',
      [Math.max(1, Number(limit) || 40)],
    );
    return rows.map((r) => this._rowToAlertHistory(r));
  }

  async _versionsFor(modelKey) {
    const { rows: vrows } = await this.q(
      'SELECT * FROM versions WHERE model_key=$1 ORDER BY effective_date', [modelKey]
    );
    const versions = [];
    for (const v of vrows) {
      const { rows: hrows } = await this.q(
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
    const { rows } = await this.q('SELECT * FROM models ORDER BY risk_rank');
    const out = [];
    for (const m of rows) {
      out.push({ key: m.key, name: m.name, riskRank: m.risk_rank, benchmark: m.benchmark, versions: await this._versionsFor(m.key) });
    }
    return out;
  }
  async getModel(key) {
    const { rows } = await this.q('SELECT * FROM models WHERE key=$1', [key]);
    if (!rows[0]) return null;
    const m = rows[0];
    return { key: m.key, name: m.name, riskRank: m.risk_rank, benchmark: m.benchmark, versions: await this._versionsFor(m.key) };
  }

  async addVersion(key, { effectiveDate, note, holdings }) {
    const model = await this.q('SELECT key FROM models WHERE key=$1', [key]);
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

    const eff = effectiveDate || new Date().toISOString().slice(0, 10);
    const cur = currentVersionOf({ versions: await this._versionsFor(key) });
    if (cur && cur.effectiveDate === eff && cur.note === (note || '') && holdingsEqual(cur.holdings, resolved)) {
      return { noChange: true };
    }

    const id = uid('ver');
    const client = await this.pool.connect();
    try {
      await this.qOn(client, 'BEGIN');
      await this.qOn(client, 'INSERT INTO versions (id,model_key,effective_date,note) VALUES ($1,$2,$3,$4)', [id, key, eff, note || '']);
      for (const h of resolved) {
        await this.qOn(client, 'INSERT INTO version_holdings (version_id,instrument_id,weight) VALUES ($1,$2,$3)', [id, h.instrumentId, h.weight]);
      }
      await this.qOn(client, 'COMMIT');
    } catch (e) {
      await this.qOn(client, 'ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
    return { id, effectiveDate: eff, note: note || '', holdings: resolved };
  }
}
