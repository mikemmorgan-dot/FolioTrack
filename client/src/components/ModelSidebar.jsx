import { RISK_COLORS } from '../App.jsx';

export default function ModelSidebar({ models, selected, onSelect }) {
  return (
    <aside className="sidebar">
      <div className="brand">
        <span className="brand-mark" />
        <div>
          <div className="brand-name">Model Portfolios</div>
          <div className="brand-sub">risk spectrum</div>
        </div>
      </div>

      <nav className="model-list">
        {models.map((m) => {
          const color = RISK_COLORS[m.riskRank];
          const active = m.key === selected;
          return (
            <button
              key={m.key}
              className={`model-item${active ? ' active' : ''}`}
              onClick={() => onSelect(m.key)}
              style={{ '--risk': color }}
            >
              <span className="risk-rail" />
              <span className="model-item-body">
                <span className="model-name">{m.name}</span>
                <span className="model-meta">
                  {m.holdingCount > 0
                    ? <>{m.holdingCount} holdings · as of {m.currentEffectiveDate}</>
                    : <span className="muted">no holdings yet</span>}
                </span>
              </span>
              <span className="risk-rank" style={{ color }}>{m.riskRank}</span>
            </button>
          );
        })}
      </nav>

      <div className="spectrum-legend">
        <span>Lower risk</span>
        <span className="spectrum-bar" />
        <span>Higher</span>
      </div>
    </aside>
  );
}
