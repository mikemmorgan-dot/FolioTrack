import { useState } from 'react';

const OTHER = '__other__';

// A <select> over a curated option list, with an "Other" escape hatch that
// reveals a free-text input — for values the list doesn't cover (a legacy
// value already in the data, a frontier market, an asset-class placeholder
// like "Equity") without forcing everything into the curated set.
export default function ClassifySelect({ options, value, onChange, placeholder }) {
  const isCustom = !!value && !options.includes(value);
  const [customMode, setCustomMode] = useState(isCustom);

  if (customMode) {
    return (
      <div className="classify-select-row">
        <input type="text" value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} />
        <button type="button" className="classify-select-back" onClick={() => { setCustomMode(false); onChange(''); }}>List</button>
      </div>
    );
  }

  return (
    <select value={options.includes(value) ? value : ''} onChange={(e) => {
      if (e.target.value === OTHER) { setCustomMode(true); onChange(''); }
      else onChange(e.target.value);
    }}>
      <option value="">—</option>
      {options.map((o) => <option key={o} value={o}>{o}</option>)}
      <option value={OTHER}>Other…</option>
    </select>
  );
}
