// LineChart.jsx — minimal dependency-free SVG line chart for two series.
export default function LineChart({ model = [], benchmark = [], height = 180 }) {
  const W = 340, H = height, padX = 6, padTop = 10, padBot = 18;
  const pts = model.length;
  if (pts < 2) return <div className="chart-empty">Not enough history yet to chart.</div>;

  const allVals = [...model.map((p) => p.value), ...benchmark.map((p) => p.value)];
  let min = Math.min(...allVals), max = Math.max(...allVals);
  if (min === max) { min -= 1; max += 1; }
  const pad = (max - min) * 0.08; min -= pad; max += pad;

  const x = (i, n) => padX + (i / (n - 1)) * (W - padX * 2);
  const y = (v) => padTop + (1 - (v - min) / (max - min)) * (H - padTop - padBot);
  const path = (arr) => arr.map((p, i) => `${i ? 'L' : 'M'}${x(i, arr.length).toFixed(1)},${y(p.value).toFixed(1)}`).join(' ');

  const base = model[0].value; // $10k baseline
  const baseY = y(base);
  const up = model[model.length - 1].value >= base;

  return (
    <svg className="linechart" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label="Growth chart">
      <line x1={padX} y1={baseY} x2={W - padX} y2={baseY} stroke="var(--text-3)" strokeDasharray="2 4" strokeWidth="1" opacity="0.5" />
      {benchmark.length >= 2 && (
        <path d={path(benchmark)} fill="none" stroke="var(--text-2)" strokeWidth="1.6" opacity="0.55" strokeLinejoin="round" />
      )}
      <path d={path(model)} fill="none" stroke={up ? 'var(--green)' : 'var(--red)'} strokeWidth="2.4" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}
