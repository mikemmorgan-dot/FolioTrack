import { useEffect, useMemo, useState } from 'react';
import { api, num } from '../api.js';
import { todayToronto, isNavStale, cadenceLabel, navFreshnessRank, YAHOO_PRICE_SOURCE, priceSourceLabel } from '../nav.js';

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
          const group = (x) => (x.source === 'manual' || x.latestDate ? 0 : 1);
          const g = group(a) - group(b);
          if (g) return g;
          const r = navFreshnessRank(a.type, a.latestDate) - navFreshnessRank(b.type, b.latestDate);
          return r || a.symbol.localeCompare(b.symbol);
        });
        setRows(sorted.map((i) => ({ ...i, newNav: '', dateOverride: '', paste: '', yahooBusy: false, yahooMsg: '', yahooSeries: null })));
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

  async function fetchYahoo(id, confirm = false, series = null) {
    patch(id, { yahooBusy: true, yahooMsg: '' });
    try {
      const proposed = series ? { series, needsConfirm: !confirm } : await api.fetchYahooHistory(id);
      if (proposed.needsConfirm && !confirm) {
        patch(id, {
          yahooBusy: false,
          yahooSeries: proposed.series,
          yahooMsg: `Yahoo Finance · ${proposed.count} closes ${proposed.from} → ${proposed.to}. This will overwrite dates on a long manual series — tap Fetch Yahoo again to confirm the merge.`,
        });
        return;
      }
      const out = await api.applyYahooHistory(id, { series: proposed.series, confirm });
      patch(id, {
        yahooBusy: false,
        yahooSeries: null,
        yahooMsg: `Applied ${out.count} Yahoo Finance closes (${out.from} → ${out.to}).`,
        latestNav: out.quote?.price ?? proposed.lastClose,
        latestDate: out.to,
        navSource: YAHOO_PRICE_SOURCE,
        source: 'manual',
      });
    } catch (e) {
      patch(id, { yahooBusy: false, yahooMsg: e.message || 'Yahoo failed — paste Date / Close below or type a NAV.' });
    }
  }

  async function applyPaste(id, paste, confirm = false) {
    patch(id, { yahooBusy: true, yahooMsg: '' });
    try {
      const out = await api.applyYahooHistory(id, { pasted: paste, confirm });
      patch(id, {
        yahooBusy: false,
        yahooMsg: `Applied ${out.count} pasted closes (${out.from} → ${out.to}).`,
        latestDate: out.to,
        navSource: YAHOO_PRICE_SOURCE,
        source: 'manual',
        paste: '',
      });
    } catch (e) {
      patch(id, { yahooBusy: false, yahooMsg: e.message || 'Couldn’t apply that paste.' });
    }
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
          Entering a NAV prices that name from your numbers (and flips it to manual) so quotes don’t wait on the live feed.
          Stocks and unmapped TSX ETFs can Fetch from Yahoo here too — apply writes nav_series (merge by date). A 429 is not a wall: paste Date / Close from ca.finance.yahoo.com or type them.
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
          <p className="ed-hint">No holdings in any current model to price.</p>
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
                  <div className="nav-pills">
                    <span className={`pill ${r.source === 'manual' || r.latestDate || r.navSource === YAHOO_PRICE_SOURCE ? 'neutral' : 'green'}`}>
                      {r.navSource === YAHOO_PRICE_SOURCE ? 'Yahoo' : priceSourceLabel(r)}
                    </span>
                    {stale && <span className="pill amber">Stale</span>}
                  </div>
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
                {r.yahooEligible && (
                  <div className="yahoo-price-actions">
                    <button type="button" className="classify-select-back" disabled={r.yahooBusy}
                      onClick={() => fetchYahoo(r.id, /confirm the merge/i.test(r.yahooMsg || ''), r.yahooSeries)}>
                      {r.yahooBusy ? 'Yahoo…' : (/confirm the merge/i.test(r.yahooMsg || '') ? 'Confirm Yahoo merge' : 'Fetch Yahoo')}
                    </button>
                    <label className="field" style={{ marginTop: 8 }}>
                      <span>Or paste Yahoo Date, Close</span>
                      <textarea className="yahoo-paste" rows={3} value={r.paste}
                        onChange={(e) => patch(r.id, { paste: e.target.value })}
                        placeholder={'Date,Close\n2024-01-02,128.00'} />
                    </label>
                    {r.paste?.trim() && (
                      <button type="button" className="classify-select-back" disabled={r.yahooBusy}
                        onClick={() => applyPaste(r.id, r.paste, /overwrite|Confirm to merge/i.test(r.yahooMsg || ''))}>
                        Apply paste
                      </button>
                    )}
                    {r.yahooMsg && <p className="note" style={{ paddingTop: 6 }}>{r.yahooMsg}</p>}
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {err && <div className="banner" style={{ margin: '16px 0 0' }}>Couldn’t save — {err}</div>}
      </div>
    </div>
  );
}
