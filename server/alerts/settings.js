// alerts/settings.js — shared validation for the price-drop alert settings.
// Both stores persist the coerced object; neither invents its own rules.

export const ALERT_DEFAULTS = {
  alertThreshold: 20,
  alertEmail: 'mikemmorgan@gmail.com',
  alertEnabled: true,
};

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function coerceAlertSettings(stored) {
  const out = { ...ALERT_DEFAULTS };
  if (stored && stored.alertThreshold != null && stored.alertThreshold !== '') {
    const n = Number(stored.alertThreshold);
    if (Number.isFinite(n)) {
      const rounded = Math.round(n * 10) / 10;
      if (rounded >= 1 && rounded <= 90) out.alertThreshold = rounded;
    }
  }
  if (stored && typeof stored.alertEmail === 'string') {
    const email = stored.alertEmail.trim();
    if (EMAIL_RE.test(email) && email.length <= 200) out.alertEmail = email;
  }
  if (stored && typeof stored.alertEnabled === 'boolean') out.alertEnabled = stored.alertEnabled;
  return out;
}

export function applyAlertSettingsPatch(current, patch = {}) {
  const next = { ...coerceAlertSettings(current) };
  const errors = [];
  if (patch.alertThreshold !== undefined) {
    const n = typeof patch.alertThreshold === 'number' ? patch.alertThreshold : Number(String(patch.alertThreshold).trim());
    if (!Number.isFinite(n) || n < 1 || n > 90) errors.push('Threshold must be between 1 and 90');
    else next.alertThreshold = Math.round(n * 10) / 10;
  }
  if (patch.alertEmail !== undefined) {
    const email = String(patch.alertEmail ?? '').trim();
    if (!EMAIL_RE.test(email) || email.length > 200) errors.push('Enter a valid alert email');
    else next.alertEmail = email;
  }
  if (patch.alertEnabled !== undefined) {
    if (typeof patch.alertEnabled !== 'boolean') errors.push('alertEnabled must be true or false');
    else next.alertEnabled = patch.alertEnabled;
  }
  if (errors.length) {
    const err = new Error(errors.join('; '));
    err.status = 400;
    throw err;
  }
  return next;
}
