import { useEffect, useState } from 'react';
import { api, BASIS, setBasis, money } from '../api.js';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function formatWhen(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  return d.toLocaleString('en-CA', {
    timeZone: 'America/Toronto',
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function formatPx(n, ccy) {
  if (n == null || !Number.isFinite(Number(n))) return '—';
  const num = Number(n).toLocaleString('en-CA', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return ccy ? `${num} ${ccy}` : num;
}

function formatDd(dd) {
  if (dd == null || !Number.isFinite(Number(dd))) return '—';
  const pct = Number(dd) * 100;
  return `${pct.toFixed(1)}%`;
}

function modelNames(models) {
  const names = (models || []).map((m) => m.name || m.key).filter(Boolean);
  return names.length ? names.join(', ') : '—';
}

export default function SettingsPanel({ onClose, onSaved, onAlertCount }) {
  const [basis, setBasisInput] = useState(String(BASIS));
  const [threshold, setThreshold] = useState('20');
  const [email, setEmail] = useState('');
  const [enabled, setEnabled] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const [loadErr, setLoadErr] = useState(null);
  const [status, setStatus] = useState(null);
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState(null);
  const [checking, setChecking] = useState(false);
  const [checkMsg, setCheckMsg] = useState(null);
  const [testing, setTesting] = useState(false);
  const [testMsg, setTestMsg] = useState(null);

  const basisN = Number(basis);
  const thresholdN = Number(threshold);
  const basisValid = Number.isFinite(basisN) && basisN > 0;
  const thresholdValid = Number.isFinite(thresholdN) && thresholdN >= 1 && thresholdN <= 90;
  const emailValid = EMAIL_RE.test(email.trim());
  const alertValid = thresholdValid && emailValid;
  const formValid = basisValid && alertValid;

  function applyPayload(payload) {
    setStatus(payload);
    const s = payload?.settings || {};
    if (s.alertThreshold != null) setThreshold(String(s.alertThreshold));
    if (s.alertEmail) setEmail(s.alertEmail);
    if (typeof s.alertEnabled === 'boolean') setEnabled(s.alertEnabled);
    if (onAlertCount) onAlertCount(payload?.activeCount || 0);
  }

  function reload() {
    return api.alerts().then(applyPayload);
  }

  useEffect(() => {
    let cancel = false;
    api.alerts()
      .then((payload) => { if (!cancel) applyPayload(payload); })
      .catch((e) => { if (!cancel) setLoadErr(e.message); })
      .finally(() => { if (!cancel) setLoaded(true); });
    return () => { cancel = true; };
  }, []);

  async function persistAlerts() {
    if (!alertValid) throw new Error('Fix the threshold and email before continuing');
    if (basisValid) setBasis(basisN);
    await api.saveAlertSettings({
      alertThreshold: thresholdN,
      alertEmail: email.trim(),
      alertEnabled: enabled,
    });
    onSaved?.();
  }

  async function save() {
    if (!formValid || saving) return;
    setSaving(true);
    setSaveMsg(null);
    try {
      await persistAlerts();
      await reload();
      setSaveMsg('Saved');
    } catch (e) {
      setSaveMsg(e.message);
    } finally {
      setSaving(false);
    }
  }

  async function checkNow() {
    if (checking) return;
    setChecking(true);
    setCheckMsg(null);
    try {
      if (alertValid) await persistAlerts();
      const summary = await api.runAlerts();
      await reload();
      const pending = summary.pending ? `, ${summary.pending} email pending` : '';
      setCheckMsg(`Checked ${summary.evaluated ?? 0} holdings. ${summary.active ?? 0} breached${pending}.`);
    } catch (e) {
      setCheckMsg(e.message);
    } finally {
      setChecking(false);
    }
  }

  async function sendTest() {
    if (testing || !alertValid) return;
    setTesting(true);
    setTestMsg(null);
    try {
      await persistAlerts();
      const result = await api.testAlertEmail();
      if (result.ok) setTestMsg({ ok: true, text: 'Test email sent.' });
      else setTestMsg({ ok: false, text: result.error || 'Email failed' });
      await reload();
    } catch (e) {
      setTestMsg({ ok: false, text: e.message });
    } finally {
      setTesting(false);
    }
  }

  const active = status?.active || [];
  const history = status?.history || [];

  return (
    <div className="editor">
      <header className="editor-bar">
        <button type="button" className="ed-cancel" onClick={onClose}>Done</button>
        <span className="ed-title">Settings</span>
        <button type="button" className="ed-save" disabled={!formValid || saving} onClick={save}>{saving ? 'Saving…' : 'Save'}</button>
      </header>

      <div className="editor-body">
        <div className="ed-section">Display</div>
        <label className="field"><span>Modelled portfolio value</span>
          <input type="number" inputMode="decimal" min="1" step="1000" value={basis}
            onChange={(e) => setBasisInput(e.target.value)} placeholder="e.g. 1000000" />
        </label>
        <p className="ed-hint">
          Every model is displayed as if this amount were invested — holdings show as weight × this value.
          It’s a display preference only (models store target weights, not dollars), saved on this device.
          {basisValid && ` Currently: ${money(basisN)}.`}
        </p>

        <div className="ed-section">Price drop alerts</div>
        {loadErr && <div className="banner">Couldn’t load alert settings — {loadErr}</div>}
        <div className="switch-row">
          <div>
            <div className="switch-label">Alerts {enabled ? 'on' : 'off'}</div>
            <p className="ed-hint">When off, breaches are still tracked. Email waits until you turn alerts back on.</p>
          </div>
          <button type="button" role="switch" aria-checked={enabled} aria-label="Price drop alerts"
            className={`switch${enabled ? ' on' : ''}`} onClick={() => setEnabled((v) => !v)}>
            <span />
          </button>
        </div>

        <label className="field"><span>Drawdown threshold (%)</span>
          <input type="number" inputMode="decimal" min="1" max="90" step="0.5" value={threshold}
            onChange={(e) => setThreshold(e.target.value)} />
        </label>
        {!thresholdValid && <p className="field-error">Threshold must be between 1 and 90.</p>}
        <p className="ed-hint">
          A holding alerts when its price is this far below the 52-week high. It clears only after it climbs back by an extra 2 percentage points, so a small bounce doesn’t flap the alert.
        </p>

        <label className="field"><span>Alert email</span>
          <input type="email" inputMode="email" autoComplete="email" value={email}
            onChange={(e) => setEmail(e.target.value)} placeholder="mikemmorgan@gmail.com" />
        </label>
        {email.length > 0 && !emailValid && <p className="field-error">Enter a valid email.</p>}
        <p className="ed-hint">
          One email per holding when it first breaches. It is not resent while the holding stays breached. Delivery uses the Resend HTTPS API from the server (not SMTP). The free onboarding sender can only deliver to the Resend account owner.
        </p>
        {!loaded && <p className="ed-hint">Loading saved settings…</p>}
        {loaded && status && !status.emailConfigured && (
          <div className="data-warn">
            <span>Email is not configured on the server. Breaches are saved as “pending - email not configured” and retried on the next check.</span>
          </div>
        )}
        {saveMsg && <p className={saveMsg === 'Saved' ? 'save-ok' : 'field-error'}>{saveMsg}</p>}

        <div className="alert-actions">
          <button type="button" className="rp-run" disabled={checking} onClick={checkNow}>
            {checking ? 'Checking…' : 'Check now'}
          </button>
          <button type="button" className="rp-run alert-secondary" disabled={testing || !alertValid} onClick={sendTest}>
            {testing ? 'Sending…' : 'Send test email'}
          </button>
        </div>
        {checkMsg && <p className="ed-hint">{checkMsg}</p>}
        {testMsg && (
          <div className={testMsg.ok ? 'save-ok' : 'data-warn'}>
            <span>{testMsg.ok ? testMsg.text : testMsg.text}</span>
          </div>
        )}

        <div className="ed-section">Breached now</div>
        <p className="ed-hint">
          Last check: {status?.lastCheckAt ? formatWhen(status.lastCheckAt) : 'not yet'}.
          {status?.lastCheckError ? ` Check error: ${status.lastCheckError}` : ''}
        </p>
        {active.length === 0 && <p className="ed-hint">No holdings are through the drawdown threshold.</p>}
        <div className="nav-list">
          {active.map((a) => (
            <article key={a.instrumentId} className="nav-card alert-card">
              <div className="nav-card-top">
                <div>
                  <div className="alert-sym">{a.symbol}</div>
                  <div className="nav-models">{a.name}</div>
                </div>
                <div className="alert-dd neg">{formatDd(a.currentDrawdown)}</div>
              </div>
              <p className="alert-basis">{a.basisLabel}</p>
              <p className="nav-meta">
                High {formatPx(a.referencePrice, a.currency)} on {a.referenceDate || '—'}
                {' · '}now {formatPx(a.currentPrice, a.currency)}
              </p>
              <p className="nav-models">Held in {modelNames(a.models)}</p>
              <p className="nav-meta">
                {a.lastNotifiedAt
                  ? `Notified ${formatWhen(a.lastNotifiedAt)}`
                  : `Email pending${a.notifyDetail ? ` — ${a.notifyDetail}` : ''}`}
              </p>
              {a.stale && (
                <div className="data-warn">
                  <span>Price as of {a.priceAsOf} is more than 5 days old. Some TSX and manual NAVs update weeks apart — treat this drawdown as stale until a newer close is cached.</span>
                </div>
              )}
              {a.lastEvalNote && <p className="nav-models">{a.lastEvalNote}</p>}
            </article>
          ))}
        </div>

        <div className="ed-section">Recent alerts</div>
        {history.length === 0 && <p className="ed-hint">No alert history yet.</p>}
        <div className="nav-list">
          {history.map((h) => (
            <article key={h.id} className="nav-card">
              <div className="nav-card-top">
                <div>
                  <div className="alert-sym">{h.symbol}</div>
                  <div className="nav-models">{h.kind}{h.detail ? ` — ${h.detail}` : ''}</div>
                </div>
                <div className="nav-meta">{formatWhen(h.at)}</div>
              </div>
              {h.drawdown != null && <p className="nav-meta">Drawdown {formatDd(h.drawdown)}</p>}
            </article>
          ))}
        </div>
      </div>
    </div>
  );
}
