import { pct, aggregateBy } from '../../api.js';

function MixTable({ title, rows }) {
  return (
    <section className="card">
      <h3 className="card-title">{title}</h3>
      <ul className="mini-list">
        {rows.map((r) => (
          <li key={r.label}>
            <span className="mini-name">{r.label}</span>
            <span className="bar"><span className="bar-fill" style={{ width: `${r.weight * 100}%` }} /></span>
            <span className="mono weight">{pct(r.weight)}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

export default function GeoSectorTab({ model }) {
  const h = model.holdings;
  if (!h.length) return <div className="empty-state"><p>No holdings to classify yet.</p></div>;

  const sectors = aggregateBy(h, 'sector');
  const countries = aggregateBy(h, 'country');

  return (
    <div className="geosector">
      <div className="ov-grid">
        <MixTable title="Sector mix" rows={sectors} />
        <MixTable title="Geographic mix" rows={countries} />
      </div>
      <p className="footnote">
        Classified at the instrument level. Funds and ETFs contribute a single sector/country here —
        true look-through (a fund’s own sector/geo breakdown) comes from factsheet entry, added next.
      </p>
    </div>
  );
}
