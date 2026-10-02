import { useEffect, useMemo, useState } from 'react';
import { api, num } from '../api.js';
import { todayToronto, isNavStale, cadenceLabel, navFreshnessRank, YAHOO_PRICE_SOURCE, TMX_PRICE_SOURCE, priceSourceLabel } from '../nav.js';
import { YAHOO_PASTE_PLACEHOLDER, formatFetchYahooError, navFieldError, parseNavInput } from '../navField.js';
import { fetchTmxInBrowser, tmxSupports } from '../tmxBrowser.js';

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
        setRows(sorted.map((i) => ({
          ...i,
          newNav: '',
          dateOverride: '',
          paste: '',
          lastPricePaste: '',
          yahooBusy: false,
          phoneBusy: false,
          yahooFailed: false,
          yahooMsg: '',
          yahooSeries: null,
          pendingSource: null,
        })));
      })
      .catch((e) => { if (!cancelled) setErr(e.message); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  const filled = useMemo(
    () => rows.filter((r) => parseNavInput(r.newNav).value != null),
    [rows]
  );
  const navInvalid = useMemo(() => rows.some((r) => navFieldError(r.newNav)), [rows]);
  const canSave = filled.length > 0 && !navInvalid && !saving && /^\d{4}-\d{2}-\d{2}$/.test(asOf);

  function patch(id, fields) {
    setRows((rs) => rs.map((r) => (r.id === id ? { ...r, ...fields } : r)));
  }

  async function fetchYahoo(id, confirm = false, series = null, navSource = null) {
    patch(id, { yahooBusy: true, yahooMsg: '', yahooFailed: false });
    try {
      const proposed = series
        ? {
          series,
          needsConfirm: false,
          source: navSource || YAHOO_PRICE_SOURCE,
          count: series.length,
          from: series[0]?.date,
          to: series.at(-1)?.date,
          lastClose: series.at(-1)?.close,
        }
        : await api.fetchYahooHistory(id);
      const label = proposed.source || YAHOO_PRICE_SOURCE;
      if (proposed.needsConfirm && !confirm) {
        patch(id, {
          yahooBusy: false,
          yahooFailed: false,
          yahooSeries: proposed.series,
          pendingSource: label,
          yahooMsg: `${label} · ${proposed.count || proposed.series.length} closes ${proposed.from || proposed.series[0]?.date} → ${proposed.to || proposed.series.at(-1)?.date}. This will overwrite dates on a long manual series — tap Confirm merge to apply.`,
        });
        return;
      }
      const out = await api.applyYahooHistory(id, { series: proposed.series, confirm, navSource: label });
      patch(id, {
        yahooBusy: false,
        yahooFailed: false,
        yahooSeries: null,
        pendingSource: null,
        yahooMsg: `Applied ${out.count} ${out.source || label} closes (${out.from} → ${out.to}).`,
        latestNav: out.quote?.price ?? proposed.lastClose,
        latestDate: out.to,
        navSource: out.source || label,
        source: 'manual',
      });
    } catch (e) {
      const confirm = /confirm to merge|overwrite/i.test(e.message || '');
      patch(id, {
        yahooBusy: false,
        yahooFailed: !confirm,
        yahooMsg: confirm
          ? e.message
          : formatFetchYahooError(e.message, { code: e.code, retryAfterMs: e.retryAfterMs }),
      });
    }
  }

  async function fillFromPhone(row) {
    patch(row.id, { phoneBusy: true, yahooMsg: '' });
    try {
      const out = await fetchTmxInBrowser(row.yahooSymbol || row.symbol);
      if (out.series?.length) {
        patch(row.id, {
          phoneBusy: false,
          yahooFailed: false,
          yahooSeries: out.series,
          pendingSource: TMX_PRICE_SOURCE,
          yahooMsg: `TMX Money from this phone · ${out.series.length} closes ${out.from} → ${out.to} (last ${out.lastClose}). Tap Apply phone series to write nav_series. Nothing is saved until you do.`,
        });
        return;
      }
      patch(row.id, {
        phoneBusy: false,
        yahooFailed: true,
        newNav: out.quote?.price != null ? String(out.quote.price) : '',
        dateOverride: todayToronto(),
        yahooMsg: `TMX last price ${out.lastClose}${out.quote?.currency ? ` ${out.quote.currency}` : ''} is in New NAV for today. Tap Save to store that one point.`,
      });
    } catch (e) {
      patch(row.id, {
        phoneBusy: false,
        yahooFailed: true,
        yahooMsg: `This phone could not read TMX (${e.message || 'request failed'}). Yahoo chart calls are blocked by the browser. Paste a last price or a Yahoo CSV.`,
      });
    }
  }

  async function saveLastPrice(row) {
    const parsed = parseNavInput(row.lastPricePaste);
    if (parsed.error || parsed.value == null) {
      patch(row.id, { yahooMsg: parsed.error || 'Enter a last price greater than 0.' });
      return;
    }
    const date = todayToronto();
    patch(row.id, { phoneBusy: true, yahooMsg: '' });
    try {
      await api.addNavBatch({
        asOf: date,
        points: [{ instrumentId: row.id, nav: parsed.value, date }],
      });
      patch(row.id, {
        phoneBusy: false,
        yahooFailed: false,
        lastPricePaste: '',
        newNav: '',
        latestNav: parsed.value,
        latestDate: date,
        navSource: 'manual',
        source: 'manual',
        yahooMsg: `Saved ${parsed.value} as the NAV for ${date}.`,
      });
    } catch (e) {
      patch(row.id, { phoneBusy: false, yahooFailed: true, yahooMsg: e.message || 'Couldn’t save that price.' });
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
          nav: parseNavInput(r.newNav).value,
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
          Stocks and unmapped TSX ETFs can Fetch here too — TMX Money is tried first for .TO and .V, then Yahoo. Apply writes nav_series (merge by date). A failed fetch is not a wall: on a phone, Fill from my phone reads TMX in the browser, or paste a Yahoo CSV.
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
            const navErr = navFieldError(r.newNav);
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
                    <input type="text" inputMode="decimal" autoComplete="off" placeholder="skip"
                      aria-invalid={navErr ? 'true' : 'false'}
                      value={r.newNav} onChange={(e) => patch(r.id, { newNav: e.target.value })} />
                  </label>
                  <label className="field">
                    <span>Date override</span>
                    <input type="date" value={r.dateOverride}
                      onChange={(e) => patch(r.id, { dateOverride: e.target.value })} />
                  </label>
                </div>
                {navErr && <p className="field-error" role="alert">{navErr}</p>}
                {r.yahooEligible && (
                  <div className="yahoo-price-actions">
                    <button type="button" className="classify-select-back" disabled={r.yahooBusy || r.phoneBusy}
                      onClick={() => {
                        const confirming = /confirm( to)? merge|overwrite dates/i.test(r.yahooMsg || '');
                        return fetchYahoo(r.id, confirming, confirming ? r.yahooSeries : null, r.pendingSource);
                      }}>
                      {r.yahooBusy ? 'Fetching…' : (/confirm( to)? merge|overwrite dates/i.test(r.yahooMsg || '') ? 'Confirm merge' : 'Fetch')}
                    </button>
                    {r.yahooSeries && r.pendingSource === TMX_PRICE_SOURCE && !/confirm( to)? merge|overwrite dates/i.test(r.yahooMsg || '') && (
                      <button type="button" className="classify-select-back" disabled={r.yahooBusy || r.phoneBusy}
                        onClick={() => fetchYahoo(r.id, false, r.yahooSeries, TMX_PRICE_SOURCE)}>
                        Apply phone series
                      </button>
                    )}
                    {r.yahooFailed && (
                      <div className="phone-fill">
                        {tmxSupports(r.yahooSymbol || r.symbol) ? (
                          <button type="button" className="classify-select-back" disabled={r.phoneBusy || r.yahooBusy}
                            onClick={() => fillFromPhone(r)}>
                            {r.phoneBusy ? 'Reading TMX…' : 'Fill from my phone'}
                          </button>
                        ) : (
                          <div className="paste-last">
                            <label className="field">
                              <span>Paste last price</span>
                              <input type="text" inputMode="decimal" autoComplete="off" placeholder="76.95"
                                value={r.lastPricePaste || ''}
                                onChange={(e) => patch(r.id, { lastPricePaste: e.target.value })} />
                            </label>
                            <button type="button" className="classify-select-back" disabled={r.phoneBusy}
                              onClick={() => saveLastPrice(r)}>
                              Save
                            </button>
                          </div>
                        )}
                        <p>
                          Or download the CSV from{' '}
                          <a className="ext" href={r.historyUrl} target="_blank" rel="noreferrer">Yahoo history for {r.yahooSymbol || r.symbol}</a>.
                          Open Historical Data, choose Download, then paste Date and Close below. Adj Close is used when the file has it.
                        </p>
                      </div>
                    )}
                    <label className="field" style={{ marginTop: 8 }}>
                      <span>Or paste Yahoo Date, Close</span>
                      <textarea className="yahoo-paste" rows={3} value={r.paste}
                        onChange={(e) => patch(r.id, { paste: e.target.value })}
                        placeholder={YAHOO_PASTE_PLACEHOLDER} />
                    </label>
                    {r.paste?.trim() && (
                      <button type="button" className="classify-select-back" disabled={r.yahooBusy}
                        onClick={() => applyPaste(r.id, r.paste, /overwrite|Confirm to merge/i.test(r.yahooMsg || ''))}>
                        Apply paste
                      </button>
                    )}
                    {r.yahooMsg && (
                      <p className={/\b429\b|rate-?limit|could not read|No price source/i.test(r.yahooMsg) ? 'field-error' : 'note'}
                        style={{ paddingTop: 6 }}
                        role={/\b429\b|rate-?limit|could not read/i.test(r.yahooMsg) ? 'alert' : undefined}>
                        {r.yahooMsg}
                      </p>
                    )}
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
