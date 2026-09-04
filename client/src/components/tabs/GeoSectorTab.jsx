import { pct, aggregateLookThrough } from '../../api.js';
import { lookThroughCoverage } from '../../lookThrough.js';
import EmptyState from '../EmptyState.jsx';

function BarList({ rows }) {
  return (
    <div className="card">
      {rows.map((r) => (
        <div className="bar-row" key={r.label}>
          <span className="bar-label">{r.label}</span>
          <span className="bar-track"><span className="bar-fill" style={{ width: `${r.weight * 100}%` }} /></span>
          <span className="bar-pct num">{pct(r.weight)}</span>
        </div>
      ))}
    </div>
  );
}

function CoverageBanner({ holdings }) {
  const c = lookThroughCoverage(holdings);
  const parts = [
    `Look-through on ${pct(c.lookThroughPct, 0)} of weight`,
    c.singleBucketCount > 0
      ? `${c.singleBucketCount} holding${c.singleBucketCount === 1 ? '' : 's'} single-bucket`
      : null,
    c.oldestAsOf ? `oldest factsheet ${c.oldestAsOf}` : null,
  ].filter(Boolean);
  const summary = parts.join(' · ');

  if (!c.issues) {
    return <p className="note" style={{ paddingTop: 0 }}>{summary}</p>;
  }

  return (
    <div className="data-warn">
      <div>{summary}</div>
      {c.missingAsOf.length > 0 && (
        <div>
          No factsheet as-of on {c.missingAsOf.map((h) => h.symbol).join(', ')} — worse than old; Geo/Sector looks more precise than the data behind it.
        </div>
      )}
      {c.missingFundBreakdown.length > 0 && (
        <div>
          Funds without look-through (single-bucket): {c.missingFundBreakdown.map((h) => h.symbol).join(', ')}
        </div>
      )}
    </div>
  );
}

export default function GeoSectorTab({ model, onEdit }) {
  const h = model.holdings;
  if (!h.length) return <EmptyState text="No holdings to classify yet." onAction={onEdit} />;

  const coverage = lookThroughCoverage(h);

  return (
    <div style={{ '--risk': 'var(--green)' }}>
      {coverage.issues && <CoverageBanner holdings={h} />}
      <div className="section-title">Sector mix</div>
      <BarList rows={aggregateLookThrough(h, 'sector')} />
      <div className="section-title">Geographic mix</div>
      <BarList rows={aggregateLookThrough(h, 'country')} />
      {!coverage.issues && coverage.lookThroughPct > 0 && <CoverageBanner holdings={h} />}
      <p className="note">Funds with a factsheet breakdown entered (Holdings tab → tap a fund) look through to their sector/geography here. Funds without one still count as a single sector/region. This isn’t live constituent data.</p>
    </div>
  );
}
