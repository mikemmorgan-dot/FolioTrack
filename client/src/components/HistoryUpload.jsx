import { num } from '../api.js';

export function skippedSummary(detail) {
  if (!detail) return '';
  const bits = [];
  if (detail.dividends) bits.push(`${detail.dividends} dividend${detail.dividends === 1 ? '' : 's'}`);
  if (detail.splits) bits.push(`${detail.splits} split${detail.splits === 1 ? '' : 's'}`);
  if (detail.duplicates) bits.push(`${detail.duplicates} duplicate date${detail.duplicates === 1 ? '' : 's'}`);
  if (detail.incomplete) bits.push(`${detail.incomplete} incomplete row${detail.incomplete === 1 ? '' : 's'}`);
  if (detail.invalid) bits.push(`${detail.invalid} invalid date${detail.invalid === 1 ? '' : 's'}`);
  return bits.join(', ');
}

export function Sparkline({ values }) {
  if (!values || values.length < 2) return null;
  const w = 320;
  const h = 46;
  const pad = 2;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const pts = values.map((v, i) => {
    const x = pad + (i / (values.length - 1)) * (w - pad * 2);
    const y = pad + (1 - (v - min) / span) * (h - pad * 2);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');
  return (
    <svg className="hist-spark" viewBox={`0 0 ${w} ${h}`} role="img" aria-label="Uploaded price history">
      <polyline fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" points={pts} />
    </svg>
  );
}

function RowTable({ rows, title }) {
  if (!rows?.length) return null;
  return (
    <div className="hist-table-wrap">
      {title && <div className="hist-table-title">{title}</div>}
      <table className="hist-rows">
        <tbody>
          {rows.map((p) => (
            <tr key={`${title || 'r'}-${p.date}`}>
              <td>{p.date}</td>
              <td className="r">{num(p.close)}</td>
              <td className="r muted">{p.adjClose != null && p.adjClose !== p.close ? num(p.adjClose) : ''}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function HistoryDropZone({
  dragOver, busy, paste, onPaste, onPreviewPaste, onFile, onDragOver, onDragLeave, onDrop,
}) {
  return (
    <div
      className={`hist-drop${dragOver ? ' over' : ''}`}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      <div className="hist-drop-title">Upload Yahoo history</div>
      <p>
        On iPhone, open the ticker’s Historical Data page in Safari, tap Share, then Save as PDF. Drop that PDF here, or a CSV. The ticker in the file is matched to a holding.
      </p>
      <label className="classify-select-back hist-file">
        {busy ? 'Reading…' : 'Choose PDF or CSV'}
        <input
          type="file"
          accept="application/pdf,.pdf,text/csv,.csv,text/plain,.txt"
          disabled={busy}
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = '';
            if (file) onFile(file, null);
          }}
        />
      </label>
      <label className="field" style={{ marginTop: 10, marginBottom: 0 }}>
        <span>Or paste CSV / history text</span>
        <textarea
          className="yahoo-paste"
          rows={3}
          value={paste}
          onChange={(e) => onPaste(e.target.value)}
          placeholder={'Date,Open,High,Low,Close,Adj Close,Volume\n2024-01-02,10,11,9,10.5,10.2,1000'}
        />
      </label>
      {paste.trim() && (
        <button type="button" className="classify-select-back" style={{ marginTop: 8 }} disabled={busy} onClick={onPreviewPaste}>
          Preview paste
        </button>
      )}
    </div>
  );
}

export function HistoryPreviewCard({
  upload, rows, overlap, busy, boxRef, onPick, onConfirmTicker, onApply, onDismiss,
}) {
  const preview = upload?.preview;
  if (!preview && upload?.phase !== 'error' && upload?.phase !== 'parsing' && !upload?.message) return null;
  const target = rows.find((r) => r.id === (upload.sourceId || upload.pickedId));
  const mismatch = !!(preview?.ticker && target && target.symbol.toUpperCase() !== preview.ticker.toUpperCase());
  const needsConfirm = mismatch && !upload.tickerConfirmed;
  const canApply = preview && target && !needsConfirm && !busy && upload.phase !== 'parsing';
  const skipped = skippedSummary(preview?.skippedDetail);

  return (
    <div className="hist-preview" ref={boxRef}>
      {upload.phase === 'parsing' && <p className="note">Reading the file…</p>}
      {upload.error && <p className="field-error" role="alert">{upload.error}</p>}
      {upload.message && <p className="note">{upload.message}</p>}
      {preview && (
        <>
          <div className="hist-kicker">
            {preview.ticker || 'No ticker detected'}
            {preview.currency ? ` · ${preview.currency}` : ''}
            {target ? ` · ${target.symbol}` : ''}
          </div>
          <Sparkline values={preview.sparkline} />
          <p className="hist-lead">
            {preview.rows.toLocaleString('en-CA')} closes
            {preview.from ? ` · ${preview.from} → ${preview.to}` : ''}
            {preview.lastClose != null ? `. Last close ${num(preview.lastClose)} on ${preview.lastDate}.` : ''}
            {' '}Close is saved, not adjusted close.
          </p>
          {overlap && (
            <p className="hist-lead">
              {overlap.addedCount.toLocaleString('en-CA')} new date{overlap.addedCount === 1 ? '' : 's'}
              {overlap.overwriteCount
                ? `, ${overlap.overwriteCount.toLocaleString('en-CA')} already saved`
                : ', none already saved'}
              . Only add missing leaves existing dates as they are.
            </p>
          )}
          {skipped && <p className="hist-lead">Skipped {skipped}. Dividends and splits are not stored as prices.</p>}
          {preview.currencyMismatch && (
            <p className="hist-warn" role="status">
              This file is in {preview.currency}. {target?.symbol || 'This holding'} is {target?.currency || 'a different currency'}. Numbers are saved as printed — they are not converted.
            </p>
          )}
          {!target && preview.ticker && (
            <p className="hist-warn" role="status">
              No holding matches {preview.ticker}. Add that name to a model, or choose a different holding below. You’ll confirm before anything is saved.
            </p>
          )}
          {!upload.sourceId && (
            <label className="field">
              <span>Apply to</span>
              <select value={upload.pickedId || ''} onChange={(e) => onPick(e.target.value)}>
                <option value="">Choose a holding…</option>
                {rows.map((r) => (
                  <option key={r.id} value={r.id}>{r.symbol} · {r.name}</option>
                ))}
              </select>
            </label>
          )}
          {needsConfirm && (
            <div className="hist-warn">
              This file is {preview.ticker}, not {target.symbol}.
              <button type="button" className="classify-select-back" style={{ marginTop: 8 }} onClick={onConfirmTicker}>
                Use this file for {target.symbol}
              </button>
            </div>
          )}
          {preview.warnings?.filter((w) => !/Confirm before applying|File currency is/.test(w)).slice(0, 4).map((w) => (
            <p className="hist-warn" key={w}>{w}</p>
          ))}
          <RowTable rows={preview.head} title={preview.tail?.length ? 'First rows' : 'Rows'} />
          <RowTable rows={preview.tail} title="Last rows" />
          <div className="hist-apply">
            <button type="button" className="hist-primary" disabled={!canApply} onClick={() => onApply('missing')}>
              {busy ? 'Saving…' : `Only add missing${overlap ? ` (${overlap.addedCount.toLocaleString('en-CA')})` : ''}`}
            </button>
            <button type="button" className="classify-select-back" disabled={!canApply} onClick={() => onApply('overwrite')}>
              Overwrite {overlap ? overlap.overwriteCount.toLocaleString('en-CA') : ''} date{(overlap?.overwriteCount || 0) === 1 ? '' : 's'}
            </button>
            <button type="button" className="classify-select-back" onClick={onDismiss}>Dismiss</button>
          </div>
        </>
      )}
    </div>
  );
}
