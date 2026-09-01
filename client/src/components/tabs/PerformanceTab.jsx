import { useEffect, useState } from 'react';
import { api, pct, signedPct, money, BASIS } from '../../api.js';
import LineChart from '../LineChart.jsx';
import AssetIcon from '../AssetIcon.jsx';

export default function PerformanceTab({ model }) {
  const [perf, setPerf] = useState(null);
  const [err, setErr] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true); setErr(null);
    api.performance(model.key).then(setPerf).catch((e) => setErr(e.message)).finally(() => setLoading(false));
  }, [model.key]);

  const hasVersions = model.versions.length > 0;
  if (!hasVersions) return <div className="empty-state"><p className="muted">No versions yet — add holdings to start tracking performance.</p></div>;
  if (loading) return <div className="loading">Computing returns…</div>;
  if (err) return <div className="banner">Couldn’t compute performance — {err}</div>;
  if (!perf) return null;

  const m = perf.model, b = perf.benchmark;
  const up = m.totalReturn >= 0;
  const notes = perf.dataNotes || {};
  const partial = (perf.coverageMin ?? 1) < 0.999;
  const chartable = m.cumulative.length >= 2;

  return (
    <>
      {/* headline */}
      <div className="perf-hero">
        <div className="perf-figure num" style={{ color: up ? 'var(--green)' : 'var(--red)' }}>{signedPct(m.totalReturn)}</div>
        <div className="perf-sub">since inception · {m.months} mo{m.annualized != null ? ` · ${signedPct(m.annualized)} ann.` : ''}</div>
      </div>

      {chartable ? <LineChart model={m.cumulative} benchmark={b.cumulative} /> : <div className="chart-empty">Not enough history yet to chart — need at least two month-ends of data.</div>}
      {chartable && (
        <div className="chart-legend">
          {/* server computes growth-of-basis at its own default; rescale to the
              user's display basis — growth is linear in the starting amount */}
          <span className="leg"><span className="ln" style={{ background: up ? 'var(--green)' : 'var(--red)' }} />Model {money(m.cumulative.at(-1).value * (BASIS / (perf.basis || BASIS)))}</span>
          <span className="leg"><span className="ln muted-ln" />Benchmark {money((b.cumulative.at(-1)?.value ?? 0) * (BASIS / (perf.basis || BASIS)))}</span>
        </div>
      )}

      {(!notes.benchmarkComplete || partial || (notes.missingHoldings?.length)) && (
        <div className="data-warn">
          {!notes.benchmarkComplete && <div>Benchmark data incomplete — sleeves unavailable from Yahoo{notes.missingBenchmarkSleeves?.length ? `: ${notes.missingBenchmarkSleeves.map((s) => s.symbol).join(', ')}` : ''}.</div>}
          {partial && <div>Some months are partial — min holding coverage {pct(perf.coverageMin)}. Returns are renormalized to holdings with data.</div>}
          {notes.missingHoldings?.length > 0 && <div>No price/NAV for: {notes.missingHoldings.map((h) => h.symbol || h.id).join(', ')}.</div>}
        </div>
      )}

      {/* period returns */}
      <div className="section-title">Returns</div>
      <div className="card">
        <div className="perf-table-head">
          <span>Period</span><span className="r">Model</span><span className="r">Bench</span><span className="r">Active</span>
        </div>
        {perf.periods.map((p) => (
          <div className="perf-table-row" key={p.label}>
            <span>{p.label}</span>
            <span className="r num">{signedPct(p.model)}</span>
            <span className="r num muted">{signedPct(p.benchmark)}</span>
            <span className={`r num ${p.active >= 0 ? 'pos' : 'neg'}`}>{signedPct(p.active)}</span>
          </div>
        ))}
      </div>

      {/* change attribution */}
      <div className="section-title">Change attribution</div>
      {perf.changes.length === 0 ? (
        <div className="card pad"><span className="muted">No model changes to attribute yet. The value each change adds shows up here once a change has a track record.</span></div>
      ) : (
        <>
          <div className="card">
            {perf.changes.map((c, i) => (
              <div className="attr-row" key={i}>
                <div className="attr-main">
                  <div className="attr-note">{c.note}</div>
                  <div className="attr-date num">{c.effectiveDate} · {c.months} mo</div>
                </div>
                <div className="attr-nums">
                  <div className={`attr-va num ${c.valueAdded >= 0 ? 'pos' : 'neg'}`}>{signedPct(c.valueAdded)}</div>
                  <div className="attr-detail num">{signedPct(c.actual)} vs {signedPct(c.counterfactual)} held</div>
                </div>
              </div>
            ))}
          </div>
          <div className="attr-total">
            <span>Cumulative value added by all changes</span>
            <span className={`num ${perf.totalValueAdded >= 0 ? 'pos' : 'neg'}`}>{signedPct(perf.totalValueAdded)}</span>
          </div>
          <p className="note">Each change is measured against holding the prior version’s weights over the same window — positive means the change helped.</p>
        </>
      )}

      {/* contribution */}
      {perf.contribution && perf.contribution.items.some((x) => x.ret != null) && (
        <>
          <div className="section-title">Contribution</div>
          <div className="perf-sub" style={{ margin: '0 4px 10px' }}>current version · since {perf.contribution.from}</div>
          <div className="rows grouped">
            {perf.contribution.items.filter((x) => x.ret != null).map((x) => (
              <div className="row" key={x.instrumentId}>
                <AssetIcon symbol={x.symbol} type={x.type} />
                <div className="row-main">
                  <div className="row-sym">{x.symbol}</div>
                  <div className="row-sub">{pct(x.weight)} · {signedPct(x.ret)} return</div>
                </div>
                <div className="row-right">
                  <div className={`row-val num ${x.contribution >= 0 ? 'pos' : 'neg'}`}>{signedPct(x.contribution, 2)}</div>
                  <div className="row-sub">contribution</div>
                </div>
              </div>
            ))}
          </div>
          <p className="note">Arithmetic contribution (weight × return) over the current version’s window; sums to the model’s window return up to a small linking residual.</p>
        </>
      )}
    </>
  );
}
