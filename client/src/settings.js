// settings.js — per-device display preferences, kept in localStorage.
// The modelled basis is a display convention (every weight is shown as
// weight × basis), not data: models only store target weights, so this
// never touches the server or other viewers of the public URL.

const KEY = 'foliotrack.settings';
const DEFAULTS = { basis: 10000 };

function read() {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? { ...DEFAULTS, ...JSON.parse(raw) } : { ...DEFAULTS };
  } catch {
    return { ...DEFAULTS };
  }
}

export function getSettings() {
  return read();
}

export function saveSettings(patch) {
  const next = { ...read(), ...patch };
  try { localStorage.setItem(KEY, JSON.stringify(next)); } catch { /* private mode etc. — setting just won't persist */ }
  return next;
}
