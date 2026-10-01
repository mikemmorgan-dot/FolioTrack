// metadataRefresh.js — when a later quote finally answers, fill name / sector /
// region that were only suggestions. Fields the user edited stay as typed.

function clean(value) {
  const s = String(value || '').trim();
  return s || null;
}

function usableName(quote, symbol) {
  const name = clean(quote?.name);
  if (!name) return null;
  if (name.toUpperCase() === String(symbol || '').trim().toUpperCase()) return null;
  return name;
}

export function metadataPatchFromQuote(inst, quote) {
  if (!inst?.meta?.unverified) return null;
  if (quote?.price == null || !Number.isFinite(Number(quote.price))) return null;
  const locks = inst.meta.locks || {};
  const patch = {};
  const liveName = usableName(quote, inst.symbol);
  if (liveName && !locks.name && liveName !== inst.name) patch.name = liveName;
  const sector = clean(quote.sector);
  const country = clean(quote.country || quote.region);
  if (sector && !locks.sector && sector !== inst.sector) patch.sector = sector;
  if (country && !locks.country && country !== inst.country) patch.country = country;
  patch.meta = { ...inst.meta, unverified: false };
  return patch;
}
