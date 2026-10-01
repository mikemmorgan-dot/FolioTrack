import { describe, it, expect } from 'vitest';
import { createAlertService } from './check.js';
import { applyAlertSettingsPatch, coerceAlertSettings } from './settings.js';
import { EMAIL_NOT_CONFIGURED } from './email.js';

const TODAY = '2026-09-01';
const NOW = new Date('2026-09-01T15:00:00.000Z');

function memoryStore(initial) {
  const db = {
    settings: initial.settings || null,
    events: new Map(),
    history: [],
    check: null,
    instruments: initial.instruments,
    models: initial.models,
    historyBySymbol: initial.historyBySymbol || {},
    nav: initial.nav || {},
  };
  return {
    async getAlertSettings() { return coerceAlertSettings(db.settings || {}); },
    async saveAlertSettings(patch) {
      db.settings = applyAlertSettingsPatch(await this.getAlertSettings(), patch);
      return db.settings;
    },
    async getAlertEvent(id) { return db.events.get(id) || null; },
    async listAlertEvents() { return [...db.events.values()]; },
    async upsertAlertEvent(event) { db.events.set(event.instrumentId, { ...event }); return event; },
    async appendAlertHistory(entry) { db.history.push(entry); return entry; },
    async listAlertHistory() { return [...db.history].reverse(); },
    async getAlertCheckMeta() { return db.check; },
    async setAlertCheckMeta(meta) { db.check = meta; return meta; },
    async listModels() { return db.models; },
    async getInstrument(id) { return db.instruments[id] || null; },
    async getPriceHistory(symbol) { return db.historyBySymbol[String(symbol).toUpperCase()] || null; },
    async getNavSeries(id) { return db.nav[id] || []; },
    db,
  };
}

function nvdaSeries(current) {
  return {
    symbol: 'NVDA',
    fetchedAt: new Date(NOW.getTime() - 60_000).toISOString(),
    series: [
      { date: '2024-01-01', close: 900 },
      { date: '2026-01-15', close: 200 },
      { date: '2026-09-01', close: current },
    ],
  };
}

function fixture(current = 140) {
  const nvda = { id: 'inst_nvda', symbol: 'NVDA', name: 'NVIDIA', type: 'stock', source: 'auto', currency: 'USD' };
  const cash = { id: 'inst_cash', symbol: 'CASH', name: 'Cash', type: 'cash', source: 'manual', currency: 'CAD' };
  const ocic = { id: 'inst_ocic', symbol: 'OCIC', name: 'Blue Owl', type: 'alt', source: 'manual', currency: 'USD' };
  const store = memoryStore({
    instruments: { inst_nvda: nvda, inst_cash: cash, inst_ocic: ocic },
    models: [
      {
        key: 'growth', name: 'Growth',
        versions: [{ effectiveDate: '2024-01-01', holdings: [
          { instrumentId: 'inst_nvda', weight: 0.2 },
          { instrumentId: 'inst_cash', weight: 0.05 },
        ] }],
      },
      {
        key: 'aggressive', name: 'Aggressive',
        versions: [{ effectiveDate: '2024-01-01', holdings: [
          { instrumentId: 'inst_nvda', weight: 0.4 },
          { instrumentId: 'inst_ocic', weight: 0.1 },
        ] }],
      },
    ],
    historyBySymbol: { NVDA: nvdaSeries(current) },
    nav: { inst_ocic: [{ date: '2026-01-01', nav: 10 }, { date: '2026-08-01', nav: 8 }] },
  });
  return { store, nvda, cash, ocic };
}

function mockEmail(impl) {
  const calls = [];
  let sendImpl = impl || (async () => ({ ok: true, id: 'msg_1' }));
  return {
    calls,
    setImpl(fn) { sendImpl = fn; },
    async send(msg) { calls.push(msg); return sendImpl(msg); },
  };
}

function service(store, email, extra = {}) {
  return createAlertService({
    store,
    email,
    now: () => NOW,
    today: () => TODAY,
    ...extra,
  });
}

describe('alert check', () => {
  it('dedupes a holding across models and sends one email listing both', async () => {
    const { store } = fixture();
    const email = mockEmail();
    const { runCheck } = service(store, email);
    const summary = await runCheck();
    expect(summary.emailed).toBe(2);
    expect(email.calls).toHaveLength(2);
    const nvdaMail = email.calls.find((c) => c.subject.includes('NVDA'));
    expect(nvdaMail.subject).toBe('FolioTrack alert: NVDA down 30.0% from 52-week high');
    expect(nvdaMail.text).toContain('Growth');
    expect(nvdaMail.text).toContain('Aggressive');
    expect(nvdaMail.to).toBe('mikemmorgan@gmail.com');
    const event = await store.getAlertEvent('inst_nvda');
    expect(event.status).toBe('active');
    expect(event.lastNotifiedAt).toBe(NOW.toISOString());
    expect(event.models).toHaveLength(2);
    expect(summary.active).toBe(2);

    email.calls.length = 0;
    const second = await runCheck();
    expect(second.emailed).toBe(0);
    expect(email.calls).toHaveLength(0);
    expect((await store.getAlertEvent('inst_nvda')).status).toBe('active');
  });

  it('does not email cash or an alt with no price, and uses the NAV peak when history is missing', async () => {
    const { store } = fixture();
    const email = mockEmail();
    await service(store, email).runCheck();
    expect(email.calls.some((c) => c.subject.includes('CASH'))).toBe(false);
    const ocic = email.calls.find((c) => c.subject.includes('OCIC'));
    expect(ocic.subject).toContain('from saved NAV peak');
    expect(ocic.text).toContain('from saved NAV series peak');
    const cashEvent = await store.getAlertEvent('inst_cash');
    expect(cashEvent).toBeNull();
  });

  it('keeps the episode through the hysteresis band, then recovers, then emails a new breach', async () => {
    const { store } = fixture(140);
    const email = mockEmail();
    const svc = service(store, email);
    await svc.runCheck();
    expect(email.calls).toHaveLength(2);

    store.db.historyBySymbol.NVDA = nvdaSeries(162);
    email.calls.length = 0;
    await svc.runCheck();
    expect((await store.getAlertEvent('inst_nvda')).status).toBe('active');
    expect(email.calls.filter((c) => c.subject.includes('NVDA'))).toHaveLength(0);

    store.db.historyBySymbol.NVDA = nvdaSeries(166);
    await svc.runCheck();
    expect((await store.getAlertEvent('inst_nvda')).status).toBe('recovered');

    store.db.historyBySymbol.NVDA = nvdaSeries(140);
    email.calls.length = 0;
    await svc.runCheck();
    expect(email.calls.filter((c) => c.subject.includes('NVDA'))).toHaveLength(1);
    expect((await store.getAlertEvent('inst_nvda')).status).toBe('active');
  });

  it('does not email an already-notified holding again when the threshold changes but it is still breached', async () => {
    const { store } = fixture(140);
    const email = mockEmail();
    const svc = service(store, email);
    await svc.runCheck();
    const before = email.calls.length;
    await store.saveAlertSettings({ alertThreshold: 25 });
    const summary = await svc.runCheck();
    expect(email.calls).toHaveLength(before);
    expect(summary.emailed).toBe(0);
    const event = await store.getAlertEvent('inst_nvda');
    expect(event.status).toBe('active');
    expect(event.threshold).toBe(25);
    expect(event.lastNotifiedAt).toBeTruthy();
  });

  it('records pending - email not configured and retries without opening a second episode', async () => {
    const { store } = fixture();
    const email = mockEmail(async () => ({ ok: false, reason: EMAIL_NOT_CONFIGURED }));
    const svc = service(store, email);
    const first = await svc.runCheck();
    expect(first.emailed).toBe(0);
    expect(first.pending).toBeGreaterThan(0);
    const event = await store.getAlertEvent('inst_nvda');
    expect(event.notifyDetail).toBe('pending - email not configured');
    expect(event.lastNotifiedAt).toBeNull();
    expect(event.status).toBe('active');

    const second = await svc.runCheck();
    expect(second.pending).toBeGreaterThan(0);
    expect(second.opened).toBe(0);
    expect((await store.listAlertEvents()).filter((e) => e.instrumentId === 'inst_nvda')).toHaveLength(1);
  });

  it('leaves a failed send unsent so the next run retries, then stops after success', async () => {
    const { store } = fixture();
    const email = mockEmail(async () => ({ ok: false, reason: 'Invalid API key' }));
    const svc = service(store, email);
    await svc.runCheck();
    expect((await store.getAlertEvent('inst_nvda')).notifyDetail).toBe('Invalid API key');
    expect((await store.getAlertEvent('inst_nvda')).lastNotifiedAt).toBeNull();

    email.setImpl(async () => ({ ok: true, id: 'msg_2' }));
    const callsBefore = email.calls.length;
    await svc.runCheck();
    expect(email.calls.length).toBeGreaterThan(callsBefore);
    expect((await store.getAlertEvent('inst_nvda')).lastNotifiedAt).toBe(NOW.toISOString());

    const sent = email.calls.length;
    await svc.runCheck();
    expect(email.calls.length).toBe(sent);
  });

  it('does not call the history fetcher when the cache is fresh, and backs off after a total miss', async () => {
    const { store } = fixture();
    let freshCalls = 0;
    const getHistory = async () => { freshCalls += 1; throw new Error('should not fetch a fresh cache'); };
    await service(store, mockEmail(), { getHistory }).runCheck();
    expect(freshCalls).toBe(0);

    const bare = { id: 'inst_ry', symbol: 'RY.TO', name: 'Royal Bank', type: 'stock', source: 'auto', currency: 'CAD' };
    store.db.instruments.inst_ry = bare;
    store.db.models[0].versions[0].holdings.push({ instrumentId: 'inst_ry', weight: 0.1 });
    let calls = 0;
    const fetching = async () => {
      calls += 1;
      throw new Error('yahoo down');
    };
    const svc = service(store, mockEmail(), { getHistory: fetching });
    await svc.runCheck();
    expect(calls).toBe(1);
    await svc.runCheck();
    expect(calls).toBe(1);
    expect(await store.getAlertEvent('inst_ry')).toBeNull();
  });

  it('skips a live fetch when a previous process stored a miss backoff', async () => {
    const { store } = fixture();
    store.db.instruments.inst_ry = { id: 'inst_ry', symbol: 'RY.TO', name: 'Royal Bank', type: 'stock', source: 'auto', currency: 'CAD' };
    store.db.models[0].versions[0].holdings.push({ instrumentId: 'inst_ry', weight: 0.1 });
    store.db.miss = { 'RY.TO': new Date(NOW.getTime() + 60 * 60 * 1000).toISOString() };
    store.getAlertMissUntil = async () => store.db.miss;
    store.setAlertMissUntil = async (obj) => { store.db.miss = obj; return obj; };
    let calls = 0;
    await service(store, mockEmail(), {
      getHistory: async () => { calls += 1; throw new Error('should stay backed off'); },
    }).runCheck();
    expect(calls).toBe(0);
  });

  it('marks a holding recovered without emailing when it leaves every current model', async () => {
    const { store } = fixture();
    const email = mockEmail();
    const svc = service(store, email);
    await svc.runCheck();
    store.db.models.forEach((m) => {
      m.versions[0].holdings = m.versions[0].holdings.filter((h) => h.instrumentId !== 'inst_nvda');
    });
    email.calls.length = 0;
    await svc.runCheck();
    const event = await store.getAlertEvent('inst_nvda');
    expect(event.status).toBe('recovered');
    expect(event.lastEvalNote).toBe('Removed from current model versions');
    expect(email.calls.some((c) => c.subject.includes('NVDA'))).toBe(false);
  });

  it('flags a stale as-of on the stored event', async () => {
    const { store } = fixture(140);
    store.db.historyBySymbol.NVDA = {
      symbol: 'NVDA',
      fetchedAt: new Date(NOW.getTime() - 60_000).toISOString(),
      series: [
        { date: '2026-01-15', close: 200 },
        { date: '2026-08-01', close: 140 },
      ],
    };
    await service(store, mockEmail(), { today: () => '2026-09-01' }).runCheck();
    const event = await store.getAlertEvent('inst_nvda');
    expect(event.stale).toBe(true);
    expect(event.basisLabel).toContain('as of 2026-08-01');
  });
});
