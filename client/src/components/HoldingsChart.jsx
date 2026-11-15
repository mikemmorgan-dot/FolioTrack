import { useState } from 'react';

const COLORS = [
  '#2be38a', '#5aa7ff', '#ffb020', '#ff5a63', '#c084fc',
  '#22d3ee', '#f472b6', '#a3e635', '#fb923c', '#818cf8',
  '#f9a8d4', '#34d399', '#94a3b8',
];

const CLASS_LABELS = {
  stock: 'Stock',
  etf_fund: 'ETF / fund',
  bond: 'Bond / muni',
  real_estate: 'Real estate',
  private: 'Private business',
  cash: 'Cash / bank',
  retirement: 'Retirement account',
  crypto: 'Crypto',
  other: 'Other',
};

function ownerName(owner) {
  if (owner === 'self') return 'Self';
  if (owner === 'spouse') return 'Spouse';
  if (owner === 'joint') return 'Joint';
  if (owner === 'dependent') return 'Dependent';
  return 'Owner not stated';
}

function pretty(iso) {
  if (!iso) return null;
  const [y, m, d] = String(iso).slice(0, 10).split('-').map(Number);
  if (!y || !m || !d) return null;
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC',
  });
}

function money(value) {
  if (value == null || !Number.isFinite(Number(value))) return null;
  return `$${Math.round(Number(value)).toLocaleString('en-US')}`;
}

function polar(cx, cy, r, angle) {
  return [cx + r * Math.cos(angle), cy + r * Math.sin(angle)];
}

function slicePath(cx, cy, r0, r1, a0, a1) {
  const large = a1 - a0 > Math.PI ? 1 : 0;
  const [x0, y0] = polar(cx, cy, r1, a0);
  const [x1, y1] = polar(cx, cy, r1, a1);
  const [x2, y2] = polar(cx, cy, r0, a1);
  const [x3, y3] = polar(cx, cy, r0, a0);
  return `M ${x0} ${y0} A ${r1} ${r1} 0 ${large} 1 ${x1} ${y1} L ${x2} ${y2} A ${r0} ${r0} 0 ${large} 0 ${x3} ${y3} Z`;
}

function Donut({ slices, selected, onSelect }) {
  const cx = 100;
  const cy = 100;
  const r1 = 78;
  const r0 = 48;
  let angle = -Math.PI / 2;
  const paths = slices.map((slice, index) => {
    const span = Math.max((Number(slice.pct) || 0) / 100, 0) * Math.PI * 2;
    const start = angle;
    const end = start + Math.min(span, Math.PI * 2 - 0.0001);
    angle = start + span;
    const color = COLORS[index % COLORS.length];
    return { slice, index, d: span > 0.0001 ? slicePath(cx, cy, r0, r1, start, end) : null, color };
  });
  const only = slices.length === 1 && (slices[0].pct || 0) >= 99.5;
  return (
    <svg className="hold-donut" viewBox="0 0 200 200" role="img" aria-label="Holdings chart">
      {only ? (
        <circle
          cx={cx}
          cy={cy}
          r={(r0 + r1) / 2}
          fill="none"
          stroke={selected === 0 ? '#fff' : COLORS[0]}
          strokeWidth={r1 - r0}
          className={selected === 0 ? 'on' : ''}
          onClick={() => onSelect(0)}
        />
      ) : paths.map((path) => path.d && (
        <path
          key={path.slice.id || path.index}
          d={path.d}
          fill={path.color}
          className={selected === path.index ? 'on' : ''}
          onClick={() => onSelect(path.index)}
        />
      ))}
      <circle cx={cx} cy={cy} r={r0 - 1} fill="#000" />
    </svg>
  );
}

function Detail({ slice, color }) {
  if (!slice) return null;
  const held = slice.heldModels || [];
  const range = slice.valueBound === 'at_least'
    ? `At least ${money(slice.min)}`
    : (slice.valueRange || (slice.max == null ? `At least ${money(slice.min)}` : `${money(slice.min)} – ${money(slice.max)}`));
  return (
    <div className="hold-detail">
      <div className="hold-detail-top">
        <span className="hold-swatch" style={{ background: color }} />
        <strong>{slice.asset || slice.label}</strong>
      </div>
      <div className="ptr-meta">
        {slice.ticker ? slice.ticker : 'No ticker'}
        {slice.tickerSource === 'name_match' ? ' · matched from name' : ''}
        {slice.assetClass ? ` · ${CLASS_LABELS[slice.assetClass] || slice.assetClass}` : ''}
      </div>
      {slice.owner && <div className="ptr-meta">{ownerName(slice.owner)}</div>}
      <div className="ptr-meta">{range} · about {slice.pct}% of the estimate</div>
      {slice.count > 1 && <div className="ptr-meta">{slice.count} positions in this slice</div>}
      {held.length > 0 && (
        <>
          <div className="ptr-tags"><span className="pill green">In your models</span></div>
          <div className="ptr-meta">{held.map((m) => m.name || m.key).join(', ')}</div>
        </>
      )}
      {slice.heldCount > 0 && slice.kind === 'class' && (
        <div className="ptr-meta">{slice.heldCount} of these match a ticker in your models</div>
      )}
    </div>
  );
}

export default function HoldingsChart({ holdings }) {
  const [mode, setMode] = useState('position');
  const [selected, setSelected] = useState(0);
  if (!holdings || holdings.status === 'none') {
    return (
      <section className="hold-card">
        <div className="ed-section">Holdings</div>
        <p className="ptr-note">No annual disclosure is stored for this filer yet.</p>
      </section>
    );
  }
  const filing = holdings.filing;
  const year = filing?.year ? `${filing.year} ` : '';
  const filed = pretty(filing?.filedDate);
  if (holdings.status === 'unreadable' || holdings.status === 'pending_ocr' || holdings.status === 'needs_manual_review') {
    return (
      <section className="hold-card">
        <div className="ed-section">Holdings</div>
        <p className="ptr-note">
          {year ? `The ${year}annual report` : 'The latest annual report'}
          {filed ? `, filed ${filed}, ` : ' '}
          {holdings.status === 'pending_ocr'
            ? 'is waiting for OCR. No holdings were guessed.'
            : 'could not be read. No holdings were guessed.'}
        </p>
        {holdings.note && <p className="ptr-note">{holdings.note}</p>}
        {filing?.sourceUrl && (
          <a className="ptr-link" href={filing.sourceUrl} target="_blank" rel="noreferrer">Source filing</a>
        )}
      </section>
    );
  }
  const slices = mode === 'class' ? (holdings.classes || []) : (holdings.positions || []);
  const active = slices[selected] || slices[0] || null;
  const totals = holdings.totals;
  return (
    <section className="hold-card">
      <div className="ed-section">Holdings</div>
      <p className="ptr-note">
        {year}annual report{filed ? `, filed ${filed}` : ''}.
        {' '}Filings report value ranges, so the dollar figures and the percentages are estimates.
        {filing?.kind === 'amendment' ? ' This chart is the latest amendment.' : ''}
      </p>
      {holdings.note && <p className="ptr-note">{holdings.note}</p>}
      {totals?.count > 0 && (
        <div className="hold-totals">
          <div>
            <span className="ptr-stat-n">{totals.label || '—'}</span>
            <span>Estimated range</span>
          </div>
          <div>
            <span className="ptr-stat-n">{totals.midpointLabel || money(totals.midpoint)}</span>
            <span>{totals.openEnded ? 'Estimate (floors where open)' : 'Estimate (midpoints)'}</span>
          </div>
        </div>
      )}
      <div className="segmented ptr-chips" role="group" aria-label="Group holdings">
        <button type="button" className={mode === 'position' ? 'on' : ''} aria-pressed={mode === 'position'} onClick={() => { setMode('position'); setSelected(0); }}>Positions</button>
        <button type="button" className={mode === 'class' ? 'on' : ''} aria-pressed={mode === 'class'} onClick={() => { setMode('class'); setSelected(0); }}>Asset class</button>
      </div>
      {slices.length === 0 ? (
        <p className="ptr-note">This filing has no valued holdings after exclusions.</p>
      ) : (
        <>
          <Donut slices={slices} selected={selected} onSelect={setSelected} />
          <Detail slice={active} color={COLORS[(slices.indexOf(active) >= 0 ? slices.indexOf(active) : 0) % COLORS.length]} />
          <ul className="hold-legend">
            {slices.map((slice, index) => (
              <li key={slice.id || index}>
                <button
                  type="button"
                  className={selected === index ? 'on' : ''}
                  aria-pressed={selected === index}
                  onClick={() => setSelected(index)}
                >
                  <span className="hold-swatch" style={{ background: COLORS[index % COLORS.length] }} />
                  <span className="hold-legend-name">{slice.label}</span>
                  <span className="hold-legend-pct">{slice.pct}%</span>
                </button>
                {(slice.heldModels || []).length > 0 && <span className="pill green">In your models</span>}
              </li>
            ))}
          </ul>
        </>
      )}
      {filing?.sourceUrl && (
        <a className="ptr-link" href={filing.sourceUrl} target="_blank" rel="noreferrer">Source filing</a>
      )}
    </section>
  );
}
