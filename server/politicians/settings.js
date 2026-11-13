// Politician-trade alert switches. The recipient is the existing price-alert
// email. These flags live in their own settings row so a price-alert save
// cannot clear them.

export const POLITICIAN_ALERT_DEFAULTS = {
  politicianAlertsEnabled: true,
  politicianAlertsHeldOnly: false,
};

export function coercePoliticianAlertSettings(stored) {
  const out = { ...POLITICIAN_ALERT_DEFAULTS };
  if (stored && typeof stored.politicianAlertsEnabled === 'boolean') {
    out.politicianAlertsEnabled = stored.politicianAlertsEnabled;
  }
  if (stored && typeof stored.politicianAlertsHeldOnly === 'boolean') {
    out.politicianAlertsHeldOnly = stored.politicianAlertsHeldOnly;
  }
  return out;
}

export function applyPoliticianAlertPatch(current, patch = {}) {
  const next = { ...coercePoliticianAlertSettings(current) };
  const errors = [];
  if (patch.politicianAlertsEnabled !== undefined) {
    if (typeof patch.politicianAlertsEnabled !== 'boolean') errors.push('politicianAlertsEnabled must be true or false');
    else next.politicianAlertsEnabled = patch.politicianAlertsEnabled;
  }
  if (patch.politicianAlertsHeldOnly !== undefined) {
    if (typeof patch.politicianAlertsHeldOnly !== 'boolean') errors.push('politicianAlertsHeldOnly must be true or false');
    else next.politicianAlertsHeldOnly = patch.politicianAlertsHeldOnly;
  }
  if (errors.length) {
    const err = new Error(errors.join('; '));
    err.status = 400;
    throw err;
  }
  return next;
}
