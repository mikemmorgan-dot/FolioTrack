import { pct, money, BASIS, aggregateBy, typeLabel } from '../../api.js';

export default function AllocationTab({ model }) {
  const h = model.holdings;
  if (!h.length) return <div className="empty-state"><p>No holdings to allocate yet.</p></div>;

  const byType = aggregateBy(h, 'type');
  // Rough equity/defensive split for the summary line.
  const defensive = h.filter((x) => x.type === 'mutualfund' ? false : x.sector === 'Fixed Income').reduce((s, x) => s + x.weight, 0);

  return (
    <div className="allocation">
      <div className="alloc-summary">
        <div><span className="stat-label">Growth-oriented</span><span className="mono">{pct(1 - defensive)}</span></div>
        <div><span className="stat-label">Fixed income</span><span className="mono">{pct(defensive)}</span></div>
      </div>

      <table className="data-table">
        <thead>
          <tr><th>Asset type</th><th>Allocation</th><th className="r">Weight</th><th className="r">Per {money(BASIS)}</th></tr>
        </thead>
        <tbody>
          {byType.map((t) => (
            <tr key={t.label}>
              <td>{typeLabel(t.label)}</td>
              <td><span className="bar wide"><span className="bar-fill" style={{ width: `${t.weight * 100}%` }} /></span></td>
              <td className="r mono">{pct(t.weight)}</td>
              <td className="r mono">{money(t.weight * BASIS)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
