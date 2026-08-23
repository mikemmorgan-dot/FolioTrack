export default function PerformanceTab({ model }) {
  const versions = [...model.versions].sort((a, b) => b.effectiveDate.localeCompare(a.effectiveDate));

  return (
    <div className="performance">
      <section className="card">
        <h3 className="card-title">Model change history</h3>
        {versions.length === 0 ? (
          <p className="muted">No versions recorded yet.</p>
        ) : (
          <ol className="timeline">
            {versions.map((v, i) => (
              <li key={v.id} className={i === 0 ? 'current' : ''}>
                <span className="tl-date mono">{v.effectiveDate}</span>
                <span className="tl-body">
                  <strong>v{versions.length - i}</strong>
                  {v.note ? ` — ${v.note}` : ' — model change'}
                  <span className="muted"> · {v.holdingCount} holdings</span>
                </span>
              </li>
            ))}
          </ol>
        )}
      </section>

      <section className="card contract">
        <h3 className="card-title">Coming next: return &amp; attribution engine</h3>
        <p className="muted">This view will compute from the data already wired up:</p>
        <ul className="contract-list">
          <li><strong>Model return path</strong> — chain each version’s weighted holding returns across its effective window (Yahoo history for listed, entered NAVs for manual).</li>
          <li><strong>vs blended benchmark</strong> — the per-model benchmark sleeves, tracked over the same windows.</li>
          <li><strong>Change attribution</strong> — for every model change, the return of the new mix vs holding the prior version: did the change add or subtract?</li>
          <li><strong>Contribution</strong> — each holding’s weight × return share of total model return.</li>
        </ul>
        <p className="footnote">Manual NAVs are periodic (not daily), so manual sleeves will report on their available cadence.</p>
      </section>
    </div>
  );
}
