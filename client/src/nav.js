// nav.js — calendar-day NAV cadence and as-of helpers (client).
// Cadences are calendar days, not trading days — labeled as such in the UI.

export const NAV_CADENCE_DAYS = {
  stock: 7,
  etf: 7,
  mutualfund: 40,
  alt: 100,
  cash: Infinity,
};

export function todayToronto() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Toronto' });
}

export function calendarDaysBetween(fromISO, toISO) {
  const a = Date.parse(`${String(fromISO).slice(0, 10)}T00:00:00Z`);
  const b = Date.parse(`${String(toISO).slice(0, 10)}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.round((b - a) / 86400000);
}

export function isNavStale(type, asOf, today = todayToronto()) {
  if (!asOf || type === 'cash') return false;
  const cadence = NAV_CADENCE_DAYS[type] ?? 7;
  if (!Number.isFinite(cadence)) return false;
  const age = calendarDaysBetween(asOf, today);
  return age != null && age > cadence;
}

export function isCashHolding(h) {
  return h?.type === 'cash' || String(h?.symbol || '').toUpperCase() === 'CASH';
}

export function cadenceLabel(type) {
  const d = NAV_CADENCE_DAYS[type] ?? 7;
  if (!Number.isFinite(d)) return 'never stale';
  return `${d} calendar-day cadence`;
}

// Missing NAV ranks ahead of stale, then fresh. Caller then sorts by symbol.
export function navFreshnessRank(type, asOf, today = todayToronto()) {
  if (!asOf) return 0;
  if (isNavStale(type, asOf, today)) return 1;
  return 2;
}
