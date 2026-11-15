import { describe, expect, it } from 'vitest';
import { memoryMethods, politicianBucket } from './memoryStore.js';
import {
  annualProgress,
  formatAnnualProgress,
  runAnnualSlice,
} from './annualIngest.js';
import { nextAnnualIngestDelay, startAnnualIngest } from './annualSchedule.js';

function memoryStore(state = {}) {
  const db = politicianBucket({});
  db.politicianAnnual = state;
  const store = { db };
  for (const [name, fn] of Object.entries(memoryMethods)) {
    store[name] = (...args) => fn.apply({ db, persist() {} }, args);
  }
  return store;
}

function filing(filingKey, sourceUrl) {
  return {
    filingKey,
    sourceUrl,
    first: 'Ada',
    last: 'Lovelace',
    personKey: 'house:lovelace:ada',
    office: 'house',
    reportYear: 2025,
    filingKind: 'original',
    filedDate: '2026-05-15',
  };
}

describe('annual backlog pace', () => {
  it('splits done, remaining, and failed', () => {
    const progress = annualProgress({
      queues: [[
        { filingKey: 'a' },
        { filingKey: 'b' },
        { filingKey: 'c' },
      ]],
      storedKeys: ['a'],
      docBackoff: { b: new Date(Date.now() + 60_000).toISOString() },
    });
    expect(progress).toMatchObject({ queued: 3, done: 1, failed: 1, remaining: 1 });
    expect(formatAnnualProgress(progress, { downloaded: 4 })).toBe(
      '[annual] progress done=1 remaining=1 failed=1 downloaded=4',
    );
  });

  it('stops the 30 minute timer once the backlog is covered', async () => {
    expect(nextAnnualIngestDelay({ backfillComplete: true, boot: true })).toBeNull();
    expect(nextAnnualIngestDelay({ backfillComplete: false, boot: true, initialDelayMs: 20_000 })).toBe(20_000);
    expect(nextAnnualIngestDelay({ backfillComplete: false, boot: false, intervalMs: 30_000 })).toBe(30_000);

    let calls = 0;
    const stop = startAnnualIngest({
      run: async () => { calls += 1; },
      getState: async () => ({ backfillComplete: true }),
      intervalMs: 30,
      initialDelayMs: 0,
      logger: { log() {}, error() {} },
    });
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(calls).toBe(0);
    stop();
  });

  it('keeps going after one document fails and does not retry it immediately', async () => {
    const fresh = new Date().toISOString();
    const store = memoryStore({
      house: {
        indexedAt: fresh,
        queue: [filing('2025:1', 'https://clerk.test/1.pdf'), filing('2025:2', 'https://clerk.test/2.pdf'), filing('2025:3', 'https://clerk.test/3.pdf')],
      },
      senate: { indexedAt: fresh, done: true, queue: [] },
      oge: { indexedAt: fresh, queue: [] },
    });
    const seen = [];
    const lines = [];
    const result = await runAnnualSlice({
      store,
      roster: { house: [{ last: 'Lovelace' }], senate: [] },
      delayMs: 0,
      sleep: async () => {},
      deadline: Date.now() + 5_000,
      docsPerRun: 8,
      pace: 'backfill',
      logger: { log(line) { lines.push(line); }, warn() {}, error() {} },
      fetchImpl: async (url) => {
        seen.push(String(url));
        if (String(url).endsWith('/1.pdf')) return { status: 500, ok: false, text: async () => '', arrayBuffer: async () => Buffer.alloc(0), headers: { get() { return null; } } };
        return { status: 404, ok: false, text: async () => '', arrayBuffer: async () => Buffer.alloc(0), headers: { get() { return null; } } };
      },
    });
    expect(seen).toEqual(['https://clerk.test/1.pdf', 'https://clerk.test/2.pdf', 'https://clerk.test/3.pdf']);
    expect(result.house.downloaded).toBe(2);
    expect(result.house.failed).toBe(1);
    expect(result.progress).toMatchObject({ done: 2, failed: 1, remaining: 0 });
    expect(lines.some((line) => line.startsWith('[annual] progress done=2 remaining=0 failed=1'))).toBe(true);
    expect(result.backfillComplete).toBe(false);

    seen.length = 0;
    await runAnnualSlice({
      store,
      roster: { house: [{ last: 'Lovelace' }], senate: [] },
      delayMs: 0,
      sleep: async () => {},
      deadline: Date.now() + 5_000,
      pace: 'backfill',
      logger: { log() {}, warn() {}, error() {} },
      fetchImpl: async (url) => {
        seen.push(String(url));
        return { status: 404, ok: false, text: async () => '', arrayBuffer: async () => Buffer.alloc(0), headers: { get() { return null; } } };
      },
    });
    expect(seen.some((url) => url.endsWith('/1.pdf'))).toBe(false);
  });
});
