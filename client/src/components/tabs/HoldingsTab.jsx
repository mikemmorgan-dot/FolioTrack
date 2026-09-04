import { useState } from 'react';
import { pct, money, num, BASIS } from '../../api.js';
import { isNavStale, isCashHolding } from '../../nav.js';
import { lookThroughChip } from '../../lookThrough.js';
import AssetIcon from '../AssetIcon.jsx';
import EmptyState from '../EmptyState.jsx';

const SORTS = {
  weight: (a, b) => b.weight - a.weight,
  name: (a, b) => a.symbol.localeCompare(b.symbol),
};

export default function HoldingsTab({ model, onEdit, onClassify, onUpdatePrices }) {
  const [sort, setSort] = useState('weight');
  if (!model.holdings.length) return <EmptyState text="No holdings in this model yet." onAction={onEdit} />;
  const h = [...model.holdings].sort(SORTS[sort]);

  return (
    <>
      <div className="toolbar">
        <button type="button" className="dropdown" onClick={onUpdatePrices}>Update prices</button>
        <button className="dropdown" onClick={() => setSort((s) => (s === 'weight' ? 'name' : 'weight'))}>
          {sort === 'weight' ? 'Highest weight' : 'Alphabetical'} ▾
        </button>
      </div>

      <div className="rows grouped">
        {h.map((x) => {
          const auto = x.source === 'auto';
          const err = typeof x.priceSource === 'string' && x.priceSource.includes('error');
          const ltChip = lookThroughChip(x);
          const stale = !auto && !isCashHolding(x) && isNavStale(x.type, x.priceAsOf);
          const priceLine = err || x.price == null
            ? 'price n/a'
            : `${num(x.price)} ${x.currency}`;
          return (
            <button type="button" className="row row-tappable" key={x.id} onClick={() => onClassify?.(x)}>
              <AssetIcon symbol={x.symbol} type={x.type} />
              <div className="row-main">
                <div className="row-sym">{x.symbol}</div>
                <div className="row-sub">{x.name}</div>
                {ltChip ? <div className={`row-lt${ltChip.includes('incomplete') ? ' warn' : ''}`}>{ltChip}</div> : null}
              </div>
              <div className="row-right">
                <div className="row-val num">{money(x.weight * BASIS)}</div>
                <div className="row-tags">
                  <span className="pill weight num">{pct(x.weight)}</span>
                  <span className={`pill ${auto ? 'green' : 'neutral'}`}>{auto ? 'Live' : 'Manual'}</span>
                  {stale && <span className="pill amber">Stale</span>}
                </div>
                <div className="row-sub num" style={{ marginTop: 4 }}>
                  {priceLine}
                  {!auto ? ` · ${x.priceAsOf || '—'}` : ''}
                </div>
              </div>
            </button>
          );
        })}
      </div>
      <p className="note">Values shown per {money(BASIS)} invested. Auto holdings price through the live provider chain; manual holdings use the NAV you last entered — the as-of date is what counts, and one update applies to every model that holds that name. Tap a holding to set its sector/geography or a fund look-through breakdown.</p>
    </>
  );
}
