// index.js — API + static host for the built React client.
import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { getStore } from './store.js';
import { getQuote, getHistory, lookup, probeAll } from './providers.js';
import { createQuoteCache, enrichHoldings, quotePatch } from './enrich.js';
import { currentVersionOf } from './util.js';
import { listInUseManualInstruments } from './nav.js';
import { runPerformance, gatherReturns, returnsForRefs, monthGrid, levelsOnGrid, monthlyReturnsFromLevels } from './perf.js';
import { riskMetrics, staticPortfolioMonthly } from './risk.js';
import { runOptimize } from './optimize.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json());

const store = await getStore();

// Quote cache (60s) + in-flight dedupe so a model view doesn't stampede the
// provider chain. GET /api/models/:key peeks this cache only — it never waits
// on a live fetch — so the current version can render immediately.
const quotes = createQuoteCache({ getQuote });
const cachedQuote = (symbol) => quotes.cachedQuote(symbol);

// ---------------- API ----------------
app.get('/api/health', (_req, res) => res.json({ ok: true, ts: new Date().toISOString() }));

app.get('/api/models', async (_req, res) => {
  const models = await store.listModels();
  res.json(models.map((m) => {
    const cv = currentVersionOf(m);
    return {
      key: m.key, name: m.name, riskRank: m.riskRank,
      versionCount: m.versions.length,
      currentEffectiveDate: cv?.effectiveDate ?? null,
      holdingCount: cv?.holdings.length ?? 0,
    };
  }));
});

app.get('/api/models/:key', async (req, res) => {
  const m = await store.getModel(req.params.key);
  if (!m) return res.status(404).json({ error: 'Model not found' });
  const cv = currentVersionOf(m);
  // Cache-only prices: never block the book on the provider chain.
  const holdings = await enrichHoldings(cv, store, quotes, { liveQuotes: false });
  res.json({
    key: m.key, name: m.name, riskRank: m.riskRank, benchmark: m.benchmark,
    versions: m.versions.map((v) => ({ id: v.id, effectiveDate: v.effectiveDate, note: v.note, holdingCount: v.holdings.length })),
    currentVersion: cv ? { id: cv.id, effectiveDate: cv.effectiveDate, note: cv.note, holdings: cv.holdings } : null,
    holdings,
  });
});

// Live prices for a model already painted from GET /api/models/:key.
// Auto holdings missing from the quote cache are fetched (in parallel);
// manual NAVs are local and cheap. Safe to ignore if the client has moved on.
app.get('/api/models/:key/quotes', async (req, res) => {
  try {
    const m = await store.getModel(req.params.key);
    if (!m) return res.status(404).json({ error: 'Model not found' });
    const cv = currentVersionOf(m);
    const holdings = await enrichHoldings(cv, store, quotes, { liveQuotes: true });
    res.json({ key: m.key, versionId: cv?.id ?? null, holdings: quotePatch(holdings) });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// A model change = a new effective-dated version. Holdings may reference an
// existing instrumentId OR carry an { instrument } spec for a brand-new ticker,
// which is upserted on the fly (with optional initialNav for manual funds/alts).
app.post('/api/models/:key/versions', async (req, res) => {
  try {
    const v = await store.addVersion(req.params.key, req.body || {});
    if (!v) return res.status(404).json({ error: 'Model not found' });
    if (v.noChange) return res.status(200).json({ noChange: true, message: 'No changes from the current version — nothing was saved.' });
    res.status(201).json(v);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Ticker resolution for the editor.
app.get('/api/lookup/:symbol', async (req, res) => {
  const r = await lookup(req.params.symbol);
  if (!r.found) console.warn(`[yahoo] lookup ${req.params.symbol}: ${r.blocked ? 'BLOCKED' : 'not found'} — ${r.reason}`);
  res.json(r);
});

// Which price providers are reachable from this server? Open in a browser to check.
app.get('/api/diagnostics', async (req, res) => {
  const symbols = req.query.symbols ? req.query.symbols.split(',') : ['AAPL', 'XBB.TO'];
  const probe = await probeAll(symbols);
  res.json({
    storage: process.env.DATABASE_URL ? 'postgres' : 'json-ephemeral',
    ...probe,
    ts: new Date().toISOString(),
  });
});

// --- history cache (1h) so the perf engine doesn't refetch on every open ---
const histCache = new Map();
const HIST_TTL = 60 * 60 * 1000;
async function cachedHistory(symbol, range) {
  const k = `${symbol}:${range}`;
  const hit = histCache.get(k);
  if (hit && Date.now() - hit.t < HIST_TTL) return hit.v;
  try {
    const v = await getHistory(symbol, range);
    histCache.set(k, { t: Date.now(), v });
    return v;
  } catch (e) {
    console.warn(`[yahoo] history failed for ${symbol}: ${e.message}`);
    throw e;
  }
}



const fetchers = () => ({
  getInstrument: (id) => store.getInstrument(id),
  getNavSeries: (id) => store.getNavSeries(id),
  getHistory: (symbol, range) => cachedHistory(symbol, range),
});

// Return & attribution engine.
app.get('/api/models/:key/performance', async (req, res) => {
  try {
    const m = await store.getModel(req.params.key);
    if (!m) return res.status(404).json({ error: 'Model not found' });
    const payload = await runPerformance(m, fetchers());
    res.json({ key: m.key, name: m.name, ...payload });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

const parseRf = (q) => {
  const v = parseFloat(q);
  return Number.isFinite(v) ? v / 100 : 0.04; // rf passed as a percent (e.g. 4 → 0.04)
};

// Realized risk of the model as actually run (version-chained series).
app.get('/api/models/:key/risk', async (req, res) => {
  try {
    const m = await store.getModel(req.params.key);
    if (!m) return res.status(404).json({ error: 'Model not found' });
    const rf = parseRf(req.query.rf);
    const { grid, instReturns, benchMonthly, dataNotes } = await gatherReturns(m, fetchers());
    // Backtest the CURRENT target weights held statically over each holding's
    // full available history — not the model's actual realized version-chain
    // history. Mike wants this specifically so the Risk tab answers "would a
    // change help or hurt risk-adjusted return", which needs a like-for-like
    // baseline comparable to the pre-trade preview and optimizer (both of
    // which already backtest this way) — the realized/chained history is a
    // different, valid question ("how did my actual decisions do") that
    // stays in the Performance tab's change attribution, unchanged here.
    const cur = currentVersionOf(m);
    const baseRefs = (cur?.holdings || []).map((h) => ({ ref: h.instrumentId, weight: h.weight }));
    const series = staticPortfolioMonthly(baseRefs, instReturns, grid);
    const benchRets = series.months.map((ym) => (benchMonthly[ym] ?? null));
    const metrics = riskMetrics(series.rets, benchRets, rf);
    res.json({ key: m.key, name: m.name, rf, metrics, coverageMin: series.coverageMin, dataNotes });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Ex-ante max-Sharpe suggestion from historical mean/covariance — NOT a
// forecast, see optimize.js. maxWeight is an optional per-holding cap, passed
// as a percent (e.g. 30 -> 0.30).
app.get('/api/models/:key/optimize', async (req, res) => {
  try {
    const m = await store.getModel(req.params.key);
    if (!m) return res.status(404).json({ error: 'Model not found' });
    const rf = parseRf(req.query.rf);
    const maxWeight = req.query.maxWeight != null && req.query.maxWeight !== ''
      ? Number(req.query.maxWeight) / 100 : null;
    const result = await runOptimize(m, fetchers(), { gatherReturns, currentVersionOf }, { rf, maxWeight });
    res.json(result);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Pre-trade what-if: compare proposed weights vs the current version's weights,
// both held statically over the same history, so deltas isolate the change.
app.post('/api/models/:key/simulate', async (req, res) => {
  try {
    const m = await store.getModel(req.params.key);
    if (!m) return res.status(404).json({ error: 'Model not found' });
    const rf = parseRf(req.body?.rf);
    const proposed = (req.body?.holdings || []).map((h) => ({
      ref: h.instrumentId || (h.symbol || '').toUpperCase(),
      instrumentId: h.instrumentId || null,
      symbol: (h.symbol || '').toUpperCase(),
      source: h.source || 'auto',
      weight: Number(h.weight),
    }));

    const cur = currentVersionOf(m);

    // gather returns for the saved model (gives grid, benchMonthly, existing instReturns by id)
    const { grid, instReturns, benchMonthly, dataNotes } = await gatherReturns(m, fetchers());

    // baseline = current version holdings, keyed by instrumentId
    const baseRefs = (cur?.holdings || []).map((h) => ({ ref: h.instrumentId, weight: h.weight }));
    const byRef = { ...instReturns };

    // fetch any proposed refs not already present (new tickers)
    const need = proposed.filter((p) => !byRef[p.ref]);
    if (need.length) Object.assign(byRef, await returnsForRefs(need, fetchers(), grid));

    const baseSeries = staticPortfolioMonthly(baseRefs, byRef, grid);
    const propSeries = staticPortfolioMonthly(proposed, byRef, grid);

    const alignBench = (months) => months.map((ym) => (benchMonthly[ym] ?? null));
    const baseMetrics = riskMetrics(baseSeries.rets, alignBench(baseSeries.months), rf);
    const propMetrics = riskMetrics(propSeries.rets, alignBench(propSeries.months), rf);

    const DELTA_KEYS = ['sharpe', 'sortino', 'informationRatio', 'volatility', 'maxDrawdown', 'beta', 'trackingError', 'annualizedReturn'];
    const deltas = {};
    for (const k of DELTA_KEYS) {
      const a = baseMetrics[k], b = propMetrics[k];
      deltas[k] = a != null && b != null ? b - a : null;
    }

    res.json({
      key: m.key, rf,
      baseline: { metrics: baseMetrics, coverageMin: baseSeries.coverageMin },
      proposed: { metrics: propMetrics, coverageMin: propSeries.coverageMin },
      deltas,
      unresolved: proposed.filter((p) => !byRef[p.ref]).map((p) => p.symbol || p.ref),
      dataNotes,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/instruments', async (req, res) => {
  try {
    // Prices panel: unique manuals in any current version, with latest NAV and
    // which models use them — one round-trip, cash excluded, no quote APIs.
    if ((req.query.inUse === '1' || req.query.inUse === 'true') && req.query.source === 'manual') {
      return res.json(await listInUseManualInstruments(store));
    }
    let list = await store.listInstruments();
    if (req.query.source) list = list.filter((i) => i.source === req.query.source);
    res.json(list);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
app.post('/api/instruments', async (req, res) => res.status(201).json(await store.addInstrument(req.body || {})));

// Many dated NAV points, one transaction. Does not create a model version.
app.post('/api/nav/batch', async (req, res) => {
  try {
    const { asOf, points } = req.body || {};
    if (!Array.isArray(points)) return res.status(400).json({ error: 'points must be an array' });
    const result = await store.addNavBatch({ asOf, points });
    res.json(result);
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});
// Factsheet entry: sector/country and their fund look-through breakdowns.
app.put('/api/instruments/:id', async (req, res) => {
  const inst = await store.updateInstrument(req.params.id, req.body || {});
  if (!inst) return res.status(404).json({ error: 'Instrument not found' });
  res.json(inst);
});
app.post('/api/instruments/:id/nav', async (req, res) => {
  const inst = await store.getInstrument(req.params.id);
  if (!inst) return res.status(404).json({ error: 'Instrument not found' });
  res.status(201).json(await store.addNav(req.params.id, req.body || {}));
});

// Quote/chart/basic performance for a single instrument — the "tap a
// security" detail view. Performance stats are computed from the same
// instrument's own price/NAV history (not the model's), so they only need
// >=2 monthly observations to exist, unlike the model-level engines.
app.get('/api/instruments/:id/detail', async (req, res) => {
  try {
    const inst = await store.getInstrument(req.params.id);
    if (!inst) return res.status(404).json({ error: 'Instrument not found' });
    const range = req.query.range || '1y';
    const rf = parseRf(req.query.rf);

    let series = [], quote = null, error = null;
    if (inst.source === 'auto') {
      try {
        const h = await cachedHistory(inst.symbol, range);
        series = h.series.map((p) => ({ date: p.date, value: p.close }));
      } catch (e) { error = e.message; }
      try { quote = await cachedQuote(inst.symbol); } catch (e) { if (!error) error = e.message; }
    } else {
      series = (await store.getNavSeries(inst.id)).map((p) => ({ date: p.date, value: p.nav }));
      const latest = await store.latestNav(inst.id);
      quote = latest ? { price: latest.nav, asOf: latest.date, currency: inst.currency } : null;
    }

    let stats = null;
    if (series.length >= 2) {
      const grid = monthGrid(series[0].date.slice(0, 7), new Date().toISOString().slice(0, 7));
      const levels = levelsOnGrid(series, grid);
      const rets = monthlyReturnsFromLevels(levels, grid);
      const monthlyRets = grid.slice(1).map((ym) => rets[ym]).filter((r) => r != null);
      if (monthlyRets.length >= 2) {
        const m = riskMetrics(monthlyRets, monthlyRets.map(() => null), rf);
        stats = { annualizedReturn: m.annualizedReturn, volatility: m.volatility, maxDrawdown: m.maxDrawdown, months: m.n };
      }
    }

    res.json({ instrument: inst, quote, series, stats, error });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/quote/:symbol', async (req, res) => {
  try { res.json(await cachedQuote(req.params.symbol)); }
  catch (e) { res.status(502).json({ error: e.message }); }
});
app.get('/api/history/:symbol', async (req, res) => {
  try { res.json(await getHistory(req.params.symbol, req.query.range || '1y', req.query.interval || '1d')); }
  catch (e) { res.status(502).json({ error: e.message }); }
});

// ---------------- static client ----------------
const clientDist = path.join(__dirname, '..', 'client', 'dist');
app.use(express.static(clientDist));
app.get('*', (_req, res) => res.sendFile(path.join(clientDist, 'index.html')));

const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log(`MPT server on :${PORT}`);
  // State the Yahoo verdict in the deploy log so it never has to be guessed.
  const probe = await probeAll();
  console.log(`[data] ${probe.verdict}`);
  for (const r of probe.results) {
    if (!r.ok) console.warn(`[data] ${r.provider} ${r.symbol}: ${r.error}`);
  }
});
