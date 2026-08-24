import { useEffect, useState } from 'react';
import { api } from './api.js';
import Hero from './components/Hero.jsx';
import { IconMenu, IconSearch, IconOverview, IconPerf, IconRisk, IconHoldings, IconGeo, IconMix } from './components/icons.jsx';
import OverviewTab from './components/tabs/OverviewTab.jsx';
import PerformanceTab from './components/tabs/PerformanceTab.jsx';
import RiskTab from './components/tabs/RiskTab.jsx';
import HoldingsTab from './components/tabs/HoldingsTab.jsx';
import GeoSectorTab from './components/tabs/GeoSectorTab.jsx';
import AllocationTab from './components/tabs/AllocationTab.jsx';

export const RISK_COLORS = { 1: '#4FC3F7', 2: '#35C9A8', 3: '#E5C044', 4: '#F0913E', 5: '#F0655B' };
export const RISK_LABELS = { 1: 'Conservative', 2: 'Balanced', 3: 'Balanced Growth', 4: 'Growth', 5: 'Aggressive' };

const VIEWS = [
  { id: 'overview', label: 'Overview', Icon: IconOverview, C: OverviewTab },
  { id: 'performance', label: 'Perf', Icon: IconPerf, C: PerformanceTab },
  { id: 'risk', label: 'Risk', Icon: IconRisk, C: RiskTab },
  { id: 'holdings', label: 'Holdings', Icon: IconHoldings, C: HoldingsTab },
  { id: 'geosector', label: 'Geo', Icon: IconGeo, C: GeoSectorTab },
  { id: 'allocation', label: 'Mix', Icon: IconMix, C: AllocationTab },
];

export default function App() {
  const [models, setModels] = useState([]);
  const [selected, setSelected] = useState(null);
  const [model, setModel] = useState(null);
  const [view, setView] = useState('overview');
  const [err, setErr] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.models()
      .then((m) => { setModels(m); setSelected((s) => s || m[0]?.key || null); })
      .catch((e) => setErr(e.message));
  }, []);

  useEffect(() => {
    if (!selected) return;
    setLoading(true);
    api.model(selected).then(setModel).catch((e) => setErr(e.message)).finally(() => setLoading(false));
  }, [selected]);

  const riskRank = models.find((m) => m.key === selected)?.riskRank;
  const Active = VIEWS.find((v) => v.id === view).C;

  return (
    <div className="app">
      <header className="topbar">
        <button className="icon-btn" aria-label="Menu"><IconMenu /></button>
        <h1>Model Portfolios</h1>
        <button className="icon-btn" aria-label="Search"><IconSearch /></button>
      </header>

      <nav className="model-pills" aria-label="Select model">
        {models.map((m) => (
          <button
            key={m.key}
            className={`model-pill${m.key === selected ? ' active' : ''}`}
            style={{ '--pill-c': RISK_COLORS[m.riskRank] }}
            onClick={() => setSelected(m.key)}
          >
            <span className="dot" />{m.name}
          </button>
        ))}
      </nav>

      {err && <div className="banner">Couldn’t load — {err}</div>}
      {loading && !model && <div className="loading">Loading…</div>}

      {model && (
        <>
          <Hero model={model} riskRank={riskRank} />
          <div className="content">
            <Active model={model} goto={setView} riskRank={riskRank} />
          </div>
        </>
      )}

      <nav className="bottom-nav" aria-label="Views">
        {VIEWS.map((v) => {
          const active = v.id === view;
          return (
            <button key={v.id} className={`nav-btn${active ? ' active' : ''}`} onClick={() => setView(v.id)} aria-current={active}>
              <v.Icon />
              <span>{v.label}</span>
            </button>
          );
        })}
      </nav>
    </div>
  );
}
