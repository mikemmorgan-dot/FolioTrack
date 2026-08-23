const METRICS = [
  { k: 'Volatility', d: 'Annualized std. dev. of model returns' },
  { k: 'Beta', d: 'Sensitivity to the blended benchmark' },
  { k: 'Max drawdown', d: 'Largest peak-to-trough decline' },
  { k: 'Sharpe', d: 'Excess return per unit of risk' },
  { k: 'Tracking error', d: 'Std. dev. of model − benchmark' },
  { k: 'Downside capture', d: 'Behaviour in falling markets' },
];

export default function RiskTab({ model }) {
  return (
    <div className="risk">
      <div className="stat-row">
        {METRICS.map((m) => (
          <div className="stat pending" key={m.k}>
            <div className="stat-label">{m.k}</div>
            <div className="stat-value mono muted">—</div>
            <div className="stat-sub">{m.d}</div>
          </div>
        ))}
      </div>
      <p className="footnote">
        Populated once the return engine is live — every metric here derives from the same
        model return series that drives the Performance view, computed against {model.name}’s blended benchmark.
      </p>
    </div>
  );
}
