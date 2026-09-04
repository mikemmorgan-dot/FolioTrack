import { useState, useEffect } from 'react';
import { api, money } from '../api.js';
import { asPctSigned, asPct } from '../riskFormat.js';
import { SECTOR_OPTIONS, REGION_OPTIONS } from '../classify.js';
import ClassifySelect from './ClassifySelect.jsx';
import LineChart from './LineChart.jsx';

const RANGES = ['1y', '2y', '5y'];

function SecurityInfo({ instrument }) {
  const [range, setRange] = useState('1y');
  const [reloadKey, setReloadKey] = useState(0);
  const [detail, setDetail] = useState(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState(null);

  useEffect(() => {
    setLoading(true); setErr(null);
    api.instrumentDetail(instrument.id, { range })
      .then(setDetail)
      .catch((e) => setErr(e.message))
      .finally(() => setLoading(false));
  }, [instrument.id, range, reloadKey]);

  const s = detail?.stats;
  const smallSample = s && s.months < 24;

  return (
    <div className="card pad" style={{ marginBottom: 18 }}>
      <div className="rp-head">
        <span className="rp-title">{instrument.symbol}</span>
        <div className="segmented">
          {RANGES.map((r) => (
            <button key={r} type="button" className={range === r ? 'seg active' : 'seg'} onClick={() => setRange(r)}>{r.toUpperCase()}</button>
          ))}
        </div>
      </div>

      {loading && <div className="loading">Loading…</div>}
      {err && <div className="banner" style={{ margin: '10px 0 0' }}>Couldn’t load — {err}</div>}

      {detail && !loading && (
        <>
          {detail.quote ? (
            <div className="rc-row" style={{ marginTop: 4 }}>
              <span>Price</span>
              <span className="num">{money(detail.quote.price, detail.quote.currency || instrument.currency)}{detail.quote.asOf ? ` · ${String(detail.quote.asOf).slice(0, 10)}` : ''}</span>
            </div>
          ) : (
            <div className="data-warn" style={{ marginTop: 8 }}>No current price available{detail.error ? ` — ${detail.error}` : ''}.</div>
          )}

          {detail.series.length >= 2 ? (
            <div style={{ marginTop: 10 }}><LineChart model={detail.series} benchmark={[]} height={140} /></div>
          ) : detail.error ? (
            <div className="data-warn" style={{ marginTop: 10 }}>
              Couldn’t load price history right now — {detail.error}
              <button type="button" className="classify-select-back" style={{ marginTop: 8 }} onClick={() => setReloadKey((k) => k + 1)}>Retry</button>
            </div>
          ) : (
            <div className="chart-empty" style={{ marginTop: 10 }}>Not enough history yet to chart.</div>
          )}

          {s ? (
            <div className="metric-grid" style={{ marginTop: 12 }}>
              <div className="metric"><div className="k">Return (ann.)</div><div className="v num">{asPctSigned(s.annualizedReturn)}</div></div>
              <div className="metric"><div className="k">Volatility</div><div className="v num">{asPct(s.volatility)}</div></div>
              <div className="metric"><div className="k">Max drawdown</div><div className="v num">{asPct(s.maxDrawdown)}</div></div>
            </div>
          ) : !detail.error ? (
            <p className="note" style={{ marginTop: 10 }}>Not enough price history yet to compute return/volatility.</p>
          ) : null}
          {smallSample && <div className="data-warn" style={{ marginTop: 8 }}>Only {s.months} monthly observations — treat as indicative, not precise.</div>}
          <p className="note" style={{ marginTop: 10 }}>This instrument’s own price history — not the model’s. {instrument.source === 'auto' ? 'Live pricing via the provider chain.' : 'From entered NAV points.'}</p>
        </>
      )}
    </div>
  );
}

let seq = 0;
const rowify = (list) => (list || []).map((r) => ({ uiKey: `bd${seq++}`, label: r.label, weight: String(r.weight) }));

function BreakdownEditor({ title, options, placeholder, rows, setRows }) {
  const total = rows.reduce((s, r) => s + (Number(r.weight) || 0), 0);
  const update = (uiKey, patch) => setRows((rs) => rs.map((r) => (r.uiKey === uiKey ? { ...r, ...patch } : r)));
  const remove = (uiKey) => setRows((rs) => rs.filter((r) => r.uiKey !== uiKey));
  const add = () => setRows((rs) => [...rs, { uiKey: `bd${seq++}`, label: '', weight: '' }]);

  return (
    <div className="field">
      <span>{title} <span className="muted">(optional — from the fund's factsheet)</span></span>
      {rows.map((r) => (
        <div className="field-row" key={r.uiKey}>
          <div style={{ flex: 1 }}>
            <ClassifySelect options={options} value={r.label} placeholder={placeholder}
              onChange={(v) => update(r.uiKey, { label: v })} />
          </div>
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
  const [mer, setMer] = useState(instrument.mer != null ? String(instrument.mer) : '');
  const [sectorRows, setSectorRows] = useState(() => rowify(instrument.sectorBreakdown));
  const [countryRows, setCountryRows] = useState(() => rowify(instrument.countryBreakdown));
  const [asOf, setAsOf] = useState(String(instrument.breakdownAsOf || '').slice(0, 10));
  const [note, setNote] = useState(instrument.breakdownNote || '');
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState(null);

  const validRows = (rows) => rows
    .map((r) => ({ label: r.label.trim(), weight: Number(r.weight) }))
    .filter((r) => r.label && Number.isFinite(r.weight) && r.weight > 0);

  const hasBreakdown = validRows(sectorRows).length > 0 || validRows(countryRows).length > 0;
  const asOfOk = /^\d{4}-\d{2}-\d{2}$/.test(asOf);
  const canSave = !saving && (!hasBreakdown || asOfOk);

  const savedOn = instrument.breakdownUpdatedAt
    ? new Date(instrument.breakdownUpdatedAt).toISOString().slice(0, 10)
    : null;

  async function save() {
    if (hasBreakdown && !asOfOk) {
      setErr('A factsheet as-of date is required when a look-through breakdown is set.');
      return;
    }
    setSaving(true); setErr(null);
    try {
      const updated = await api.updateInstrument(instrument.id, {
        sector: sector.trim() || null,
        country: country.trim() || null,
        mer: mer.trim() === '' ? null : Number(mer),
        sectorBreakdown: validRows(sectorRows).length ? validRows(sectorRows) : null,
        countryBreakdown: validRows(countryRows).length ? validRows(countryRows) : null,
        breakdownAsOf: asOfOk ? asOf : null,
        breakdownNote: note.trim() || null,
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
        <span className="ed-title">{instrument.symbol}</span>
        <button type="button" className="ed-save" disabled={!canSave} onClick={save}>{saving ? 'Saving…' : 'Save'}</button>
      </header>

      <div className="editor-body">
        <SecurityInfo instrument={instrument} />

        <div className="ed-section">MER</div>
        <label className="field"><span>Management expense ratio (optional, %)</span>
          <input type="number" inputMode="decimal" step="0.01" min="0" value={mer}
            onChange={(e) => setMer(e.target.value)} placeholder="e.g. 0.09" />
        </label>

        <p className="ed-hint">
          A breakdown below is entered manually from {instrument.name}'s factsheet — it isn't live data.
          {asOfOk ? ` Factsheet as-of ${asOf}.` : ''}
          {savedOn ? ` Last saved in FolioTrack ${savedOn}.` : ''}
        </p>

        <div className="ed-section">Fallback classification</div>
        <p className="note">Used for Geo/Sector when no breakdown is entered below.</p>
        <div className="field-row">
          <label className="field"><span>Sector</span>
            <ClassifySelect options={SECTOR_OPTIONS} value={sector} placeholder="e.g. Equity" onChange={setSector} />
          </label>
          <label className="field"><span>Region</span>
            <ClassifySelect options={REGION_OPTIONS} value={country} placeholder="e.g. Canada" onChange={setCountry} />
          </label>
        </div>

        <div className="ed-section">Fund look-through</div>
        <label className="field">
          <span>Factsheet as-of <span className="muted">(required when a breakdown is set)</span></span>
          <input type="date" value={asOf} onChange={(e) => setAsOf(e.target.value)} required={hasBreakdown} />
        </label>
        {hasBreakdown && !asOfOk && (
          <div className="data-warn">Factsheet as-of is required — without it Geo/Sector looks more precise than the data behind it.</div>
        )}
        <label className="field">
          <span>Note <span className="muted">(optional)</span></span>
          <input type="text" maxLength={200} value={note} onChange={(e) => setNote(e.target.value)}
            placeholder="e.g. VFV factsheet Aug 2026" />
        </label>
        <BreakdownEditor title="Sector breakdown" options={SECTOR_OPTIONS} placeholder="e.g. Financials" rows={sectorRows} setRows={setSectorRows} />
        <BreakdownEditor title="Country breakdown" options={REGION_OPTIONS} placeholder="e.g. Canada" rows={countryRows} setRows={setCountryRows} />

        {err && <div className="banner" style={{ margin: '16px 0 0' }}>Couldn’t save — {err}</div>}
      </div>
    </div>
  );
}
