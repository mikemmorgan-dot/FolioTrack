// risk.js — pure risk & risk-adjusted-return metrics from a monthly return series.
// All functions are deterministic and network-free so they can be unit-tested.

const PPY = 12; // periods per year (monthly)

const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);
const sampleStd = (a) => {
  if (a.length < 2) return 0;
  const m = mean(a);
  return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1));
};
const geomAnnualReturn = (rets) => {
  if (!rets.length) return 0;
  const growth = rets.reduce((acc, r) => acc * (1 + r), 1);
  return Math.pow(growth, PPY / rets.length) - 1;
};
const rfMonthlyFrom = (rfAnnual) => Math.pow(1 + rfAnnual, 1 / PPY) - 1;

function maxDrawdown(rets) {
  let lvl = 1, peak = 1, mdd = 0;
  for (const r of rets) {
    lvl *= 1 + r;
    if (lvl > peak) peak = lvl;
    const dd = lvl / peak - 1;
    if (dd < mdd) mdd = dd;
  }
  return mdd; // <= 0
}

// covariance/variance (sample) over aligned arrays
function cov(x, y) {
  const n = x.length;
  if (n < 2) return 0;
  const mx = mean(x), my = mean(y);
  let s = 0;
  for (let i = 0; i < n; i++) s += (x[i] - mx) * (y[i] - my);
  return s / (n - 1);
}

export function riskMetrics(modelRets, benchRets, rfAnnual = 0.04) {
  const n = modelRets.length;
  const rfM = rfMonthlyFrom(rfAnnual);

  const annRet = geomAnnualReturn(modelRets);
  const annVol = sampleStd(modelRets) * Math.sqrt(PPY);

  // downside deviation vs risk-free MAR
  const downs = modelRets.map((r) => Math.min(0, r - rfM));
  const downsideDev = Math.sqrt(mean(downs.map((d) => d * d))) * Math.sqrt(PPY);

  // Sharpe is naturally guarded by annVol>0, since sampleStd returns 0 for
  // n<2 — but downsideDev has no such floor (it's a mean of squared downside
  // deviations, well-defined even from a single observation), so sortino
  // needs its own n>=2 guard. Without it, a single monthly return can
  // produce a specific-looking Sortino number while Sharpe correctly shows
  // "no data" for the exact same insufficient sample.
  const sharpe = annVol > 0 ? (annRet - rfAnnual) / annVol : null;
  const sortino = n >= 2 && downsideDev > 0 ? (annRet - rfAnnual) / downsideDev : null;
  const mdd = maxDrawdown(modelRets);

  const out = {
    n,
    annualizedReturn: annRet,
    volatility: annVol,
    downsideDeviation: downsideDev,
    sharpe,
    sortino,
    maxDrawdown: mdd,
    // benchmark-relative (filled below if benchmark available)
    beta: null, alpha: null, correlation: null,
    trackingError: null, informationRatio: null,
    upCapture: null, downCapture: null,
    benchAnnualizedReturn: null, activeReturn: null,
  };

  // align to months where both model & benchmark exist
  const m = [], b = [];
  for (let i = 0; i < n; i++) {
    if (benchRets[i] != null) { m.push(modelRets[i]); b.push(benchRets[i]); }
  }
  if (m.length >= 2) {
    const varB = cov(b, b);
    const beta = varB > 0 ? cov(m, b) / varB : null;
    const stdM = sampleStd(m), stdB = sampleStd(b);
    const corr = stdM > 0 && stdB > 0 ? cov(m, b) / (stdM * stdB) : null;

    const annM = geomAnnualReturn(m), annB = geomAnnualReturn(b);
    const active = m.map((x, i) => x - b[i]);
    const te = sampleStd(active) * Math.sqrt(PPY);
    const activeAnn = annM - annB;
    const ir = te > 0 ? activeAnn / te : null;

    // CAPM alpha (annualized, arithmetic)
    const alphaMonthly = mean(m) - (rfM + (beta ?? 0) * (mean(b) - rfM));
    const alphaAnn = alphaMonthly * PPY;

    // capture ratios (cumulative, over up/down benchmark months)
    const cumIn = (arr, pick) => arr.reduce((acc, _, i) => (pick(b[i]) ? acc * (1 + arr[i]) : acc), 1) - 1;
    const upM = cumIn(m, (x) => x > 0), upB = cumIn(b, (x) => x > 0);
    const dnM = cumIn(m, (x) => x < 0), dnB = cumIn(b, (x) => x < 0);

    Object.assign(out, {
      beta,
      alpha: alphaAnn,
      correlation: corr,
      trackingError: te,
      informationRatio: ir,
      benchAnnualizedReturn: annB,
      activeReturn: activeAnn,
      upCapture: upB !== 0 ? upM / upB : null,
      downCapture: dnB !== 0 ? dnM / dnB : null,
    });
  }
  return out;
}

// Monthly return series for a FIXED set of weights held across the grid,
// renormalized each month to the holdings with data. Returns { months, rets, coverageMin }.
export function staticPortfolioMonthly(holdings, instReturnsByRef, grid) {
  const totalW = holdings.reduce((s, h) => s + h.weight, 0) || 1;
  const months = [], rets = [];
  let coverageMin = 1;
  for (let i = 1; i < grid.length; i++) {
    const ym = grid[i];
    let num = 0, wsum = 0;
    for (const h of holdings) {
      const r = instReturnsByRef[h.ref]?.[ym];
      if (r == null) continue;
      num += h.weight * r; wsum += h.weight;
    }
    if (wsum > 0) {
      months.push(ym);
      rets.push(num / wsum);
      coverageMin = Math.min(coverageMin, wsum / totalW);
    }
  }
  return { months, rets, coverageMin };
}
