import { useEffect, useMemo, useState } from 'react';
import { api, num } from '../api.js';
import { todayToronto, isNavStale, cadenceLabel, navFreshnessRank } from '../nav.js';

export default function PricesPanel({ onClose, onSaved }) {
  const [asOf, setAsOf] = useState(todayToronto);
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true); setErr(null);
    api.manualInstruments()
      .then((list) => {
        if (cancelled) return;
        const sorted = [...list].sort((a, b) => {
          const r = navFreshnessRank(a.type, a.latestDate) - navFreshnessRank(b.type, b.latestDate);
          return r || a.symbol.localeCompare(b.symbol);
        });
        setRows(sorted.map((i) => ({ ...i, newNav: '', dateOverride: '' })));
      })
      .catch((e) => { if (!cancelled) setErr(e.message); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  const filled = useMemo(
    () => rows.filter((r) => String(r.newNav).trim() !== '' && Number.isFinite(Number(r.newNav))),
    [rows]
  );
  const canSave = filled.length > 0 && !saving && /^\d{4}-\d{2}-\d{2}$/.test(asOf);

  function patch(id, fields) {
    setRows((rs) => rs.map((r) => (r.id === id ? { ...r, ...fields } : r)));
  }

  async function save() {
    if (!canSave) return;
    setSaving(true); setErr(null);
    try {
      await api.addNavBatch({
        asOf,
        points: filled.map((r) => ({
          instrumentId: r.id,
          nav: Number(r.newNav),
          ...(r.dateOverride.trim() ? { date: r.dateOverride.trim() } : {}),
        })),
      });
      onSaved();
    } catch (e) {
      setErr(e.message); setSaving(false);
    }
  }

  return (
    <div className="editor">
      <header className="editor-bar">
        <button type="button" className="ed-cancel" onClick={onClose}>Cancel</button>
        <span className="ed-title">Prices</span>
        <button type="button" className="ed-save" disabled={!canSave} onClick={save}>
          {saving ? 'Saving…' : 'Save'}
        </button>
      </header>

      <div className="editor-body">
        <p className="ed-hint">
          One NAV update applies to every model that holds the name — instruments are shared, this is not an allocation change.
          Empty new-NAV rows are skipped; you don’t have to fill every name.
          Stale means the last NAV is older than the calendar-day cadence for that type (stocks/ETFs 7, mutual funds 40, alts 100) — not trading days.
          Cash stays at $1 and isn’t listed.
        </p>

        <label className="field">
          <span>As of (America/Toronto)</span>
          <input type="date" value={asOf} onChange={(e) => setAsOf(e.target.value)} />
        </label>
        <p className="note" style={{ paddingTop: 0 }}>
          Shared date for every filled row. Optional per-row date overrides it.
        </p>

        {loading && <div className="loading">Loading…</div>}

        {!loading && rows.length === 0 && (
          <p className="ed-hint">No manual holdings in any current model. Auto names are priced by the provider chain.</p>
        )}

        <div className="nav-list">
          {rows.map((r) => {
            const stale = isNavStale(r.type, r.latestDate);
            const used = r.models.map((m) => m.name).join(', ');
            return (
              <div className="nav-card" key={r.id}>
                <div className="nav-card-top">
                  <div>
                    <div className="row-sym">{r.symbol}</div>
                    <div className="row-sub">{r.name}</div>
                  </div>
                  {stale && <span className="pill amber">Stale</span>}
                </div>
                <div className="nav-meta">
                  Last NAV {r.latestNav != null ? `${num(r.latestNav)} ${r.currency}` : '—'}
                  {' · '}
                  {r.latestDate || '—'}
                  {' · '}
                  {cadenceLabel(r.type)}
                </div>
                <div className="nav-models">{used ? `Used in ${used}` : 'Not in a current model'}</div>
                <div className="nav-inputs">
                  <label className="field">
                    <span>New NAV</span>
                    <input type="number" inputMode="decimal" step="any" placeholder="skip"
                      value={r.newNav} onChange={(e) => patch(r.id, { newNav: e.target.value })} />
                  </label>
                  <label className="field">
                    <span>Date override</span>
                    <input type="date" value={r.dateOverride}
                      onChange={(e) => patch(r.id, { dateOverride: e.target.value })} />
                  </label>
                </div>
              </div>
            );
          })}
        </div>

        {err && <div className="banner" style={{ margin: '16px 0 0' }}>Couldn’t save — {err}</div>}
      </div>
    </div>
  );
}
