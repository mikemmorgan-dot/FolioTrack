import { useEffect, useState } from 'react';
import { api } from './api.js';
import ModelSidebar from './components/ModelSidebar.jsx';
import PortfolioView from './components/PortfolioView.jsx';

// The signature: a single risk spectrum drives model color from calm → hot.
export const RISK_COLORS = {
  1: '#2E7D8A', // conservative
  2: '#3E9B86', // balanced
  3: '#C9A227', // balanced growth
  4: '#D0803E', // growth
  5: '#B4453A', // aggressive growth
};

export default function App() {
  const [models, setModels] = useState([]);
  const [selected, setSelected] = useState(null);
  const [err, setErr] = useState(null);

  useEffect(() => {
    api.models()
      .then((m) => { setModels(m); setSelected((s) => s || m[0]?.key || null); })
      .catch((e) => setErr(e.message));
  }, []);

  return (
    <div className="app">
      <ModelSidebar models={models} selected={selected} onSelect={setSelected} />
      <main className="main">
        {err && <div className="banner error">Couldn’t load models — {err}</div>}
        {selected ? (
          <PortfolioView key={selected} modelKey={selected} riskRank={models.find((m) => m.key === selected)?.riskRank} />
        ) : (
          !err && <div className="empty">Loading models…</div>
        )}
      </main>
    </div>
  );
}
