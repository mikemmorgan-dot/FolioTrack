import { pct, money, num, BASIS, typeLabel } from '../../api.js';

export default function HoldingsTab({ model }) {
  const h = [...model.holdings].sort((a, b) => b.weight - a.weight);
  if (!h.length) return <div className="empty-state"><p>No holdings in this model yet.</p></div>;

  return (
    <div className="holdings">
      <div className="table-note">Values shown per {money(BASIS)} invested in the model.</div>
      <div className="table-wrap">
        <table className="data-table">
          <thead>
            <tr>
              <th>Symbol</th><th>Name</th><th>Type</th><th>Source</th>
              <th className="r">Weight</th><th className="r">Price</th><th className="r">Value</th><th className="r">As of</th>
            </tr>
          </thead>
          <tbody>
            {h.map((x) => {
              const auto = x.source === 'auto';
              const err = typeof x.priceSource === 'string' && x.priceSource.includes('error');
              return (
                <tr key={x.id}>
                  <td className="mono ticker">{x.symbol}</td>
                  <td className="name-cell">{x.name}</td>
                  <td><span className="chip">{typeLabel(x.type)}</span></td>
                  <td>
                    <span className={`src ${auto ? 'src-auto' : 'src-manual'}`}>
                      {auto ? 'Live' : 'Manual'}
                    </span>
                  </td>
                  <td className="r mono">{pct(x.weight)}</td>
                  <td className="r mono">{err ? <span className="muted">n/a</span> : `${num(x.price)} ${x.currency}`}</td>
                  <td className="r mono">{money(x.weight * BASIS)}</td>
                  <td className="r mono muted">{x.priceAsOf ? x.priceAsOf.slice(0, 10) : '—'}</td>
                </tr>
              );
            })}
          </tbody>
          <tfoot>
            <tr>
              <td colSpan={4}>Total</td>
              <td className="r mono">{pct(h.reduce((s, x) => s + x.weight, 0))}</td>
              <td></td>
              <td className="r mono">{money(h.reduce((s, x) => s + x.weight, 0) * BASIS)}</td>
              <td></td>
            </tr>
          </tfoot>
        </table>
      </div>
    </div>
  );
}
