import { useState } from 'react';
import { api } from '../api.js';
import { METRIC_DEFS, deltaClass } from '../riskFormat.js';

const SHOW = ['sharpe', 'sortino', 'volatility', 'maxDrawdown', 'beta', 'informationRatio'];

export default function RiskPreview({ modelKey, rows }) {
  const [rf, setRf] = useState(4);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState(null);

  async function run() {
    setLoading(true); setErr(null); setData(null);
    try {
      const holdings = rows.map((r) => ({
        instrumentId: r.instrumentId || undefined,
        symbol: r.symbol, source: r.source,
        weight: (Number(r.weightPct) || 0) / 100,
      }));
      setData(await api.simulate(modelKey, { rf, holdings }));
    } catch (e) { setErr(e.message); }
    finally { setLoading(false); }
  }

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

      <button className="rp-run" onClick={run} disabled={loading}>{loading ? 'Simulating…' : 'Preview risk impact'}</button>
      {err && <div className="banner" style={{ margin: '10px 0 0' }}>{err}</div>}

      {data && (
        <>
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
          <p className="note" style={{ padding: '10px 2px 0' }}>Compares your proposed weights vs the current version’s weights, both held over history. Green = improvement.</p>
        </>
      )}
    </div>
  );
}
