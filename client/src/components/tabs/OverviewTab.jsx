import { pct, money, BASIS, aggregateBy, typeColor, typeLabel } from '../../api.js';
import { isNavStale, isCashHolding } from '../../nav.js';
import AssetIcon from '../AssetIcon.jsx';
import EmptyState from '../EmptyState.jsx';

export default function OverviewTab({ model, goto, onEdit, onUpdatePrices }) {
  const h = model.holdings;
  if (!h.length) return <EmptyState onAction={onEdit} />;

  const top = [...h].sort((a, b) => b.weight - a.weight).slice(0, 4);
  const byType = aggregateBy(h, 'type');
  const staleCount = h.filter((x) => x.source === 'manual' && !isCashHolding(x) && isNavStale(x.type, x.priceAsOf)).length;

  return (
    <>
      {staleCount > 0 && (
        <button type="button" className="stale-line" onClick={onUpdatePrices}>
          {staleCount} manual price{staleCount === 1 ? '' : 's'} older than cadence
        </button>
      )}
      <div className="section-title">Top holdings</div>
      <div className="rows grouped">
        {top.map((x) => (
          <div className="row" key={x.id} onClick={() => goto('holdings')}>
            <AssetIcon symbol={x.symbol} type={x.type} />
            <div className="row-main">
              <div className="row-sym">{x.symbol}</div>
              <div className="row-sub">{x.name}</div>
            </div>
            <div className="row-right">
              <div className="row-val num">{pct(x.weight)}</div>
              <div className="row-sub num" style={{ marginTop: 4 }}>{money(x.weight * BASIS)}</div>
            </div>
          </div>
        ))}
      </div>

      <div className="section-title">Asset mix</div>
      <div className="card">
        {byType.map((t) => (
          <div className="bar-row" key={t.label}>
            <span className="bar-label">{typeLabel(t.label)}</span>
            <span className="bar-track"><span className="bar-fill" style={{ width: `${t.weight * 100}%`, background: typeColor(t.label) }} /></span>
            <span className="bar-pct num">{pct(t.weight)}</span>
          </div>
        ))}
      </div>
      <p className="note">Tap a holding for the full list. Performance & risk populate once you open them.</p>
    </>
  );
}
