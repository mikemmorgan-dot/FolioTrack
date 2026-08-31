import { useState } from 'react';
import { api } from '../api.js';
import { asRatio, asPct } from '../riskFormat.js';

export default function OptimizePanel({ modelKey, rf, onApply }) {
  const [maxWeight, setMaxWeight] = useState('');
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState(null);

  async function run() {
    setLoading(true); setErr(null); setData(null);
    try {
      const mw = maxWeight === '' ? null : Number(maxWeight);
      setData(await api.optimize(modelKey, { rf, maxWeight: mw }));
    } catch (e) { setErr(e.message); }
    finally { setLoading(false); }
  }

  return (
    <div className="risk-preview">
      <div className="rp-head">
        <span className="rp-title">Ex-ante optimizer</span>
        <div className="rf-input sm">
          <input type="number" step="1" inputMode="decimal" min="0" max="100" placeholder="cap %"
            value={maxWeight} onChange={(e) => setMaxWeight(e.target.value)} style={{ width: 56 }} />
          <span>max/holding</span>
        </div>
      </div>

      <p className="note" style={{ padding: '0 2px 10px' }}>
        Suggests weights that maximize Sharpe using each holding's own historical mean return and covariance —
        a historical estimate, not a forecast of future performance. Long-only, fully invested{maxWeight ? `, capped at ${maxWeight}% per holding` : ''}.
      </p>

      <button className="rp-run" onClick={run} disabled={loading}>{loading ? 'Optimizing…' : 'Run optimizer'}</button>
      {err && <div className="banner" style={{ margin: '10px 0 0' }}>{err}</div>}

      {data && (
        <>
          <div className="rp-table" style={{ marginTop: 12 }}>
            <div className="rp-r rp-h"><span>Metric (ex-ante)</span><span className="r">Current</span><span className="r">Suggested</span><span className="r">Δ</span></div>
            {[
              { k: 'sharpe', label: 'Sharpe', fmt: asRatio, good: 1 },
              { k: 'expectedReturn', label: 'Expected return', fmt: asPct, good: 1 },
              { k: 'volatility', label: 'Volatility', fmt: asPct, good: -1 },
            ].map(({ k, label, fmt, good }) => {
              const a = data.current[k], b = data.suggested[k];
              const d = a != null && b != null ? b - a : null;
              const deltaStr = d == null ? '—' : `${d >= 0 ? '+' : '−'}${fmt(Math.abs(d))}`;
              const cls = d == null || Math.abs(d) < 1e-9 ? 'muted' : (good > 0) === (d > 0) ? 'pos' : 'neg';
              return (
                <div className="rp-r" key={k}>
                  <span>{label}</span>
                  <span className="r num muted">{fmt(a)}</span>
                  <span className="r num">{fmt(b)}</span>
                  <span className={`r num ${cls}`}>{deltaStr}</span>
                </div>
              );
            })}
          </div>

          <div className="rp-table" style={{ marginTop: 12 }}>
            <div className="rp-r rp-h"><span>Holding</span><span className="r">Current</span><span className="r">Suggested</span><span className="r">Δ</span></div>
            {data.holdings.map((h) => {
              const d = h.suggestedWeight - h.currentWeight;
              return (
                <div className="rp-r" key={h.instrumentId}>
                  <span>{h.symbol}</span>
                  <span className="r num muted">{asPct(h.currentWeight)}</span>
                  <span className="r num">{asPct(h.suggestedWeight)}</span>
                  <span className="r num muted">
                    {Math.abs(d) < 1e-9 ? '—' : `${d >= 0 ? '+' : '−'}${asPct(Math.abs(d))}`}
                  </span>
                </div>
              );
            })}
          </div>

          {data.excludedHoldings?.length > 0 && (
            <div className="data-warn" style={{ marginTop: 10 }}>
              Excluded from the optimizer — not enough history: {data.excludedHoldings.map((e) => `${e.symbol || e.id} (${e.reason})`).join(', ')}.
              {data.excludedWeight > 0 && ` These make up ${asPct(data.excludedWeight)} of the current portfolio; the comparison above is renormalized to the rest.`}
            </div>
          )}

          <button type="button" className="add-holding" style={{ marginTop: 12 }}
            onClick={() => onApply(Object.fromEntries(data.holdings.map((h) => [h.instrumentId, +(h.suggestedWeight * 100).toFixed(2)])))}>
            Edit with suggested weights
          </button>
          <p className="note" style={{ padding: '10px 2px 0' }}>
            Opens the editor with these weights pre-filled — nothing is saved until you review and hit Save there.
          </p>
        </>
      )}
    </div>
  );
}
