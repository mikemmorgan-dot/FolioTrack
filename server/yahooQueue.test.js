import { describe, expect, it } from 'vitest';
import {
  createPaceQueue,
  createRunFetchDedupe,
  dedupeYahoo,
  parseRetryAfter,
  resetYahooDedupeForTests,
  retryDelayMs,
  withYahooRun,
} from './yahooQueue.js';

describe('Yahoo pacing queue', () => {
  it('sends at most one request at a time, with at least 1.5s between starts', async () => {
    const sleeps = [];
    let t = 0;
    let active = 0;
    let maxActive = 0;
    const queue = createPaceQueue({
      minIntervalMs: 1500,
      jitterMs: 400,
      now: () => t,
      sleep: async (ms) => {
        sleeps.push(ms);
        t += ms;
      },
      random: () => 0,
    });
    const task = () => queue.enqueue(async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      active -= 1;
      return t;
    });
    await Promise.all([task(), task(), task()]);
    expect(maxActive).toBe(1);
    expect(sleeps).toEqual([1500, 1500]);
    expect(queue.stats().maxActive).toBe(1);
  });

  it('adds jitter on top of the 1.5s gap and keeps going after a failure', async () => {
    const sleeps = [];
    let t = 0;
    const queue = createPaceQueue({
      minIntervalMs: 1500,
      jitterMs: 400,
      now: () => t,
      sleep: async (ms) => {
        sleeps.push(ms);
        t += ms;
      },
      random: () => 0.5,
    });
    await queue.enqueue(async () => 'a');
    await expect(queue.enqueue(async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    await expect(queue.enqueue(async () => 'c')).resolves.toBe('c');
    expect(sleeps).toEqual([1700, 1700]);
  });
});

describe('Yahoo 429 retry delay', () => {
  it('honors Retry-After seconds and HTTP dates', () => {
    expect(parseRetryAfter('3', 1_000)).toBe(3000);
    expect(parseRetryAfter('0', 1_000)).toBe(0);
    const now = Date.parse('2026-10-02T12:00:00.000Z');
    expect(parseRetryAfter('Fri, 02 Oct 2026 12:00:12 GMT', now)).toBe(12_000);
    expect(parseRetryAfter('', now)).toBeNull();
    expect(parseRetryAfter(null, now)).toBeNull();
  });

  it('uses Retry-After when present and exponential backoff otherwise', () => {
    expect(retryDelayMs({ retryAfterMs: 3000, random: () => 0 })).toBe(3000);
    expect(retryDelayMs({ attempt: 0, retryAfterMs: null, random: () => 0 })).toBe(1500);
    expect(retryDelayMs({ attempt: 2, retryAfterMs: null, random: () => 0 })).toBe(6000);
    expect(retryDelayMs({ retryAfterMs: 120_000, random: () => 0 })).toBe(30_000);
  });
});

describe('Yahoo dedupe within a run', () => {
  it('shares one fetch for the same symbol inside a run and not across runs', async () => {
    resetYahooDedupeForTests();
    let calls = 0;
    const fetchHistory = async (symbol) => {
      calls += 1;
      return symbol;
    };
    const deduped = createRunFetchDedupe(fetchHistory);
    const [a, b] = await Promise.all([deduped('atd.to', 'max', { force: true }), deduped('ATD.TO', 'max', { force: true })]);
    expect(a).toBe('atd.to');
    expect(b).toBe('atd.to');
    expect(calls).toBe(1);
    await deduped('ATD.TO', 'max', { force: false });
    expect(calls).toBe(2);

    let inner = 0;
    await withYahooRun(async () => {
      const run = () => dedupeYahoo('hist:ATD.TO:max', async () => {
        inner += 1;
        return 'bar';
      });
      await run();
      await run();
    });
    expect(inner).toBe(1);
    await dedupeYahoo('hist:ATD.TO:max', async () => { inner += 1; });
    expect(inner).toBe(2);
  });
});
