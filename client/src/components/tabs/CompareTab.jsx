import { useEffect, useState } from 'react';
import { api, pct } from '../../api.js';
import { RISK_COLORS } from '../../App.jsx';

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
        <p className="compare-dek">Current version of each model. Risk is the model’s rank on the Conservative → Aggressive ladder — not a computed Sharpe.</p>
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
