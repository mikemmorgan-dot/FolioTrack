// funding.js — pure allocation + funding math for the Add holding form.
//
// Weights are percents with the editor's existing precision: 2 decimal places
// (`toFixed(2)` / hundredths). Proportional funding scales the current book
// by (100 − newWeight) / 100 when that book already sums to 100, then
// largest-remainder rounding forces the result to sum to exactly 100.00.

export const FUND_PROPORTIONAL = 'proportional';
export const FUND_CASH = 'cash';
export const FUND_MANUAL = 'manual';

export const WEIGHT_DECIMALS = 2;

const CASH_SYMBOL = 'CASH';

export function isCashHolding(h) {
  if (!h) return false;
  if (h.isCash === true) return true;
  if (h.type === 'cash') return true;
  return String(h.symbol || '').trim().toUpperCase() === CASH_SYMBOL;
}

// Existing editor convention: half-away-from-zero at 2 decimal percents.
export function roundPercent(n) {
  const x = Number(n);
  if (!Number.isFinite(x)) return 0;
  return +x.toFixed(WEIGHT_DECIMALS);
}

function percentUnits(n) {
  return Math.round(roundPercent(n) * 100);
}

function sumUnits(rows) {
  return rows.reduce((s, r) => s + percentUnits(r.weightPct), 0);
}

/**
 * Round `rawValues` (percents) so they sum to `target` at `decimals` places.
 * Leftover hundredths go to the largest fractional parts.
 */
export function largestRemainder(rawValues, target, decimals = WEIGHT_DECIMALS) {
  const scale = 10 ** decimals;
  const targetUnits = Math.round(Number(target) * scale);
  const exact = (rawValues || []).map((v) => {
    const n = Number(v);
    return Number.isFinite(n) ? n * scale : 0;
  });
  if (!exact.length) return [];
  const floors = exact.map((u) => Math.floor(u + 1e-8));
  let short = targetUnits - floors.reduce((a, b) => a + b, 0);
  const ranked = exact.map((u, i) => ({ i, frac: u - Math.floor(u + 1e-8) }));
  if (short > 0) {
    ranked.sort((a, b) => b.frac - a.frac || a.i - b.i);
    for (let k = 0; short > 0; k++) {
      floors[ranked[k % ranked.length].i] += 1;
      short -= 1;
    }
  } else if (short < 0) {
    ranked.sort((a, b) => a.frac - b.frac || a.i - b.i);
    let guard = 0;
    while (short < 0 && guard < exact.length * 8) {
      const i = ranked[guard % ranked.length].i;
      if (floors[i] > 0) {
        floors[i] -= 1;
        short += 1;
      }
      guard += 1;
    }
  }
  return floors.map((u) => u / scale);
}

const ALLOC_HELP = 'Enter an allocation above 0% to preview or add this holding.';

export function allocationState(raw) {
  const s = String(raw ?? '').trim();
  if (s === '' || s === '.' || s === '-' || s === '+') {
    return { valid: false, value: null, message: ALLOC_HELP };
  }
  const n = Number(s);
  if (!Number.isFinite(n)) {
    return { valid: false, value: null, message: 'Allocation must be a number.' };
  }
  if (n < 0 || n > 100) {
    return { valid: false, value: null, message: 'Allocation must be between 0 and 100.' };
  }
  if (n === 0) {
    return { valid: false, value: 0, message: ALLOC_HELP };
  }
  const rounded = roundPercent(n);
  if (!(rounded > 0)) {
    return { valid: false, value: n, message: 'Enter at least 0.01%.' };
  }
  if (rounded > 100) {
    return { valid: false, value: n, message: 'Allocation must be between 0 and 100.' };
  }
  return { valid: true, value: rounded, message: null };
}

// Preview stays disabled until the add form has a real weight and a ticker
// (cash doesn't need a ticker). Closed form: the button previews the draft.
export function previewGate({ adding, allocationRaw, symbol, isCash }) {
  if (!adding) return { blocked: false, message: null };
  const alloc = allocationState(allocationRaw);
  if (!alloc.valid) return { blocked: true, message: alloc.message || ALLOC_HELP };
  const sym = String(symbol || '').trim();
  if (!isCash && !sym) {
    return { blocked: true, message: 'Enter a ticker and an allocation above 0% to preview this holding.' };
  }
  if (!isCash && /\s/.test(sym)) {
    return { blocked: true, message: 'Enter a ticker symbol, not a company name, to preview this holding.' };
  }
  return { blocked: false, message: null, allocationPct: alloc.value };
}

export function addDisabled({ allocationRaw, funding, needsName, duplicate, cashAlready }) {
  const alloc = allocationState(allocationRaw);
  if (!alloc.valid) return { disabled: true, message: alloc.message || ALLOC_HELP };
  if (cashAlready) {
    return { disabled: true, message: 'This model already has a cash holding — change its weight above.' };
  }
  if (duplicate) {
    return { disabled: true, message: 'That symbol is already in this model — change its weight above.' };
  }
  if (needsName) return { disabled: true, message: 'Enter a name before adding this holding.' };
  if (funding && !funding.canAdd) {
    return { disabled: true, message: funding.warning || 'This allocation can’t be funded that way.' };
  }
  return { disabled: false, message: null };
}

function asHolding(h, i) {
  return {
    key: h.key ?? h.uiKey ?? `h${i}`,
    symbol: h.symbol || '',
    name: h.name || h.symbol || '',
    weightPct: Number(h.weightPct) || 0,
    isCash: h.isCash != null ? !!h.isCash : isCashHolding(h),
  };
}

function pack(mode, extra) {
  return {
    mode,
    canAdd: false,
    cashNegative: false,
    warning: null,
    total: 0,
    newWeightPct: 0,
    rows: [],
    ...extra,
  };
}

function fundProportional(list, neu, newPct) {
  const sum = list.reduce((s, h) => s + h.weightPct, 0);
  if (!(sum > 0)) {
    const rows = [{ ...neu, weightPct: newPct, isNew: true }];
    return pack(FUND_PROPORTIONAL, {
      canAdd: true,
      total: newPct,
      newWeightPct: newPct,
      rows,
    });
  }

  const room = roundPercent(100 - newPct);
  const nonCash = list.filter((h) => !h.isCash);
  const cash = list.filter((h) => h.isCash);
  // Literal factor from the spec. When the book is already 100%, non-cash
  // holdings (and cash, via the residual) shrink by this factor.
  const statedFactor = room / 100;
  const ncSum = nonCash.reduce((s, h) => s + h.weightPct, 0);
  let rawByKey = new Map();

  if (!nonCash.length) {
    const f = room / sum;
    list.forEach((h) => rawByKey.set(h.key, h.weightPct * f));
  } else if (!cash.length) {
    // No cash sleeve: scale non-cash into the room left for them.
    // Equals statedFactor when they already sum to 100.
    const f = ncSum > 0 ? room / ncSum : 0;
    nonCash.forEach((h) => rawByKey.set(h.key, h.weightPct * f));
  } else {
    const ncRaws = nonCash.map((h) => h.weightPct * statedFactor);
    const ncScaled = ncRaws.reduce((s, x) => s + x, 0);
    const residual = room - ncScaled;
    if (residual < -1e-6) {
      const f = room / sum;
      list.forEach((h) => rawByKey.set(h.key, h.weightPct * f));
    } else {
      nonCash.forEach((h, i) => rawByKey.set(h.key, ncRaws[i]));
      const cashSum = cash.reduce((s, h) => s + h.weightPct, 0);
      cash.forEach((h) => {
        const share = cashSum > 0 ? h.weightPct / cashSum : 1 / cash.length;
        rawByKey.set(h.key, share * residual);
      });
    }
  }

  const raws = list.map((h) => rawByKey.get(h.key) || 0);
  const rounded = largestRemainder(raws, room, WEIGHT_DECIMALS);
  const rows = list.map((h, i) => ({ ...h, weightPct: rounded[i], isNew: false }));
  rows.push({ ...neu, weightPct: newPct, isNew: true });
  return pack(FUND_PROPORTIONAL, {
    canAdd: true,
    total: sumUnits(rows) / 100,
    newWeightPct: newPct,
    rows,
  });
}

function fundFromCash(list, neu, newPct) {
  const cashRows = list.filter((h) => h.isCash);
  if (!cashRows.length || neu.isCash) {
    const rows = list.map((h) => ({ ...h, isNew: false }));
    rows.push({ ...neu, weightPct: newPct, isNew: true });
    return pack(FUND_CASH, {
      canAdd: false,
      warning: neu.isCash
        ? 'Taking from cash doesn’t apply when the new holding is cash.'
        : 'No cash holding to draw from.',
      total: sumUnits(rows) / 100,
      newWeightPct: newPct,
      rows,
    });
  }

  const cash = cashRows[0];
  const nextCash = roundPercent(roundPercent(cash.weightPct) - newPct);
  const cashNegative = nextCash < -0.001;
  const rows = list.map((h) => ({
    ...h,
    isNew: false,
    weightPct: h.key === cash.key ? nextCash : roundPercent(h.weightPct),
  }));
  rows.push({ ...neu, weightPct: newPct, isNew: true });

  // A book already at 100% (within the editor's 0.50 tolerance) stays exactly
  // 100.00, with the penny parked on cash. Other holdings are not rescaled.
  const originalUnits = list.reduce((s, h) => s + percentUnits(h.weightPct), 0);
  if (!cashNegative && Math.abs(originalUnits - 10000) <= 50) {
    const cashRow = rows.find((r) => r.key === cash.key);
    const others = rows
      .filter((r) => r.key !== cash.key)
      .reduce((s, r) => s + percentUnits(r.weightPct), 0);
    const adjusted = 10000 - others;
    if (adjusted >= 0) cashRow.weightPct = adjusted / 100;
  }

  const total = sumUnits(rows) / 100;
  return pack(FUND_CASH, {
    canAdd: !cashNegative,
    cashNegative,
    warning: cashNegative
      ? `Cash would go negative (${nextCash.toFixed(2)}%). Lower the allocation or pick another funding method.`
      : null,
    total,
    newWeightPct: newPct,
    rows,
  });
}

function fundManual(list, neu, newPct) {
  const rows = list.map((h) => ({ ...h, isNew: false, weightPct: h.weightPct }));
  rows.push({ ...neu, weightPct: newPct, isNew: true });
  return pack(FUND_MANUAL, {
    canAdd: true,
    total: sumUnits(rows) / 100,
    newWeightPct: newPct,
    rows,
  });
}

export function fundAllocation({ holdings, newHolding, mode, allocationPct }) {
  const alloc = allocationState(allocationPct);
  const list = (holdings || []).map(asHolding);
  const neu = {
    key: newHolding?.key || '__new__',
    symbol: newHolding?.symbol || 'NEW',
    name: newHolding?.name || newHolding?.symbol || 'New holding',
    isCash: newHolding ? isCashHolding(newHolding) : false,
  };
  if (!alloc.valid) {
    return pack(mode || FUND_PROPORTIONAL, {
      warning: alloc.message,
      total: sumUnits(list.map((h) => ({ weightPct: h.weightPct }))) / 100,
      rows: list.map((h) => ({ ...h, isNew: false })),
    });
  }
  const pct = alloc.value;
  if (mode === FUND_CASH) return fundFromCash(list, neu, pct);
  if (mode === FUND_MANUAL) return fundManual(list, neu, pct);
  return fundProportional(list, neu, pct);
}

// Merge funded weights back onto editor rows and append the new holding.
// Returns null applied rows when the funding choice can't be saved (negative cash).
export function applyFunding(rows, newRow, { mode, allocationPct }) {
  const funded = fundAllocation({
    holdings: (rows || []).map((r) => ({
      key: r.uiKey,
      symbol: r.symbol,
      name: r.name,
      weightPct: r.weightPct,
      type: r.type,
      isCash: isCashHolding(r),
    })),
    newHolding: {
      key: '__new__',
      symbol: newRow.symbol,
      name: newRow.name,
      type: newRow.type,
      isCash: isCashHolding(newRow),
    },
    mode,
    allocationPct,
  });
  if (!funded.canAdd) return { ...funded, applied: null };
  const byKey = new Map(funded.rows.filter((r) => !r.isNew).map((r) => [r.key, r.weightPct]));
  const applied = (rows || []).map((r) => (
    byKey.has(r.uiKey) ? { ...r, weightPct: byKey.get(r.uiKey) } : r
  ));
  applied.push({ ...newRow, weightPct: funded.newWeightPct });
  return { ...funded, applied };
}
