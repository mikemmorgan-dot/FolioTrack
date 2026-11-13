// Disclosure-window summary for politician trades.
// Postgres does the GROUP BY (see pgStore). This module owns the window,
// the statutory range bounds, and the compact JSON shape. The memory store
// uses aggregateSummary() so dev and tests follow the same rules.

import { AMOUNT_RANGES, matchableAssetClass } from './normalize.js';
import { heldIndex } from './records.js';

export const SUMMARY_WINDOWS = [7, 30, 90];
export const SUMMARY_WINDOW_DEFAULT = 30;
export const RANK_LIMIT = 10;
export const CLUSTER_LIMIT = 20;
export const CLUSTER_MIN_DEFAULT = 3;
export const CLUSTER_MIN_MAX = 10;
// Printed floor of the open-ended statutory bucket. There is no ceiling.
export const OVER_50M = 'Over $50,000,000';
export const OVER_50M_MIN = 50_000_000;

const DAY = /^\d{4}-\d{2}-\d{2}$/;

export function usTodayIso(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

export function addDaysIso(iso, days) {
  const dt = new Date(`${iso}T00:00:00Z`);
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

// Inclusive disclosure dates: today and the previous (days - 1) calendar days.
export function summaryBounds(windowDays, asOf) {
  return { from: addDaysIso(asOf, -(windowDays - 1)), to: asOf };
}

export function normalizeClusterMin(value, env = process.env) {
  const fromEnv = Number(env.POLITICIAN_CLUSTER_MIN);
  const fallback = Number.isFinite(fromEnv) && fromEnv >= 2 && fromEnv <= CLUSTER_MIN_MAX
    ? Math.round(fromEnv)
    : CLUSTER_MIN_DEFAULT;
  if (value == null || value === '') return fallback;
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(CLUSTER_MIN_MAX, Math.max(2, Math.round(n)));
}

export function normalizeSummaryQuery(query = {}, now = new Date()) {
  const windowRaw = Number(query.window);
  const windowDays = SUMMARY_WINDOWS.includes(windowRaw) ? windowRaw : SUMMARY_WINDOW_DEFAULT;
  const asOf = DAY.test(query.asOf) ? query.asOf : usTodayIso(now);
  const { from, to } = summaryBounds(windowDays, asOf);
  const filer = query.filer === 'member' || query.filer === 'candidate' ? query.filer : '';
  return {
    windowDays,
    asOf,
    from,
    to,
    filer,
    clusterMin: normalizeClusterMin(query.clusterMin),
    rankLimit: RANK_LIMIT,
    clusterLimit: CLUSTER_LIMIT,
  };
}

export function filerMatches(status, filer) {
  if (!filer) return true;
  if (filer === 'candidate') return status === 'candidate';
  return status !== 'candidate';
}

export function filerSql(column, param = '$3') {
  return `(${param}::text = '' OR (${param}::text = 'candidate' AND ${column} = 'candidate') OR (${param}::text = 'member' AND ${column} IS DISTINCT FROM 'candidate'))`;
}

function sqlLiteral(label) {
  return `'${String(label).replace(/'/g, "''")}'`;
}

export function amountMinSql(column = 'amount_range') {
  const whens = AMOUNT_RANGES
    .map(([min, , label]) => `WHEN ${sqlLiteral(label)} THEN ${min}`)
    .join(' ');
  return `CASE ${column} ${whens} WHEN ${sqlLiteral(OVER_50M)} THEN ${OVER_50M_MIN} ELSE NULL END`;
}

export function amountMaxSql(column = 'amount_range') {
  const whens = AMOUNT_RANGES
    .map(([, max, label]) => `WHEN ${sqlLiteral(label)} THEN ${max}`)
    .join(' ');
  return `CASE ${column} ${whens} ELSE NULL END`;
}

export function amountRangeBounds(label) {
  const text = String(label ?? '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
  const hit = AMOUNT_RANGES.find((row) => row[2] === text);
  if (hit) return { min: hit[0], max: hit[1], open: false };
  if (text === OVER_50M) return { min: OVER_50M_MIN, max: null, open: true };
  return null;
}

export function emptyAmounts() {
  return { min: 0, max: 0, open: false, known: 0, unknown: 0 };
}

export function addAmount(acc, label) {
  const bounds = amountRangeBounds(label);
  if (!bounds) {
    acc.open = true;
    acc.unknown += 1;
    return acc;
  }
  acc.min += bounds.min;
  acc.known += 1;
  if (bounds.open) acc.open = true;
  else acc.max += bounds.max;
  return acc;
}

export function mergeAmounts(into, from) {
  into.min += from.min;
  into.max += from.max;
  into.known += from.known;
  into.unknown += from.unknown;
  into.open = into.open || from.open;
  return into;
}

export function formatDollars(n) {
  return `$${Math.round(Number(n)).toLocaleString('en-US')}`;
}

// Closed span is sum of minimums through sum of maximums.
// An open statutory bucket has no maximum, so the label stays "Over $…".
export function amountSpan(acc) {
  if (!acc.known) return { amountMin: null, amountMax: null, amountLabel: null };
  if (acc.open) {
    return { amountMin: acc.min, amountMax: null, amountLabel: `Over ${formatDollars(acc.min)}` };
  }
  return {
    amountMin: acc.min,
    amountMax: acc.max,
    amountLabel: `${formatDollars(acc.min)} - ${formatDollars(acc.max)}`,
  };
}

export function spanFromSums(amountMin, amountMax, openRows, knownAmounts) {
  const known = Number(knownAmounts) || 0;
  if (!known) return { amountMin: null, amountMax: null, amountLabel: null };
  const min = Number(amountMin);
  if ((Number(openRows) || 0) > 0 || amountMax == null) {
    return { amountMin: min, amountMax: null, amountLabel: `Over ${formatDollars(min)}` };
  }
  const max = Number(amountMax);
  return {
    amountMin: min,
    amountMax: max,
    amountLabel: `${formatDollars(min)} - ${formatDollars(max)}`,
  };
}

function compareRank(a, b) {
  return b.trades - a.trades || b.politicians - a.politicians || a.ticker.localeCompare(b.ticker);
}

function compareClusters(a, b) {
  return b.politicians - a.politicians || b.trades - a.trades || a.ticker.localeCompare(b.ticker);
}

function compareBuyers(a, b) {
  const ad = a.dates[0] || '';
  const bd = b.dates[0] || '';
  if (ad !== bd) return ad < bd ? -1 : 1;
  return String(a.name).localeCompare(String(b.name));
}

function inWindow(date, from, to) {
  return Boolean(date) && date >= from && date <= to;
}

function rankSide(trades, txType, limit) {
  const groups = new Map();
  for (const trade of trades) {
    if (trade.txType !== txType || !trade.tickerNorm) continue;
    let group = groups.get(trade.tickerNorm);
    if (!group) {
      group = {
        ticker: trade.tickerNorm,
        people: new Set(),
        trades: 0,
        amounts: emptyAmounts(),
        matchable: false,
      };
      groups.set(trade.tickerNorm, group);
    }
    group.people.add(trade.personKey);
    group.trades += 1;
    addAmount(group.amounts, trade.amountRange);
    if (matchableAssetClass(trade.assetClass)) group.matchable = true;
  }
  return [...groups.values()]
    .map((group) => ({
      ticker: group.ticker,
      trades: group.trades,
      politicians: group.people.size,
      matchable: group.matchable,
      ...amountSpan(group.amounts),
    }))
    .sort(compareRank)
    .slice(0, limit);
}

function clusterBuys(trades, minPeople, limit) {
  const byTicker = new Map();
  for (const trade of trades) {
    if (trade.txType !== 'buy' || !trade.tickerNorm) continue;
    let people = byTicker.get(trade.tickerNorm);
    if (!people) {
      people = new Map();
      byTicker.set(trade.tickerNorm, people);
    }
    let person = people.get(trade.personKey);
    if (!person) {
      person = {
        personKey: trade.personKey,
        name: trade.personName,
        party: trade.party || null,
        office: trade.office,
        filerStatus: trade.filerStatus || null,
        dates: new Set(),
        trades: 0,
        amounts: emptyAmounts(),
        latest: '',
        matchable: false,
      };
      people.set(trade.personKey, person);
    }
    person.trades += 1;
    if (trade.disclosedDate) person.dates.add(trade.disclosedDate);
    addAmount(person.amounts, trade.amountRange);
    if (matchableAssetClass(trade.assetClass)) person.matchable = true;
    const stamp = `${trade.disclosedDate || ''}\n${trade.id || ''}`;
    if (stamp >= person.latest) {
      person.latest = stamp;
      person.name = trade.personName;
      person.party = trade.party || null;
      person.office = trade.office;
      person.filerStatus = trade.filerStatus || null;
    }
  }

  const clusters = [];
  for (const [ticker, people] of byTicker) {
    if (people.size < minPeople) continue;
    const buyers = [...people.values()].map((person) => ({
      personKey: person.personKey,
      name: person.name,
      party: person.party,
      office: person.office,
      filerStatus: person.filerStatus,
      dates: [...person.dates].sort(),
      trades: person.trades,
      ...amountSpan(person.amounts),
    })).sort(compareBuyers);
    const amounts = emptyAmounts();
    let tradeCount = 0;
    let matchable = false;
    for (const person of people.values()) {
      mergeAmounts(amounts, person.amounts);
      tradeCount += person.trades;
      if (person.matchable) matchable = true;
    }
    clusters.push({
      ticker,
      politicians: people.size,
      trades: tradeCount,
      matchable,
      ...amountSpan(amounts),
      buyers,
    });
  }
  clusters.sort(compareClusters);
  return { clusterTotal: clusters.length, clusters: clusters.slice(0, limit) };
}

function countExcluded(filings, trades, query) {
  const parsed = new Set();
  for (const trade of trades) {
    if (trade.tickerNorm) parsed.add(trade.filingId);
  }
  let n = 0;
  for (const filing of filings) {
    if (!inWindow(filing.filedDate, query.from, query.to)) continue;
    if (!filerMatches(filing.filerStatus, query.filer)) continue;
    if (parsed.has(filing.id)) continue;
    n += 1;
  }
  return n;
}

export function aggregateSummary({ trades = [], filings = [], query = {}, now } = {}) {
  const q = normalizeSummaryQuery(query, now);
  const scoped = [];
  for (const trade of trades) {
    if (!inWindow(trade.disclosedDate, q.from, q.to)) continue;
    if (!filerMatches(trade.filerStatus, q.filer)) continue;
    if (!trade.tickerNorm) continue;
    scoped.push(trade);
  }
  const { clusters, clusterTotal } = clusterBuys(scoped, q.clusterMin, q.clusterLimit);
  return {
    window: q.windowDays,
    from: q.from,
    to: q.to,
    filer: q.filer,
    clusterMin: q.clusterMin,
    excludedFilings: countExcluded(filings, trades, q),
    bought: rankSide(scoped, 'buy', q.rankLimit),
    sold: rankSide(scoped, 'sell', q.rankLimit),
    clusters,
    clusterTotal,
  };
}

function num(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function mapRankRow(row) {
  return {
    ticker: row.ticker_norm,
    trades: Number(row.trades) || 0,
    politicians: Number(row.politicians) || 0,
    matchable: row.matchable === true,
    ...spanFromSums(row.amount_min, row.amount_max, row.open_rows, row.known_amounts),
  };
}

export function summaryFromSql({ rankRows = [], clusterRows = [], excluded = 0, query = {}, now } = {}) {
  const q = normalizeSummaryQuery(query, now);
  const bought = [];
  const sold = [];
  for (const row of rankRows) {
    const mapped = mapRankRow(row);
    if (row.tx_type === 'buy') bought.push(mapped);
    else if (row.tx_type === 'sell') sold.push(mapped);
  }
  const clusters = [];
  const seen = new Map();
  let clusterTotal = 0;
  for (const row of clusterRows) {
    clusterTotal = Number(row.cluster_total) || clusterTotal;
    let cluster = seen.get(row.ticker_norm);
    if (!cluster) {
      cluster = {
        ticker: row.ticker_norm,
        politicians: Number(row.politicians) || 0,
        trades: Number(row.cluster_trades) || 0,
        matchable: row.cluster_matchable === true,
        ...spanFromSums(row.cluster_min, row.cluster_max, row.cluster_open, row.cluster_known),
        buyers: [],
      };
      seen.set(row.ticker_norm, cluster);
      clusters.push(cluster);
    }
    const dates = Array.isArray(row.dates) ? row.dates.map((d) => String(d).slice(0, 10)) : [];
    cluster.buyers.push({
      personKey: row.person_key,
      name: row.person_name,
      party: row.party || null,
      office: row.office,
      filerStatus: row.filer_status || null,
      dates,
      trades: Number(row.trades) || 0,
      ...spanFromSums(row.amount_min, row.amount_max, row.open_rows, row.known_amounts),
    });
  }
  return {
    window: q.windowDays,
    from: q.from,
    to: q.to,
    filer: q.filer,
    clusterMin: q.clusterMin,
    excludedFilings: num(excluded) || 0,
    bought,
    sold,
    clusters,
    clusterTotal,
  };
}

export function attachHeldModels(summary, symbols) {
  const held = heldIndex(symbols);
  const mark = (row) => {
    const models = row.matchable ? (held.get(row.ticker) || []) : [];
    const { matchable, ...rest } = row;
    const names = models.map((model) => model.name || model.key);
    return {
      ...rest,
      held: names.length > 0,
      ...(names.length ? { models: names } : {}),
    };
  };
  return {
    ...summary,
    bought: (summary.bought || []).map(mark),
    sold: (summary.sold || []).map(mark),
    clusters: (summary.clusters || []).map(mark),
  };
}

const SCOPED_COLUMNS = `
         ticker_norm, person_key, asset_class,
         ${amountMinSql('amount_range')} AS amount_min,
         ${amountMaxSql('amount_range')} AS amount_max`;

export const SUMMARY_RANK_SQL = `
WITH scoped AS (
  SELECT tx_type, ${SCOPED_COLUMNS}
  FROM politician_trades
  WHERE disclosed_date >= $1::date
    AND disclosed_date <= $2::date
    AND ticker_norm IS NOT NULL
    AND tx_type IN ('buy', 'sell')
    AND ${filerSql('filer_status')}
),
grouped AS (
  SELECT tx_type,
         ticker_norm,
         count(*)::int AS trades,
         count(DISTINCT person_key)::int AS politicians,
         sum(amount_min)::bigint AS amount_min,
         sum(amount_max)::bigint AS amount_max,
         count(*) FILTER (WHERE amount_min IS NULL OR amount_max IS NULL)::int AS open_rows,
         count(*) FILTER (WHERE amount_min IS NOT NULL)::int AS known_amounts,
         bool_or(asset_class IN ('stock', 'etf', 'fund')) AS matchable
  FROM scoped
  GROUP BY tx_type, ticker_norm
),
ranked AS (
  SELECT grouped.*,
         row_number() OVER (
           PARTITION BY tx_type
           ORDER BY trades DESC, politicians DESC, ticker_norm
         ) AS rn
  FROM grouped
)
SELECT tx_type, ticker_norm, trades, politicians, amount_min, amount_max,
       open_rows, known_amounts, matchable
FROM ranked
WHERE rn <= ${RANK_LIMIT}
ORDER BY tx_type, rn
`;

export const SUMMARY_CLUSTER_SQL = `
WITH scoped AS (
  SELECT id, person_name, office, party, filer_status, disclosed_date,
         ${SCOPED_COLUMNS}
  FROM politician_trades
  WHERE disclosed_date >= $1::date
    AND disclosed_date <= $2::date
    AND ticker_norm IS NOT NULL
    AND tx_type = 'buy'
    AND ${filerSql('filer_status')}
),
buyers AS (
  SELECT ticker_norm,
         person_key,
         (array_agg(person_name ORDER BY disclosed_date DESC, id DESC))[1] AS person_name,
         (array_agg(office ORDER BY disclosed_date DESC, id DESC))[1] AS office,
         (array_agg(party ORDER BY disclosed_date DESC, id DESC))[1] AS party,
         (array_agg(filer_status ORDER BY disclosed_date DESC, id DESC))[1] AS filer_status,
         count(*)::int AS trades,
         array_agg(DISTINCT to_char(disclosed_date, 'YYYY-MM-DD') ORDER BY to_char(disclosed_date, 'YYYY-MM-DD')) AS dates,
         sum(amount_min)::bigint AS amount_min,
         sum(amount_max)::bigint AS amount_max,
         count(*) FILTER (WHERE amount_min IS NULL OR amount_max IS NULL)::int AS open_rows,
         count(*) FILTER (WHERE amount_min IS NOT NULL)::int AS known_amounts,
         bool_or(asset_class IN ('stock', 'etf', 'fund')) AS matchable
  FROM scoped
  GROUP BY ticker_norm, person_key
),
clusters AS (
  SELECT ticker_norm,
         count(*)::int AS politicians,
         sum(trades)::int AS trades,
         sum(amount_min)::bigint AS amount_min,
         sum(amount_max)::bigint AS amount_max,
         sum(open_rows)::int AS open_rows,
         sum(known_amounts)::int AS known_amounts,
         bool_or(matchable) AS matchable,
         count(*) OVER () AS cluster_total
  FROM buyers
  GROUP BY ticker_norm
  HAVING count(*) >= $4::int
),
top_clusters AS (
  SELECT * FROM clusters
  ORDER BY politicians DESC, trades DESC, ticker_norm
  LIMIT ${CLUSTER_LIMIT}
)
SELECT c.cluster_total,
       c.politicians,
       c.trades AS cluster_trades,
       c.amount_min AS cluster_min,
       c.amount_max AS cluster_max,
       c.open_rows AS cluster_open,
       c.known_amounts AS cluster_known,
       c.matchable AS cluster_matchable,
       b.ticker_norm, b.person_key, b.person_name, b.office, b.party, b.filer_status,
       b.trades, b.dates, b.amount_min, b.amount_max, b.open_rows, b.known_amounts
FROM top_clusters c
JOIN buyers b USING (ticker_norm)
ORDER BY c.politicians DESC, c.trades DESC, c.ticker_norm, b.dates[1], b.person_name
`;

export const SUMMARY_EXCLUDED_SQL = `
SELECT count(*)::int AS n
FROM politician_filings f
WHERE f.filed_date >= $1::date
  AND f.filed_date <= $2::date
  AND ${filerSql('f.filer_status')}
  AND NOT EXISTS (
    SELECT 1 FROM politician_trades t
    WHERE t.filing_id = f.id
      AND t.ticker_norm IS NOT NULL
  )
`;
