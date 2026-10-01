import { useState, useRef, useEffect, useMemo } from 'react';
import { api, pct, typeColor } from '../api.js';
import { SECTOR_OPTIONS, REGION_OPTIONS } from '../classify.js';
import RiskPreview from './RiskPreview.jsx';
import ClassifySelect from './ClassifySelect.jsx';
import {
  FUND_CASH,
  FUND_MANUAL,
  FUND_PROPORTIONAL,
  addDisabled,
  allocationState,
  applyFunding,
  fundAllocation,
  isCashHolding,
  previewGate,
} from '../funding.js';

const TYPES = [
  { id: 'stock', label: 'Stock' },
  { id: 'etf', label: 'ETF' },
  { id: 'mutualfund', label: 'Fund' },
  { id: 'alt', label: 'Alt' },
  { id: 'cash', label: 'Cash' },
];

let seq = 0;
const keyify = () => `h${seq++}`;

function formatCooldown(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

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
  const [proposal, setProposal] = useState(null);
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

  const addRow = (nextRows) => {
    setRows(nextRows.map((r) => (r.uiKey ? r : { ...r, uiKey: keyify() })));
    setAdding(false);
  };

  // While the add form is open, preview the funded book (existing weights
  // adjusted + the new holding). Until the allocation is valid, preview stays
  // off so it can't compare the current weights to themselves.
  const pending = useMemo(() => {
    if (!proposal) return null;
    const gate = previewGate({
      adding: true,
      allocationRaw: proposal.allocationRaw,
      symbol: proposal.symbol,
      isCash: proposal.isCash,
    });
    if (gate.blocked) return { valid: false, message: gate.message, holdings: null };
    if (proposal.isCash && rows.some((r) => isCashHolding(r))) {
      return { valid: false, message: 'This model already has a cash holding — change its weight above.', holdings: null };
    }
    if (!proposal.isCash && proposal.symbol && rows.some((r) => String(r.symbol || '').toUpperCase() === proposal.symbol)) {
      return { valid: false, message: 'That symbol is already in this model — change its weight above.', holdings: null };
    }
    const funded = fundAllocation({
      holdings: rows.map((r) => ({
        key: r.uiKey, symbol: r.symbol, name: r.name, weightPct: r.weightPct, type: r.type,
      })),
      newHolding: {
        key: '__new__', symbol: proposal.symbol, name: proposal.name, isCash: proposal.isCash, type: proposal.type,
      },
      mode: proposal.mode,
      allocationPct: proposal.value,
    });
    if (!funded.canAdd) return { valid: false, message: funded.warning || gate.message, holdings: null };
    const byKey = new Map(funded.rows.filter((r) => !r.isNew).map((r) => [r.key, r.weightPct]));
    const holdings = rows.map((r) => ({
      instrumentId: r.instrumentId || undefined,
      symbol: r.symbol,
      source: r.source || (isCashHolding(r) ? 'manual' : 'auto'),
      weight: (byKey.has(r.uiKey) ? byKey.get(r.uiKey) : (Number(r.weightPct) || 0)) / 100,
    }));
    holdings.push({
      symbol: proposal.symbol,
      source: proposal.source || 'auto',
      weight: funded.newWeightPct / 100,
      hypothetical: true,
      ...(proposal.initialNav ? { initialNav: proposal.initialNav } : {}),
    });
    return { valid: true, message: null, holdings };
  }, [proposal, rows]);

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
          instrument: {
            symbol: r.symbol, name: r.name, type: r.type, source: r.source,
            currency: r.currency, sector: r.sector, country: r.country, mer: r.mer,
            ...(r.meta ? { meta: r.meta } : {}),
          },
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
          ? (
            <AddPanel
              rows={rows}
              onAdd={addRow}
              onCancel={() => setAdding(false)}
              onProposal={setProposal}
              hasCash={rows.some((r) => isCashHolding(r))}
            />
          )
          : <button type="button" className="add-holding" onClick={() => setAdding(true)}>+ Add holding</button>}

        {(rows.length > 0 || adding) && <RiskPreview modelKey={model.key} rows={rows} pending={pending} />}

        {err && <div className="banner" style={{ margin: '16px 0 0' }}>Couldn’t save — {err}</div>}
        {noChange && <div className="data-warn" style={{ margin: '16px 0 0' }}>No changes from the current version — nothing was saved.</div>}
      </div>

      <div className={`sum-bar${balanced ? ' ok' : overAllocated ? ' over' : ' short'}`}>
        <span>Total weight{!balanced && !overAllocated ? ` · ${pct((100 - total) / 100)} will go to Cash` : ''}</span>
        <span className="sum-val num">{pct(total / 100)}</span>
        {!balanced && <button type="button" className="sum-normalize" onClick={normalize}>Normalize to 100%</button>}
      </div>
      {overAllocated && <p className="note" style={{ padding: '8px 18px 0', margin: 0 }}>Over 100% — reduce a holding or normalize before saving; cash can only fill a shortfall, not remove an excess.</p>}
    </div>
  );
}

function AddPanel({ rows, onAdd, onCancel, onProposal, hasCash }) {
  const [symbol, setSymbol] = useState('');
  const [looking, setLooking] = useState(false);
  const [resolved, setResolved] = useState(null); // null | {found,...}
  const [form, setForm] = useState({ name: '', type: 'stock', currency: 'CAD', sector: '', country: '', mer: '', navDate: '', nav: '' });
  // Once the user picks a type or edits a field themselves, lookups must not
  // overwrite their choice — that was silently resetting the selection to Fund.
  const [allocationRaw, setAllocationRaw] = useState('');
  const [mode, setMode] = useState(FUND_PROPORTIONAL);
  const [touched, setTouched] = useState({ type: false, name: false, sector: false, country: false, currency: false });
  const panelRef = useRef(null);
  const resultRef = useRef(null);
  const isCash = form.type === 'cash';
  const sym = isCash ? CASH_SYMBOL : symbol.trim().toUpperCase();
  const navNum = Number(form.nav);
  const manualNav = !isCash && form.nav !== '' && form.navDate && Number.isFinite(navNum)
    ? { date: form.navDate, nav: navNum }
    : null;
  const alloc = allocationState(allocationRaw);
  const cashModeOff = isCash || !hasCash;

  const funded = alloc.valid ? fundAllocation({
    holdings: rows.map((r) => ({
      key: r.uiKey, symbol: r.symbol, name: r.name, weightPct: r.weightPct, type: r.type,
    })),
    newHolding: {
      key: '__new__',
      symbol: sym || 'NEW',
      name: isCash ? 'Cash' : (form.name || sym || 'New holding'),
      isCash,
      type: isCash ? 'cash' : form.type,
    },
    mode,
    allocationPct: alloc.value,
  }) : null;

  const duplicate = !isCash && !!sym && rows.some((r) => String(r.symbol || '').toUpperCase() === sym);
  const gate = addDisabled({
    allocationRaw,
    funding: funded,
    needsName: !isCash && !String(form.name || '').trim(),
    duplicate,
    cashAlready: isCash && hasCash,
  });

  useEffect(() => {
    if (mode === FUND_CASH && cashModeOff) setMode(FUND_PROPORTIONAL);
  }, [mode, cashModeOff]);

  useEffect(() => {
    const point = !isCash && form.nav !== '' && form.navDate && Number.isFinite(Number(form.nav))
      ? { date: form.navDate, nav: Number(form.nav) }
      : null;
    const liveSource = point || isCash
      ? 'manual'
      : (!resolved || resolved.found || resolved.allowAuto ? 'auto' : 'manual');
    onProposal?.({
      adding: true,
      allocationRaw,
      value: alloc.value,
      mode,
      symbol: sym,
      isCash,
      source: liveSource,
      initialNav: point,
      name: isCash ? 'Cash' : (form.name || sym),
      type: isCash ? 'cash' : form.type,
    });
  }, [onProposal, allocationRaw, alloc.value, mode, sym, isCash, form.nav, form.navDate, form.name, form.type, resolved]);

  useEffect(() => () => onProposal?.(null), [onProposal]);

  useEffect(() => { panelRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' }); }, []);
  useEffect(() => { if (resolved || isCash) resultRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); }, [resolved, isCash]);

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
      const suggested = r.suggestion || null;
      setForm((f) => ({
        ...f,
        // Only fill fields the user hasn't set themselves — and on a failed
        // lookup, clear them back to blank (or to this symbol's offline
        // suggestion) rather than leaving whatever a PREVIOUS symbol filled in.
        name: touched.name ? f.name : (r.found ? (r.name || suggested?.name || '') : (suggested?.name || '')),
        type: touched.type ? f.type : (r.guessType || 'stock'),
        currency: touched.currency ? f.currency : (r.currency || f.currency),
        sector: touched.sector ? f.sector : (r.found ? (r.sector || suggested?.sector || '') : (suggested?.sector || '')),
        country: touched.country ? f.country : (
          r.found
            ? (r.country || suggested?.region || '')
            : (suggested?.region || r.region || '')
        ),
      }));
    } catch (e) {
      setResolved({ found: false, symbol, reason: e.message, blocked: true });
    } finally {
      setLooking(false);
    }
  }

  function confirm() {
    if (gate.disabled || !alloc.valid) return;
    // Cash skips lookup entirely and uses the same instrument shape as the
    // automatic shortfall-fill: symbol CASH, type cash, source manual, NAV $1.
    // 'auto' = priced from the provider chain. 'manual' = priced from
    // user-entered NAVs. A confirmed quote stays auto. So does a lookup where
    // every hop was a cooldown, 429/403, missing key, or unreachable host and
    // at least one was rate-limiting — prices fill in on a later quote. A
    // provider that said the symbol does not exist stays manual. An entered
    // NAV always forces manual.
    const row = isCash
      ? cashRow(alloc.value)
      : {
        instrumentId: null,
        symbol: sym,
        name: form.name || sym,
        type: form.type,
        source: manualNav ? 'manual' : ((resolved?.found || resolved?.allowAuto) ? 'auto' : 'manual'),
        currency: form.currency || 'CAD',
        sector: form.sector || null,
        country: form.country || null,
        mer: form.mer.trim() === '' ? null : Number(form.mer),
        weightPct: alloc.value,
        ...((!resolved?.found && resolved?.allowAuto) ? {
          meta: {
            unverified: true,
            locks: {
              name: !!touched.name,
              sector: !!touched.sector,
              country: !!touched.country,
            },
            suggested: resolved.suggestion || null,
          },
        } : {}),
        ...(manualNav ? { initialNav: manualNav } : {}),
      };
    const result = applyFunding(rows, row, { mode, allocationPct: alloc.value });
    if (!result?.applied) return;
    onAdd(result.applied);
  }

  const manualNote = funded && mode === FUND_MANUAL
    ? (funded.total > 100.5
      ? `Total would be ${funded.total.toFixed(2)}%. Save stays blocked until weights are back to 100%.`
      : funded.total < 99.5
        ? `Total would be ${funded.total.toFixed(2)}%. A shortfall is added to Cash when you save.`
        : null)
    : null;
  const totalClass = !funded ? ''
    : funded.total > 100.5 ? 'over'
      : Math.abs(funded.total - 100) > 0.5 ? 'short' : 'ok';

  const allocationFields = (
    <>
      <label className="field alloc-field">
        <span>Allocation %</span>
        <input
          type="number"
          inputMode="decimal"
          min="0"
          max="100"
          step="any"
          placeholder="e.g. 5"
          value={allocationRaw}
          onChange={(e) => setAllocationRaw(e.target.value)}
        />
      </label>
      {!alloc.valid && <p className="fund-help">{alloc.message}</p>}

      <fieldset className="fund-modes">
        <legend>Fund this allocation</legend>
        <label className="fund-option">
          <input type="radio" name="fund-mode" checked={mode === FUND_PROPORTIONAL} onChange={() => setMode(FUND_PROPORTIONAL)} />
          <span>Scale existing holdings proportionally</span>
        </label>
        <label className={`fund-option${cashModeOff ? ' disabled' : ''}`}>
          <input type="radio" name="fund-mode" checked={mode === FUND_CASH} disabled={cashModeOff} onChange={() => setMode(FUND_CASH)} />
          <span>Take from Cash</span>
        </label>
        {cashModeOff && (
          <p className="fund-help">{isCash ? 'Taking from cash doesn’t apply when the new holding is cash.' : 'No cash holding in this model.'}</p>
        )}
        <label className="fund-option">
          <input type="radio" name="fund-mode" checked={mode === FUND_MANUAL} onChange={() => setMode(FUND_MANUAL)} />
          <span>I'll adjust weights manually</span>
        </label>
      </fieldset>

      {funded && (
        <div className="fund-preview" aria-label="Resulting weights">
          {funded.rows.map((r) => (
            <div className={`fund-preview-row${r.isNew ? ' is-new' : ''}`} key={`${r.isNew ? 'new' : 'old'}-${r.key}`}>
              <span>{r.isNew ? (r.symbol && r.symbol !== 'NEW' ? r.symbol : 'New holding') : (r.symbol || r.name)}</span>
              <span className="num">{Number(r.weightPct).toFixed(2)}%</span>
            </div>
          ))}
          <div className={`fund-preview-row total ${totalClass}`}>
            <span>Total</span>
            <span className="num">{funded.total.toFixed(2)}%</span>
          </div>
        </div>
      )}
      {funded?.warning && <div className="data-warn">{funded.warning}</div>}
      {manualNote && <p className="fund-help">{manualNote}</p>}
    </>
  );

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
          {allocationFields}
          <div className="notfound blocked-note">
            <div><span className="pill neutral">Manual · $1.00 NAV</span> not live-priced</div>
            <div className="reason">Cash is an ordinary manual instrument with NAV fixed at $1.00 — it doesn’t need a ticker or a live quote. Enter the allocation above.</div>
            {hasCash && (
              <div className="reason">This model already has a cash holding — change its weight above rather than adding another.</div>
            )}
          </div>
          {gate.disabled && !hasCash && <p className="fund-help">{gate.message}</p>}
          <div className="add-actions">
            <button type="button" className="ed-cancel" onClick={onCancel}>Cancel</button>
            {!hasCash && (
              <button type="button" className="btn-primary sm" onClick={confirm} disabled={gate.disabled}>Add to model</button>
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

          {allocationFields}

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
              ) : resolved.rateLimited ? (
                <div className="notfound blocked-note rate-limit-note">
                  <div><span className="pill amber">Rate limited</span></div>
                  <div className="rate-limit-msg">
                    Price sources are rate-limited right now, so I couldn't look up {(resolved.symbol || sym || '').toUpperCase()}. You can add it now and prices will fill in later.
                  </div>
                  {resolved.cooldownUntil && (
                    <div className="reason">Cooldown ends {formatCooldown(resolved.cooldownUntil)}.</div>
                  )}
                  <button type="button" className="lookup-retry" onClick={doLookup} disabled={looking}>
                    {looking ? '…' : 'Retry'}
                  </button>
                  <div className="reason">Open <code>/api/diagnostics</code> to see which price sources are cooling down.</div>
                </div>
              ) : resolved.blocked ? (
                <div className="notfound blocked-note">
                  <div><span className="pill amber">No data source reachable</span> couldn’t verify this ticker</div>
                  <div className="reason">{resolved.reason}</div>
                  <div className="reason">Adding this as a manual holding for now — enter a NAV below and update it periodically. Open <code>/api/diagnostics</code> to see which price sources currently work.</div>
                </div>
              ) : (
                <div className="notfound"><span className="pill neutral">Not found</span> add it manually below</div>
              )}

              {resolved.suggestion && !resolved.found && (
                <p className="suggested-note">suggested, edit if wrong</p>
              )}

              <label className="field"><span>Name</span>
                <input type="text" value={form.name}
                  onChange={(e) => { setTouched((t) => ({ ...t, name: true })); set('name')(e); }}
                  placeholder="Instrument name" />
              </label>

              <div className="field-row">
                <label className="field"><span>Currency</span>
                  <input type="text" value={form.currency} onChange={(e) => { setTouched((t) => ({ ...t, currency: true })); set('currency')(e); }} />
                </label>
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

              <div className="field-row field-row-nav">
                <label className="field"><span>NAV date (optional)</span><input type="date" value={form.navDate} onChange={set('navDate')} /></label>
                <label className="field"><span>NAV (optional)</span><input type="number" inputMode="decimal" value={form.nav} onChange={set('nav')} placeholder="e.g. 42.15" /></label>
              </div>
              <p className="note" style={{ paddingTop: 0 }}>
                {resolved.allowAuto
                  ? 'Optional. A NAV prices this name from your numbers and marks it manual. Leave it blank to keep live pricing once sources recover.'
                  : 'Optional. If you enter a NAV, this name is priced from your numbers — use this when live quotes fail.'}
              </p>

              {gate.disabled && <p className="fund-help">{gate.message}</p>}
              <div className="add-actions">
                <button type="button" className="ed-cancel" onClick={onCancel}>Cancel</button>
                <button type="button" className="btn-primary sm" onClick={confirm} disabled={gate.disabled}>Add to model</button>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
