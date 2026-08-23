// index.js — API + static host for the built React client.
import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { getStore } from './store.js';
import { getQuote, getHistory } from './yahoo.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json());

const store = getStore();

// --- tiny in-memory quote cache so we don't hammer Yahoo on every view ---
const cache = new Map();
const TTL_MS = 60 * 1000;
async function cachedQuote(symbol) {
  const hit = cache.get(symbol);
  if (hit && Date.now() - hit.t < TTL_MS) return hit.v;
  const v = await getQuote(symbol);
  cache.set(symbol, { t: Date.now(), v });
  return v;
}

// Enrich a version's holdings with a live/last price so the client can show
// values without knowing anything about the source. This is the hybrid seam:
// 'auto' resolves through Yahoo, 'manual' resolves through the stored NAV series.
async function enrichHoldings(version) {
  if (!version) return [];
  const out = [];
  for (const h of version.holdings) {
    const inst = store.getInstrument(h.instrumentId);
    if (!inst) continue;
    let price = null;
    let priceAsOf = null;
    let priceSource = inst.source;
    try {
      if (inst.source === 'auto') {
        const q = await cachedQuote(inst.symbol);
        price = q.price;
        priceAsOf = q.asOf;
      } else {
        const nav = store.latestNav(inst.id);
        price = nav?.nav ?? null;
        priceAsOf = nav?.date ?? null;
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

app.get('/api/models', (_req, res) => {
  res.json(
    store.listModels().map((m) => {
      const cv = store.currentVersion(m.key);
      return {
        key: m.key, name: m.name, riskRank: m.riskRank,
        versionCount: m.versions.length,
        currentEffectiveDate: cv?.effectiveDate ?? null,
        holdingCount: cv?.holdings.length ?? 0,
      };
    })
  );
});

app.get('/api/models/:key', async (req, res) => {
  const m = store.getModel(req.params.key);
  if (!m) return res.status(404).json({ error: 'Model not found' });
  const cv = store.currentVersion(m.key);
  const holdings = await enrichHoldings(cv);
  res.json({
    key: m.key, name: m.name, riskRank: m.riskRank, benchmark: m.benchmark,
    versions: m.versions.map((v) => ({ id: v.id, effectiveDate: v.effectiveDate, note: v.note, holdingCount: v.holdings.length })),
    currentVersion: cv ? { id: cv.id, effectiveDate: cv.effectiveDate, note: cv.note } : null,
    holdings,
  });
});

// A model change = new effective-dated version (never mutate history).
app.post('/api/models/:key/versions', (req, res) => {
  const v = store.addVersion(req.params.key, req.body || {});
  if (!v) return res.status(404).json({ error: 'Model not found' });
  res.status(201).json(v);
});

app.get('/api/instruments', (_req, res) => res.json(store.listInstruments()));
app.post('/api/instruments', (req, res) => res.status(201).json(store.addInstrument(req.body || {})));
app.post('/api/instruments/:id/nav', (req, res) => {
  const inst = store.getInstrument(req.params.id);
  if (!inst) return res.status(404).json({ error: 'Instrument not found' });
  res.status(201).json(store.addNav(req.params.id, req.body || {}));
});

// Direct market-data passthroughs (also used by future performance/risk views).
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
app.listen(PORT, () => console.log(`MPT server on :${PORT}`));
