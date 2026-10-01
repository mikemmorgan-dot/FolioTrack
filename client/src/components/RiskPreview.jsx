import { useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import { METRIC_DEFS, deltaClass } from '../riskFormat.js';

const SHOW = ['sharpe', 'sortino', 'volatility', 'maxDrawdown', 'beta', 'informationRatio'];
const TIMEOUT_MS = 45000;

function rowsToHoldings(rows) {
  return (rows || []).map((r) => ({
    instrumentId: r.instrumentId || undefined,
    symbol: r.symbol,
    source: r.source,
    weight: (Number(r.weightPct) || 0) / 100,
  }));
}

function thinHistory(data) {
  if (!data) return false;
  const n1 = data.baseline?.metrics?.n || 0;
  const n2 = data.proposed?.metrics?.n || 0;
  return n1 < 2 && n2 < 2;
}

function newHoldingNote(h) {
  if (!h || h.covered) return null;
  const sym = h.symbol || 'This holding';
  if (h.reason === 'insufficient') {
    return `${sym} has only a single NAV, so history is insufficient and the preview ignores it.`;
  }
  return `${sym} has no price history yet, so the preview ignores it`;
}

export default function RiskPreview({ modelKey, rows, pending }) {
  const [rf, setRf] = useState(4);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState(null);
  const abortRef = useRef(null);
  const reqRef = useRef(0);

  const blocked = !!pending && pending.valid === false;
  const blockMessage = blocked ? (pending.message || 'Enter an allocation above 0% to preview or add this holding.') : null;
  const activeHoldings = pending?.valid ? pending.holdings : null;
  const payloadKey = JSON.stringify({
    rf,
    blocked,
    holdings: activeHoldings,
  });

  async function run(list) {
    if (pending && pending.valid === false) return;
    const holdings = list || activeHoldings || rowsToHoldings(rows);
    const id = ++reqRef.current;
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; ctrl.abort(); }, TIMEOUT_MS);
    setLoading(true);
    setErr(null);
    try {
      const result = await api.simulate(modelKey, { rf, holdings }, { signal: ctrl.signal });
      if (id !== reqRef.current) return;
      setData(result);
    } catch (e) {
      if (id !== reqRef.current) return;
      if (e?.name === 'AbortError') {
        if (timedOut) {
          setErr('Preview timed out before history finished loading. Retry.');
          setData(null);
        }
      } else {
        setErr(e.message || 'Preview failed.');
        setData(null);
      }
    } finally {
      clearTimeout(timer);
      if (id === reqRef.current) setLoading(false);
    }
  }

  // Auto-refresh only while a funded allocation is on the form. Symbol and
  // funding changes are in the payload, so typing settles before a fetch.
  useEffect(() => {
    if (!pending?.valid) return undefined;
    const list = pending.holdings;
    const t = setTimeout(() => { run(list); }, 500);
    return () => clearTimeout(t);
    // payloadKey already covers rf, holdings, and validity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [payloadKey]);

  useEffect(() => {
    if (!blocked) return undefined;
    reqRef.current += 1;
    abortRef.current?.abort();
    setLoading(false);
    setErr(null);
    setData(null);
    return undefined;
  }, [blocked]);

  // Closing the add form drops the hypothetical preview so the card doesn't
  // keep showing a book that was never added.
  const sawPending = useRef(false);
  useEffect(() => {
    if (pending) sawPending.current = true;
    else if (sawPending.current) {
      sawPending.current = false;
      reqRef.current += 1;
      abortRef.current?.abort();
      setLoading(false);
      setErr(null);
      setData(null);
    }
  }, [pending]);

  useEffect(() => () => {
    reqRef.current += 1;
    abortRef.current?.abort();
  }, []);

  const coverPct = data && Number.isFinite(data.coverage) ? Math.round(data.coverage * 100) : null;
  const ignore = newHoldingNote(data?.newHolding);
  const empty = thinHistory(data);

  return (
    <div className="risk-preview">
      <div className="rp-head">
        <span className="rp-title">Projected risk impact</span>
        <div className="rf-input sm">
          <input type="number" step="0.25" inputMode="decimal" value={rf}
            onChange={(e) => setRf(e.target.value === '' ? 0 : Number(e.target.value))} />
          <span>% rf</span>
        </div>
      </div>

      <button type="button" className="rp-run" onClick={() => run()} disabled={loading || blocked}>
        {loading ? 'Simulating…' : 'Preview risk impact'}
      </button>
      {blocked && <p className="fund-help">{blockMessage}</p>}
      {loading && <p className="fund-help">Fetching price history…</p>}
      {err && (
        <>
          <div className="banner" style={{ margin: '10px 0 0' }}>{err}</div>
          <button type="button" className="rp-retry" onClick={() => run()}>Retry</button>
        </>
      )}

      {data && empty && !err && (
        <>
          <div className="data-warn" style={{ marginTop: 10 }}>Not enough history to project risk for these weights.</div>
          <button type="button" className="rp-retry" onClick={() => run()}>Retry</button>
        </>
      )}

      {data && !empty && (
        <>
          {ignore && <div className="rp-ignore">{ignore}</div>}
          <div className="rp-table">
            <div className="rp-r rp-h"><span>Metric</span><span className="r">Now</span><span className="r">Proposed</span><span className="r">Δ</span></div>
            {SHOW.map((k) => {
              const def = METRIC_DEFS[k];
              const a = data.baseline.metrics[k], b = data.proposed.metrics[k], d = data.deltas[k];
              const deltaStr = d == null ? '—' : `${d >= 0 ? '+' : '−'}${def.fmt(Math.abs(d))}`;
              return (
                <div className="rp-r" key={k}>
                  <span>{def.label}</span>
                  <span className="r num muted">{def.fmt(a)}</span>
                  <span className="r num">{def.fmt(b)}</span>
                  <span className={`r num ${deltaClass(k, d)}`}>{deltaStr}</span>
                </div>
              );
            })}
          </div>
          {data.unresolved?.length > 0 && (
            <div className="data-warn" style={{ marginTop: 10 }}>No history yet for {data.unresolved.join(', ')} — excluded from the projection.</div>
          )}
          {coverPct != null && (
            <p className="rp-cover">Projection covers {coverPct}% of weight.</p>
          )}
          <p className="note" style={{ padding: '10px 2px 0' }}>Compares your proposed weights vs the current version’s weights, both held over history. Green = improvement.</p>
        </>
      )}

      {data && empty && (
        <>
          {ignore && <div className="rp-ignore">{ignore}</div>}
          {data.unresolved?.length > 0 && (
            <div className="data-warn" style={{ marginTop: 10 }}>No history yet for {data.unresolved.join(', ')} — excluded from the projection.</div>
          )}
          {coverPct != null && (
            <p className="rp-cover">Projection covers {coverPct}% of weight.</p>
          )}
        </>
      )}
    </div>
  );
}
