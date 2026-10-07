import { describe, it, expect } from 'vitest';
import {
  PRICE_SNAPSHOT_SQL,
  NAV_SNAPSHOT_SQL,
  PRICE_WINDOW_SQL,
  NAV_WINDOW_SQL,
  PRICE_META_SQL,
  PRICE_META_UPSERT_SQL,
  PRICE_POINTS_UPSERT_SQL,
  PRICE_POINTS_BACKFILL_SQL,
  PRICE_SERIES_CLEAR_SQL,
  NAV_UPSERT_SQL,
  INSTRUMENT_CORE_SQL,
} from './seriesSql.js';
import { poolOptions } from './db.js';
import {
  resolveDrawdown,
  resolveDrawdownFromSnapshot,
  snapshotFromSeries,
  evaluateHolding,
  evaluateFromSnapshot,
  WEEKS_52_DAYS,
} from './alerts/drawdown.js';
import { noteEgress, logEgress, egressAls, approxJsonBytes } from './egress.js';
import { rangeStartIso } from './historyCache.js';

const TODAY = '2026-09-01';

function sqlBlob(sql) {
  return String(sql).toLowerCase();
}

describe('history queries do not ship the price blob', () => {
  const reads = [
    PRICE_SNAPSHOT_SQL,
    NAV_SNAPSHOT_SQL,
    PRICE_WINDOW_SQL,
    NAV_WINDOW_SQL,
    PRICE_POINTS_UPSERT_SQL,
    NAV_UPSERT_SQL,
    INSTRUMENT_CORE_SQL,
  ];

  it('never SELECT * and never reads price_history.series on the hot path', () => {
    for (const sql of reads) {
      expect(sqlBlob(sql)).not.toMatch(/select\s+\*/);
      expect(sql).not.toMatch(/\bseries\b/);
    }
  });

  it('price meta returns a count and a legacy flag, not the blob', () => {
    expect(PRICE_META_SQL).toMatch(/AS has_legacy/);
    expect(PRICE_META_SQL).toMatch(/count\(\*\)::int/);
    expect(PRICE_META_SQL).not.toMatch(/jsonb_array_elements/);
    expect(PRICE_META_SQL).not.toMatch(/SELECT\s+series/i);
  });

  it('asks Postgres for the latest close and the 52-week high, not every row', () => {
    expect(PRICE_SNAPSHOT_SQL).toMatch(/ORDER BY date DESC\s+LIMIT 1/);
    expect(PRICE_SNAPSHOT_SQL).toMatch(/ORDER BY p\.close DESC, p\.date DESC\s+LIMIT 1/);
    expect(PRICE_SNAPSHOT_SQL).toMatch(/\$2::int/);
    expect(WEEKS_52_DAYS).toBe(364);
    expect(NAV_SNAPSHOT_SQL).toMatch(/ORDER BY nav DESC, date DESC\s+LIMIT 1/);
    expect(NAV_SNAPSHOT_SQL).toMatch(/ORDER BY date DESC\s+LIMIT 1/);
  });

  it('bounds a chart or return window and leaves max unbounded', () => {
    expect(PRICE_WINDOW_SQL).toMatch(/date >= \$2::date/);
    expect(PRICE_WINDOW_SQL).toMatch(/date <= \$3::date/);
    expect(NAV_WINDOW_SQL).toMatch(/\$2::date IS NULL OR date >= \$2::date/);
    expect(rangeStartIso('1y', Date.parse('2026-09-01T00:00:00.000Z'))).toBe('2025-09-01');
    expect(rangeStartIso('max', Date.parse('2026-09-01T00:00:00.000Z'))).toBeNull();
  });

  it('does not rewrite a close or a nav that is already stored', () => {
    expect(PRICE_POINTS_UPSERT_SQL).toMatch(/IS DISTINCT FROM/);
    expect(PRICE_POINTS_UPSERT_SQL).not.toMatch(/RETURNING/);
    expect(NAV_UPSERT_SQL).toMatch(/nav_series\.nav IS DISTINCT FROM EXCLUDED\.nav/);
    expect(PRICE_META_UPSERT_SQL).not.toMatch(/RETURNING/);
  });

  it('copies the old blob inside the database and does not return it', () => {
    expect(PRICE_POINTS_BACKFILL_SQL).toMatch(/jsonb_array_elements/);
    expect(PRICE_POINTS_BACKFILL_SQL).toMatch(/DISTINCT ON/);
    expect(PRICE_POINTS_BACKFILL_SQL).toMatch(/ON CONFLICT \(symbol, date\) DO NOTHING/);
    expect(PRICE_POINTS_BACKFILL_SQL).not.toMatch(/RETURNING/);
    expect(PRICE_SERIES_CLEAR_SQL).toMatch(/series = '\[\]'::jsonb/);
    expect(PRICE_SERIES_CLEAR_SQL).not.toMatch(/RETURNING/);
  });

  it('alert instrument reads skip breakdown and factsheet columns', () => {
    expect(INSTRUMENT_CORE_SQL).toMatch(/nav_source/);
    expect(INSTRUMENT_CORE_SQL).not.toMatch(/sector_breakdown/);
    expect(INSTRUMENT_CORE_SQL).not.toMatch(/published_returns/);
    expect(INSTRUMENT_CORE_SQL).not.toMatch(/\bmeta\b/);
  });
});

describe('snapshot drawdown matches a full series walk', () => {
  const historySeries = [
    { date: '2024-01-01', close: 500 },
    { date: '2025-09-01', close: 400 },
    { date: '2026-01-15', close: 200 },
    { date: '2026-03-01', close: 200 },
    { date: 'bad', close: 999 },
    { date: '2026-01-15', close: 1 },
    { date: '2026-09-01', close: 140 },
  ];
  const navSeries = [
    { date: '2024-01-02', nav: 80 },
    { date: '2025-06-30', nav: 120 },
    { date: '2026-08-01', nav: 90 },
  ];

  it('reproduces 52-week and NAV results from the aggregate fields alone', () => {
    const fromSeries = resolveDrawdown({ today: TODAY, historySeries, navSeries, historyFetchedAt: '2026-09-01T12:00:00.000Z' });
    const snap = snapshotFromSeries({ historySeries, navSeries, historyFetchedAt: '2026-09-01T12:00:00.000Z' });
    // A SQL row has the same fields and no daily points.
    const fromDb = resolveDrawdownFromSnapshot({
      price: {
        n: snap.price.n,
        firstDate: snap.price.firstDate,
        latestDate: snap.price.latestDate,
        latestClose: snap.price.latestClose,
        peakDate: snap.price.peakDate,
        peakClose: snap.price.peakClose,
        fetchedAt: snap.price.fetchedAt,
      },
      nav: snap.nav,
    }, { today: TODAY });
    expect(fromDb).toEqual(fromSeries);
    expect(fromDb.referenceDate).toBe('2026-03-01');
    expect(fromDb.referencePrice).toBe(200);
    expect(fromDb.currentPrice).toBe(140);
  });

  it('prefers NAV when the snapshot says a NAV point exists', () => {
    const inst = { id: 'inst_ry', symbol: 'RY.TO', name: 'Royal Bank', type: 'stock', source: 'auto', currency: 'CAD' };
    const models = [{ key: 'growth', name: 'Growth', weight: 0.1 }];
    const snap = snapshotFromSeries({ historySeries, navSeries });
    const fromSnap = evaluateFromSnapshot({ inst, models, snap, today: TODAY });
    const fromRows = evaluateHolding({
      inst, models, today: TODAY, historySeries: [], navSeries,
    });
    expect(fromSnap.basis).toBe('nav');
    expect(fromSnap.referencePrice).toBe(fromRows.referencePrice);
    expect(fromSnap.currentPrice).toBe(90);
  });
});

describe('egress log', () => {
  it('counts rows and approximate bytes for the active request only', () => {
    const lines = [];
    const orig = console.log;
    console.log = (...args) => lines.push(args.join(' '));
    try {
      egressAls.run({ label: 'GET /api/history/RY.TO', queries: 0, rows: 0, bytes: 0, logged: false }, () => {
        noteEgress(252, approxJsonBytes([{ date: '2026-09-01', close: 10 }]));
        logEgress('GET /api/history/RY.TO');
      });
      expect(lines[0]).toMatch(/GET \/api\/history\/RY.TO queries=1 rows=252 bytes~\d+/);
      lines.length = 0;
      logEgress('outside');
      expect(lines).toEqual([]);
    } finally {
      console.log = orig;
    }
  });
});

describe('pool', () => {
  it('caps the pool and drops idle clients before Neon does', () => {
    const opts = poolOptions({ DATABASE_URL: 'postgres://example', PGSSL: 'disable' });
    expect(opts.max).toBe(5);
    expect(opts.idleTimeoutMillis).toBeGreaterThan(0);
    expect(opts.connectionTimeoutMillis).toBeGreaterThan(0);
    expect(opts.keepAlive).toBe(true);
    expect(opts.ssl).toBe(false);
  });
});
