const METRICS = [
  { k: 'Volatility', d: 'Annualized std. dev.' },
  { k: 'Beta', d: 'vs blended benchmark' },
  { k: 'Max drawdown', d: 'Peak-to-trough' },
  { k: 'Sharpe', d: 'Return per unit risk' },
  { k: 'Tracking error', d: 'Model − benchmark' },
  { k: 'Downside capture', d: 'In falling markets' },
];

export default function RiskTab({ model }) {
  return (
    <>
      <div className="section-title">Risk metrics</div>
      <div className="metric-grid">
        {METRICS.map((m) => (
          <div className="metric" key={m.k}>
            <div className="k">{m.k}</div>
            <div className="v muted">—</div>
            <div className="d">{m.d}</div>
          </div>
        ))}
      </div>
      <p className="note">Populated once the return engine is live — every metric derives from the same model return series that drives Performance, computed against {model.name}’s blended benchmark.</p>
    </>
  );
}
