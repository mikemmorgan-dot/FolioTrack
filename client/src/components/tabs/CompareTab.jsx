import { useEffect, useState } from 'react';
import { api, pct } from '../../api.js';
import { RISK_COLORS } from '../../App.jsx';
import { METRIC_DEFS } from '../../riskFormat.js';

function merLabel(mer) {
  if (mer == null) return '—';
  return pct(mer / 100, 2);
}

function riskLabel(rank) {
  return rank == null ? '—' : `${rank}`;
}

export default function CompareTab() {
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let live = true;
    setLoading(true);
    setErr(null);
    api.compare()
      .then((d) => { if (live) setData(d); })
      .catch((e) => { if (live) setErr(e.message); })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, []);

  if (loading) return <div className="loading">Comparing models…</div>;
  if (err) return <div className="banner">Couldn’t load compare — {err}</div>;
  if (!data?.models?.length) return <p className="note">No models to compare.</p>;

  const { models, universe, pairs } = data;
  const adjacent = pairs.filter((p) => p.adjacent);
  const sharedRows = universe.filter((r) => r.modelCount >= 2);
  const nameOf = Object.fromEntries(models.map((m) => [m.key, m.shortName || m.name]));

  return (
    <>
      <div className="compare-lead">
        <div className="section-title" style={{ marginTop: 4 }}>Compare</div>
        <p className="compare-dek">Current version of each model. Rank is its place on the Conservative → Aggressive ladder. Sharpe, volatility, and drawdown are computed below, on one shared date range.</p>
      </div>

      <div className="compare-cards">
        {models.map((m) => {
          const color = RISK_COLORS[m.riskRank];
          const merPartial = m.holdingCount > 0 && m.merKnownWeight < 1 && m.blendedMer != null;
          return (
            <article key={m.key} className="compare-card" style={{ '--risk': color }}>
              <div className="compare-card-top">
                <span className="dot" />
                <div>
                  <div className="compare-card-name">{m.name}</div>
                  <div className="compare-card-sub">
                    Rank {riskLabel(m.riskRank)}
                    {m.effectiveDate ? ` · ${m.effectiveDate}` : ' · no version'}
                  </div>
                </div>
              </div>
              <div className="compare-card-stats">
                <div>
                  <div className="k">Blended MER</div>
                  <div className="v num">{merLabel(m.blendedMer)}</div>
                  {merPartial && (
                    <div className="est">on {pct(m.merKnownWeight, 0)} of weight</div>
                  )}
                </div>
                <div>
                  <div className="k">Holdings</div>
                  <div className="v num">{m.holdingCount}</div>
                </div>
                <div>
                  <div className="k">Unique</div>
                  <div className="v num">{m.holdingCount ? pct(m.uniqueWeight, 0) : '—'}</div>
                </div>
                <div>
                  <div className="k">Shared</div>
                  <div className="v num">{m.holdingCount ? pct(m.sharedWeight, 0) : '—'}</div>
                </div>
              </div>
              {m.holdingCount > 0 && (
                <div className="compare-split" aria-hidden="true">
                  <span className="compare-split-shared" style={{ width: `${m.sharedWeight * 100}%` }} />
                  <span className="compare-split-unique" style={{ width: `${m.uniqueWeight * 100}%`, background: color }} />
                </div>
              )}
            </article>
          );
        })}
      </div>

      <RiskMetrics />

      <div className="section-title">Overlap</div>
      <p className="compare-note">Weight in common is Σ min(weight) on shared tickers — the sleeve that matches at the lesser weight. Unique is weight in tickers no other current model holds.</p>
      <div className="card">
        {adjacent.length === 0 && <div className="compare-empty">No pairs to compare.</div>}
        {adjacent.map((p) => (
          <div className="bar-row" key={`${p.a}-${p.b}`}>
            <span className="bar-label compare-pair-label">{nameOf[p.a]} ↔ {nameOf[p.b]}</span>
            <span className="bar-track">
              <span className="bar-fill" style={{ width: `${p.intersectionWeight * 100}%` }} />
            </span>
            <span className="bar-pct num">{pct(p.intersectionWeight, 0)}</span>
          </div>
        ))}
      </div>

      {sharedRows.length > 0 && (
        <>
          <div className="section-title">Shared tickers</div>
          <div className="rows grouped">
            <div className="row compare-shared-head">
              <div className="row-main muted">Ticker</div>
              <div className="compare-mini-w">
                {models.map((m) => (
                  <span key={m.key} style={{ color: RISK_COLORS[m.riskRank] }}>{m.shortName}</span>
                ))}
              </div>
            </div>
            {sharedRows.map((r) => (
              <div className="row" key={r.id}>
                <div className="row-main">
                  <div className="row-sym">{r.symbol}</div>
                  <div className="row-sub">in {r.modelCount} models · {r.name}</div>
                </div>
                <div className="row-right">
                  <div className="compare-mini-w">
                    {models.map((m) => {
                      const w = r.weights[m.key];
                      return (
                        <span key={m.key} className={`num${w ? '' : ' muted'}`}>
                          {w ? pct(w, 0) : '—'}
                        </span>
                      );
                    })}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </>
      )}

      <div className="section-title">Weights</div>
      <p className="compare-note">Same ticker on one row. Scroll sideways for every model.</p>
      <div className="compare-table-wrap">
        <table className="compare-table">
          <thead>
            <tr>
              <th className="sticky">Ticker</th>
              {models.map((m) => (
                <th key={m.key} style={{ color: RISK_COLORS[m.riskRank] }}>{m.shortName}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {universe.length === 0 && (
              <tr>
                <td className="sticky muted" colSpan={models.length + 1}>No holdings yet</td>
              </tr>
            )}
            {universe.map((r) => (
              <tr key={r.id}>
                <th className="sticky">
                  <div className="cmp-sym">{r.symbol}</div>
                  <div className="cmp-n muted">{r.modelCount} model{r.modelCount === 1 ? '' : 's'}</div>
                </th>
                {models.map((m) => {
                  const w = r.weights[m.key];
                  return (
                    <td key={m.key} className={`num${w ? '' : ' muted'}`}>
                      {w == null ? '—' : pct(w, 1)}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="note">Blended MER averages known fund MERs only (stocks and alts with no MER are left out of the average). Empty models have no current version.</p>
    </>
  );
}

const RISK_ROWS = [
  { key: 'annualizedReturn', label: 'Ann. return', sub: 'Geometric' },
  { key: 'volatility', label: 'Volatility', sub: 'Std dev' },
  { key: 'sharpe', label: 'Sharpe' },
  { key: 'sortino', label: 'Sortino' },
  { key: 'maxDrawdown', label: 'Max drawdown' },
  { key: 'beta', label: 'Beta', sub: 'Vs its benchmark' },
  { key: 'trackingError', label: 'Tracking error' },
  { key: 'informationRatio', label: 'Info ratio' },
];

const PERIOD_LABEL = { '1y': '1y', '3y': '3y', '5y': '5y', max: 'Max common' };
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function ymLabel(ym) {
  if (!ym || ym.length < 7) return '';
  return `${MONTHS[Number(ym.slice(5, 7)) - 1]} ${ym.slice(0, 4)}`;
}

function rankRow(models, key) {
  const good = METRIC_DEFS[key]?.good ?? 0;
  if (!good) return {};
  const vals = [];
  for (const m of models || []) {
    const v = m.metrics?.[key];
    if (v == null || !Number.isFinite(v)) continue;
    vals.push({ id: m.key, v });
  }
  if (vals.length < 2) return {};
  let best = vals[0].v;
  let worst = vals[0].v;
  for (const x of vals) {
    if ((good > 0 && x.v > best) || (good < 0 && x.v < best)) best = x.v;
    if ((good > 0 && x.v < worst) || (good < 0 && x.v > worst)) worst = x.v;
  }
  if (Math.abs(best - worst) < 1e-12) return {};
  const out = {};
  for (const x of vals) {
    if (Math.abs(x.v - best) < 1e-12) out[x.id] = 'best';
    else if (Math.abs(x.v - worst) < 1e-12) out[x.id] = 'worst';
  }
  return out;
}

function rankTitle(key, rank) {
  if (!rank) return '';
  if (key === 'maxDrawdown') return rank === 'best' ? 'Shallowest drawdown' : 'Deepest drawdown';
  if (key === 'volatility') return rank === 'best' ? 'Lowest volatility' : 'Highest volatility';
  const label = METRIC_DEFS[key]?.label || key;
  return rank === 'best' ? `Highest ${label}` : `Lowest ${label}`;
}

function leftOutTitle(leftOut) {
  if (!leftOut?.length) return '';
  return `Left out: ${leftOut.map((h) => `${h.symbol} ${pct(h.weight, 0)}`).join(', ')}`;
}

function RiskMetrics() {
  const [period, setPeriod] = useState(null);
  const [rf, setRf] = useState(4);
  const [rfQuery, setRfQuery] = useState(4);
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const t = setTimeout(() => setRfQuery(rf), 350);
    return () => clearTimeout(t);
  }, [rf]);

  useEffect(() => {
    let live = true;
    setLoading(true);
    setErr(null);
    api.compareRisk({ period, rf: rfQuery })
      .then((d) => { if (live) setData(d); })
      .catch((e) => { if (live) setErr(e.message); })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [period, rfQuery]);

  const models = data?.models || [];
  const ranks = Object.fromEntries(RISK_ROWS.map((row) => [row.key, rankRow(models, row.key)]));
  const active = data?.period;
  const periods = data?.availablePeriods || [];

  return (
    <>
      <div className="section-title">Risk metrics</div>
      <p className="compare-note">Same months for every model, using the current version’s weights. Scroll sideways. A dagger is a partial figure.</p>

      {periods.length > 0 && (
        <div className="segmented risk-periods" role="group" aria-label="Risk period">
          {periods.map((p) => (
            <button
              key={p}
              type="button"
              className={active === p ? 'seg active' : 'seg'}
              aria-pressed={active === p}
              onClick={() => setPeriod(p)}
            >
              {PERIOD_LABEL[p] || p}
            </button>
          ))}
        </div>
      )}

      {data?.range && (
        <p className="risk-range">
          {data.period === 'max'
            ? `Max common starts ${ymLabel(data.range.start)} to ${ymLabel(data.range.end)} · ${data.range.months} month${data.range.months === 1 ? '' : 's'}`
            : `${ymLabel(data.range.start)} to ${ymLabel(data.range.end)} · ${data.range.months} month${data.range.months === 1 ? '' : 's'}${data.common?.start ? ` · Max common starts ${ymLabel(data.common.start)}` : ''}`}
        </p>
      )}
      {data?.staleEnd && data?.range && (
        <p className="compare-note">Ends {ymLabel(data.range.end)}. Later months are not in every model's cached history.</p>
      )}
      {data?.unavailableReason && !data.period && (
        <p className="compare-note">{data.unavailableReason}</p>
      )}

      <div className="rf-bar risk-rf">
        <span>Risk-free rate</span>
        <div className="rf-input">
          <input
            type="number"
            inputMode="decimal"
            step="0.25"
            aria-label="Risk-free rate"
            value={rf}
            onChange={(e) => setRf(e.target.value === '' ? 0 : Number(e.target.value))}
          />
          <span>%</span>
        </div>
        <span className="muted rf-hint">Sharpe and Sortino use this</span>
      </div>

      {loading && !data && <div className="loading risk-loading">Computing risk…</div>}
      {err && <div className="banner">Couldn’t compute risk. {err}</div>}

      {data?.period && models.length > 0 && (
        <div className={`compare-table-wrap${loading ? ' is-loading' : ''}`} aria-busy={loading}>
          <table className="compare-table risk-table">
            <caption className="sr">Risk metrics by model for {active === 'max' ? 'Max common' : active}</caption>
            <thead>
              <tr>
                <th className="sticky">Metric</th>
                {models.map((m) => (
                  <th key={m.key} className="model-col" style={{ color: RISK_COLORS[m.riskRank], '--risk': RISK_COLORS[m.riskRank] }}>
                    {m.shortName}
                    {m.partial && m.coverage != null && (
                      <div className="cmp-partial">on {pct(m.coverage, 0)}</div>
                    )}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {RISK_ROWS.map((row) => (
                <tr key={row.key}>
                  <th className="sticky">
                    <div>{row.label}</div>
                    {row.sub && <div className="cmp-n muted">{row.sub}</div>}
                  </th>
                  {models.map((m) => {
                    const value = m.metrics?.[row.key];
                    const reason = m.metricReasons?.[row.key] || (value == null ? m.reason : null);
                    const rank = ranks[row.key]?.[m.key];
                    const title = [rankTitle(row.key, rank), m.partial && value != null ? 'Partial. Weight without a full monthly series is left out' : '', value == null ? reason : '']
                      .filter(Boolean).join('. ');
                    return (
                      <td key={m.key} className={rank || (value == null ? 'muted' : '')} title={title || undefined}>
                        {value == null ? (
                          <>
                            <div>—</div>
                            {reason && <div className="cmp-why">{reason}</div>}
                          </>
                        ) : (
                          <div className={`num${METRIC_DEFS[row.key].good && value < 0 && row.key !== 'maxDrawdown' && row.key !== 'volatility' ? ' neg' : ''}${METRIC_DEFS[row.key].good > 0 && value > 0 && row.key !== 'maxDrawdown' ? ' pos' : ''}`}>
                            {METRIC_DEFS[row.key].fmt(value)}
                            {m.partial && <span className="cmp-dagger" aria-label="partial">†</span>}
                          </div>
                        )}
                      </td>
                    );
                  })}
                </tr>
              ))}
              <tr>
                <th className="sticky">
                  <div>Full history</div>
                  <div className="cmp-n muted">of weight</div>
                </th>
                {models.map((m) => (
                  <td key={m.key} className={m.coverage == null ? 'muted' : ''} title={leftOutTitle(m.leftOut) || undefined}>
                    {m.coverage == null ? (
                      <>
                        <div>—</div>
                        {m.reason && <div className="cmp-why">{m.reason}</div>}
                      </>
                    ) : (
                      <>
                        <div className="num">{pct(m.coverage, 0)}</div>
                        {m.partial && <div className="cmp-partial">partial</div>}
                      </>
                    )}
                  </td>
                ))}
              </tr>
              <tr>
                <th className="sticky">
                  <div>Benchmark</div>
                </th>
                {models.map((m) => (
                  <td key={m.key} className={`bench${m.benchmarkLabel ? '' : ' muted'}`}>
                    {m.benchmarkLabel || '—'}
                    {!m.benchmarkLabel && m.reason && <div className="cmp-why">{m.metricReasons?.beta || 'No benchmark'}</div>}
                  </td>
                ))}
              </tr>
            </tbody>
          </table>
        </div>
      )}

      <p className="note">
        Each column holds that model's current weights flat over the months above. Max common starts at the latest month where every priced holding and the benchmark already have a close. A dagger means the figure uses only the weight with its own month-end price in every one of those months. A manual fund, a private holding, cash, or a listed name with no cached months is left out and the rest is reweighted, the same way blended MER skips a holding with no MER. A dash is a missing input, not a zero. The underline marks the best and worst figure in that row. Beta, tracking error, and info ratio use that model's own benchmark. Prices are the month-end closes already in the cache. This screen does not call a quote provider.
      </p>
    </>
  );
}
