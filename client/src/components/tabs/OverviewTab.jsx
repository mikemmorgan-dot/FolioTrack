import { pct, aggregateBy, typeLabel, blendedMer } from '../../api.js';

function Empty({ goto }) {
  return (
    <div className="empty-state">
      <p>This model has no holdings yet.</p>
      <p className="muted">Add a version with target weights to start tracking it.</p>
    </div>
  );
}

export default function OverviewTab({ model, goto }) {
  const h = model.holdings;
  if (!h.length) return <Empty goto={goto} />;

  const byType = aggregateBy(h, 'type');
  const top = [...h].sort((a, b) => b.weight - a.weight).slice(0, 5);
  const mer = blendedMer(h);
  const autoCount = h.filter((x) => x.source === 'auto').length;
  const manualCount = h.length - autoCount;

  return (
    <div className="overview">
      <div className="stat-row">
        <div className="stat">
          <div className="stat-label">Holdings</div>
          <div className="stat-value mono">{h.length}</div>
          <div className="stat-sub">{autoCount} live · {manualCount} manual</div>
        </div>
        <div className="stat">
          <div className="stat-label">Blended MER</div>
          <div className="stat-value mono">{mer == null ? '—' : pct(mer / 100, 2)}</div>
          <div className="stat-sub">weight-avg, where known</div>
        </div>
        <div className="stat">
          <div className="stat-label">Benchmark sleeves</div>
          <div className="stat-value mono">{model.benchmark.length}</div>
          <div className="stat-sub">blended to underlying</div>
        </div>
        <div className="stat">
          <div className="stat-label">Model version</div>
          <div className="stat-value mono">v{model.versions.length}</div>
          <div className="stat-sub">since {model.currentVersion?.effectiveDate}</div>
        </div>
      </div>

      <div className="ov-grid">
        <section className="card">
          <h3 className="card-title">Top holdings</h3>
          <ul className="mini-list">
            {top.map((x) => (
              <li key={x.id}>
                <span className="mono ticker">{x.symbol}</span>
                <span className="mini-name">{x.name}</span>
                <span className="mono weight">{pct(x.weight)}</span>
              </li>
            ))}
          </ul>
          <button className="link" onClick={() => goto('holdings')}>All holdings →</button>
        </section>

        <section className="card">
          <h3 className="card-title">Asset mix</h3>
          <ul className="mini-list">
            {byType.map((t) => (
              <li key={t.label}>
                <span className="mini-name">{typeLabel(t.label)}</span>
                <span className="bar"><span className="bar-fill" style={{ width: `${t.weight * 100}%` }} /></span>
                <span className="mono weight">{pct(t.weight)}</span>
              </li>
            ))}
          </ul>
          <button className="link" onClick={() => goto('allocation')}>Allocation table →</button>
        </section>
      </div>

      <p className="footnote">
        Live prices via Yahoo for listed holdings; manual holdings use your latest entered NAV.
        Performance & risk views compute from history once you open them.
      </p>
    </div>
  );
}
