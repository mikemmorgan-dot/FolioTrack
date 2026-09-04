import { useState, useEffect, useRef } from 'react';
import { api, money } from '../api.js';
import { asPctSigned, asPct } from '../riskFormat.js';
import { SECTOR_OPTIONS, REGION_OPTIONS } from '../classify.js';
import ClassifySelect from './ClassifySelect.jsx';
import LineChart from './LineChart.jsx';

const RANGES = ['1y', '2y', '5y'];
const HISTORY_MODES = [
  { id: 'since-added', label: 'Since added' },
  { id: 'full', label: 'Full history' },
];

function SecurityInfo({ instrument, modelKey }) {
  const inModel = !!modelKey;
  const [range, setRange] = useState('1y');
  const [mode, setMode] = useState('since-added');
  const [reloadKey, setReloadKey] = useState(0);
  const [detail, setDetail] = useState(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState(null);
  const forceRefresh = useRef(false);

  useEffect(() => {
    const refresh = forceRefresh.current;
    forceRefresh.current = false;
    setLoading(true); setErr(null);
    const req = inModel
      ? api.holdingHistory(modelKey, instrument.id, { mode, refresh })
      : api.instrumentDetail(instrument.id, { range, refresh });
    req.then(setDetail).catch((e) => setErr(e.message)).finally(() => setLoading(false));
  }, [instrument.id, range, mode, modelKey, inModel, reloadKey]);

  const retry = () => { forceRefresh.current = true; setReloadKey((k) => k + 1); };

  const s = detail?.stats;
  const smallSample = s && (s.estimate || s.months < 24);
  const periodReturn = s?.periodReturn;
  const rangeFrom = detail?.range?.from || detail?.series?.[0]?.date;
  const rangeTo = detail?.range?.to || detail?.series?.at?.(-1)?.date;

  return (
    <div className="card pad" style={{ marginBottom: 18 }}>
      <div className="rp-head">
        <span className="rp-title">{instrument.symbol}</span>
        {inModel ? (
          <div className="segmented" style={{ flex: '1 1 180px' }}>
            {HISTORY_MODES.map((m) => (
              <button key={m.id} type="button" className={mode === m.id ? 'seg active' : 'seg'} onClick={() => setMode(m.id)}>{m.label}</button>
            ))}
          </div>
        ) : (
          <div className="segmented">
            {RANGES.map((r) => (
              <button key={r} type="button" className={range === r ? 'seg active' : 'seg'} onClick={() => setRange(r)}>{r.toUpperCase()}</button>
            ))}
          </div>
        )}
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
          ) : !detail.stale ? (
            <div className="data-warn" style={{ marginTop: 8 }}>No current price available{detail.error ? ` — ${detail.error}` : ''}.</div>
          ) : null}

          {detail.stale && detail.series.length >= 2 && (
            <div className="data-warn" style={{ marginTop: 10 }}>
              Showing cached prices{detail.fetchedAt ? ` from ${String(detail.fetchedAt).slice(0, 10)}` : ''} — live providers are unavailable right now. The chart may be behind.
              <button type="button" className="classify-select-back" style={{ marginTop: 8 }} onClick={retry}>Retry</button>
            </div>
          )}

          {detail.series.length >= 2 ? (
            <div style={{ marginTop: 10 }}><LineChart model={detail.series} benchmark={[]} height={140} /></div>
          ) : detail.error ? (
            <div className="data-warn" style={{ marginTop: 10 }}>
              Couldn’t load price history right now — {detail.error}
              <button type="button" className="classify-select-back" style={{ marginTop: 8 }} onClick={retry}>Retry</button>
            </div>
          ) : (
            <div className="chart-empty" style={{ marginTop: 10 }}>Not enough history yet to chart.</div>
          )}

          {periodReturn != null && (
            <div className="rc-row">
              <span>Period return{s?.estimate ? ' (est.)' : ''}{rangeFrom && rangeTo ? ` · ${rangeFrom} → ${rangeTo}` : ''}</span>
              <span className={`num ${periodReturn >= 0 ? 'pos' : 'neg'}`}>{asPctSigned(periodReturn)}</span>
            </div>
          )}

          {s && (s.annualizedReturn != null || s.volatility != null) ? (
            <div className="metric-grid" style={{ marginTop: 12 }}>
              <div className="metric"><div className="k">Return (ann.)</div><div className="v num">{asPctSigned(s.annualizedReturn)}</div></div>
              <div className="metric"><div className="k">Volatility</div><div className="v num">{asPct(s.volatility)}</div></div>
              <div className="metric"><div className="k">Max drawdown</div><div className="v num">{asPct(s.maxDrawdown)}</div></div>
            </div>
          ) : !detail.error && periodReturn == null ? (
            <p className="note" style={{ marginTop: 10 }}>Not enough price history yet to compute return/volatility.</p>
          ) : null}
          {smallSample && s?.months > 0 && <div className="data-warn" style={{ marginTop: 8 }}>Only {s.months} monthly observations — treat as indicative, not precise.</div>}
          <p className="note" style={{ marginTop: 10 }}>
            {inModel && mode === 'since-added' && detail.addedAt
              ? `Since first added to this model (${detail.addedAt}). `
              : inModel && mode === 'full'
                ? 'Full available price history for this security — not the model’s return. '
                : 'This instrument’s own price history — not the model’s. '}
            {instrument.source === 'auto'
              ? (detail.stale
                ? 'Cached market data — live providers did not answer this time.'
                : 'Live pricing via the provider chain (TSX history can be thin).')
              : 'From entered NAV points.'}
          </p>
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

export default function ClassifyPanel({ instrument, modelKey, onClose, onSaved }) {
  const [sector, setSector] = useState(instrument.sector || '');
  const [country, setCountry] = useState(instrument.country || '');
  const [mer, setMer] = useState(instrument.mer != null ? String(instrument.mer) : '');
  const [sectorRows, setSectorRows] = useState(() => rowify(instrument.sectorBreakdown));
  const [countryRows, setCountryRows] = useState(() => rowify(instrument.countryBreakdown));
  const [asOf, setAsOf] = useState(String(instrument.breakdownAsOf || '').slice(0, 10));
  const [note, setNote] = useState(instrument.breakdownNote || '');
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState(null);
  const [sourceInfo, setSourceInfo] = useState(null);
  const [fetching, setFetching] = useState(false);
  const [fetchMsg, setFetchMsg] = useState(null);

  useEffect(() => {
    let cancelled = false;
    api.factsheetSource(instrument.id)
      .then((s) => { if (!cancelled) setSourceInfo(s); })
      .catch(() => { if (!cancelled) setSourceInfo({ mapped: false }); });
    return () => { cancelled = true; };
  }, [instrument.id]);

  const mapped = !!sourceInfo?.mapped;
  const fundLike = instrument.type === 'etf' || instrument.type === 'mutualfund';

  const validRows = (rows) => rows
    .map((r) => ({ label: r.label.trim(), weight: Number(r.weight) }))
    .filter((r) => r.label && Number.isFinite(r.weight) && r.weight > 0);

  const hasBreakdown = validRows(sectorRows).length > 0 || validRows(countryRows).length > 0;
  const asOfOk = /^\d{4}-\d{2}-\d{2}$/.test(asOf);
  const canSave = !saving && (!hasBreakdown || asOfOk);

  const savedOn = instrument.breakdownUpdatedAt
    ? new Date(instrument.breakdownUpdatedAt).toISOString().slice(0, 10)
    : null;

  async function fetchFactsheet() {
    setFetching(true); setFetchMsg(null); setErr(null);
    try {
      const out = await api.fetchBreakdown(instrument.id);
      const p = out.proposed || {};
      setSectorRows(rowify(p.sectorBreakdown));
      setCountryRows(rowify(p.countryBreakdown));
      if (p.breakdownAsOf) setAsOf(p.breakdownAsOf);
      if (p.breakdownNote) setNote(p.breakdownNote);
      const bits = ['Filled from the issuer factsheet — review, then Save.'];
      if (out.asOfEstimated || out.estimates) bits.push('Treat weights / as-of as estimates.');
      setFetchMsg(bits.join(' '));
    } catch (e) {
      setFetchMsg(null);
      setErr(e.message || 'Factsheet fetch failed. Enter the breakdown manually below.');
    } finally {
      setFetching(false);
    }
  }

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
      setErr(`Couldn’t save — ${e.message}`); setSaving(false);
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
        <SecurityInfo instrument={instrument} modelKey={modelKey} />

        <div className="ed-section">MER</div>
        <label className="field"><span>Management expense ratio (optional, %)</span>
          <input type="number" inputMode="decimal" step="0.01" min="0" value={mer}
            onChange={(e) => setMer(e.target.value)} placeholder="e.g. 0.09" />
        </label>

        <p className="ed-hint">
          A breakdown can be fetched from a mapped issuer factsheet or entered manually — it isn't a live feed.
          {asOfOk ? ` Factsheet as-of ${asOf}.` : ''}
          {savedOn ? ` Last saved in FolioTrack ${savedOn}.` : ''}
        </p>

        {fundLike && (
          <div className="fetch-box">
            <button type="button" className="fetch-factsheet" disabled={!mapped || fetching} onClick={fetchFactsheet}>
              {fetching ? 'Fetching…' : 'Fetch from factsheet'}
            </button>
            {!mapped && sourceInfo && (
              <p className="note" style={{ paddingTop: 8 }}>
                No issuer factsheet mapped for {instrument.symbol}. Enter the breakdown manually below.
              </p>
            )}
            {mapped && sourceInfo?.source && (
              <p className="note" style={{ paddingTop: 8 }}>
                Mapped: {sourceInfo.source.issuer}. Fills the form only — Save still required.
              </p>
            )}
            {fetchMsg && <div className="data-warn" style={{ marginTop: 8 }}>{fetchMsg}</div>}
          </div>
        )}

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

        {err && <div className="banner" style={{ margin: '16px 0 0' }}>{err}</div>}
      </div>
    </div>
  );
}
