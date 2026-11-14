// Net buy vs sell for one ticker.
// Net count is buys minus sells. Exchanges are counted on their own.
// Dollars are an estimate: the midpoint of each statutory range.
// Over $50,000,000 has no ceiling, so it contributes its lower bound and
// the estimate is marked a minimum. A row with no parseable amount is left
// out of the dollars and counted in `excluded`.

import { AMOUNT_RANGES, canonicalTicker, matchableAssetClass } from './normalize.js';

const OVER_50M = 'Over $50,000,000';
const OVER_50M_MIN = 50_000_000;

export function rangeMidpoint(label) {
  const text = String(label ?? '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
  const hit = AMOUNT_RANGES.find((row) => row[2] === text);
  if (hit) return { value: (hit[0] + hit[1]) / 2, open: false };
  if (text === OVER_50M) return { value: OVER_50M_MIN, open: true };
  return null;
}

function trim1(n) {
  const rounded = Math.round(n * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

function compactMagnitude(abs) {
  if (abs >= 1_000_000_000) return `${trim1(abs / 1_000_000_000)}B`;
  if (abs >= 1_000_000) return `${trim1(abs / 1_000_000)}M`;
  if (abs >= 1_000) return `${trim1(abs / 1_000)}K`;
  return Math.round(abs).toLocaleString('en-US');
}

export function formatCompactDollars(n) {
  const value = Number(n);
  if (!Number.isFinite(value)) return null;
  const sign = value > 0 ? '+' : value < 0 ? '-' : '';
  return `${sign}$${compactMagnitude(Math.abs(value))}`;
}

export function formatNetCount(netCount) {
  const n = Number(netCount) || 0;
  if (n > 0) return `Net +${n}`;
  return `Net ${n}`;
}

export function formatNetEstimate(net) {
  if (!net || net.estimatedNet == null || !Number.isFinite(Number(net.estimatedNet))) return null;
  const compact = formatCompactDollars(net.estimatedNet);
  if (!compact) return null;
  return net.minimum ? `Est. net at least ${compact}` : `Est. net ${compact}`;
}

function emptyAcc() {
  return {
    buys: 0,
    sells: 0,
    exchanges: 0,
    buyMid: 0,
    sellMid: 0,
    known: 0,
    minimum: false,
    excluded: 0,
    matchable: false,
  };
}

function addTrade(acc, trade) {
  const side = trade.txType;
  if (side === 'exchange') {
    acc.exchanges += 1;
  } else if (side === 'buy' || side === 'sell') {
    if (side === 'buy') acc.buys += 1;
    else acc.sells += 1;
    const mid = rangeMidpoint(trade.amountRange);
    if (!mid) acc.excluded += 1;
    else {
      acc.known += 1;
      if (mid.open) acc.minimum = true;
      if (side === 'buy') acc.buyMid += mid.value;
      else acc.sellMid += mid.value;
    }
  } else {
    return acc;
  }
  if (matchableAssetClass(trade.assetClass)) acc.matchable = true;
  return acc;
}

export function presentNet(acc) {
  const estimatedNet = acc.known ? acc.buyMid - acc.sellMid : null;
  const net = {
    buys: acc.buys,
    sells: acc.sells,
    exchanges: acc.exchanges,
    netCount: acc.buys - acc.sells,
    estimatedNet,
    minimum: acc.minimum === true,
    excluded: acc.excluded,
  };
  return {
    ...net,
    countLabel: formatNetCount(net.netCount),
    estimateLabel: formatNetEstimate(net),
  };
}

export function emptyPresentedNet() {
  return presentNet(emptyAcc());
}

function tickerKey(trade) {
  return trade?.tickerNorm || canonicalTicker(trade?.ticker) || null;
}

export function aggregateNetByTicker(trades) {
  const groups = new Map();
  for (const trade of trades || []) {
    const ticker = tickerKey(trade);
    if (!ticker) continue;
    let acc = groups.get(ticker);
    if (!acc) {
      acc = emptyAcc();
      groups.set(ticker, acc);
    }
    addTrade(acc, trade);
  }
  return groups;
}

export function netForTicker(groups, ticker) {
  const acc = groups.get(ticker);
  return presentNet(acc || emptyAcc());
}

function netDollars(row) {
  const net = row.net || row;
  return net.estimatedNet == null ? null : Math.abs(Number(net.estimatedNet));
}

function netCountAbs(row) {
  const net = row.net || row;
  return Math.abs(Number(net.netCount) || 0);
}

export function compareNetRows(a, b) {
  const ad = netDollars(a);
  const bd = netDollars(b);
  if (ad == null && bd != null) return 1;
  if (bd == null && ad != null) return -1;
  if (ad != null && bd != null && ad !== bd) return bd - ad;
  const ac = netCountAbs(a);
  const bc = netCountAbs(b);
  if (ac !== bc) return bc - ac;
  return String(a.ticker).localeCompare(String(b.ticker));
}

export function bothSideNets(groups, limit = null) {
  const rows = [];
  for (const [ticker, acc] of groups) {
    if (!(acc.buys > 0 && acc.sells > 0)) continue;
    rows.push({
      ticker,
      matchable: acc.matchable === true,
      net: presentNet(acc),
    });
  }
  rows.sort(compareNetRows);
  return {
    netTotal: rows.length,
    nets: limit == null ? rows : rows.slice(0, limit),
  };
}

export function netFromColumns(row) {
  if (!row || (row.net_buys == null && row.net_sells == null)) return null;
  const acc = emptyAcc();
  acc.buys = Number(row.net_buys) || 0;
  acc.sells = Number(row.net_sells) || 0;
  acc.exchanges = Number(row.net_exchanges) || 0;
  acc.known = Number(row.net_known) || 0;
  acc.excluded = Number(row.net_excluded) || 0;
  acc.minimum = (Number(row.net_open) || 0) > 0;
  acc.buyMid = Number(row.net_buy_mid) || 0;
  acc.sellMid = Number(row.net_sell_mid) || 0;
  if (!acc.known) {
    acc.buyMid = 0;
    acc.sellMid = 0;
  }
  return presentNet(acc);
}

export function rollupByTicker(trades, bounds) {
  const from = bounds?.from || '';
  const to = bounds?.to || '';
  const scoped = [];
  for (const trade of trades || []) {
    if (!tickerKey(trade)) continue;
    const date = trade.disclosedDate || '';
    if (!date || date < from || date > to) continue;
    scoped.push(trade);
  }
  const groups = aggregateNetByTicker(scoped);
  const tickers = [...groups.entries()].map(([ticker, acc]) => ({
    ticker,
    net: presentNet(acc),
  }));
  tickers.sort(compareNetRows);
  return {
    window: bounds?.windowDays ?? null,
    from,
    to,
    tickers,
  };
}

export function digestNetLines(trades) {
  const { nets } = bothSideNets(aggregateNetByTicker(trades || []), null);
  return nets.map((row) => {
    const net = row.net;
    const parts = [
      row.ticker,
      net.countLabel,
      net.estimateLabel || 'Est. net unavailable',
      `${net.buys} ${net.buys === 1 ? 'buy' : 'buys'}`,
      `${net.sells} ${net.sells === 1 ? 'sell' : 'sells'}`,
    ];
    if (net.exchanges) {
      parts.push(`${net.exchanges} ${net.exchanges === 1 ? 'exchange' : 'exchanges'}`);
    }
    if (net.excluded) {
      parts.push(`${net.excluded} ${net.excluded === 1 ? 'amount' : 'amounts'} left out`);
    }
    return parts.join(' · ');
  });
}
