// alerts/email.js — Resend over HTTPS. Render's free tier blocks outbound
// SMTP, so this never opens a mail port. fetch is injectable for tests.

export const RESEND_URL = 'https://api.resend.com/emails';
export const DEFAULT_FROM = 'FolioTrack <onboarding@resend.dev>';
export const FOLIOTRACK_URL = 'https://foliotrack.onrender.com';
export const EMAIL_NOT_CONFIGURED = 'pending - email not configured';

export function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function oneLine(value) {
  return String(value ?? '').replace(/[\r\n]+/g, ' ').trim();
}

function px(n, currency) {
  if (n == null || !Number.isFinite(Number(n))) return '—';
  const num = Number(n).toLocaleString('en-CA', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return currency ? `${num} ${currency}` : num;
}

function pct1(drawdown) {
  return `${(Math.abs(Number(drawdown)) * 100).toFixed(1)}%`;
}

function modelList(models) {
  const names = (models || []).map((m) => m?.name || m?.key).filter(Boolean);
  return names.length ? names.join(', ') : '—';
}

function basisPhrase(evaluation) {
  if (evaluation.basis === 'nav') return 'saved NAV peak';
  if (evaluation.covers52w === false) return 'cached high';
  return '52-week high';
}

export function buildAlertEmail(evaluation, { threshold, appUrl = FOLIOTRACK_URL } = {}) {
  const symbol = oneLine(evaluation.symbol || 'Unknown');
  const name = oneLine(evaluation.name || '');
  const models = modelList(evaluation.models);
  const down = pct1(evaluation.drawdown);
  const fromWhat = basisPhrase(evaluation);
  const subject = `FolioTrack alert: ${symbol} down ${down} from ${fromWhat}`;
  const lines = [
    'FolioTrack price drop alert',
    '',
    name ? `${symbol} — ${name}` : symbol,
    `Models: ${models}`,
    `Current price: ${px(evaluation.currentPrice, evaluation.currency)}`,
    `Reference high: ${px(evaluation.referencePrice, evaluation.currency)} on ${evaluation.referenceDate || '—'}`,
    `Drawdown: -${down}`,
    `Threshold: ${Number(threshold)}%`,
    `Price as of: ${evaluation.priceAsOf || '—'}`,
    `Basis: ${evaluation.basisLabel || fromWhat}`,
    '',
    appUrl,
  ];
  const text = lines.join('\n');
  const html = `<!DOCTYPE html>
<html><body style="font-family:sans-serif;color:#111;line-height:1.45">
<h2 style="margin:0 0 12px">FolioTrack price drop alert</h2>
<p style="margin:0 0 8px"><strong>${escapeHtml(symbol)}</strong>${name ? ` — ${escapeHtml(name)}` : ''}</p>
<ul>
<li>Models: ${escapeHtml(models)}</li>
<li>Current price: ${escapeHtml(px(evaluation.currentPrice, evaluation.currency))}</li>
<li>Reference high: ${escapeHtml(px(evaluation.referencePrice, evaluation.currency))} on ${escapeHtml(evaluation.referenceDate || '—')}</li>
<li>Drawdown: -${escapeHtml(down)}</li>
<li>Threshold: ${escapeHtml(String(Number(threshold)))}%</li>
<li>Price as of: ${escapeHtml(evaluation.priceAsOf || '—')}</li>
<li>Basis: ${escapeHtml(evaluation.basisLabel || fromWhat)}</li>
</ul>
<p><a href="${escapeHtml(appUrl)}">Open FolioTrack</a></p>
</body></html>`;
  return { subject, text, html };
}

export function buildTestEmail({ to, appUrl = FOLIOTRACK_URL } = {}) {
  const subject = 'FolioTrack test email';
  const text = [
    'This is a test email from FolioTrack price-drop alerts.',
    `Recipient: ${to}`,
    'If you received it, Resend is delivering to this address.',
    '',
    appUrl,
  ].join('\n');
  const html = `<!DOCTYPE html>
<html><body style="font-family:sans-serif;color:#111;line-height:1.45">
<h2 style="margin:0 0 12px">FolioTrack test email</h2>
<p>This is a test from FolioTrack price-drop alerts.</p>
<p>Recipient: ${escapeHtml(to)}</p>
<p>If you received it, Resend is delivering to this address.</p>
<p><a href="${escapeHtml(appUrl)}">Open FolioTrack</a></p>
</body></html>`;
  return { to, subject, text, html };
}

function providerError(parsed, raw, status) {
  if (parsed && typeof parsed === 'object') {
    if (typeof parsed.message === 'string' && parsed.message.trim()) return parsed.message.trim();
    if (typeof parsed.error === 'string' && parsed.error.trim()) return parsed.error.trim();
    if (parsed.error && typeof parsed.error.message === 'string' && parsed.error.message.trim()) {
      return parsed.error.message.trim();
    }
    try { return JSON.stringify(parsed); } catch { /* ignore */ }
  }
  const text = String(raw || '').trim();
  return text || `HTTP ${status}`;
}

export function createEmailSender({
  fetchImpl = globalThis.fetch,
  apiKey = () => process.env.RESEND_API_KEY || '',
  from = () => process.env.ALERT_FROM || DEFAULT_FROM,
} = {}) {
  const resolve = (v) => (typeof v === 'function' ? v() : v);

  async function send({ to, subject, text, html }) {
    const key = String(resolve(apiKey) || '').trim();
    if (!key) return { ok: false, reason: EMAIL_NOT_CONFIGURED };
    const recipient = Array.isArray(to) ? to.filter(Boolean) : [to].filter(Boolean);
    if (!recipient.length) return { ok: false, reason: 'No alert recipient configured' };
    let res;
    try {
      res = await fetchImpl(RESEND_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${key}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from: resolve(from) || DEFAULT_FROM,
          to: recipient,
          subject: oneLine(subject),
          text,
          html,
        }),
      });
    } catch (e) {
      return { ok: false, reason: e?.message || 'Email provider request failed' };
    }
    const raw = typeof res?.text === 'function' ? await res.text() : '';
    let parsed = null;
    try { parsed = raw ? JSON.parse(raw) : null; } catch { parsed = null; }
    if (!res?.ok) return { ok: false, reason: providerError(parsed, raw, res?.status), status: res?.status || null };
    return { ok: true, id: parsed?.id || null };
  }

  return { send };
}
