import { useEffect, useState, useRef } from 'react';
import { api } from '../../api.js';
import { METRIC_DEFS, asRatio, asPct } from '../../riskFormat.js';
import OptimizePanel from '../OptimizePanel.jsx';

const RATIO3 = ['sharpe', 'sortino', 'informationRatio'];
const GRID2 = ['volatility', 'maxDrawdown', 'beta', 'alpha', 'trackingError', 'upCapture', 'downCapture', 'correlation'];

export default function RiskTab({ model, onOptimizeApply }) {
  const [rf, setRf] = useState(4);
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const [loading, setLoading] = useState(true);
  const t = useRef(null);

  useEffect(() => {
    if (!model.versions.length) { setLoading(false); return; }
    clearTimeout(t.current);
    t.current = setTimeout(() => {
      setLoading(true); setErr(null);
      api.risk(model.key, rf).then(setData).catch((e) => setErr(e.message)).finally(() => setLoading(false));
    }, 350);
    return () => clearTimeout(t.current);
  }, [model.key, rf]);

  if (!model.versions.length) return <div className="empty-state"><p className="muted">No versions yet — add holdings to compute risk.</p></div>;

  const m = data?.metrics;
  const benchMissing = data && !data.dataNotes?.benchmarkComplete;
  const smallSample = m && m.n < 24;

  return (
    <>
      <div className="rf-bar">
        <span>Risk-free rate</span>
        <div className="rf-input">
          <input type="number" inputMode="decimal" step="0.25" value={rf}
            onChange={(e) => setRf(e.target.value === '' ? 0 : Number(e.target.value))} />
          <span>%</span>
        </div>
        <span className="muted rf-hint">Sharpe &amp; Sortino scale with this</span>
      </div>

      {loading && <div className="loading">Computing risk…</div>}
      {err && <div className="banner">Couldn’t compute risk — {err}</div>}

      {m && !loading && (
        <>
          <div className="risk-trio">
            {RATIO3.map((k) => (
              <div className="risk-big" key={k}>
                <div className="k">{METRIC_DEFS[k].label}</div>
                <div className={`v num ${m[k] == null ? 'muted' : m[k] >= 0 ? 'pos' : 'neg'}`}>{asRatio(m[k])}</div>
              </div>
            ))}
          </div>

          <div className="metric-grid" style={{ marginTop: 12 }}>
            {GRID2.map((k) => (
              <div className="metric" key={k}>
                <div className="k">{METRIC_DEFS[k].label}</div>
                <div className="v num">{METRIC_DEFS[k].fmt(m[k])}</div>
              </div>
            ))}
          </div>

          <div className="risk-context card pad">
            <div className="rc-row"><span>Annualized return</span><span className="num">{METRIC_DEFS.annualizedReturn.fmt(m.annualizedReturn)}</span></div>
            <div className="rc-row"><span>Benchmark return (ann.)</span><span className="num muted">{m.benchAnnualizedReturn == null ? '—' : METRIC_DEFS.annualizedReturn.fmt(m.benchAnnualizedReturn)}</span></div>
            <div className="rc-row"><span>Observations</span><span className="num">{m.n} months</span></div>
          </div>

          {(benchMissing || smallSample) && (
            <div className="data-warn">
              {smallSample && <div>Only {m.n} monthly observations — treat beta, alpha and ratios as indicative, not precise.</div>}
              {benchMissing && <div>Benchmark data incomplete — beta, tracking error, info ratio and capture may be unavailable.</div>}
            </div>
          )}

          <p className="note">Sharpe = (annualized return − risk-free) ÷ annualized volatility. Sortino uses downside deviation vs the risk-free rate. Info ratio = active return ÷ tracking error. Computed on monthly returns of the model as actually run.</p>

          <div className="section-title" style={{ marginTop: 20 }}>Optimize</div>
          <OptimizePanel modelKey={model.key} rf={(Number(rf) || 0) / 100} onApply={onOptimizeApply} />
        </>
      )}
    </>
  );
}
