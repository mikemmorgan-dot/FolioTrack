import { useState, useRef, useEffect } from 'react';
import { api, pct, typeColor, typeLabel } from '../api.js';
import { SECTOR_OPTIONS, REGION_OPTIONS } from '../classify.js';
import RiskPreview from './RiskPreview.jsx';
import ClassifySelect from './ClassifySelect.jsx';

const TYPES = [
  { id: 'stock', label: 'Stock' },
  { id: 'etf', label: 'ETF' },
  { id: 'mutualfund', label: 'Fund' },
  { id: 'alt', label: 'Alt' },
  { id: 'cash', label: 'Cash' },
];

let seq = 0;
const keyify = () => `h${seq++}`;

// Cash is an ordinary manual holding whose NAV never moves — $1.00, always —
// so it needs no special-casing anywhere in the pricing/return/risk math:
// a constant price is already exactly 0% return, 0% volatility by
// construction in every existing calculation. ensureInstrument dedupes by
// symbol, so this resolves to the same instrument every time it's used.
const CASH_SYMBOL = 'CASH';
const cashRow = (weightPct) => ({
  uiKey: keyify(), instrumentId: null, symbol: CASH_SYMBOL, name: 'Cash', type: 'cash',
  source: 'manual', currency: 'CAD', sector: null, country: null, mer: null,
  weightPct: +weightPct.toFixed(2),
  initialNav: { date: '2020-01-01', nav: 1 },
});

// `overrideWeights` (instrumentId -> weightPct) lets a caller open the editor
// pre-filled with, e.g., the optimizer's suggested weights instead of the
// model's currently saved ones. Falls back to the saved weight per holding.
function fromModel(model, overrideWeights) {
  return model.holdings.map((h) => ({
    uiKey: keyify(),
    instrumentId: h.id,
    symbol: h.symbol, name: h.name, type: h.type, currency: h.currency,
    sector: h.sector, country: h.country, mer: h.mer,
    source: h.source,
    weightPct: overrideWeights?.[h.id] ?? +(h.weight * 100).toFixed(2),
  }));
}

export default function EditModel({ model, initialWeights, onClose, onSaved }) {
  const [rows, setRows] = useState(() => fromModel(model, initialWeights));
  const [effectiveDate, setEffectiveDate] = useState(new Date().toISOString().slice(0, 10));
  const [note, setNote] = useState('');
  const [adding, setAdding] = useState(false);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState(null);
  const [noChange, setNoChange] = useState(false);

  const total = rows.reduce((s, r) => s + (Number(r.weightPct) || 0), 0);
  const balanced = Math.abs(total - 100) <= 0.5;
  const overAllocated = total > 100.5;
  // Under 100% is fine now — save() tops up a Cash sleeve for the shortfall
  // automatically. Over 100% still blocks: there's no equivalent automatic
  // fix for "too much allocated" (nothing to shrink without guessing what).
  const canSave = rows.length > 0 && !overAllocated && !saving;

  const setWeight = (uiKey, v) => setRows((rs) => rs.map((r) => (r.uiKey === uiKey ? { ...r, weightPct: v } : r)));
  const remove = (uiKey) => setRows((rs) => rs.filter((r) => r.uiKey !== uiKey));
  const normalize = () => {
    if (total <= 0) return;
    setRows((rs) => rs.map((r) => ({ ...r, weightPct: +((Number(r.weightPct) || 0) / total * 100).toFixed(2) })));
  };

  const addRow = (row) => {
    setRows((rs) => {
      // CASH is one instrument (ensureInstrument dedupes by symbol). A second
      // row would collide on version_holdings' (version, instrument) PK.
      if (row.symbol === CASH_SYMBOL && rs.some((r) => r.symbol === CASH_SYMBOL)) return rs;
      return [...rs, { ...row, uiKey: keyify() }];
    });
    setAdding(false);
  };

  async function save() {
    setSaving(true); setErr(null); setNoChange(false);
    try {
      // Top up (or create) a Cash row for any shortfall below 100% — the
      // "allocate to cash automatically" behavior. Over 100% is already
      // blocked by canSave, so shortfall here is never negative in practice.
      let finalRows = rows;
      const shortfall = 100 - total;
      if (shortfall > 0.01) {
        const cashIdx = rows.findIndex((r) => r.symbol === CASH_SYMBOL);
        finalRows = cashIdx >= 0
          ? rows.map((r, i) => (i === cashIdx ? { ...r, weightPct: +((Number(r.weightPct) || 0) + shortfall).toFixed(2) } : r))
          : [...rows, cashRow(shortfall)];
      }
      const holdings = finalRows.map((r) => {
        const weight = (Number(r.weightPct) || 0) / 100;
        if (r.instrumentId) return { instrumentId: r.instrumentId, weight };
        return {
          instrument: { symbol: r.symbol, name: r.name, type: r.type, source: r.source, currency: r.currency, sector: r.sector, country: r.country, mer: r.mer },
          weight,
          ...(r.initialNav ? { initialNav: r.initialNav } : {}),
        };
      });
      const result = await api.addVersion(model.key, { effectiveDate, note, holdings });
      if (result?.noChange) { setSaving(false); setNoChange(true); return; }
      onSaved();
    } catch (e) {
      setErr(e.message); setSaving(false);
    }
  }

  return (
    <div className="editor">
      <header className="editor-bar">
        <button type="button" className="ed-cancel" onClick={onClose}>Cancel</button>
        <span className="ed-title">Edit {model.name}</span>
        <button type="button" className="ed-save" disabled={!canSave} onClick={save}>{saving ? 'Saving…' : 'Save'}</button>
      </header>

      <div className="editor-body">
        <p className="ed-hint">Saving records a new effective-dated version — it doesn’t overwrite history.</p>

        <div className="field-row">
          <label className="field">
            <span>Effective date</span>
            <input type="date" value={effectiveDate} onChange={(e) => setEffectiveDate(e.target.value)} />
          </label>
        </div>
        <label className="field">
          <span>What changed &amp; why</span>
          <input type="text" placeholder="e.g. Trimmed bonds, added private credit" value={note} onChange={(e) => setNote(e.target.value)} />
        </label>

        <div className="ed-section">Holdings</div>
        <div className="rows grouped">
          {rows.map((r) => (
            <div className="row edit-row" key={r.uiKey}>
              <span className="asset-icon" style={{ '--ai-c': typeColor(r.type) }}>{(r.symbol || '?').replace(/\..*/, '').slice(0, 3)}</span>
              <div className="row-main">
                <div className="row-sym">{r.symbol}</div>
                <div className="row-sub">{r.name}{r.source === 'manual' ? ' · manual' : ''}</div>
              </div>
              <div className="weight-input">
                <input type="number" inputMode="decimal" value={r.weightPct}
                  onChange={(e) => setWeight(r.uiKey, e.target.value)} />
                <span>%</span>
              </div>
              <button type="button" className="row-x" aria-label="Remove" onClick={() => remove(r.uiKey)}>×</button>
            </div>
          ))}
          {rows.length === 0 && <div className="row"><span className="muted">No holdings — add one below.</span></div>}
        </div>

        {adding
          ? <AddPanel onAdd={addRow} onCancel={() => setAdding(false)} hasCash={rows.some((r) => r.symbol === CASH_SYMBOL)} />
          : <button type="button" className="add-holding" onClick={() => setAdding(true)}>+ Add holding</button>}

        {rows.length > 0 && <RiskPreview modelKey={model.key} rows={rows} />}

        {err && <div className="banner" style={{ margin: '16px 0 0' }}>Couldn’t save — {err}</div>}
        {noChange && <div className="data-warn" style={{ margin: '16px 0 0' }}>No changes from the current version — nothing was saved.</div>}
      </div>

      <div className={`sum-bar${balanced ? ' ok' : ''}`}>
        <span>Total weight{!balanced && !overAllocated ? ` · ${pct((100 - total) / 100)} will go to Cash` : ''}</span>
        <span className="sum-val num">{pct(total / 100)}</span>
        {!balanced && <button type="button" className="sum-normalize" onClick={normalize}>Normalize to 100%</button>}
      </div>
      {overAllocated && <p className="note" style={{ padding: '8px 18px 0', margin: 0 }}>Over 100% — reduce a holding or normalize before saving; cash can only fill a shortfall, not remove an excess.</p>}
    </div>
  );
}

function AddPanel({ onAdd, onCancel, hasCash }) {
  const [symbol, setSymbol] = useState('');
  const [looking, setLooking] = useState(false);
  const [resolved, setResolved] = useState(null); // null | {found,...}
  const [form, setForm] = useState({ name: '', type: 'stock', currency: 'CAD', sector: '', country: '', mer: '', navDate: '', nav: '' });
  // Once the user picks a type or edits a field themselves, lookups must not
  // overwrite their choice — that was silently resetting the selection to Fund.
  const [touched, setTouched] = useState({ type: false, name: false, sector: false, country: false });
  const panelRef = useRef(null);
  const resultRef = useRef(null);
  const isCash = form.type === 'cash';

  useEffect(() => { panelRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' }); }, []);
  useEffect(() => { if (resolved || isCash) resultRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' }); }, [resolved, isCash]);

  async function doLookup() {
    if (!symbol.trim()) return;
    // A space means a company name, not a ticker ("HYDRO ONE" vs "H.TO") —
    // catch it before it burns a provider call and returns a confusing wall
    // of per-provider errors for a symbol that was never going to exist.
    if (/\s/.test(symbol.trim())) {
      setResolved({
        found: false, blocked: false, symbol: symbol.trim(),
        nameLike: true,
      });
      return;
    }
    setLooking(true);
    try {
      const r = await api.lookup(symbol.trim());
      setResolved(r);
      setForm((f) => ({
        ...f,
        // Only fill fields the user hasn't set themselves — and on a failed
        // lookup, clear them back to blank rather than leaving whatever a
        // PREVIOUS (different) symbol's successful lookup had filled in.
        // Otherwise a blocked H.TO lookup right after a resolved bare H
        // leaves Hyatt's name sitting there looking like it belongs to H.TO.
        name: touched.name ? f.name : (r.found ? r.name : ''),
        type: touched.type ? f.type : (r.found ? r.guessType : 'stock'),
        currency: r.found ? (r.currency || f.currency) : f.currency,
        // Best-effort — providers.js only fills these in when its profile
        // source (Twelve Data) actually covers the symbol, unverified for TSX.
        // Same stale-data reasoning as name/type: a symbol change that fails
        // to classify (or fails outright) must not keep a DIFFERENT earlier
        // symbol's sector/country sitting there looking current.
        sector: touched.sector ? f.sector : (r.sector || ''),
        country: touched.country ? f.country : (r.country || ''),
      }));
    } catch (e) {
      setResolved({ found: false, symbol, reason: e.message, blocked: true });
    } finally {
      setLooking(false);
    }
  }

  function confirm() {
    // Cash skips lookup entirely and uses the same instrument shape as the
    // automatic shortfall-fill: symbol CASH, type cash, source manual, NAV $1.
    if (isCash) {
      if (hasCash) return;
      onAdd(cashRow(0));
      return;
    }
    // 'auto' = priced from the provider chain. 'manual' = priced from
    // user-entered NAVs. Only an actual confirmed price earns 'auto' — a
    // block doesn't get the benefit of the doubt. That used to be assumed
    // transient for listed types, but for TSX specifically it isn't: no
    // free-tier fallback covers TSX quotes (see providers.js), so a blocked
    // TSX symbol would otherwise sit "auto" and just never price.
    const auto = !!resolved?.found;
    const row = {
      instrumentId: null,
      symbol: symbol.trim().toUpperCase(),
      name: form.name || symbol.trim().toUpperCase(),
      type: form.type,
      source: auto ? 'auto' : 'manual',
      currency: form.currency || 'CAD',
      sector: form.sector || null,
      country: form.country || null,
      mer: form.mer.trim() === '' ? null : Number(form.mer),
      weightPct: 0,
    };
    if (!auto && form.nav && form.navDate) row.initialNav = { date: form.navDate, nav: Number(form.nav) };
    onAdd(row);
  }

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const pickType = (id) => {
    setTouched((s) => ({ ...s, type: true }));
    setForm((f) => ({ ...f, type: id }));
  };

  return (
    <div className="add-panel" ref={panelRef}>
      <div className="field"><span>Type</span>
        <div className="segmented">
          {TYPES.map((t) => (
            <button key={t.id} type="button" className={form.type === t.id ? 'seg active' : 'seg'}
              style={form.type === t.id ? { '--seg-c': typeColor(t.id) } : undefined}
              onClick={() => pickType(t.id)}>{t.label}</button>
          ))}
        </div>
      </div>

      {isCash ? (
        <div className="lookup-result" ref={resultRef}>
          <div className="notfound blocked-note">
            <div><span className="pill neutral">Manual · $1.00 NAV</span> not live-priced</div>
            <div className="reason">Cash is an ordinary manual instrument with NAV fixed at $1.00 — it doesn’t need a ticker or a live quote. Set its weight in the list after adding.</div>
            {hasCash && (
              <div className="reason">This model already has a cash holding — change its weight above rather than adding another.</div>
            )}
          </div>
          <div className="add-actions">
            <button type="button" className="ed-cancel" onClick={onCancel}>Cancel</button>
            {!hasCash && (
              <button type="button" className="btn-primary sm" onClick={confirm}>Add to model</button>
            )}
          </div>
        </div>
      ) : (
        <>
          <div className="lookup-row">
            <input className="sym-input" placeholder="Ticker / fund code (e.g. AAPL, VFV.TO, RBF1005)"
              value={symbol} autoCapitalize="characters"
              onChange={(e) => { setSymbol(e.target.value); setResolved(null); }} />
            <button type="button" className="lookup-btn" onClick={doLookup} disabled={looking || !symbol.trim()}>{looking ? '…' : 'Look up'}</button>
          </div>

          {resolved && (
            <div className="lookup-result" ref={resultRef}>
              {resolved.found ? (
                <div className="found">
                  <span className="pill green">Live{resolved.provider ? ` · ${resolved.provider}` : ''}</span>
                  {resolved.partial
                    ? <span>Price found, but this source carries no name or currency — please fill them in.</span>
                    : <span>{resolved.name} · {resolved.currency}</span>}
                  {!resolved.sector && !resolved.country && resolved.classificationError && (
                    <div className="reason">Sector/region couldn’t be auto-filled ({resolved.classificationError}) — fill them in below if you have them.</div>
                  )}
                </div>
              ) : resolved.nameLike ? (
                <div className="notfound blocked-note">
                  <div><span className="pill amber">That looks like a company name</span></div>
                  <div className="reason">Enter the ticker symbol instead — e.g. Hydro One is <code>H.TO</code>, Royal Bank is <code>RY.TO</code>. TSX listings use the <code>.TO</code> suffix; a bare symbol is treated as US-listed.</div>
                </div>
              ) : resolved.blocked ? (
                <div className="notfound blocked-note">
                  <div><span className="pill amber">No data source reachable</span> couldn’t verify this ticker</div>
                  <div className="reason">{resolved.reason}</div>
                  <div className="reason">Adding this as a manual holding for now — enter a NAV below and update it periodically. Open <code>/api/diagnostics</code> to see which price sources currently work.</div>
                </div>
              ) : (
                <div className="notfound"><span className="pill neutral">Not on Yahoo</span> add it manually below</div>
              )}

              <label className="field"><span>Name</span>
                <input type="text" value={form.name}
                  onChange={(e) => { setTouched((t) => ({ ...t, name: true })); set('name')(e); }}
                  placeholder="Instrument name" />
              </label>

              <div className="field-row">
                <label className="field"><span>Currency</span><input type="text" value={form.currency} onChange={set('currency')} /></label>
                <label className="field"><span>Sector (optional)</span>
                  <ClassifySelect options={SECTOR_OPTIONS} value={form.sector} placeholder="e.g. Energy"
                    onChange={(v) => { setTouched((t) => ({ ...t, sector: true })); setForm((f) => ({ ...f, sector: v })); }} />
                </label>
              </div>
              <label className="field"><span>Region (optional)</span>
                <ClassifySelect options={REGION_OPTIONS} value={form.country} placeholder="e.g. Canada"
                  onChange={(v) => { setTouched((t) => ({ ...t, country: true })); setForm((f) => ({ ...f, country: v })); }} />
              </label>

              {(form.type === 'etf' || form.type === 'mutualfund') && (
                <label className="field"><span>MER (optional, %)</span>
                  <input type="number" inputMode="decimal" step="0.01" min="0" value={form.mer}
                    onChange={set('mer')} placeholder="e.g. 0.09" />
                </label>
              )}

              {!resolved.found && (
                <div className="field-row field-row-nav">
                  <label className="field"><span>NAV date (optional)</span><input type="date" value={form.navDate} onChange={set('navDate')} /></label>
                  <label className="field"><span>NAV (optional)</span><input type="number" inputMode="decimal" value={form.nav} onChange={set('nav')} placeholder="e.g. 42.15" /></label>
                </div>
              )}

              <div className="add-actions">
                <button type="button" className="ed-cancel" onClick={onCancel}>Cancel</button>
                <button type="button" className="btn-primary sm" onClick={confirm} disabled={!form.name.trim()}>Add to model</button>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
