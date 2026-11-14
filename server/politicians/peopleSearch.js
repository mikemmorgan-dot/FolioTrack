// Name typeahead for the politician screen.
// Postgres matches with a built-in GIN index on to_tsvector('simple', …),
// which supports prefix queries (pelo → pelosi) without an extra extension.
// The memory store uses the same token rules.

import { nameFold } from './normalize.js';
import { SUMMARY_WINDOWS, summaryBounds, usTodayIso } from './summary.js';

export const PEOPLE_SEARCH_LIMIT = 10;
export const PEOPLE_SEARCH_MIN = 2;

const TOKEN = /^[a-z0-9]+$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

export function peopleSearchQuery(raw) {
  const folded = nameFold(raw).slice(0, 80);
  const tokens = folded.split(' ').filter((token) => TOKEN.test(token)).slice(0, 6);
  if (!tokens.some((token) => token.length >= PEOPLE_SEARCH_MIN)) return null;
  return {
    tokens,
    // simple dictionary does not stem, so a prefix is the typed letters.
    tsquery: tokens.map((token) => `${token}:*`).join(' & '),
  };
}

// Every typed token is a prefix of the first name, the last name, or another
// word in the display name. "nancy", "pelosi", "Nancy Pelosi", and "pelo" match.
export function personNameMatches(personName, personKey, tokens) {
  if (!tokens?.length) return false;
  const hay = `${nameFold(personName)} ${nameFold(String(personKey || '').replace(/:/g, ' '))}`
    .split(/\s+/)
    .filter(Boolean);
  return tokens.every((token) => hay.some((part) => part.startsWith(token)));
}

export function buildPeopleSearchSql(tsquery) {
  const where = `
    to_tsvector('simple', person_name) @@ to_tsquery('simple', $1)
    OR to_tsvector('simple', replace(person_key, ':', ' ')) @@ to_tsquery('simple', $1)
  `;
  const sql = `
WITH keys AS (
  SELECT person_key FROM politician_trades
  WHERE ${where}
  UNION
  SELECT person_key FROM politician_filings
  WHERE ${where}
),
counts AS (
  SELECT t.person_key,
         count(*)::int AS trade_count,
         max(t.disclosed_date) AS latest_disclosure
  FROM politician_trades t
  JOIN keys k ON k.person_key = t.person_key
  GROUP BY t.person_key
),
identity AS (
  SELECT DISTINCT ON (f.person_key)
         f.person_key, f.person_name, f.office, f.party, f.state, f.filer_status
  FROM politician_filings f
  JOIN keys k ON k.person_key = f.person_key
  ORDER BY f.person_key, f.filed_date DESC NULLS LAST, f.id DESC
)
SELECT i.person_key, i.person_name, i.office, i.party, i.state, i.filer_status,
       COALESCE(c.trade_count, 0)::int AS trade_count,
       c.latest_disclosure
FROM identity i
LEFT JOIN counts c ON c.person_key = i.person_key
ORDER BY trade_count DESC, i.person_name ASC, i.person_key ASC
LIMIT ${PEOPLE_SEARCH_LIMIT}
`;
  return { sql, params: [tsquery] };
}

export function personWindowBounds(query = {}, now = new Date()) {
  const windowRaw = Number(query.window);
  if (!SUMMARY_WINDOWS.includes(windowRaw)) return null;
  const asOf = DAY.test(query.asOf) ? query.asOf : usTodayIso(now);
  const { from, to } = summaryBounds(windowRaw, asOf);
  return { windowDays: windowRaw, asOf, from, to };
}

function isoDay(value) {
  if (value == null || value === '') return null;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  const s = String(value);
  return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : null;
}

export function peopleFromRows(rows) {
  return rows.map((row) => ({
    personKey: row.person_key,
    personName: row.person_name,
    office: row.office,
    party: row.party || null,
    state: row.state || null,
    filerStatus: row.filer_status || null,
    tradeCount: Number(row.trade_count) || 0,
    latestDisclosure: isoDay(row.latest_disclosure),
  }));
}
