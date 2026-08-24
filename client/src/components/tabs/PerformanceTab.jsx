export default function PerformanceTab({ model }) {
  const versions = [...model.versions].sort((a, b) => b.effectiveDate.localeCompare(a.effectiveDate));

  return (
    <>
      <div className="section-title">Model changes</div>
      {versions.length === 0 ? (
        <div className="card pad"><span className="muted">No versions recorded yet.</span></div>
      ) : (
        <div className="card pad">
          <div className="tl">
            {versions.map((v, i) => (
              <div key={v.id} className={`tl-item${i === 0 ? ' current' : ''}`}>
                <div className="tl-marker"><span className="tl-dot" /><span className="tl-line" /></div>
                <div className="tl-body">
                  <div className="tl-top">
                    <span className="badge">v{versions.length - i}</span>
                    <span className="tl-date num">{v.effectiveDate}</span>
                  </div>
                  <div className="tl-note">{v.note || 'Model change'}</div>
                  <div className="tl-meta num">{v.holdingCount} holdings</div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="section-title">Coming next</div>
      <div className="card pad">
        <p className="muted" style={{ margin: '0 0 6px', fontSize: 14 }}>Return &amp; attribution engine — computed from data already wired:</p>
        <ul className="contract-list">
          <li><span className="n">1</span><span><b>Model return path</b> — chain each version’s weighted holding returns across its effective window.</span></li>
          <li><span className="n">2</span><span><b>vs blended benchmark</b> — the per-model sleeves, tracked over the same windows.</span></li>
          <li><span className="n">3</span><span><b>Change attribution</b> — for each model change, the new mix vs holding the prior version.</span></li>
          <li><span className="n">4</span><span><b>Contribution</b> — each holding’s weight × return share of total.</span></li>
        </ul>
      </div>
    </>
  );
}
