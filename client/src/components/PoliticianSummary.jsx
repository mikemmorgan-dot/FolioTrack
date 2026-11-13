const WINDOWS = [
  { id: 7, label: '7 days' },
  { id: 30, label: '30 days' },
  { id: 90, label: '90 days' },
];
const CLUSTER_CHOICES = [3, 4, 5];

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

function tradeLabel(n, side) {
  const word = side === 'sell' ? 'sell' : 'buy';
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

function HeldLine({ row }) {
  if (!row.held) return null;
  const names = (row.models || []).filter(Boolean);
  return <div className="ptr-meta">In your models{names.length ? ` · ${names.join(', ')}` : ''}</div>;
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
}) {
  const minPeople = clusterMin;
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
        Uses the disclosure date{summary?.from ? ` (${pretty(summary.from)} – ${pretty(summary.to)})` : ''}.
        Transaction dates can lag by up to 45 days.
      </p>
      <p className="ptr-note">Sums of the reported ranges, not an exact dollar amount.</p>
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
      <RankList rows={summary.bought || []} side="buy" onTicker={onTicker} />

      <div className="ed-section">Most sold</div>
      <RankList rows={summary.sold || []} side="sell" onTicker={onTicker} />
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
      <p className="ptr-note">Tickers bought by {minPeople} or more politicians in this window.</p>
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
