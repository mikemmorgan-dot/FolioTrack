// index.js — API + static host for the built React client.
import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { getStore } from './store.js';
import { getQuote, getHistory, lookup, probeAll, providerStatusList } from './providers.js';
import { yahooStatus } from './yahoo.js';
import { tmxStatus } from './tmx.js';
import {
  isYahooHistoryEligible,
  yahooSymbolFor,
  yahooPageUrl,
  fetchYahooHistoryForSymbol,
  planApplySeries,
  parseYahooPaste,
  YahooSeriesError,
  YAHOO_PRICE_SOURCE,
  TMX_PRICE_SOURCE,
  navSourceForApply,
} from './yahooSeries.js';
import { createHistoryCache } from './historyCache.js';
import { createQuoteCache, enrichHoldings, quotePatch } from './enrich.js';
import { currentVersionOf } from './util.js';
import { listInUseManualInstruments } from './nav.js';
import { loadNavMarket } from './navPrice.js';
import { runPerformance, gatherReturns, returnsForRefs, monthGrid, levelsOnGrid, monthlyReturnsFromLevels } from './perf.js';
import { riskMetrics, staticPortfolioMonthly } from './risk.js';
import { compareStaticRisk, newHoldingProjectionStatus, hasUsableReturns } from './projection.js';
import { runOptimize } from './optimize.js';
import { lookupSource } from './factsheet/sources.js';
import { fetchBreakdownForSymbol, BreakdownFetchError } from './factsheet/fetchBreakdown.js';
import { firstAddedToModel, filterSeriesByRange, periodReturnFromSeries, rangeBounds } from './holdingHistory.js';
import { periodReturnsFromSeries } from './periodReturns.js';
import { createPriceUploadRouter } from './historyUpload.js';
import { publishedToPeriodRow } from './factsheet/publishedReturns.js';
import { buildCompare } from './compare.js';
import { createEmailSender } from './alerts/email.js';
import { createAlertService } from './alerts/check.js';
import { createAlertRouter } from './alerts/http.js';
import { createAlertCoordinator } from './alerts/runner.js';
import { startAlertScheduler } from './alerts/schedule.js';
import { listenThenStart } from './boot.js';
import { egressMiddleware, openEgressScope } from './egress.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;

// Listen first. Migrations, the provider probe, and the first alert check run
// only after the socket is open so /api/health can answer a cold-start ping.
const boot = listenThenStart({
  app,
  port: PORT,
  getStore,
  mount: async (expressApp) => {
    // Prices Apply posts the proposed series back. A max TMX history is a few
    // hundred KB, over Express's default 100kb, which surfaced as HTTP 413.
    // PDF/CSV upload parses its own body (up to ~10MB) and must not hit this cap.
    const jsonParser = express.json({ limit: '2mb' });
    expressApp.use((req, res, next) => {
      if (req.path === '/api/prices/parse-pdf') return next();
      return jsonParser(req, res, next);
    });
  },
  logger: console,
});

const { store } = await boot.started;

// Health is registered before this middleware, so a keep-alive ping never
// reaches it and never opens a database scope.
app.use(egressMiddleware);

// Quote cache (60s) + in-flight dedupe so a model view doesn't stampede the
// provider chain. GET /api/models/:key peeks this cache only — it never waits
// on a live fetch — so the current version can render immediately.
const quotes = createQuoteCache({ getQuote });
const cachedQuote = (symbol) => quotes.cachedQuote(symbol);

// ---------------- API ----------------
app.use(createPriceUploadRouter(store));

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

// Side-by-side of every model's *current* version: weights, overlap, MER, risk rank.
// Cache-only enrich — no live quotes. Overlap math lives in compare.js.
app.get('/api/compare', async (_req, res) => {
  try {
    const models = await store.listModels();
    const snapshots = [];
    for (const m of models) {
      const cv = currentVersionOf(m);
      const holdings = await enrichHoldings(cv, store, quotes, { liveQuotes: false });
      snapshots.push({
        key: m.key,
        name: m.name,
        riskRank: m.riskRank,
        versionCount: m.versions.length,
        currentVersion: cv ? { id: cv.id, effectiveDate: cv.effectiveDate } : null,
        holdings,
      });
    }
    res.json(buildCompare(snapshots));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
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
    providers: providerStatusList(),
    yahoo: yahooStatus(),
    tmx: tmxStatus(),
    relay: yahooStatus().relay,
    ts: new Date().toISOString(),
  });
});

// Persistent history cache (Postgres / JSON) + 18h TTL. Live providers are
// only called on a miss or stale row; a stored series is returned with
// stale: true if every live hop fails. Sequential chain + provider cooldown
// live in providers.js / historyCache.js.
const history = createHistoryCache({
  getPriceHistory: (symbol, opts) => store.getPriceHistory(symbol, opts),
  getPriceHistoryMeta: (symbol) => store.getPriceHistoryMeta?.(symbol) ?? null,
  putPriceHistory: (symbol, rec) => store.putPriceHistory(symbol, rec),
  fetchLive: (symbol, range) => getHistory(symbol, range),
});
async function cachedHistory(symbol, range, opts) {
  try {
    return await history.getHistory(symbol, range, opts);
  } catch (e) {
    console.warn(`[history] ${symbol}: ${e.message}`);
    throw e;
  }
}
const refreshFlag = (q) => q === '1' || q === 'true';



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
      hypothetical: !!h.hypothetical,
      initialNav: h.initialNav || null,
    }));

    const cur = currentVersionOf(m);

    // gather returns for the saved model (gives grid, benchMonthly, existing instReturns by id)
    const { grid, instReturns, benchMonthly, dataNotes } = await gatherReturns(m, fetchers());

    // baseline = current version holdings, keyed by instrumentId
    const baseRefs = (cur?.holdings || []).map((h) => ({ ref: h.instrumentId, weight: h.weight }));
    const byRef = { ...instReturns };

    // New tickers (and a manual NAV that isn't a saved instrument yet) are
    // priced through the same cached history path as everything else.
    const need = proposed.filter((p) => !hasUsableReturns(byRef[p.ref]) && (p.hypothetical || !byRef[p.ref]));
    if (need.length) Object.assign(byRef, await returnsForRefs(need, fetchers(), grid));

    const compared = compareStaticRisk({
      baseline: baseRefs,
      proposed,
      returnsByRef: byRef,
      grid,
      benchMonthly,
      rf,
    });
    const hypo = proposed.find((p) => p.hypothetical) || null;

    res.json({
      key: m.key,
      rf,
      ...compared,
      newHolding: newHoldingProjectionStatus(hypo, byRef),
      dataNotes,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/instruments', async (req, res) => {
  try {
    // Prices panel: unique non-cash names in any current version, with latest
    // NAV and which models use them — one round-trip, no quote APIs. Autos
    // are included so a TSX name can take a NAV when the provider chain dies.
    if (req.query.inUse === '1' || req.query.inUse === 'true') {
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
    const result = await store.addNavBatch({ asOf, points, navSource: 'manual' });
    res.json(result);
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});
// Factsheet entry: sector/country and their fund look-through breakdowns.
app.put('/api/instruments/:id', async (req, res) => {
  try {
    const inst = await store.updateInstrument(req.params.id, req.body || {});
    if (!inst) return res.status(404).json({ error: 'Instrument not found' });
    res.json(inst);
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
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

    let series = [], quote = null, error = null, stale = false, fetchedAt = null, fromCache = false;
    let priceSource = inst.source === 'manual' ? 'nav_series' : 'auto';
    const navMarket = await loadNavMarket(store, inst);
    if (navMarket.hasNav) {
      priceSource = 'nav_series';
      series = navMarket.series.map((p) => ({ date: p.date, value: p.price }));
      quote = navMarket.quote;
    } else if (inst.source === 'auto') {
      try {
        const h = await cachedHistory(inst.symbol, range, { force: refreshFlag(req.query.refresh) });
        series = (h.series || []).map((p) => ({ date: p.date, value: p.close }));
        stale = !!h.stale;
        fetchedAt = h.fetchedAt || null;
        fromCache = !!h.fromCache;
        if (h.stale) error = h.error || 'Live providers unavailable — showing cached prices';
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

    const returns = periodReturnsFromSeries(series);

    res.json({
      instrument: inst, quote, series, stats, returns, error, stale, fetchedAt, fromCache,
      source: priceSource,
      navSource: inst.navSource || null,
      priceLabel: priceSource === 'nav_series' ? (inst.navSource || 'manual') : null,
      needMoreNav: priceSource === 'nav_series' && series.length < 2,
      publishedReturns: inst.publishedReturns || null,
      publishedPeriodReturns: publishedToPeriodRow(inst.publishedReturns),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Mapped? Cheap — no network. ClassifyPanel uses this to enable/disable Fetch.
app.get('/api/instruments/:id/factsheet-source', async (req, res) => {
  const inst = await store.getInstrument(req.params.id);
  if (!inst) return res.status(404).json({ error: 'Instrument not found' });
  const skip = inst.type === 'stock' || inst.type === 'alt' || inst.type === 'cash';
  const source = skip ? null : lookupSource(inst.symbol);
  res.json({
    symbol: inst.symbol,
    type: inst.type,
    mapped: !!source,
    source: source ? {
      issuer: source.issuer,
      parser: source.parser,
      url: source.url,
      series: source.series || null,
      fundserv: source.fundserv || null,
      documentLabel: source.documentLabel || null,
    } : null,
  });
});

// Propose a look-through from the issuer factsheet. Does not write the instrument.
app.post('/api/instruments/:id/fetch-breakdown', async (req, res) => {
  try {
    const inst = await store.getInstrument(req.params.id);
    if (!inst) return res.status(404).json({ error: 'Instrument not found' });
    if (inst.type === 'stock' || inst.type === 'alt' || inst.type === 'cash') {
      return res.status(422).json({
        error: `${inst.symbol} is a ${inst.type} — look-through is for funds. Enter a breakdown manually if you still want one.`,
      });
    }
    const payload = await fetchBreakdownForSymbol(inst.symbol);
    // MER is proposed only when the instrument does not already have one
    // (same rule as FID5982 — ClassifyPanel will not overwrite a filled MER).
    if (payload?.proposed?.mer != null && inst.mer != null && inst.mer !== '') {
      delete payload.proposed.mer;
    }
    res.json(payload);
  } catch (e) {
    if (e instanceof BreakdownFetchError) return res.status(e.status).json({ error: e.message, code: e.code });
    res.status(500).json({ error: e.message });
  }
});

// Eligible for Yahoo EOD fetch? Cheap — no network.
app.get('/api/instruments/:id/yahoo-source', async (req, res) => {
  const inst = await store.getInstrument(req.params.id);
  if (!inst) return res.status(404).json({ error: 'Instrument not found' });
  const eligible = isYahooHistoryEligible(inst);
  const yahooSymbol = yahooSymbolFor(inst.symbol);
  res.json({
    symbol: inst.symbol,
    type: inst.type,
    eligible,
    yahooSymbol,
    pageUrl: yahooPageUrl(yahooSymbol),
    historyUrl: yahooSymbol ? `https://ca.finance.yahoo.com/quote/${encodeURIComponent(yahooSymbol)}/history` : null,
    navSource: inst.navSource || null,
    priceSource: YAHOO_PRICE_SOURCE,
  });
});

// Propose an EOD series from Yahoo (or the PR #6 cache on 429). Does not write.
app.post('/api/instruments/:id/fetch-yahoo-history', async (req, res) => {
  try {
    const inst = await store.getInstrument(req.params.id);
    if (!inst) return res.status(404).json({ error: 'Instrument not found' });
    if (!isYahooHistoryEligible(inst)) {
      return res.status(422).json({
        error: `${inst.symbol} is not fetched from Yahoo — use Prices or a mapped issuer factsheet.`,
        code: 'ineligible',
        manualFallback: true,
      });
    }
    const existing = await store.getNavSeries(inst.id);
    const proposed = await fetchYahooHistoryForSymbol(inst.symbol, {
      getHistoryImpl: (symbol, range) => getHistory(symbol, range),
      getCached: (symbol) => store.getPriceHistory(symbol),
      putCached: (symbol, rec) => store.putPriceHistory(symbol, rec),
    });
    const plan = planApplySeries(existing, proposed.series, { existingSource: inst.navSource });
    res.json({
      ...proposed,
      existingCount: existing.length,
      needsConfirm: plan.needsConfirm,
      apply: plan.summary,
    });
  } catch (e) {
    if (e instanceof YahooSeriesError) {
      return res.status(e.status).json({
        error: e.message,
        code: e.code,
        manualFallback: e.manualFallback,
        retryAfterMs: e.retryAfterMs ?? null,
      });
    }
    res.status(502).json({
      error: e.message || 'Yahoo history failed. Enter prices manually in Prices.',
      code: 'blocked',
      manualFallback: true,
    });
  }
});

// Write a proposed (or pasted) series into nav_series. Merge by date.
app.post('/api/instruments/:id/apply-yahoo-history', async (req, res) => {
  try {
    const inst = await store.getInstrument(req.params.id);
    if (!inst) return res.status(404).json({ error: 'Instrument not found' });
    if (!isYahooHistoryEligible(inst)) {
      return res.status(422).json({
        error: `${inst.symbol} is not fetched from Yahoo — use Prices or a mapped issuer factsheet.`,
        code: 'ineligible',
        manualFallback: true,
      });
    }
    let series = [];
    if (Array.isArray(req.body?.series) && req.body.series.length) {
      series = req.body.series;
    } else if (req.body?.pasted) {
      series = parseYahooPaste(req.body.pasted);
    }
    if (!series.length) {
      return res.status(400).json({ error: 'Provide series rows or a Yahoo Date/Close paste.' });
    }
    const existing = await store.getNavSeries(inst.id);
    const navSource = navSourceForApply(req.body?.navSource);
    const plan = planApplySeries(existing, series, {
      confirm: !!req.body?.confirm,
      existingSource: inst.navSource,
    });
    if (plan.needsConfirm) {
      return res.status(409).json({
        needsConfirm: true,
        error: plan.error,
        ...plan.summary,
        source: navSource,
      });
    }

    const result = await store.addNavBatch({
      navSource,
      points: plan.series.map((p) => ({ instrumentId: inst.id, date: p.date, nav: p.close })),
    });
    const yahooSymbol = yahooSymbolFor(inst.symbol);
    await store.putPriceHistory(yahooSymbol, {
      series: plan.merged || plan.series,
      provider: navSource === TMX_PRICE_SOURCE ? 'tmx' : 'yahoo',
      range: 'max',
      fetchedAt: new Date().toISOString(),
    });
    const updated = await store.getInstrument(inst.id);
    const navMarket = await loadNavMarket(store, updated);
    const chart = navMarket.series.map((p) => ({ date: p.date, value: p.price }));
    res.json({
      applied: true,
      source: navSource,
      instrument: updated,
      latest: result.latest,
      count: chart.length,
      from: chart[0]?.date || null,
      to: chart.at(-1)?.date || null,
      quote: navMarket.quote,
      returns: periodReturnsFromSeries(chart),
      merge: 'by date — incoming close wins on a shared date; other existing dates are kept',
    });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

// Price series for a holding in a model: full available history, or since the
// first model version that included this instrument. TSX auto history is only
// as good as the free Yahoo/fallback chain (often thinner than US).
app.get('/api/models/:key/instruments/:id/history', async (req, res) => {
  try {
    const m = await store.getModel(req.params.key);
    if (!m) return res.status(404).json({ error: 'Model not found' });
    const inst = await store.getInstrument(req.params.id);
    if (!inst) return res.status(404).json({ error: 'Instrument not found' });
    const mode = req.query.mode === 'full' ? 'full' : 'since-added';
    const rf = parseRf(req.query.rf);
    const added = firstAddedToModel(m.versions, inst.id);

    let raw = [], quote = null, error = null, stale = false, fetchedAt = null, fromCache = false;
    let priceSource = inst.source === 'manual' ? 'nav_series' : 'auto';
    const navMarket = await loadNavMarket(store, inst);
    if (navMarket.hasNav) {
      priceSource = 'nav_series';
      raw = navMarket.series;
      quote = navMarket.quote;
    } else if (inst.source === 'auto') {
      try {
        const h = await cachedHistory(inst.symbol, 'max', { force: refreshFlag(req.query.refresh) });
        raw = (h.series || []).map((p) => ({ date: p.date, price: p.close }));
        stale = !!h.stale;
        fetchedAt = h.fetchedAt || null;
        fromCache = !!h.fromCache;
        if (h.stale) error = h.error || 'Live providers unavailable — showing cached prices';
      } catch (e) {
        error = e.message;
      }
      try { quote = await cachedQuote(inst.symbol); } catch (e) { if (!error) error = e.message; }
    } else {
      raw = (await store.getNavSeries(inst.id)).map((p) => ({ date: p.date, price: p.nav }));
      const latest = await store.latestNav(inst.id);
      quote = latest ? { price: latest.nav, asOf: latest.date, currency: inst.currency } : null;
    }

    const series = filterSeriesByRange(raw, { mode, addedAt: added?.addedAt });
    const bounds = rangeBounds(series);
    const periodReturn = periodReturnFromSeries(series);
    const returns = periodReturnsFromSeries(series);

    let stats = null;
    if (series.length >= 2) {
      const grid = monthGrid(series[0].date.slice(0, 7), series[series.length - 1].date.slice(0, 7));
      const levels = levelsOnGrid(series.map((p) => ({ date: p.date, value: p.price })), grid);
      const rets = monthlyReturnsFromLevels(levels, grid);
      const monthlyRets = grid.slice(1).map((ym) => rets[ym]).filter((r) => r != null);
      if (monthlyRets.length >= 2) {
        const mtr = riskMetrics(monthlyRets, monthlyRets.map(() => null), rf);
        stats = {
          periodReturn,
          annualizedReturn: mtr.annualizedReturn,
          volatility: mtr.volatility,
          maxDrawdown: mtr.maxDrawdown,
          months: mtr.n,
          estimate: mtr.n < 24,
        };
      }
    }
    if (!stats && periodReturn != null) {
      stats = { periodReturn, annualizedReturn: null, volatility: null, maxDrawdown: null, months: 0, estimate: true };
    }

    res.json({
      instrument: inst,
      quote,
      series: series.map((p) => ({ date: p.date, value: p.price })),
      stats,
      returns,
      addedAt: added?.addedAt || null,
      firstVersionId: added?.versionId || null,
      source: priceSource,
      navSource: inst.navSource || null,
      priceLabel: priceSource === 'nav_series' ? (inst.navSource || 'manual') : null,
      needMoreNav: priceSource === 'nav_series' && series.length < 2,
      publishedReturns: inst.publishedReturns || null,
      publishedPeriodReturns: publishedToPeriodRow(inst.publishedReturns),
      range: { mode, ...bounds, addedAt: added?.addedAt || null },
      error,
      stale,
      fetchedAt,
      fromCache,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/quote/:symbol', async (req, res) => {
  try { res.json(await cachedQuote(req.params.symbol)); }
  catch (e) { res.status(502).json({ error: e.message }); }
});
app.get('/api/history/:symbol', async (req, res) => {
  try { res.json(await cachedHistory(req.params.symbol, req.query.range || '1y')); }
  catch (e) { res.status(502).json({ error: e.message }); }
});

// Price-drop alerts. The check refreshes auto-priced stock/ETF history when
// the last close is more than ~1 trading day old (oldest or missing first,
// capped). Cron respects the per-holding miss timer and the history-cache
// fail window (force: false). Check now / Refresh prices now pass force so
// that timer is skipped; per-provider cooldowns still apply inside the chain.
// Manual NAV / Cash / private holdings are never refreshed. A live quote may
// be appended as today's point when candles lag.
const alertEmail = createEmailSender();
const alerts = createAlertService({
  store,
  getHistory: (symbol, range, opts) => cachedHistory(symbol, range || 'max', {
    force: opts?.force === true,
    // Drawdown reads a SQL snapshot after the write. Do not ship the series.
    omitSeries: true,
  }),
  email: alertEmail,
});
const alertRuns = createAlertCoordinator({
  store,
  logger: console,
  runJob: (opts) => (
    opts?.kind === 'refresh'
      ? alerts.refreshPricesNow(opts)
      : alerts.runCheck({ ...(opts || {}), refresh: opts?.refresh !== false })
  ),
});
await alertRuns.hydrate();
app.use('/api/alerts', createAlertRouter({
  store,
  startCheck: (opts) => alertRuns.start(opts),
  getStatus: () => alertRuns.status(),
  sendTestEmail: () => alerts.sendTestEmail(),
}));

// ---------------- static client ----------------
const clientDist = path.join(__dirname, '..', 'client', 'dist');
app.use(express.static(clientDist));
app.get('*', (_req, res) => res.sendFile(path.join(clientDist, 'index.html')));

// Provider probe and the first alert check run after listen and after routes
// are mounted. They are not awaited: a slow probe must not block startup.
void (async () => {
  if (!String(process.env.RESEND_API_KEY || '').trim()) {
    console.warn('[alerts] RESEND_API_KEY is not set — breaches will be recorded as pending - email not configured');
  }
  if (!String(process.env.ALERT_CRON_TOKEN || '').trim()) {
    console.warn('[alerts] ALERT_CRON_TOKEN is not set — /api/alerts/check will reject every request');
  }
  try {
    // State the Yahoo verdict in the deploy log so it never has to be guessed.
    // Probe first so its cooldowns are in place before the alert check asks
    // the history cache for anything stale.
    const probe = await probeAll();
    console.log(`[data] ${probe.verdict}`);
    for (const r of probe.results) {
      if (!r.ok) console.warn(`[data] ${r.provider} ${r.symbol}: ${r.error}`);
    }
  } catch (e) {
    console.error(`[boot] provider probe failed: ${e.message}`);
  }
  startAlertScheduler({
    run: () => openEgressScope('scheduler alert-check', () => alertRuns.start({ refresh: true, kind: 'check' })),
    logger: console,
  });
})();
