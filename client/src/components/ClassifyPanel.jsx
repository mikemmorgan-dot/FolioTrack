import { useState } from 'react';
import { api } from '../api.js';

let seq = 0;
const rowify = (list) => (list || []).map((r) => ({ uiKey: `bd${seq++}`, label: r.label, weight: String(r.weight) }));

function BreakdownEditor({ title, rows, setRows }) {
  const total = rows.reduce((s, r) => s + (Number(r.weight) || 0), 0);
  const update = (uiKey, patch) => setRows((rs) => rs.map((r) => (r.uiKey === uiKey ? { ...r, ...patch } : r)));
  const remove = (uiKey) => setRows((rs) => rs.filter((r) => r.uiKey !== uiKey));
  const add = () => setRows((rs) => [...rs, { uiKey: `bd${seq++}`, label: '', weight: '' }]);

  return (
    <div className="field">
      <span>{title} <span className="muted">(optional — from the fund's factsheet)</span></span>
      {rows.map((r) => (
        <div className="field-row" key={r.uiKey}>
          <input type="text" placeholder="e.g. Financials" value={r.label}
            onChange={(e) => update(r.uiKey, { label: e.target.value })} />
          <input type="number" inputMode="decimal" placeholder="%" style={{ maxWidth: 80 }}
            value={r.weight} onChange={(e) => update(r.uiKey, { weight: e.target.value })} />
          <button type="button" className="row-x" aria-label="Remove" onClick={() => remove(r.uiKey)}>×</button>
        </div>
      ))}
      <button type="button" className="add-holding" onClick={add}>+ Add row</button>
      {rows.length > 0 && (
        <div className="muted" style={{ marginTop: 4 }}>
          Total {total.toFixed(0)}%{Math.abs(total - 100) > 1 ? ' — doesn’t need to be exactly 100%, distributes proportionally' : ''}
        </div>
      )}
    </div>
  );
}

export default function ClassifyPanel({ instrument, onClose, onSaved }) {
  const [sector, setSector] = useState(instrument.sector || '');
  const [country, setCountry] = useState(instrument.country || '');
  const [sectorRows, setSectorRows] = useState(() => rowify(instrument.sectorBreakdown));
  const [countryRows, setCountryRows] = useState(() => rowify(instrument.countryBreakdown));
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState(null);

  const validRows = (rows) => rows
    .map((r) => ({ label: r.label.trim(), weight: Number(r.weight) }))
    .filter((r) => r.label && Number.isFinite(r.weight) && r.weight > 0);

  async function save() {
    setSaving(true); setErr(null);
    try {
      const updated = await api.updateInstrument(instrument.id, {
        sector: sector.trim() || null,
        country: country.trim() || null,
        sectorBreakdown: validRows(sectorRows).length ? validRows(sectorRows) : null,
        countryBreakdown: validRows(countryRows).length ? validRows(countryRows) : null,
      });
      onSaved(updated);
    } catch (e) {
      setErr(e.message); setSaving(false);
    }
  }

  return (
    <div className="editor">
      <header className="editor-bar">
        <button type="button" className="ed-cancel" onClick={onClose}>Cancel</button>
        <span className="ed-title">Classify {instrument.symbol}</span>
        <button type="button" className="ed-save" disabled={saving} onClick={save}>{saving ? 'Saving…' : 'Save'}</button>
      </header>

      <div className="editor-body">
        <p className="ed-hint">
          A breakdown below is entered manually from {instrument.name}'s factsheet — it isn't live data.
          {instrument.breakdownUpdatedAt && ` Last updated ${new Date(instrument.breakdownUpdatedAt).toISOString().slice(0, 10)}.`}
        </p>

        <div className="ed-section">Fallback classification</div>
        <p className="note">Used for Geo/Sector when no breakdown is entered below.</p>
        <div className="field-row">
          <label className="field"><span>Sector</span><input type="text" value={sector} onChange={(e) => setSector(e.target.value)} placeholder="e.g. Equity" /></label>
          <label className="field"><span>Region</span><input type="text" value={country} onChange={(e) => setCountry(e.target.value)} placeholder="e.g. Canada" /></label>
        </div>

        <div className="ed-section">Fund look-through</div>
        <BreakdownEditor title="Sector breakdown" rows={sectorRows} setRows={setSectorRows} />
        <BreakdownEditor title="Country breakdown" rows={countryRows} setRows={setCountryRows} />

        {err && <div className="banner" style={{ margin: '16px 0 0' }}>Couldn’t save — {err}</div>}
      </div>
    </div>
  );
}
