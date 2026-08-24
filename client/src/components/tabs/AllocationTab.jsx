import { pct, money, BASIS, aggregateBy, typeColor, typeLabel } from '../../api.js';
import EmptyState from '../EmptyState.jsx';

export default function AllocationTab({ model }) {
  const h = model.holdings;
  if (!h.length) return <EmptyState text="No holdings to allocate yet." />;

  const byType = aggregateBy(h, 'type');
  const fixed = h.filter((x) => x.sector === 'Fixed Income').reduce((s, x) => s + x.weight, 0);

  return (
    <>
      <div className="section-title">Allocation</div>
      <div className="card pad" style={{ display: 'flex', gap: 28, marginBottom: 12 }}>
        <div>
          <div className="muted" style={{ fontSize: 13, fontWeight: 600 }}>Growth-oriented</div>
          <div className="num" style={{ fontSize: 30, fontWeight: 700 }}>{pct(1 - fixed)}</div>
        </div>
        <div>
          <div className="muted" style={{ fontSize: 13, fontWeight: 600 }}>Fixed income</div>
          <div className="num" style={{ fontSize: 30, fontWeight: 700 }}>{pct(fixed)}</div>
        </div>
      </div>

      <div className="card">
        {byType.map((t) => (
          <div className="bar-row" key={t.label}>
            <span className="bar-label">{typeLabel(t.label)}</span>
            <span className="bar-track"><span className="bar-fill" style={{ width: `${t.weight * 100}%`, background: typeColor(t.label) }} /></span>
            <span className="bar-pct num">{pct(t.weight)}</span>
          </div>
        ))}
      </div>

      <div className="section-title">Per {money(BASIS)}</div>
      <div className="rows grouped">
        {byType.map((t) => (
          <div className="row" key={t.label}>
            <span className="asset-icon" style={{ '--ai-c': typeColor(t.label), fontSize: 11 }}>{pct(t.weight, 0)}</span>
            <div className="row-main"><div className="row-sym" style={{ fontSize: 15 }}>{typeLabel(t.label)}</div></div>
            <div className="row-right"><div className="row-val num">{money(t.weight * BASIS)}</div></div>
          </div>
        ))}
      </div>
    </>
  );
}
