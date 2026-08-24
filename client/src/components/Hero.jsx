import { pct, aggregateBy, typeColor, typeLabel, blendedMer } from '../api.js';
import { RISK_COLORS, RISK_LABELS } from '../App.jsx';

export default function Hero({ model, riskRank }) {
  const color = RISK_COLORS[riskRank];
  const h = model.holdings;

  if (!h.length) {
    return (
      <div className="hero">
        <div className="hero-name"><span className="dot" style={{ background: color }} />{RISK_LABELS[riskRank]}</div>
        <div className="hero-figure">{model.name}</div>
        <div className="hero-caption">No holdings yet</div>
      </div>
    );
  }

  const byType = aggregateBy(h, 'type');
  const fixed = h.filter((x) => x.sector === 'Fixed Income').reduce((s, x) => s + x.weight, 0);
  const growth = 1 - fixed;
  const mer = blendedMer(h);

  return (
    <div className="hero" style={{ '--risk': color }}>
      <div className="hero-name"><span className="dot" />{model.name} model</div>
      <div className="hero-figure num">{pct(growth, 0)}<span className="unit">growth</span></div>
      <div className="hero-caption">{pct(fixed, 0)} fixed income · per $10,000 modelled</div>

      <div className="alloc-bar">
        {byType.map((t) => (
          <span key={t.label} style={{ width: `${t.weight * 100}%`, background: typeColor(t.label) }} />
        ))}
      </div>
      <div className="alloc-legend">
        {byType.map((t) => (
          <span className="leg" key={t.label}>
            <span className="swatch" style={{ background: typeColor(t.label) }} />
            {typeLabel(t.label)} <b className="num">{pct(t.weight, 0)}</b>
          </span>
        ))}
      </div>

      <div className="stat-strip">
        <div className="stat-chip"><div className="k">Holdings</div><div className="v num">{h.length}</div></div>
        <div className="stat-chip"><div className="k">Blended MER</div><div className="v num">{mer == null ? '—' : pct(mer / 100, 2)}</div></div>
        <div className="stat-chip"><div className="k">Version</div><div className="v num">v{model.versions.length}</div></div>
        <div className="stat-chip"><div className="k">Effective</div><div className="v num" style={{ fontSize: 15 }}>{model.currentVersion?.effectiveDate}</div></div>
      </div>
    </div>
  );
}
