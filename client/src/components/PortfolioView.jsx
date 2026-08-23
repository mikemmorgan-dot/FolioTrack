import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { RISK_COLORS } from '../App.jsx';
import OverviewTab from './tabs/OverviewTab.jsx';
import PerformanceTab from './tabs/PerformanceTab.jsx';
import RiskTab from './tabs/RiskTab.jsx';
import HoldingsTab from './tabs/HoldingsTab.jsx';
import GeoSectorTab from './tabs/GeoSectorTab.jsx';
import AllocationTab from './tabs/AllocationTab.jsx';

const TABS = [
  { id: 'overview', label: 'Overview', C: OverviewTab },
  { id: 'performance', label: 'Performance', C: PerformanceTab },
  { id: 'risk', label: 'Risk', C: RiskTab },
  { id: 'holdings', label: 'Holdings', C: HoldingsTab },
  { id: 'geosector', label: 'Geo / Sector', C: GeoSectorTab },
  { id: 'allocation', label: 'Allocation', C: AllocationTab },
];

export default function PortfolioView({ modelKey, riskRank }) {
  const [model, setModel] = useState(null);
  const [tab, setTab] = useState('overview');
  const [err, setErr] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true); setErr(null);
    api.model(modelKey)
      .then(setModel)
      .catch((e) => setErr(e.message))
      .finally(() => setLoading(false));
  }, [modelKey]);

  const color = RISK_COLORS[riskRank] || '#0B6B63';
  const Active = TABS.find((t) => t.id === tab).C;

  return (
    <div className="portfolio" style={{ '--risk': color }}>
      <header className="pf-header">
        <div>
          <div className="pf-eyebrow">Model portfolio</div>
          <h1 className="pf-title">{model?.name || '…'}</h1>
        </div>
        {model?.currentVersion && (
          <div className="pf-version">
            <span className="tag">v{model.versions.length}</span>
            effective {model.currentVersion.effectiveDate}
            {model.currentVersion.note && <span className="pf-note">· {model.currentVersion.note}</span>}
          </div>
        )}
      </header>

      <nav className="tabbar" role="tablist">
        {TABS.map((t) => (
          <button key={t.id} role="tab" aria-selected={tab === t.id}
            className={`tab${tab === t.id ? ' active' : ''}`} onClick={() => setTab(t.id)}>
            {t.label}
          </button>
        ))}
      </nav>

      <section className="tab-panel">
        {err && <div className="banner error">Couldn’t load this model — {err}</div>}
        {loading && <div className="empty">Loading…</div>}
        {!loading && model && <Active model={model} goto={setTab} />}
      </section>
    </div>
  );
}
