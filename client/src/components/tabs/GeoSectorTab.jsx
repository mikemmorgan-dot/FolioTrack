import { pct, aggregateBy } from '../../api.js';
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

export default function GeoSectorTab({ model, onEdit }) {
  const h = model.holdings;
  if (!h.length) return <EmptyState text="No holdings to classify yet." onAction={onEdit} />;

  return (
    <div style={{ '--risk': 'var(--green)' }}>
      <div className="section-title">Sector mix</div>
      <BarList rows={aggregateBy(h, 'sector')} />
      <div className="section-title">Geographic mix</div>
      <BarList rows={aggregateBy(h, 'country')} />
      <p className="note">Classified at the instrument level. Funds contribute a single sector/region here — true fund look-through comes from factsheet entry, added next.</p>
    </div>
  );
}
