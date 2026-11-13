import { useEffect, useState } from 'react';
import { api } from '../api.js';

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
        <div className="ptr-meta">{officeName(item.office)}{party ? ` · ${party}` : ''}</div>
        <div className="ptr-tags">
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
        {officeName(item.office)}{party ? ` · ${party}` : ''}{item.state ? ` · ${item.state}` : ''}
      </div>
      <div className="ptr-line">
        <span className="ptr-side">{item.ticker || 'No ticker'}</span>
        <span className="ptr-side-label">{sideName(item)}</span>
      </div>
      <div className="ptr-tags">
        {held.length > 0 && <span className="pill green">In your models</span>}
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

function PersonView({ personKey, onBack }) {
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const [offset, setOffset] = useState(0);
  const [items, setItems] = useState([]);

  useEffect(() => {
    let cancel = false;
    setErr(null);
    api.politician(personKey, { offset, limit: 40 })
      .then((body) => {
        if (cancel) return;
        setData(body);
        setItems((prev) => (offset === 0 ? body.items : prev.concat(body.items)));
      })
      .catch((e) => { if (!cancel) setErr(e.message); });
    return () => { cancel = true; };
  }, [personKey, offset]);

  const person = data?.person;
  const party = partyName(person?.party);
  return (
    <>
      <header className="editor-bar">
        <button type="button" className="ed-cancel" onClick={onBack}>Back</button>
        <span className="ed-title">{person?.personName || 'Filer'}</span>
        <span />
      </header>
      <div className="editor-body">
        {err && <div className="banner">{err}</div>}
        {person && (
          <>
            <p className="ed-hint">
              {officeName(person.office)}{party ? ` · ${party}` : ''}{person.state ? ` · ${person.state}` : ''}
            </p>
            <div className="ptr-stats">
              <div><span className="ptr-stat-n">{data.counts?.buy ?? 0}</span><span>Buys</span></div>
              <div><span className="ptr-stat-n">{data.counts?.sell ?? 0}</span><span>Sells</span></div>
              <div><span className="ptr-stat-n">{data.counts?.exchange ?? 0}</span><span>Exchanges</span></div>
            </div>
            {(data.topTickers || []).length > 0 && (
              <>
                <div className="ed-section">Most traded</div>
                <div className="ptr-top">
                  {data.topTickers.map((row) => (
                    <span key={row.ticker} className="pill neutral">{row.ticker} · {row.count}</span>
                  ))}
                </div>
              </>
            )}
          </>
        )}
        <div className="ed-section">Trades</div>
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
  const [office, setOffice] = useState('');
  const [party, setParty] = useState('');
  const [side, setSide] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [heldOnly, setHeldOnly] = useState(false);
  const [offset, setOffset] = useState(0);
  const [items, setItems] = useState([]);
  const [page, setPage] = useState(null);
  const [err, setErr] = useState(null);
  const [loading, setLoading] = useState(true);
  const [personKey, setPersonKey] = useState(null);
  const [status, setStatus] = useState(null);
  const [settings, setSettings] = useState(null);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshNote, setRefreshNote] = useState('');

  const filters = { q, office, party, side, from, to, heldOnly: heldOnly ? '1' : '', offset, limit: 40 };

  useEffect(() => {
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
  }, [q, office, party, side, from, to, heldOnly, offset]);

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
      const body = await api.politicianTrades({ ...filters, offset: 0 });
      setPage(body);
      setItems(body.items);
      const n = latest?.summary?.newTrades;
      setRefreshNote(n == null ? 'Refresh finished.' : `Refresh finished. ${n} new parsed trade${n === 1 ? '' : 's'}.`);
    } catch (e) {
      setRefreshNote(e.message);
    } finally {
      setRefreshing(false);
    }
  }

  if (personKey) {
    return (
      <div className="editor">
        <PersonView personKey={personKey} onBack={() => setPersonKey(null)} />
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
        <p className="ed-hint">
          Public stock trades from the House Clerk, Senate eFD, and presidential OGE 278-T reports.
          Amounts stay the reported range. A filing that cannot be read is linked and marked for review.
        </p>
        <label className="field"><span>Search name or ticker</span>
          <input value={q} onChange={(e) => { setOffset(0); setItems([]); setQ(e.target.value); }} placeholder="Pelosi or AAPL" />
        </label>
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
      </div>
    </div>
  );
}
