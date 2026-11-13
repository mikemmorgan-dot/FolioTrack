// Politician trade routes. Refresh returns as soon as the poll is queued.
// The work continues in the background and does not hold the request open.

import express from 'express';
import { matchableAssetClass } from './normalize.js';
import { badgesBySymbol, heldIndex } from './records.js';
import { applyPoliticianAlertPatch } from './settings.js';
import { attachHeldModels } from './summary.js';

function asyncRoute(fn) {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch((err) => {
      const status = err.status || 500;
      if (status >= 500) console.error(`[politicians] ${req.method} ${req.path}: ${err.message}`);
      if (!res.headersSent) res.status(status).json({ error: err.message || 'Request failed' });
    });
  };
}

export function createPoliticianRouter({ store, startPoll, pollRunning } = {}) {
  const router = express.Router();

  router.get('/', asyncRoute(async (req, res) => {
    const feed = await store.listPoliticianFeed(req.query || {});
    const symbols = await store.listHeldPoliticianSymbols();
    const held = heldIndex(symbols);
    feed.items = feed.items.map((item) => ({
      ...item,
      heldModels: item.kind === 'trade' && matchableAssetClass(item.assetClass) && item.tickerNorm
        ? (held.get(item.tickerNorm) || [])
        : [],
    }));
    res.json(feed);
  }));

  router.get('/status', asyncRoute(async (_req, res) => {
    const state = await store.getPoliticianPollState();
    const settings = await store.getPoliticianAlertSettings();
    res.json({
      running: typeof pollRunning === 'function' ? pollRunning() : false,
      alertsEnabled: settings.politicianAlertsEnabled,
      heldOnly: settings.politicianAlertsHeldOnly,
      alertsArmed: state.alertsArmed === true,
      backfillComplete: state.backfillComplete === true,
      lastRunAt: state.lastRunAt || null,
      lastError: state.lastError || null,
      summary: state.lastSummary || null,
      sources: state.sources || {},
    });
  }));

  router.post('/refresh', (_req, res) => {
    if (typeof startPoll !== 'function') {
      res.status(503).json({ error: 'Politician poll is not configured' });
      return;
    }
    const ack = startPoll();
    res.status(202).json(ack);
  });

  router.get('/settings', asyncRoute(async (_req, res) => {
    res.json(await store.getPoliticianAlertSettings());
  }));

  router.put('/settings', asyncRoute(async (req, res) => {
    const next = applyPoliticianAlertPatch(
      await store.getPoliticianAlertSettings(),
      req.body || {},
    );
    res.json(await store.savePoliticianAlertSettings(next));
  }));

  router.get('/summary', asyncRoute(async (req, res) => {
    const query = { ...(req.query || {}) };
    // Public window is the US disclosure calendar through today.
    delete query.asOf;
    const [summary, symbols] = await Promise.all([
      store.summarizePoliticianTrades(query),
      store.listHeldPoliticianSymbols(),
    ]);
    res.json(attachHeldModels(summary, symbols));
  }));

  router.get('/held', asyncRoute(async (_req, res) => {
    const symbols = await store.listHeldPoliticianSymbols();
    const norms = [...new Set(symbols.map((s) => s.tickerNorm).filter(Boolean))];
    const summaries = await store.summarizeHeldTrades(norms);
    res.json({ bySymbol: badgesBySymbol(symbols, summaries) });
  }));

  router.get('/people/:personKey', asyncRoute(async (req, res) => {
    const person = await store.getPolitician(req.params.personKey, req.query || {});
    if (!person) {
      res.status(404).json({ error: 'No filings for that person yet' });
      return;
    }
    const symbols = await store.listHeldPoliticianSymbols();
    const held = heldIndex(symbols);
    person.items = (person.items || []).map((item) => ({
      ...item,
      heldModels: item.kind === 'trade' && matchableAssetClass(item.assetClass) && item.tickerNorm
        ? (held.get(item.tickerNorm) || [])
        : [],
    }));
    res.json(person);
  }));

  return router;
}
