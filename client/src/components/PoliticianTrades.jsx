import { useEffect, useState } from 'react';
import { api } from '../api.js';
import PoliticianSearch from './PoliticianSearch.jsx';
import PoliticianSummary, { NetLine, NET_TIP, signClass } from './PoliticianSummary.jsx';

const OFFICES = [
  { id: '', label: 'All' },
  { id: 'house', label: 'House' },
  { id: 'senate', label: 'Senate' },
  { id: 'president', label: 'President' },
];
const PARTIES = [
  { id: '', label: 'Any party' },
  { id: 'D', label: 'Democrat' },
  { id: 'R', label: 'Republican' },
  { id: 'I', label: 'Independent' },
];
const SIDES = [
  { id: '', label: 'Buy & sell' },
  { id: 'buy', label: 'Buy' },
  { id: 'sell', label: 'Sell' },
  { id: 'exchange', label: 'Exchange' },
];
const FILERS = [
  { id: '', label: 'All' },
  { id: 'member', label: 'Members' },
  { id: 'candidate', label: 'Candidates' },
];

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

function sideName(item) {
  const base = item.txType === 'buy' ? 'Buy' : item.txType === 'sell' ? 'Sell' : item.txType === 'exchange' ? 'Exchange' : 'Other';
  return item.partial ? `${base} (partial)` : base;
}

function ownerName(owner) {
  if (owner === 'self') return 'Self';
  if (owner === 'spouse') return 'Spouse';
  if (owner === 'joint') return 'Joint';
  if (owner === 'child') return 'Child';
  return 'Owner not stated';
}

function ChipRow({ options, value, onChange, label }) {
  return (
    <div className="segmented ptr-chips" role="group" aria-label={label}>
      {options.map((opt) => (
        <button
          key={opt.id || 'all'}
          type="button"
          className={value === opt.id ? 'on' : ''}
          aria-pressed={value === opt.id}
          onClick={() => onChange(opt.id)}
        >{opt.label}</button>
      ))}
    </div>
  );
}

function TradeCard({ item, onPerson }) {
  const party = partyName(item.party);
  const held = item.heldModels || [];
  if (item.kind === 'review') {
    return (
      <article className="ptr-card">
        <button type="button" className="ptr-who" onClick={() => onPerson(item.personKey)}>
          {item.personName}
        </button>
        <div className="ptr-meta">{officeName(item.office)}{party ? ` · ${party}` : ''}{item.filerStatus === 'candidate' ? ' · Candidate' : ''}</div>
        <div className="ptr-tags">
          {item.filerStatus === 'candidate' && <span className="pill amber">Candidate</span>}
          <span className="pill amber">Needs review</span>
        </div>
        <p className="ptr-note">{item.parseNote || 'This filing could not be read. Open the source and review it by hand.'}</p>
        <div className="ptr-meta">Disclosed {pretty(item.disclosedDate)}</div>
        {item.sourceUrl && <a className="ptr-link" href={item.sourceUrl} target="_blank" rel="noreferrer">Source filing</a>}
      </article>
    );
  }
  return (
    <article className="ptr-card">
      <button type="button" className="ptr-who" onClick={() => onPerson(item.personKey)}>
        {item.personName}
      </button>
      <div className="ptr-meta">
        {officeName(item.office)}{party ? ` · ${party}` : ''}{item.state ? ` · ${item.state}` : ''}{item.filerStatus === 'candidate' ? ' · Candidate' : ''}
      </div>
      <div className="ptr-line">
        <span className="ptr-side">{item.ticker || 'No ticker'}</span>
        <span className="ptr-side-label">{sideName(item)}</span>
      </div>
      <div className="ptr-tags">
        {item.filerStatus === 'candidate' && <span className="pill amber">Candidate</span>}
        {held.length > 0 && <span className="pill green">In your models</span>}
        {item.ocr && <span className="pill neutral">OCR{item.ocrConfidence != null ? ` ${item.ocrConfidence}` : ''}</span>}
        {item.tickerSource === 'name_match' && (
          <span className="pill neutral" title={item.tickerMatchConfidence != null ? `Name match confidence ${item.tickerMatchConfidence}` : 'Matched from the asset name'}>matched from name</span>
        )}
      </div>
      {held.length > 0 && <div className="ptr-meta">{held.map((m) => m.name || m.key).join(', ')}</div>}
      <p className="ptr-asset">{item.asset}</p>
      <div className="ptr-meta">{ownerName(item.owner)} · {item.amountRange}</div>
      <div className="ptr-meta">
        Traded {pretty(item.txDate)} · disclosed {pretty(item.disclosedDate)}
        {item.lagDays != null ? ` · ${item.lagDays} day lag` : ''}
      </div>
      {item.sourceUrl && <a className="ptr-link" href={item.sourceUrl} target="_blank" rel="noreferrer">Source filing</a>}
    </article>
  );
}

const PERSON_WINDOWS = [
  { id: 7, label: '7 days' },
  { id: 30, label: '30 days' },
  { id: 90, label: '90 days' },
];

function PersonView({ personKey, initialWindow = 30, onBack }) {
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const [offset, setOffset] = useState(0);
  const [items, setItems] = useState([]);
  const [windowDays, setWindowDays] = useState(initialWindow);
  const [scope, setScope] = useState('window');
  const [widened, setWidened] = useState(false);
  const [seenKey, setSeenKey] = useState(personKey);
  if (seenKey !== personKey) {
    setSeenKey(personKey);
    setData(null);
    setErr(null);
    setOffset(0);
    setItems([]);
    setWindowDays(initialWindow);
    setScope('window');
    setWidened(false);
  }

  useEffect(() => {
    let cancel = false;
    setErr(null);
    const query = { offset, limit: 40, window: windowDays };
    if (scope === 'all') query.feed = 'all';
    api.politician(personKey, query)
      .then((body) => {
        if (cancel) return;
        const outsideWindow = scope === 'window'
          && offset === 0
          && (body.total === 0)
          && ((body.counts?.trades || 0) > 0);
        if (outsideWindow) {
          setWidened(true);
          setScope('all');
          return;
        }
        setData(body);
        setItems((prev) => (offset === 0 ? body.items : prev.concat(body.items)));
      })
      .catch((e) => { if (!cancel) setErr(e.message); });
    return () => { cancel = true; };
  }, [personKey, offset, scope, windowDays]);

  function changeWindow(days) {
    if (days === windowDays) return;
    setOffset(0);
    setItems([]);
    setData(null);
    setScope('window');
    setWidened(false);
    setWindowDays(days);
  }

  const person = data?.person;
  const party = partyName(person?.party);
  const rollup = data?.tickerRollup?.window === windowDays ? data.tickerRollup : null;
  const rollupTickers = rollup?.tickers || [];
  return (
    <>
      <header className="editor-bar">
        <button type="button" className="ed-cancel" onClick={onBack}>Back</button>
        <span className="ed-title">{person?.personName || 'Filer'}</span>
        <span />
      </header>
      <div className="editor-body">
        {err && <div className="banner">{err}</div>}
        {!data && !err && <p className="ed-hint">Loading…</p>}
        {person && (
          <>
            <p className="ed-hint">
              {officeName(person.office)}{party ? ` · ${party}` : ''}{person.state ? ` · ${person.state}` : ''}{person.filerStatus === 'candidate' ? ' · Candidate' : ''}
            </p>
            {widened && (
              <p className="ptr-note" role="status">
                No disclosures in the last {windowDays} days.
                {data.latestDisclosure ? ` Latest disclosure was ${pretty(data.latestDisclosure)}.` : ''}
                {' '}Showing every filing.
              </p>
            )}
            {!widened && scope === 'window' && (
              <p className="ptr-note">
                Last {windowDays} days
                {data.window?.from ? ` (${pretty(data.window.from)} – ${pretty(data.window.to)})` : ''}.
                {' '}Counts below are every filing.
                {' '}
                <button
                  type="button"
                  className="ptr-text-btn"
                  onClick={() => { setOffset(0); setItems([]); setScope('all'); }}
                >Show every filing</button>
              </p>
            )}
            <div className="ptr-stats">
              <div><span className="ptr-stat-n">{data.counts?.buy ?? 0}</span><span>Buys</span></div>
              <div><span className="ptr-stat-n">{data.counts?.sell ?? 0}</span><span>Sells</span></div>
              <div><span className="ptr-stat-n">{data.counts?.exchange ?? 0}</span><span>Exchanges</span></div>
            </div>
            <div className="ed-section">By ticker</div>
            <div className="segmented ptr-chips" role="group" aria-label="Disclosure window">
              {PERSON_WINDOWS.map((opt) => (
                <button
                  key={opt.id}
                  type="button"
                  className={windowDays === opt.id ? 'on' : ''}
                  aria-pressed={windowDays === opt.id}
                  onClick={() => changeWindow(opt.id)}
                >{opt.label}</button>
              ))}
            </div>
            <p className="ptr-note">
              This window is by disclosure date{rollup?.from ? ` (${pretty(rollup.from)} – ${pretty(rollup.to)})` : ''}.
              Net is this filer's buys minus sells. Dollars are estimates from range midpoints.
            </p>
            {person && !rollup && <p className="ed-hint">Loading tickers…</p>}
            {rollup && rollupTickers.length === 0 && (
              <p className="ptr-note">No ticker trades disclosed in this window.</p>
            )}
            {rollupTickers.map((row) => (
              <div key={row.ticker} className="ptr-rank ptr-rollup">
                <span className="ptr-rank-top">
                  <span className="ptr-rank-ticker">{row.ticker}</span>
                  {row.net?.estimateLabel && (
                    <span className={`ptr-rank-amt ${signClass(row.net.estimatedNet)}`} title={NET_TIP}>
                      {row.net.estimateLabel}
                    </span>
                  )}
                </span>
                <NetLine net={row.net} hideEstimate />
              </div>
            ))}
          </>
        )}
        <div className="ed-section">Trades</div>
        <p className="ptr-note">Rows without a ticker, including bonds, stay in this list.</p>
        {items.map((item) => <TradeCard key={item.id} item={item} onPerson={() => {}} />)}
        {data?.hasMore && (
          <button type="button" className="rp-run alert-secondary" onClick={() => setOffset((n) => n + 40)}>Load more</button>
        )}
      </div>
    </>
  );
}

export default function PoliticianTrades({ onClose, initialTicker = '' }) {
  const [q, setQ] = useState(initialTicker || '');
  const [ticker, setTicker] = useState('');
  const [office, setOffice] = useState('');
  const [party, setParty] = useState('');
  const [side, setSide] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [heldOnly, setHeldOnly] = useState(false);
  const [filer, setFiler] = useState('');
  const [windowDays, setWindowDays] = useState(30);
  const [clusterMin, setClusterMin] = useState(3);
  const [expanded, setExpanded] = useState({ buy: false, sell: false, net: false });
  const [fullRanks, setFullRanks] = useState(false);
  const [summary, setSummary] = useState(null);
  const [summaryErr, setSummaryErr] = useState(null);
  const [summaryLoading, setSummaryLoading] = useState(true);
  const [offset, setOffset] = useState(0);
  const [items, setItems] = useState([]);
  const [page, setPage] = useState(null);
  const [err, setErr] = useState(null);
  const [loading, setLoading] = useState(false);
  const [feedOpen, setFeedOpen] = useState(Boolean(initialTicker));
  const [personKey, setPersonKey] = useState(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [status, setStatus] = useState(null);
  const [settings, setSettings] = useState(null);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshNote, setRefreshNote] = useState('');

  const filters = {
    q, ticker, office, party, side, filer, from, to, heldOnly: heldOnly ? '1' : '', offset, limit: 40,
  };

  useEffect(() => {
    let cancel = false;
    setSummaryLoading(true);
    setSummaryErr(null);
    const query = { window: windowDays, filer, clusterMin };
    if (fullRanks) query.limit = 'all';
    api.politicianSummary(query)
      .then((body) => { if (!cancel) setSummary(body); })
      .catch((e) => { if (!cancel) setSummaryErr(e.message); })
      .finally(() => { if (!cancel) setSummaryLoading(false); });
    return () => { cancel = true; };
  }, [windowDays, filer, clusterMin, fullRanks, reloadKey]);

  useEffect(() => {
    if (!feedOpen) return undefined;
    let cancel = false;
    setLoading(true);
    setErr(null);
    api.politicianTrades(filters)
      .then((body) => {
        if (cancel) return;
        setPage(body);
        setItems((prev) => (offset === 0 ? body.items : prev.concat(body.items)));
      })
      .catch((e) => { if (!cancel) setErr(e.message); })
      .finally(() => { if (!cancel) setLoading(false); });
    return () => { cancel = true; };
    // filters is a new object every render; the fields below are the real deps.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [feedOpen, q, ticker, office, party, side, filer, from, to, heldOnly, offset, reloadKey]);

  useEffect(() => {
    api.politicianStatus().then(setStatus).catch(() => {});
    api.politicianSettings().then(setSettings).catch(() => {});
  }, []);

  function resetAnd(setter) {
    return (value) => {
      setOffset(0);
      setItems([]);
      setter(value);
    };
  }

  function openTicker(symbol) {
    setOffset(0);
    setItems([]);
    setQ('');
    setTicker(symbol);
    setFeedOpen(true);
    requestAnimationFrame(() => {
      document.getElementById('ptr-feed')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  }

  async function saveSettings(patch) {
    const next = await api.savePoliticianSettings(patch);
    setSettings(next);
    setStatus((prev) => prev ? ({
      ...prev,
      alertsEnabled: next.politicianAlertsEnabled,
      heldOnly: next.politicianAlertsHeldOnly,
    }) : prev);
  }

  async function refresh() {
    setRefreshing(true);
    setRefreshNote('');
    try {
      await api.refreshPoliticianTrades();
      const deadline = Date.now() + 120000;
      let latest = null;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 800));
        latest = await api.politicianStatus();
        setStatus(latest);
        if (!latest.running) break;
      }
      setOffset(0);
      setItems([]);
      setReloadKey((n) => n + 1);
      const n = latest?.summary?.newTrades;
      if (latest?.running || latest?.backfillComplete === false) {
        setRefreshNote('Backfill is running in the background. It resumes after a restart and switches to a once-a-day check when the window is done.');
      } else {
        setRefreshNote(n == null ? 'Refresh finished.' : `Refresh finished. ${n} new parsed trade${n === 1 ? '' : 's'}.`);
      }
    } catch (e) {
      setRefreshNote(e.message);
    } finally {
      setRefreshing(false);
    }
  }

  function expandList(side) {
    setExpanded((prev) => ({ ...prev, [side]: true }));
    if (summary?.rankLimit != null) setFullRanks(true);
  }

  function collapseList(side) {
    setExpanded((prev) => ({ ...prev, [side]: false }));
  }

  if (personKey) {
    return (
      <div className="editor">
        <PersonView personKey={personKey} initialWindow={windowDays} onBack={() => setPersonKey(null)} />
      </div>
    );
  }

  return (
    <div className="editor">
      <header className="editor-bar">
        <button type="button" className="ed-cancel" onClick={onClose}>Done</button>
        <span className="ed-title">Politician trades</span>
        <button type="button" className="ed-save" disabled={refreshing} onClick={refresh}>
          {refreshing ? '…' : 'Refresh'}
        </button>
      </header>
      <div className="editor-body">
        <PoliticianSearch onPerson={setPersonKey} onTicker={openTicker} />
        <p className="ed-hint">
          Public stock trades from House members and House candidates, senators, the President, and the Vice President. House candidates stay in the feed and are labeled Candidate.
          Amounts stay the reported range. Scanned presidential filings are OCR’d one page at a time; a row that does not validate stays linked for review. An OCR label marks rows read from a scan.
        </p>
        <p className="ptr-note">Filers. This choice applies to the summary and the filings below.</p>
        <ChipRow label="Filer" options={FILERS} value={filer} onChange={resetAnd(setFiler)} />
        <PoliticianSummary
          summary={summary}
          loading={summaryLoading}
          error={summaryErr}
          windowDays={windowDays}
          onWindow={(days) => setWindowDays(days)}
          clusterMin={clusterMin}
          onClusterMin={(n) => setClusterMin(n)}
          onTicker={openTicker}
          onPerson={setPersonKey}
          expanded={expanded}
          onExpand={expandList}
          onCollapse={collapseList}
        />

        <button
          type="button"
          id="ptr-feed"
          className="ptr-feed-toggle"
          aria-expanded={feedOpen}
          onClick={() => setFeedOpen((open) => !open)}
        >
          <span>Filings</span>
          <span>{feedOpen ? 'Hide' : 'Show'}</span>
        </button>
        {feedOpen && (
          <>
            <label className="field"><span>Search name or ticker</span>
              <input value={q} onChange={(e) => { setOffset(0); setItems([]); setQ(e.target.value); }} placeholder="Pelosi or AAPL" />
            </label>
            {ticker && (
              <button type="button" className="ptr-held on" onClick={() => { setOffset(0); setItems([]); setTicker(''); }}>
                Filtered to {ticker}. Clear
              </button>
            )}
            <ChipRow label="Office" options={OFFICES} value={office} onChange={resetAnd(setOffice)} />
            <ChipRow label="Party" options={PARTIES} value={party} onChange={resetAnd(setParty)} />
            <ChipRow label="Transaction" options={SIDES} value={side} onChange={resetAnd(setSide)} />
            <div className="ptr-dates">
              <label className="field"><span>Disclosed from</span>
                <input type="date" value={from} onChange={(e) => { setOffset(0); setItems([]); setFrom(e.target.value); }} />
              </label>
              <label className="field"><span>Disclosed to</span>
                <input type="date" value={to} onChange={(e) => { setOffset(0); setItems([]); setTo(e.target.value); }} />
              </label>
            </div>
            <button type="button" className={`ptr-held${heldOnly ? ' on' : ''}`} aria-pressed={heldOnly}
              onClick={() => { setOffset(0); setItems([]); setHeldOnly((v) => !v); }}>
              {heldOnly ? 'Showing tickers in your models' : 'Show only tickers in your models'}
            </button>
            <div className="ed-section">Newest disclosed</div>
            {err && <div className="banner">{err}</div>}
            {loading && items.length === 0 && <p className="ed-hint">Loading…</p>}
            {!loading && items.length === 0 && (
              <p className="ed-hint">No filings match. Use Refresh to pull the House, Senate, and presidential reports.</p>
            )}
            {items.map((item) => <TradeCard key={`${item.kind}-${item.id}`} item={item} onPerson={setPersonKey} />)}
            {page?.hasMore && (
              <button type="button" className="rp-run alert-secondary" onClick={() => setOffset((n) => n + 40)}>Load more</button>
            )}
            {page?.total != null && items.length > 0 && (
              <p className="ed-hint">{page.total} matching filing{page.total === 1 ? '' : 's'}.</p>
            )}
          </>
        )}

        <div className="ed-section">Email</div>
        <div className="switch-row">
          <div>
            <div className="switch-label">Trade alerts {settings?.politicianAlertsEnabled === false ? 'off' : 'on'}</div>
            <p className="ed-hint">One digest per refresh, to the same address as price alerts. The first backfill does not email the history.</p>
          </div>
          <button type="button" role="switch" aria-label="Politician trade alerts"
            aria-checked={settings?.politicianAlertsEnabled !== false}
            className={`switch${settings?.politicianAlertsEnabled !== false ? ' on' : ''}`}
            onClick={() => saveSettings({ politicianAlertsEnabled: !(settings?.politicianAlertsEnabled !== false) }).catch((e) => setRefreshNote(e.message))}
          ><span /></button>
        </div>
        <div className="switch-row">
          <div>
            <div className="switch-label">Held tickers only</div>
            <p className="ed-hint">When on, the digest includes only trades in tickers your current models hold.</p>
          </div>
          <button type="button" role="switch" aria-label="Held tickers only"
            aria-checked={settings?.politicianAlertsHeldOnly === true}
            className={`switch${settings?.politicianAlertsHeldOnly ? ' on' : ''}`}
            onClick={() => saveSettings({ politicianAlertsHeldOnly: !settings?.politicianAlertsHeldOnly }).catch((e) => setRefreshNote(e.message))}
          ><span /></button>
        </div>
        {status?.lastRunAt && <p className="ed-hint">Last refresh {new Date(status.lastRunAt).toLocaleString('en-CA', { timeZone: 'America/Toronto' })}.</p>}
        {status?.summary?.digest?.reason && status.summary.digest.sent === false && status.alertsArmed === false && (
          <p className="ed-hint">Still walking the backfill window. Digests start after that finishes.</p>
        )}
        {refreshNote && <p className="ed-hint">{refreshNote}</p>}
      </div>
    </div>
  );
}
