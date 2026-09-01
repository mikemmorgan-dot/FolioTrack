import { useState } from 'react';
import { BASIS, setBasis, money } from '../api.js';

export default function SettingsPanel({ onClose, onSaved }) {
  const [basis, setBasisInput] = useState(String(BASIS));
  const n = Number(basis);
  const valid = Number.isFinite(n) && n > 0;

  function save() {
    if (!valid) return;
    setBasis(n);
    onSaved();
  }

  return (
    <div className="editor">
      <header className="editor-bar">
        <button type="button" className="ed-cancel" onClick={onClose}>Cancel</button>
        <span className="ed-title">Settings</span>
        <button type="button" className="ed-save" disabled={!valid} onClick={save}>Save</button>
      </header>

      <div className="editor-body">
        <div className="ed-section">Display</div>
        <label className="field"><span>Modelled portfolio value</span>
          <input type="number" inputMode="decimal" min="1" step="1000" value={basis}
            onChange={(e) => setBasisInput(e.target.value)} placeholder="e.g. 1000000" />
        </label>
        <p className="ed-hint">
          Every model is displayed as if this amount were invested — holdings show as weight × this value.
          It’s a display preference only (models store target weights, not dollars), saved on this device.
          {valid && ` Currently: ${money(n)}.`}
        </p>
      </div>
    </div>
  );
}
