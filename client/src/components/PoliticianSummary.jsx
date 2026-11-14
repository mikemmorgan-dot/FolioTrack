const WINDOWS = [
  { id: 7, label: '7 days' },
  { id: 30, label: '30 days' },
  { id: 90, label: '90 days' },
];
const CLUSTER_CHOICES = [3, 4, 5];
const RANK_CAP = 10;

export const NET_TIP = 'Estimated from the midpoint of each reported amount range. Over $50,000,000 is counted as $50,000,000, so that figure is a minimum. Trades with no parseable amount are left out.';

function pretty(iso) {
  if (!iso) return '—';
  const [y, m, d] = String(iso).slice(0, 10).split('-').map(Number);
  if (!y || !m || !d) return String(iso);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC',
  });
}

function officeName(office) {
  if (office === 'house') return 'House';
  if (office === 'senate') return 'Senate';
  if (office === 'president') return 'President';
  if (office === 'vice-president') return 'Vice President';
  return office || '—';
}

function partyName(party) {
  if (party === 'D') return 'Democrat';
  if (party === 'R') return 'Republican';
  if (party === 'I') return 'Independent';
  return null;
}

function peopleLabel(n) {
  return `${n} politician${n === 1 ? '' : 's'}`;
}

function sideCount(n, singular) {
  return `${n} ${singular}${n === 1 ? '' : 's'}`;
}

function tradeLabel(n, side) {
  const word = side === 'sell' ? 'sell' : 'buy';
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

export function signClass(n) {
  if (n > 0) return 'pos';
  if (n < 0) return 'neg';
  return '';
}

export function NetLine({ net, hideEstimate = false }) {
  if (!net) return null;
  const mixed = net.buys > 0 && net.sells > 0;
  return (
    <span className="ptr-net">
      <span className={signClass(net.netCount)}>{net.countLabel || `Net ${net.netCount}`}</span>
      {!hideEstimate && net.estimateLabel && (
        <span className={signClass(net.estimatedNet)} title={NET_TIP}>{net.estimateLabel}</span>
      )}
      {mixed && <span className="ptr-net-extra">{sideCount(net.buys, 'buy')} · {sideCount(net.sells, 'sell')}</span>}
      {net.exchanges > 0 && (
        <span className="ptr-net-extra">{net.exchanges} exchange{net.exchanges === 1 ? '' : 's'}</span>
      )}
      {net.excluded > 0 && (
        <span className="ptr-net-extra">{net.excluded} amount{net.excluded === 1 ? '' : 's'} left out</span>
      )}
    </span>
  );
}

function HeldLine({ row }) {
  if (!row.held) return null;
  const names = (row.models || []).filter(Boolean);
  return <div className="ptr-meta">In your models{names.length ? ` · ${names.join(', ')}` : ''}</div>;
}

function ShowAll({ total, shown, expanded, loading, onExpand, onCollapse }) {
  if (!total || total <= RANK_CAP) return null;
  if (expanded && shown >= total) {
    return (
      <button type="button" className="ptr-more" aria-expanded="true" onClick={onCollapse}>
        Show top {RANK_CAP}
      </button>
    );
  }
  if (expanded && loading && shown < total) {
    return <p className="ptr-note">Loading all {total}…</p>;
  }
  return (
    <button type="button" className="ptr-more" aria-expanded="false" onClick={onExpand}>
      Show all {total}
    </button>
  );
}

function RankList({ rows, side, onTicker }) {
  if (!rows.length) {
    return <p className="ptr-note">No parsed {side === 'sell' ? 'sells' : 'buys'} in this window.</p>;
  }
  return rows.map((row) => (
    <button
      key={row.ticker}
      type="button"
      className="ptr-rank"
      onClick={() => onTicker(row.ticker)}
      aria-label={`Show ${row.ticker} filings`}
    >
      <span className="ptr-rank-top">
        <span className="ptr-rank-ticker">{row.ticker}</span>
        <span className="ptr-rank-amt">{row.amountLabel || 'Range not available'}</span>
      </span>
      <span className="ptr-meta">{tradeLabel(row.trades, side)} · {peopleLabel(row.politicians)}</span>
      <NetLine net={row.net} />
      <HeldLine row={row} />
    </button>
  ));
}

export default function PoliticianSummary({
  summary,
  loading,
  error,
  windowDays,
  onWindow,
  clusterMin,
  onClusterMin,
  onTicker,
  onPerson,
  expanded,
  onExpand,
  onCollapse,
}) {
  const minPeople = clusterMin;
  const bought = summary?.bought || [];
  const sold = summary?.sold || [];
  const nets = summary?.nets || [];
  const showBought = expanded?.buy ? bought : bought.slice(0, RANK_CAP);
  const showSold = expanded?.sell ? sold : sold.slice(0, RANK_CAP);
  const showNets = expanded?.net ? nets : nets.slice(0, RANK_CAP);
  const loadingFull = Boolean(loading && summary && summary.rankLimit != null && (
    expanded?.buy || expanded?.sell || expanded?.net
  ));
  return (
    <section className="ptr-summary" aria-label="Trade summary">
      <div className="ed-section">Summary</div>
      <div className="segmented ptr-chips" role="group" aria-label="Disclosure window">
        {WINDOWS.map((opt) => (
          <button
            key={opt.id}
            type="button"
            className={windowDays === opt.id ? 'on' : ''}
            aria-pressed={windowDays === opt.id}
            onClick={() => onWindow(opt.id)}
          >{opt.label}</button>
        ))}
      </div>
      <p className="ptr-note">
        The window is by disclosure date{summary?.from ? ` (${pretty(summary.from)} – ${pretty(summary.to)})` : ''}, not the day the trade happened.
        Filings can lag the trade by up to 45 days.
      </p>
      <p className="ptr-note">
        Range labels add up the reported ranges. Est. net uses the midpoint of each range.
        Over $50,000,000 counts as $50,000,000 and is marked “at least”.
        Trades with no amount are left out of the estimate.
      </p>
      {error && <div className="banner">{error}</div>}
      {loading && !summary && <p className="ed-hint">Loading summary…</p>}
      {loading && summary && <p className="ed-hint">Updating…</p>}
      {summary && summary.excludedFilings > 0 && (
        <p className="ptr-note">
          {summary.excludedFilings} filing{summary.excludedFilings === 1 ? '' : 's'} in this window
          {' '}ha{summary.excludedFilings === 1 ? 's' : 've'} no parsed ticker and
          {summary.excludedFilings === 1 ? ' is' : ' are'} left out of these lists.
        </p>
      )}

      {summary && (
        <>
      <div className="ed-section">Most bought</div>
      <RankList rows={showBought} side="buy" onTicker={onTicker} />
      <ShowAll
        total={summary.boughtTotal}
        shown={showBought.length}
        expanded={Boolean(expanded?.buy)}
        loading={loadingFull}
        onExpand={() => onExpand('buy')}
        onCollapse={() => onCollapse('buy')}
      />

      <div className="ed-section">Most sold</div>
      <RankList rows={showSold} side="sell" onTicker={onTicker} />
      <ShowAll
        total={summary.soldTotal}
        shown={showSold.length}
        expanded={Boolean(expanded?.sell)}
        loading={loadingFull}
        onExpand={() => onExpand('sell')}
        onCollapse={() => onCollapse('sell')}
      />

      <div className="ed-section">Net buyers vs sellers</div>
      <p className="ptr-note">
        Tickers with both buys and sells in this disclosure window, across every politician.
        Net count is buys minus sells. Exchanges are separate.
      </p>
      {showNets.length === 0 && (
        <p className="ptr-note">No ticker was both bought and sold in this window.</p>
      )}
      {showNets.map((row) => (
        <button
          key={row.ticker}
          type="button"
          className="ptr-rank"
          onClick={() => onTicker(row.ticker)}
          aria-label={`Show ${row.ticker} filings`}
        >
          <span className="ptr-rank-top">
            <span className="ptr-rank-ticker">{row.ticker}</span>
            {row.net?.estimateLabel && (
              <span className={`ptr-rank-amt ${signClass(row.net.estimatedNet)}`} title={NET_TIP}>
                {row.net.estimateLabel}
              </span>
            )}
          </span>
          <NetLine net={row.net} hideEstimate />
          <HeldLine row={row} />
        </button>
      ))}
      <ShowAll
        total={summary.netTotal}
        shown={showNets.length}
        expanded={Boolean(expanded?.net)}
        loading={loadingFull}
        onExpand={() => onExpand('net')}
        onCollapse={() => onCollapse('net')}
      />
        </>
      )}

      <div className="ed-section">Cluster buys</div>
      <div className="segmented ptr-chips" role="group" aria-label="Cluster size">
        {CLUSTER_CHOICES.map((n) => (
          <button
            key={n}
            type="button"
            className={clusterMin === n ? 'on' : ''}
            aria-pressed={clusterMin === n}
            onClick={() => onClusterMin(n)}
          >{n}+ people</button>
        ))}
      </div>
      <p className="ptr-note">Tickers bought by {minPeople} or more politicians in this disclosure window.</p>
      {summary && summary.clusters.length === 0 && (
        <p className="ptr-note">None in this window.</p>
      )}
      {summary && (summary.clusters || []).map((cluster) => (
        <article key={cluster.ticker} className="ptr-card">
          <button
            type="button"
            className="ptr-rank ptr-rank-in-card"
            onClick={() => onTicker(cluster.ticker)}
            aria-label={`Show ${cluster.ticker} filings`}
          >
            <span className="ptr-rank-top">
              <span className="ptr-rank-ticker">{cluster.ticker}</span>
              <span className="ptr-rank-amt">{cluster.amountLabel || 'Range not available'}</span>
            </span>
            <span className="ptr-meta">{peopleLabel(cluster.politicians)} · {tradeLabel(cluster.trades, 'buy')}</span>
            <NetLine net={cluster.net} />
            <HeldLine row={cluster} />
          </button>
          <ul className="ptr-buyers">
            {cluster.buyers.map((buyer) => {
              const party = partyName(buyer.party);
              return (
                <li key={buyer.personKey}>
                  <button type="button" className="ptr-who" onClick={() => onPerson(buyer.personKey)}>
                    {buyer.name}
                  </button>
                  <div className="ptr-meta">
                    {officeName(buyer.office)}
                    {party ? ` · ${party}` : ''}
                    {buyer.filerStatus === 'candidate' ? ' · Candidate' : ''}
                  </div>
                  {buyer.filerStatus === 'candidate' && (
                    <div className="ptr-tags"><span className="pill amber">Candidate</span></div>
                  )}
                  <div className="ptr-meta">
                    {(buyer.dates || []).map(pretty).join(', ') || '—'}
                    {buyer.amountLabel ? ` · ${buyer.amountLabel}` : ''}
                    {buyer.trades > 1 ? ` · ${buyer.trades} buys` : ''}
                  </div>
                </li>
              );
            })}
          </ul>
        </article>
      ))}
      {summary?.clusterTotal > (summary?.clusters?.length || 0) && (
        <p className="ptr-note">
          Showing {summary.clusters.length} of {summary.clusterTotal} clustered tickers.
        </p>
      )}
    </section>
  );
}
