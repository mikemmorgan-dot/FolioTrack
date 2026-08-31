// index.js — API + static host for the built React client.
import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { getStore } from './store.js';
import { getQuote, getHistory, lookup, probeAll } from './providers.js';
import { currentVersionOf } from './util.js';
import { runPerformance, gatherReturns, returnsForRefs, computeCore } from './perf.js';
import { riskMetrics, staticPortfolioMonthly } from './risk.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json());

const store = await getStore();

// --- tiny quote cache so we don't hammer Yahoo on every view ---
const cache = new Map();
const TTL_MS = 60 * 1000;
async function cachedQuote(symbol) {
  const hit = cache.get(symbol);
  if (hit && Date.now() - hit.t < TTL_MS) return hit.v;
  const v = await getQuote(symbol);
  cache.set(symbol, { t: Date.now(), v });
  return v;
}

// Hybrid price seam: 'auto' → Yahoo, 'manual' → latest stored NAV.
async function enrichHoldings(version) {
  if (!version) return [];
  const out = [];
  for (const h of version.holdings) {
    const inst = await store.getInstrument(h.instrumentId);
    if (!inst) continue;
    let price = null, priceAsOf = null, priceSource = inst.source;
    try {
      if (inst.source === 'auto') {
        const q = await cachedQuote(inst.symbol);
        price = q.price; priceAsOf = q.asOf;
      } else {
        const nav = await store.latestNav(inst.id);
        price = nav?.nav ?? null; priceAsOf = nav?.date ?? null;
      }
    } catch (e) {
      priceSource = `${inst.source} (error: ${e.message})`;
    }
    out.push({ ...inst, weight: h.weight, price, priceAsOf, priceSource });
  }
  return out;
}

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
  const holdings = await enrichHoldings(cv);
  res.json({
    key: m.key, name: m.name, riskRank: m.riskRank, benchmark: m.benchmark,
    versions: m.versions.map((v) => ({ id: v.id, effectiveDate: v.effectiveDate, note: v.note, holdingCount: v.holdings.length })),
    currentVersion: cv ? { id: cv.id, effectiveDate: cv.effectiveDate, note: cv.note, holdings: cv.holdings } : null,
    holdings,
  });
});

// A model change = a new effective-dated version. Holdings may reference an
// existing instrumentId OR carry an { instrument } spec for a brand-new ticker,
// which is upserted on the fly (with optional initialNav for manual funds/alts).
app.post('/api/models/:key/versions', async (req, res) => {
  try {
    const v = await store.addVersion(req.params.key, req.body || {});
    if (!v) return res.status(404).json({ error: 'Model not found' });
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
    const { grid, instReturns, instMeta, benchMonthly, dataNotes } = await gatherReturns(m, fetchers());
    const core = computeCore({ grid, versions: m.versions, instReturns, benchMonthly, instMeta });
    const months = core.grid.slice(1); // active months
    const modelRets = core.model.cumulative.slice(1).map((p) => p.ret);
    const benchRets = months.map((ym) => (benchMonthly[ym] ?? null));
    const metrics = riskMetrics(modelRets, benchRets, rf);
    res.json({ key: m.key, name: m.name, rf, metrics, coverageMin: core.coverageMin, dataNotes });
  } catch (e) {
    res.status(500).json({ error: e.message });
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

app.get('/api/instruments', async (_req, res) => res.json(await store.listInstruments()));
app.post('/api/instruments', async (req, res) => res.status(201).json(await store.addInstrument(req.body || {})));
app.post('/api/instruments/:id/nav', async (req, res) => {
  const inst = await store.getInstrument(req.params.id);
  if (!inst) return res.status(404).json({ error: 'Instrument not found' });
  res.status(201).json(await store.addNav(req.params.id, req.body || {}));
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
