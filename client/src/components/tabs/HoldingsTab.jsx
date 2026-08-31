import { useState } from 'react';
import { pct, money, num, BASIS } from '../../api.js';
import AssetIcon from '../AssetIcon.jsx';
import EmptyState from '../EmptyState.jsx';
import { IconSort } from '../icons.jsx';

const SORTS = {
  weight: (a, b) => b.weight - a.weight,
  name: (a, b) => a.symbol.localeCompare(b.symbol),
};

export default function HoldingsTab({ model, onEdit }) {
  const [sort, setSort] = useState('weight');
  if (!model.holdings.length) return <EmptyState text="No holdings in this model yet." onAction={onEdit} />;
  const h = [...model.holdings].sort(SORTS[sort]);

  return (
    <>
      <div className="toolbar">
        <button className="round-btn" aria-label="Filter"><IconSort /></button>
        <button className="dropdown" onClick={() => setSort((s) => (s === 'weight' ? 'name' : 'weight'))}>
          {sort === 'weight' ? 'Highest weight' : 'Alphabetical'} ▾
        </button>
      </div>

      <div className="rows grouped">
        {h.map((x) => {
          const auto = x.source === 'auto';
          const err = typeof x.priceSource === 'string' && x.priceSource.includes('error');
          return (
            <div className="row" key={x.id}>
              <AssetIcon symbol={x.symbol} type={x.type} />
              <div className="row-main">
                <div className="row-sym">{x.symbol}</div>
                <div className="row-sub">{x.name}</div>
              </div>
              <div className="row-right">
                <div className="row-val num">{money(x.weight * BASIS)}</div>
                <div className="row-tags">
                  <span className="pill weight num">{pct(x.weight)}</span>
                  <span className={`pill ${auto ? 'green' : 'neutral'}`}>{auto ? 'Live' : 'Manual'}</span>
                </div>
                <div className="row-sub num" style={{ marginTop: 4 }}>
                  {err ? 'price n/a' : `${num(x.price)} ${x.currency}`}
                </div>
              </div>
            </div>
          );
        })}
      </div>
      <p className="note">Values shown per {money(BASIS)} invested. Live prices via Yahoo; manual holdings use your latest entered NAV.</p>
    </>
  );
}
