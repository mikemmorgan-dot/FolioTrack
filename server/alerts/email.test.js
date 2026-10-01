import { describe, it, expect, afterEach } from 'vitest';
import {
  createEmailSender,
  buildAlertEmail,
  buildTestEmail,
  EMAIL_NOT_CONFIGURED,
  DEFAULT_FROM,
  RESEND_URL,
  FOLIOTRACK_URL,
} from './email.js';

const prevKey = process.env.RESEND_API_KEY;
const prevFrom = process.env.ALERT_FROM;

afterEach(() => {
  if (prevKey === undefined) delete process.env.RESEND_API_KEY;
  else process.env.RESEND_API_KEY = prevKey;
  if (prevFrom === undefined) delete process.env.ALERT_FROM;
  else process.env.ALERT_FROM = prevFrom;
});

function mockFetch(status, body, { throwMessage } = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    if (throwMessage) throw new Error(throwMessage);
    return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body) };
  };
  return { fetchImpl, calls };
}

const sample = {
  symbol: 'NVDA',
  name: 'NVIDIA',
  currency: 'USD',
  models: [{ key: 'growth', name: 'Growth' }, { key: 'aggressive', name: 'Aggressive' }],
  currentPrice: 140,
  referencePrice: 200,
  referenceDate: '2026-01-15',
  drawdown: -0.234,
  priceAsOf: '2026-09-28',
  basis: '52w',
  covers52w: true,
  basisLabel: 'from 52-week high, using cached closes as of 2026-09-28',
};

describe('alert email content', () => {
  it('includes the holding, models, prices, drawdown, threshold, and app link', () => {
    const mail = buildAlertEmail(sample, { threshold: 20 });
    expect(mail.subject).toBe('FolioTrack alert: NVDA down 23.4% from 52-week high');
    for (const blob of [mail.text, mail.html]) {
      expect(blob).toContain('NVDA');
      expect(blob).toContain('NVIDIA');
      expect(blob).toContain('Growth');
      expect(blob).toContain('Aggressive');
      expect(blob).toContain('140.00 USD');
      expect(blob).toContain('200.00 USD');
      expect(blob).toContain('2026-01-15');
      expect(blob).toContain('23.4%');
      expect(blob).toContain('20%');
      expect(blob).toContain('2026-09-28');
      expect(blob).toContain(FOLIOTRACK_URL);
      expect(blob).toContain('from 52-week high, using cached closes as of 2026-09-28');
    }
  });

  it('labels a NAV-peak fallback differently', () => {
    const mail = buildAlertEmail({ ...sample, basis: 'nav', covers52w: false, basisLabel: 'from saved NAV series peak, using NAV as of 2026-08-01' }, { threshold: 20 });
    expect(mail.subject).toContain('from saved NAV peak');
  });
});

describe('Resend sender', () => {
  it('POSTs to the Resend HTTPS API on success', async () => {
    delete process.env.ALERT_FROM;
    const { fetchImpl, calls } = mockFetch(200, { id: 're_123' });
    const sender = createEmailSender({ fetchImpl, apiKey: 're_test' });
    const mail = buildTestEmail({ to: 'mikemmorgan@gmail.com' });
    const result = await sender.send(mail);
    expect(result).toEqual({ ok: true, id: 're_123' });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(RESEND_URL);
    expect(calls[0].init.method).toBe('POST');
    expect(calls[0].init.headers.Authorization).toBe('Bearer re_test');
    const body = JSON.parse(calls[0].init.body);
    expect(body.from).toBe(DEFAULT_FROM);
    expect(body.to).toEqual(['mikemmorgan@gmail.com']);
    expect(body.subject).toBe('FolioTrack test email');
    expect(body.text).toContain(FOLIOTRACK_URL);
    expect(body.html).toContain(FOLIOTRACK_URL);
  });

  it('returns the provider error and does not pretend the send worked', async () => {
    const { fetchImpl, calls } = mockFetch(422, { message: 'Invalid `to` field' });
    const sender = createEmailSender({ fetchImpl, apiKey: 're_test', from: 'FolioTrack <onboarding@resend.dev>' });
    const mail = buildAlertEmail(sample, { threshold: 20 });
    const result = await sender.send({ ...mail, to: 'mikemmorgan@gmail.com' });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('Invalid `to` field');
    expect(calls).toHaveLength(1);
  });

  it('does not call fetch when RESEND_API_KEY is missing', async () => {
    delete process.env.RESEND_API_KEY;
    const { fetchImpl, calls } = mockFetch(200, { id: 'nope' });
    const sender = createEmailSender({ fetchImpl, apiKey: () => process.env.RESEND_API_KEY || '' });
    const result = await sender.send({ to: 'mikemmorgan@gmail.com', subject: 'x', text: 'y', html: '<p>y</p>' });
    expect(result).toEqual({ ok: false, reason: EMAIL_NOT_CONFIGURED });
    expect(calls).toHaveLength(0);
  });

  it('returns the thrown fetch error so the next run can retry', async () => {
    const { fetchImpl } = mockFetch(200, {}, { throwMessage: 'network down' });
    const sender = createEmailSender({ fetchImpl, apiKey: 're_test' });
    const result = await sender.send({ to: 'a@b.co', subject: 'x', text: 'y', html: '<p>y</p>' });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('network down');
  });
});
