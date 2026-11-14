// Postgres politician tables. Reads are paged or aggregated. A poll asks only
// for the filing keys it is about to download, not for every stored trade.

import { canonicalTicker } from './normalize.js';
import { isReadableAnnual, selectCurrentAnnual } from './annualRecords.js';
import { presentHoldings } from './holdingsView.js';
import { heldIndex } from './records.js';
import { OCR_CLAIM_MS, OCR_FAILED_NOTE, PENDING_OCR_NOTE } from './ocrPending.js';
import { applyPoliticianAlertPatch, coercePoliticianAlertSettings } from './settings.js';
import { normalizeFeedQuery } from './memoryStore.js';
import {
  PERSON_ROLLUP_SQL,
  SUMMARY_CLUSTER_SQL,
  SUMMARY_EXCLUDED_SQL,
  SUMMARY_NET_SQL,
  SUMMARY_RANK_SQL,
  normalizeSummaryQuery,
  rollupFromRows,
  summaryFromSql,
} from './summary.js';

function day(value) {
  if (value == null || value === '') return null;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  const s = String(value);
  return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : null;
}

function isoTs(value) {
  if (value == null || value === '') return null;
  if (value instanceof Date) return value.toISOString();
  const t = Date.parse(value);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

const FILING_COLUMNS = `
  id, source, filing_key, person_key, person_name, office, party, filer_status,
  state, district, filed_date, source_url, parse_status, parse_note,
  ocr_done, ocr_page, page_count, ocr_claimed_at
`;

function rowToFiling(r) {
  return {
    id: r.id,
    source: r.source,
    filingKey: r.filing_key,
    personKey: r.person_key,
    personName: r.person_name,
    office: r.office,
    party: r.party || null,
    filerStatus: r.filer_status || null,
    state: r.state || null,
    district: r.district || null,
    filedDate: day(r.filed_date),
    sourceUrl: r.source_url,
    parseStatus: r.parse_status,
    parseNote: r.parse_note || null,
    ocrDone: r.ocr_done === true,
    ocrPage: r.ocr_page,
    pageCount: r.page_count,
    ocrClaimedAt: isoTs(r.ocr_claimed_at),
  };
}

const FEED_SQL = `
SELECT kind, id, disclosed_date, person_key, person_name, office, party, state,
       owner, ticker, ticker_norm, asset, asset_class, tx_type, partial,
       tx_date, lag_days, amount_range, source_url, parse_note, ocr, ocr_confidence,
       filer_status, ticker_source, ticker_match_confidence
FROM (
  SELECT 'trade'::text AS kind, t.id, t.disclosed_date, t.person_key, t.person_name,
         t.office, t.party, t.state, t.owner, t.ticker, t.ticker_norm, t.asset,
         t.asset_class, t.tx_type, t.partial, t.tx_date, t.lag_days, t.amount_range,
         t.source_url, NULL::text AS parse_note, t.ocr, t.ocr_confidence, t.filer_status,
         t.ticker_source, t.ticker_match_confidence
  FROM politician_trades t
  UNION ALL
  SELECT 'review'::text, f.id, f.filed_date, f.person_key, f.person_name,
         f.office, f.party, f.state, NULL::text, NULL::text, NULL::text, NULL::text,
         NULL::text, NULL::text, false, NULL::date, NULL::int, NULL::text,
         f.source_url, f.parse_note, false, NULL::int, f.filer_status,
         NULL::text, NULL::int
  FROM politician_filings f
  WHERE f.parse_status IN ('needs_manual_review', 'partial')
) feed
`;

function rowToItem(r) {
  return {
    kind: r.kind,
    id: r.id,
    personKey: r.person_key,
    personName: r.person_name,
    office: r.office,
    party: r.party || null,
    filerStatus: r.filer_status || null,
    state: r.state || null,
    owner: r.owner || null,
    ticker: r.ticker || null,
    tickerNorm: r.ticker_norm || null,
    asset: r.asset || null,
    assetClass: r.asset_class || null,
    txType: r.tx_type || null,
    partial: r.partial === true,
    txDate: day(r.tx_date),
    disclosedDate: day(r.disclosed_date),
    lagDays: r.lag_days == null ? null : Number(r.lag_days),
    amountRange: r.amount_range || null,
    sourceUrl: r.source_url,
    parseNote: r.parse_note || null,
    ocr: r.ocr === true,
    ocrConfidence: r.ocr_confidence == null ? null : Number(r.ocr_confidence),
    tickerSource: r.ticker_source || null,
    tickerMatchConfidence: r.ticker_match_confidence == null ? null : Number(r.ticker_match_confidence),
  };
}

export function buildFeedFilter(query, heldNorms) {
  const params = [];
  const where = [];
  const add = (sql, ...values) => {
    const parts = sql.split('$?');
    let out = parts[0];
    values.forEach((value, i) => {
      params.push(value);
      out += `$${params.length}${parts[i + 1] || ''}`;
    });
    where.push(out);
  };
  if (query.office === 'president') where.push(`office IN ('president', 'vice-president')`);
  else if (query.office) add('office = $?', query.office);
  if (query.party) add('party = $?', query.party);
  if (query.filer === 'candidate') where.push(`filer_status = 'candidate'`);
  else if (query.filer === 'member') where.push(`filer_status IS DISTINCT FROM 'candidate'`);
  if (query.personKey) add('person_key = $?', query.personKey);
  if (query.from) add('disclosed_date >= $?::date', query.from);
  if (query.to) add('disclosed_date <= $?::date', query.to);
  if (query.side) add('tx_type = $?', query.side);
  if (query.ticker) add('ticker_norm = $?', query.ticker);
  if (query.heldOnly) {
    where.push(`kind = 'trade' AND asset_class IN ('stock', 'etf', 'fund')`);
    add('ticker_norm = ANY($?::text[])', heldNorms || []);
  }
  if (query.q) {
    const pattern = `%${query.q.replace(/[%_\\]/g, '\\$&')}%`;
    add(
      `(person_name ILIKE $? ESCAPE '\\' OR COALESCE(ticker, '') ILIKE $? ESCAPE '\\' OR COALESCE(asset, '') ILIKE $? ESCAPE '\\')`,
      pattern,
      pattern,
      pattern,
    );
  }
  return { whereSql: where.length ? `WHERE ${where.join(' AND ')}` : '', params };
}

const HELD_SQL = `
WITH latest AS (
  SELECT DISTINCT ON (model_key) id
  FROM versions
  ORDER BY model_key, effective_date DESC, created_at DESC, id DESC
)
SELECT i.symbol, m.key AS model_key, m.name AS model_name
FROM latest l
JOIN versions v ON v.id = l.id
JOIN models m ON m.key = v.model_key
JOIN version_holdings vh ON vh.version_id = l.id
JOIN instruments i ON i.id = vh.instrument_id
`;

export function installPgPolitician(Store) {
  const readSetting = async function readSetting(key) {
    const { rows } = await this.q('SELECT value FROM app_settings WHERE key = $1', [key]);
    return rows[0]?.value ?? null;
  };
  const writeSetting = async function writeSetting(key, value) {
    await this.q(
      `INSERT INTO app_settings (key, value, updated_at) VALUES ($1, $2::jsonb, now())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      [key, JSON.stringify(value)],
    );
    return value;
  };

  Store.prototype.getPoliticianAlertSettings = async function getPoliticianAlertSettings() {
    return coercePoliticianAlertSettings(await readSetting.call(this, 'politicianAlerts') || {});
  };
  Store.prototype.savePoliticianAlertSettings = async function savePoliticianAlertSettings(patch) {
    const next = applyPoliticianAlertPatch(await this.getPoliticianAlertSettings(), patch);
    await writeSetting.call(this, 'politicianAlerts', next);
    return next;
  };
  Store.prototype.getPoliticianPollState = async function getPoliticianPollState() {
    return (await readSetting.call(this, 'politicianPoll')) || {};
  };
  Store.prototype.setPoliticianPollState = async function setPoliticianPollState(state) {
    await writeSetting.call(this, 'politicianPoll', state || {});
    return state || {};
  };
  Store.prototype.getPoliticianRoster = async function getPoliticianRoster() {
    return readSetting.call(this, 'politicianRoster');
  };
  Store.prototype.setPoliticianRoster = async function setPoliticianRoster(roster) {
    await writeSetting.call(this, 'politicianRoster', roster);
    return roster;
  };
  Store.prototype.existingPoliticianKeys = async function existingPoliticianKeys(source, keys) {
    if (!keys?.length) return [];
    const { rows } = await this.q(
      `SELECT filing_key FROM politician_filings WHERE source = $1 AND filing_key = ANY($2::text[])`,
      [source, keys],
    );
    return rows.map((r) => r.filing_key);
  };
  Store.prototype.insertPoliticianBundle = async function insertPoliticianBundle(filing, trades = []) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const inserted = await this.qOn(
        client,
        `INSERT INTO politician_filings (
           id, source, filing_key, person_key, person_name, office, party, filer_status, state, district,
           filed_date, source_url, parse_status, parse_note, ocr_done, ocr_page, page_count
         ) VALUES (
           $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::date,$12,$13,$14,$15,$16,$17
         )
         ON CONFLICT (source, filing_key) DO NOTHING
         RETURNING id`,
        [
          filing.id, filing.source, filing.filingKey, filing.personKey, filing.personName,
          filing.office, filing.party || null, filing.filerStatus || null, filing.state || null, filing.district || null,
          filing.filedDate || null, filing.sourceUrl, filing.parseStatus, filing.parseNote || null,
          filing.ocrDone === true, filing.ocrPage ?? null, filing.pageCount ?? null,
        ],
      );
      if (!inserted.rows.length) {
        await client.query('ROLLBACK');
        return { created: false, trades: 0 };
      }
      if (trades.length) {
        const col = (fn) => trades.map(fn);
        await this.qOn(
          client,
          `INSERT INTO politician_trades (
             id, filing_id, row_index, person_key, person_name, office, party, filer_status, state,
             owner, ticker, ticker_norm, asset, asset_class, tx_type, partial,
             tx_date, disclosed_date, lag_days, amount_range, source_url, ocr, ocr_confidence,
             digest_pending, ticker_source, ticker_match_confidence, name_match_at
           )
           SELECT * FROM unnest(
             $1::text[], $2::text[], $3::int[], $4::text[], $5::text[], $6::text[], $7::text[], $8::text[], $9::text[],
             $10::text[], $11::text[], $12::text[], $13::text[], $14::text[], $15::text[], $16::boolean[],
             $17::date[], $18::date[], $19::int[], $20::text[], $21::text[], $22::boolean[], $23::int[],
             $24::boolean[], $25::text[], $26::int[], $27::timestamptz[]
           )
           ON CONFLICT (filing_id, row_index) DO NOTHING`,
          [
            col((t) => t.id),
            col((t) => t.filingId),
            col((t) => t.rowIndex),
            col((t) => t.personKey),
            col((t) => t.personName),
            col((t) => t.office),
            col((t) => t.party || null),
            col((t) => t.filerStatus || null),
            col((t) => t.state || null),
            col((t) => t.owner),
            col((t) => t.ticker || null),
            col((t) => t.tickerNorm || null),
            col((t) => t.asset),
            col((t) => t.assetClass),
            col((t) => t.txType),
            col((t) => t.partial === true),
            col((t) => t.txDate || null),
            col((t) => t.disclosedDate || null),
            col((t) => (t.lagDays == null ? null : t.lagDays)),
            col((t) => t.amountRange),
            col((t) => t.sourceUrl),
            col((t) => t.ocr === true),
            col((t) => (t.ocrConfidence == null ? null : t.ocrConfidence)),
            col((t) => t.digestPending === true),
            col((t) => t.tickerSource || null),
            col((t) => (t.tickerMatchConfidence == null ? null : t.tickerMatchConfidence)),
            col((t) => t.nameMatchAt || null),
          ],
        );
      }
      await client.query('COMMIT');
      return { created: true, trades: trades.length };
    } catch (err) {
      try { await client.query('ROLLBACK'); } catch { /* already closed */ }
      throw err;
    } finally {
      client.release();
    }
  };
  Store.prototype.getPoliticianFilings = async function getPoliticianFilings(source, keys) {
    if (!keys?.length) return [];
    const { rows } = await this.q(
      `SELECT id, source, filing_key, parse_status, parse_note, ocr_done, ocr_page, page_count,
              source_url, ocr_claimed_at
       FROM politician_filings WHERE source = $1 AND filing_key = ANY($2::text[])`,
      [source, keys],
    );
    return rows.map((r) => ({
      id: r.id,
      source: r.source,
      filingKey: r.filing_key,
      parseStatus: r.parse_status,
      parseNote: r.parse_note || null,
      ocrDone: r.ocr_done === true,
      ocrPage: r.ocr_page,
      pageCount: r.page_count,
      sourceUrl: r.source_url,
      ocrClaimedAt: isoTs(r.ocr_claimed_at),
    }));
  };
  Store.prototype.updatePoliticianFiling = async function updatePoliticianFiling(filing, { protectClaim = false } = {}) {
    const staleBefore = new Date(Date.now() - OCR_CLAIM_MS).toISOString();
    const result = await this.q(
      `UPDATE politician_filings
       SET parse_status = $2, parse_note = $3, ocr_done = $4, ocr_page = $5, page_count = $6,
           filer_status = $7
       WHERE id = $1
         AND (
           $8::boolean = false
           OR parse_status IS DISTINCT FROM 'ocr_running'
           OR ocr_claimed_at IS NULL
           OR ocr_claimed_at < $9::timestamptz
         )`,
      [
        filing.id,
        filing.parseStatus,
        filing.parseNote || null,
        filing.ocrDone === true,
        filing.ocrPage ?? null,
        filing.pageCount ?? null,
        filing.filerStatus || null,
        protectClaim === true,
        staleBefore,
      ],
    );
    if (protectClaim && !result.rowCount) return { skipped: true };
    return filing;
  };
  Store.prototype.claimPoliticianOcr = async function claimPoliticianOcr(filing, { force = false, now = new Date(), staleMs = OCR_CLAIM_MS } = {}) {
    const claimedAt = (now instanceof Date ? now : new Date(now)).toISOString();
    const staleBefore = new Date(Date.parse(claimedAt) - staleMs).toISOString();
    const updated = await this.q(
      `UPDATE politician_filings
       SET parse_status = 'ocr_running', parse_note = $1, ocr_claimed_at = $2::timestamptz, ocr_done = false
       WHERE source = $3 AND filing_key = $4
         AND (
           $5::boolean
           OR parse_status = 'pending_ocr'
           OR (parse_status = 'ocr_running' AND (ocr_claimed_at IS NULL OR ocr_claimed_at < $6::timestamptz))
           OR (ocr_done = true AND COALESCE(parse_note, '') ILIKE '%OCR tools are not installed%')
           OR (ocr_done = false AND parse_status IS DISTINCT FROM 'ocr_running')
         )
       RETURNING id`,
      ['OCR in progress', claimedAt, filing.source, filing.filingKey, force === true, staleBefore],
    );
    if (updated.rows.length) return { claimed: true, id: updated.rows[0].id };
    const inserted = await this.q(
      `INSERT INTO politician_filings (
         id, source, filing_key, person_key, person_name, office, party, filer_status, state, district,
         filed_date, source_url, parse_status, parse_note, ocr_done, ocr_claimed_at
       ) VALUES (
         $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::date,$12,'ocr_running',$13,false,$14::timestamptz
       )
       ON CONFLICT (source, filing_key) DO NOTHING
       RETURNING id`,
      [
        filing.id, filing.source, filing.filingKey, filing.personKey, filing.personName,
        filing.office, filing.party || null, filing.filerStatus || null, filing.state || null, filing.district || null,
        filing.filedDate || null, filing.sourceUrl, 'OCR in progress', claimedAt,
      ],
    );
    if (inserted.rows.length) return { claimed: true, id: inserted.rows[0].id, created: true };
    return { claimed: false, id: filing.id };
  };
  Store.prototype.releasePoliticianOcrClaim = async function releasePoliticianOcrClaim(id) {
    const result = await this.q(
      `UPDATE politician_filings
       SET parse_status = 'pending_ocr', parse_note = $2, ocr_done = false, ocr_claimed_at = NULL
       WHERE id = $1 AND parse_status = 'ocr_running'`,
      [id, PENDING_OCR_NOTE],
    );
    return (result.rowCount || 0) > 0;
  };
  Store.prototype.recoverFailedPresidentialOcr = async function recoverFailedPresidentialOcr() {
    const result = await this.q(
      `UPDATE politician_filings AS f
       SET parse_status = 'pending_ocr',
           parse_note = $2,
           ocr_done = false,
           ocr_claimed_at = NULL
       WHERE f.source = 'oge'
         AND f.office IN ('president', 'vice-president')
         AND f.parse_note = $1
         AND NOT EXISTS (
           SELECT 1 FROM politician_trades AS t WHERE t.filing_id = f.id
         )`,
      [OCR_FAILED_NOTE, PENDING_OCR_NOTE],
    );
    return result.rowCount || 0;
  };
  Store.prototype.listPendingPresidentialFilings = async function listPendingPresidentialFilings({ limit = 20, now = new Date() } = {}) {
    const staleBefore = new Date((now instanceof Date ? now.getTime() : Date.parse(now)) - OCR_CLAIM_MS).toISOString();
    const cap = Math.min(20, Math.max(1, Number(limit) || 20));
    const { rows } = await this.q(
      `SELECT ${FILING_COLUMNS}
       FROM politician_filings
       WHERE source = 'oge'
         AND office IN ('president', 'vice-president')
         AND (source_url ILIKE '%$FILE%' OR source_url ILIKE '%24FILE%')
         AND (
           parse_status = 'pending_ocr'
           OR (parse_status = 'ocr_running' AND (ocr_claimed_at IS NULL OR ocr_claimed_at < $1::timestamptz))
           OR (ocr_done = true AND COALESCE(parse_note, '') ILIKE '%OCR tools are not installed%')
         )
       ORDER BY filed_date DESC NULLS LAST, filing_key
       LIMIT $2`,
      [staleBefore, cap],
    );
    return rows.map(rowToFiling);
  };
  Store.prototype.getPresidentialFiling = async function getPresidentialFiling(filingKey) {
    const { rows } = await this.q(
      `SELECT ${FILING_COLUMNS}
       FROM politician_filings
       WHERE source = 'oge' AND filing_key = $1`,
      [filingKey],
    );
    return rows[0] ? rowToFiling(rows[0]) : null;
  };
  Store.prototype.listDigestPendingTrades = async function listDigestPendingTrades(limit = 80) {
    const cap = Math.min(80, Math.max(1, Number(limit) || 80));
    const { rows } = await this.q(
      `SELECT id, person_key, person_name, office, party, filer_status, state,
              owner, ticker, ticker_norm, asset, asset_class, tx_type, partial,
              tx_date, disclosed_date, lag_days, amount_range, source_url, filing_id,
              ticker_source, ticker_match_confidence
       FROM politician_trades
       WHERE digest_pending
         AND emailed_at IS NULL
       ORDER BY disclosed_date DESC NULLS LAST, id DESC
       LIMIT $1`,
      [cap],
    );
    return rows.map((r) => ({
      id: r.id,
      filingId: r.filing_id,
      personKey: r.person_key,
      personName: r.person_name,
      office: r.office,
      party: r.party || null,
      filerStatus: r.filer_status || null,
      state: r.state || null,
      owner: r.owner,
      ticker: r.ticker || null,
      tickerNorm: r.ticker_norm || null,
      asset: r.asset,
      assetClass: r.asset_class,
      txType: r.tx_type,
      partial: r.partial === true,
      txDate: day(r.tx_date),
      disclosedDate: day(r.disclosed_date),
      lagDays: r.lag_days == null ? null : Number(r.lag_days),
      amountRange: r.amount_range,
      sourceUrl: r.source_url,
      digestPending: true,
      tickerSource: r.ticker_source || null,
      tickerMatchConfidence: r.ticker_match_confidence == null ? null : Number(r.ticker_match_confidence),
    }));
  };
  Store.prototype.markDigestPending = async function markDigestPending(ids = []) {
    const list = (ids || []).filter(Boolean);
    if (!list.length) return [];
    const result = await this.q(
      `UPDATE politician_trades
       SET digest_pending = true
       WHERE emailed_at IS NULL
         AND id = ANY($1::text[])
       RETURNING id`,
      [list],
    );
    return (result.rows || []).map((row) => row.id);
  };
  Store.prototype.markTradesEmailed = async function markTradesEmailed(ids = [], emailedAt = new Date().toISOString()) {
    const list = (ids || []).filter(Boolean);
    if (!list.length) return 0;
    const result = await this.q(
      `UPDATE politician_trades
       SET emailed_at = $2::timestamptz,
           digest_pending = false
       WHERE emailed_at IS NULL
         AND id = ANY($1::text[])`,
      [list, emailedAt],
    );
    return result.rowCount || 0;
  };
  Store.prototype.insertPoliticianTrades = async function insertPoliticianTrades(trades = []) {
    if (!trades.length) return { inserted: 0 };
    const col = (fn) => trades.map(fn);
    const result = await this.q(
      `INSERT INTO politician_trades (
         id, filing_id, row_index, person_key, person_name, office, party, filer_status, state,
         owner, ticker, ticker_norm, asset, asset_class, tx_type, partial,
         tx_date, disclosed_date, lag_days, amount_range, source_url, ocr, ocr_confidence,
         digest_pending, ticker_source, ticker_match_confidence, name_match_at
       )
       SELECT * FROM unnest(
         $1::text[], $2::text[], $3::int[], $4::text[], $5::text[], $6::text[], $7::text[], $8::text[], $9::text[],
         $10::text[], $11::text[], $12::text[], $13::text[], $14::text[], $15::text[], $16::boolean[],
         $17::date[], $18::date[], $19::int[], $20::text[], $21::text[], $22::boolean[], $23::int[],
         $24::boolean[], $25::text[], $26::int[], $27::timestamptz[]
       )
       ON CONFLICT (filing_id, row_index) DO NOTHING`,
      [
        col((t) => t.id), col((t) => t.filingId), col((t) => t.rowIndex), col((t) => t.personKey),
        col((t) => t.personName), col((t) => t.office), col((t) => t.party || null), col((t) => t.filerStatus || null), col((t) => t.state || null),
        col((t) => t.owner), col((t) => t.ticker || null), col((t) => t.tickerNorm || null), col((t) => t.asset),
        col((t) => t.assetClass), col((t) => t.txType), col((t) => t.partial === true),
        col((t) => t.txDate || null), col((t) => t.disclosedDate || null),
        col((t) => (t.lagDays == null ? null : t.lagDays)), col((t) => t.amountRange), col((t) => t.sourceUrl),
        col((t) => t.ocr === true), col((t) => (t.ocrConfidence == null ? null : t.ocrConfidence)),
        col((t) => t.digestPending === true),
        col((t) => t.tickerSource || null),
        col((t) => (t.tickerMatchConfidence == null ? null : t.tickerMatchConfidence)),
        col((t) => t.nameMatchAt || null),
      ],
    );
    return { inserted: result.rowCount || 0 };
  };
  Store.prototype.getTickerNameCatalog = async function getTickerNameCatalog() {
    const doc = await readSetting.call(this, 'tickerNameCatalog');
    return doc && typeof doc === 'object' ? doc : null;
  };
  Store.prototype.saveTickerNameCatalog = async function saveTickerNameCatalog(doc) {
    await writeSetting.call(this, 'tickerNameCatalog', doc || {});
    return doc;
  };
  Store.prototype.listUnmatchedPoliticianTrades = async function listUnmatchedPoliticianTrades({
    checkedBefore = null,
    matcherVersion = 0,
    limit = 500,
  } = {}) {
    const cap = Math.min(2000, Math.max(1, Number(limit) || 500));
    const version = Number(matcherVersion) || 0;
    const { rows } = await this.q(
      `SELECT id, asset, asset_class, ticker, ticker_norm, ticker_source
       FROM politician_trades
       WHERE ticker IS NULL
         AND ticker_norm IS NULL
         AND COALESCE(ticker_source, '') <> 'filing'
         AND (
           $1::timestamptz IS NULL
           OR name_match_at IS NULL
           OR name_match_at < $1::timestamptz
           OR COALESCE(name_match_version, 0) < $2::int
         )
       ORDER BY id
       LIMIT $3`,
      [checkedBefore || null, version, cap],
    );
    return rows.map((r) => ({
      id: r.id,
      asset: r.asset,
      assetClass: r.asset_class,
      ticker: null,
      tickerNorm: null,
      tickerSource: r.ticker_source || null,
    }));
  };
  Store.prototype.applyPoliticianNameMatches = async function applyPoliticianNameMatches(updates = []) {
    const rows = (updates || []).filter((row) => row?.id);
    if (!rows.length) return { updated: 0, matched: 0 };
    const result = await this.q(
      `UPDATE politician_trades AS t
       SET ticker = v.ticker,
           ticker_norm = v.ticker_norm,
           asset_class = COALESCE(v.asset_class, t.asset_class),
           ticker_source = v.ticker_source,
           ticker_match_confidence = v.confidence,
           name_match_at = v.checked_at,
           name_match_version = v.version
       FROM unnest(
         $1::text[], $2::text[], $3::text[], $4::text[], $5::text[], $6::int[], $7::timestamptz[], $8::int[]
       ) AS v(id, ticker, ticker_norm, asset_class, ticker_source, confidence, checked_at, version)
       WHERE t.id = v.id
         AND t.ticker IS NULL
         AND t.ticker_norm IS NULL
         AND COALESCE(t.ticker_source, '') <> 'filing'
       RETURNING t.ticker`,
      [
        rows.map((row) => row.id),
        rows.map((row) => row.ticker || null),
        rows.map((row) => row.tickerNorm || null),
        rows.map((row) => row.assetClass || null),
        rows.map((row) => row.tickerSource || null),
        rows.map((row) => (row.tickerMatchConfidence == null ? null : row.tickerMatchConfidence)),
        rows.map((row) => row.nameMatchAt || null),
        rows.map((row) => (row.nameMatchVersion == null ? null : row.nameMatchVersion)),
      ],
    );
    const updated = result.rowCount || 0;
    const matched = (result.rows || []).filter((row) => row.ticker).length;
    return { updated, matched };
  };
  Store.prototype.listHeldPoliticianSymbols = async function listHeldPoliticianSymbols() {
    const { rows } = await this.q(HELD_SQL);
    return rows.map((r) => ({
      symbol: r.symbol,
      tickerNorm: canonicalTicker(r.symbol),
      modelKey: r.model_key,
      modelName: r.model_name,
    }));
  };
  Store.prototype.summarizePoliticianTrades = async function summarizePoliticianTrades(query = {}) {
    const q = normalizeSummaryQuery(query);
    const rankParams = [q.from, q.to, q.filer, q.rankAll ? null : q.rankLimit];
    const clusterParams = [q.from, q.to, q.filer, q.clusterMin];
    const [ranks, clusters, netList, excluded] = await Promise.all([
      this.q(SUMMARY_RANK_SQL, rankParams),
      this.q(SUMMARY_CLUSTER_SQL, clusterParams),
      this.q(SUMMARY_NET_SQL, rankParams),
      this.q(SUMMARY_EXCLUDED_SQL, rankParams.slice(0, 3)),
    ]);
    return summaryFromSql({
      rankRows: ranks.rows,
      clusterRows: clusters.rows,
      netRows: netList.rows,
      excluded: excluded.rows[0]?.n,
      query,
    });
  };
  Store.prototype.summarizeHeldTrades = async function summarizeHeldTrades(norms) {
    const list = (norms || []).filter(Boolean);
    if (!list.length) return [];
    const { rows } = await this.q(
      `SELECT ticker_norm, count(*)::int AS n, max(disclosed_date) AS latest
       FROM politician_trades
       WHERE ticker_norm = ANY($1::text[])
         AND asset_class IN ('stock', 'etf', 'fund')
       GROUP BY ticker_norm`,
      [list],
    );
    return rows.map((r) => ({
      tickerNorm: r.ticker_norm,
      count: Number(r.n) || 0,
      latest: day(r.latest),
    }));
  };
  Store.prototype.listPoliticianFeed = async function listPoliticianFeed(query = {}) {
    const q = normalizeFeedQuery(query);
    let heldNorms = null;
    if (q.heldOnly) {
      const symbols = await this.listHeldPoliticianSymbols();
      heldNorms = [...new Set(symbols.map((s) => s.tickerNorm).filter(Boolean))];
    }
    const { whereSql, params } = buildFeedFilter(q, heldNorms);
    const count = await this.q(`SELECT count(*)::int AS n FROM (${FEED_SQL}) feed ${whereSql}`, params);
    const pageParams = params.slice();
    pageParams.push(q.limit, q.offset);
    const { rows } = await this.q(
      `SELECT * FROM (${FEED_SQL}) feed ${whereSql}
       ORDER BY disclosed_date DESC NULLS LAST, id DESC
       LIMIT $${pageParams.length - 1} OFFSET $${pageParams.length}`,
      pageParams,
    );
    const total = Number(count.rows[0]?.n) || 0;
    return {
      items: rows.map(rowToItem),
      offset: q.offset,
      limit: q.limit,
      total,
      hasMore: q.offset + rows.length < total,
    };
  };
  Store.prototype.getPolitician = async function getPolitician(personKey, query = {}) {
    const { rows } = await this.q(
      `SELECT person_name, office, party, state, filer_status
       FROM politician_filings
       WHERE person_key = $1
       ORDER BY filed_date DESC NULLS LAST
       LIMIT 1`,
      [personKey],
    );
    const annualIdentity = rows[0] ? null : await this.q(
      `SELECT person_name, office, party, state, filer_status
       FROM politician_annual_filings
       WHERE person_key = $1
       ORDER BY filed_date DESC NULLS LAST
       LIMIT 1`,
      [personKey],
    );
    const identity = rows[0] || annualIdentity?.rows?.[0];
    if (!identity) return null;
    const counts = await this.q(
      `SELECT
         count(*) FILTER (WHERE tx_type = 'buy')::int AS buys,
         count(*) FILTER (WHERE tx_type = 'sell')::int AS sells,
         count(*) FILTER (WHERE tx_type = 'exchange')::int AS exchanges,
         count(*)::int AS trades
       FROM politician_trades
       WHERE person_key = $1`,
      [personKey],
    );
    const top = await this.q(
      `SELECT ticker, count(*)::int AS n
       FROM politician_trades
       WHERE person_key = $1 AND ticker IS NOT NULL
       GROUP BY ticker
       ORDER BY n DESC, ticker
       LIMIT 8`,
      [personKey],
    );
    const windowQuery = normalizeSummaryQuery(query);
    const rollup = await this.q(PERSON_ROLLUP_SQL, [personKey, windowQuery.from, windowQuery.to]);
    const feed = await this.listPoliticianFeed({ ...query, personKey });
    const c = counts.rows[0] || {};
    const holdings = await this.getPoliticianHoldings(personKey);
    return {
      person: {
        personKey,
        personName: identity.person_name,
        office: identity.office,
        party: identity.party || null,
        filerStatus: identity.filer_status || null,
        state: identity.state || null,
      },
      counts: {
        buy: Number(c.buys) || 0,
        sell: Number(c.sells) || 0,
        exchange: Number(c.exchanges) || 0,
        trades: Number(c.trades) || 0,
      },
      topTickers: top.rows.map((r) => ({ ticker: r.ticker, count: Number(r.n) || 0 })),
      tickerRollup: rollupFromRows(rollup.rows, query),
      holdings,
      ...feed,
    };
  };

  function annualFilingFromRow(r) {
    return {
      id: r.id,
      source: r.source,
      filingKey: r.filing_key,
      personKey: r.person_key,
      personName: r.person_name,
      office: r.office,
      party: r.party || null,
      filerStatus: r.filer_status || null,
      state: r.state || null,
      district: r.district || null,
      reportYear: r.report_year == null ? null : Number(r.report_year),
      filedDate: day(r.filed_date),
      filingKind: r.filing_kind,
      sourceUrl: r.source_url,
      parseStatus: r.parse_status,
      parseNote: r.parse_note || null,
      excludedCount: Number(r.excluded_count) || 0,
      unreadableCount: Number(r.unreadable_count) || 0,
      ocrDone: r.ocr_done === true,
      ocrPage: r.ocr_page,
      pageCount: r.page_count,
      ocrClaimedAt: isoTs(r.ocr_claimed_at),
    };
  }

  function holdingFromRow(r) {
    return {
      id: r.id,
      filingId: r.filing_id,
      rowIndex: Number(r.row_index),
      asset: r.asset,
      ticker: r.ticker || null,
      tickerNorm: r.ticker_norm || null,
      tickerSource: r.ticker_source || null,
      tickerMatchConfidence: r.ticker_match_confidence == null ? null : Number(r.ticker_match_confidence),
      assetClass: r.asset_class,
      owner: r.owner,
      valueRange: r.value_range,
      valueMin: r.value_min == null ? null : Number(r.value_min),
      valueMax: r.value_max == null ? null : Number(r.value_max),
      valueMid: r.value_mid == null ? null : Number(r.value_mid),
      valueBound: r.value_bound,
      ocr: r.ocr === true,
      ocrConfidence: r.ocr_confidence == null ? null : Number(r.ocr_confidence),
    };
  }

  Store.prototype.getAnnualState = async function getAnnualState() {
    return (await readSetting.call(this, 'politicianAnnual')) || {};
  };
  Store.prototype.setAnnualState = async function setAnnualState(state) {
    await writeSetting.call(this, 'politicianAnnual', state || {});
    return state || {};
  };
  Store.prototype.existingAnnualKeys = async function existingAnnualKeys(source, keys) {
    if (!keys?.length) return [];
    const { rows } = await this.q(
      `SELECT filing_key FROM politician_annual_filings
       WHERE source = $1 AND filing_key = ANY($2::text[])`,
      [source, keys],
    );
    return rows.map((r) => r.filing_key);
  };
  Store.prototype.insertAnnualBundle = async function insertAnnualBundle(filing, holdings = []) {
    const found = await this.q(
      `SELECT id, parse_status FROM politician_annual_filings WHERE source = $1 AND filing_key = $2`,
      [filing.source, filing.filingKey],
    );
    const existing = found.rows[0];
    if (existing && existing.parse_status !== 'pending_ocr' && existing.parse_status !== 'ocr_running') {
      return { created: false, holdings: 0 };
    }
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      if (existing) {
        await client.query('DELETE FROM politician_holdings WHERE filing_id = $1', [existing.id]);
        await client.query(
          `UPDATE politician_annual_filings SET
             person_key = $2, person_name = $3, office = $4, party = $5, filer_status = $6,
             state = $7, district = $8, report_year = $9, filed_date = $10, filing_kind = $11,
             source_url = $12, parse_status = $13, parse_note = $14, excluded_count = $15,
             unreadable_count = $16, ocr_done = $17, ocr_page = $18, page_count = $19, ocr_claimed_at = NULL
           WHERE id = $1`,
          [
            existing.id, filing.personKey, filing.personName, filing.office, filing.party,
            filing.filerStatus, filing.state, filing.district, filing.reportYear, filing.filedDate,
            filing.filingKind, filing.sourceUrl, filing.parseStatus, filing.parseNote,
            filing.excludedCount || 0, filing.unreadableCount || 0, filing.ocrDone === true,
            filing.ocrPage, filing.pageCount,
          ],
        );
      } else {
        await client.query(
          `INSERT INTO politician_annual_filings (
             id, source, filing_key, person_key, person_name, office, party, filer_status,
             state, district, report_year, filed_date, filing_kind, source_url, parse_status,
             parse_note, excluded_count, unreadable_count, ocr_done, ocr_page, page_count
           ) VALUES (
             $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21
           )`,
          [
            filing.id, filing.source, filing.filingKey, filing.personKey, filing.personName,
            filing.office, filing.party, filing.filerStatus, filing.state, filing.district,
            filing.reportYear, filing.filedDate, filing.filingKind, filing.sourceUrl,
            filing.parseStatus, filing.parseNote, filing.excludedCount || 0,
            filing.unreadableCount || 0, filing.ocrDone === true, filing.ocrPage, filing.pageCount,
          ],
        );
      }
      const filingId = existing?.id || filing.id;
      for (let i = 0; i < holdings.length; i += 80) {
        const chunk = holdings.slice(i, i + 80);
        const params = [];
        const values = chunk.map((row) => {
          const cols = [
            row.id, filingId, row.rowIndex, row.asset, row.ticker, row.tickerNorm, row.tickerSource,
            row.tickerMatchConfidence, row.assetClass, row.owner, row.valueRange, row.valueMin,
            row.valueMax, row.valueMid, row.valueBound, row.ocr === true, row.ocrConfidence,
          ];
          const marks = cols.map((value) => {
            params.push(value);
            return `$${params.length}`;
          });
          return `(${marks.join(',')})`;
        });
        await client.query(
          `INSERT INTO politician_holdings (
             id, filing_id, row_index, asset, ticker, ticker_norm, ticker_source,
             ticker_match_confidence, asset_class, owner, value_range, value_min,
             value_max, value_mid, value_bound, ocr, ocr_confidence
           ) VALUES ${values.join(',')}`,
          params,
        );
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
    return { created: !existing, holdings: holdings.length };
  };
  Store.prototype.listAnnualFilingsForPerson = async function listAnnualFilingsForPerson(personKey) {
    const { rows } = await this.q(
      `SELECT * FROM politician_annual_filings WHERE person_key = $1`,
      [personKey],
    );
    return rows.map(annualFilingFromRow);
  };
  Store.prototype.listAnnualFilingSummaries = async function listAnnualFilingSummaries() {
    const { rows } = await this.q(
      `SELECT id, source, filing_key, person_key, person_name, office, party, filer_status,
              state, district, report_year, filed_date, filing_kind, source_url, parse_status,
              parse_note, excluded_count, unreadable_count, ocr_done, ocr_page, page_count,
              ocr_claimed_at
       FROM politician_annual_filings`,
    );
    return rows.map(annualFilingFromRow);
  };
  Store.prototype.listHoldingsForFiling = async function listHoldingsForFiling(filingId) {
    const { rows } = await this.q(
      `SELECT * FROM politician_holdings WHERE filing_id = $1 ORDER BY value_mid DESC NULLS LAST, row_index`,
      [filingId],
    );
    return rows.map(holdingFromRow);
  };
  Store.prototype.getPoliticianHoldings = async function getPoliticianHoldings(personKey) {
    const filings = await this.listAnnualFilingsForPerson(personKey);
    const { current } = selectCurrentAnnual(filings);
    const holdings = current && isReadableAnnual(current)
      ? await this.listHoldingsForFiling(current.id)
      : [];
    const held = heldIndex(await this.listHeldPoliticianSymbols());
    return presentHoldings({ filings, holdings, held });
  };
  Store.prototype.touchAnnualFiling = async function touchAnnualFiling(id, patch = {}) {
    const sets = [];
    const params = [id];
    const col = {
      parseStatus: 'parse_status',
      parseNote: 'parse_note',
      ocrDone: 'ocr_done',
      ocrPage: 'ocr_page',
      pageCount: 'page_count',
      ocrClaimedAt: 'ocr_claimed_at',
      excludedCount: 'excluded_count',
      unreadableCount: 'unreadable_count',
      reportYear: 'report_year',
    };
    for (const [key, sql] of Object.entries(col)) {
      if (patch[key] !== undefined) {
        params.push(patch[key]);
        sets.push(`${sql} = $${params.length}`);
      }
    }
    if (!sets.length) return null;
    await this.q(`UPDATE politician_annual_filings SET ${sets.join(', ')} WHERE id = $1`, params);
    return { id };
  };
  Store.prototype.appendAnnualHoldings = async function appendAnnualHoldings(filingId, rows = []) {
    if (!rows.length) return { inserted: 0 };
    const current = await this.q(
      `SELECT COALESCE(MAX(row_index), 0)::int AS n FROM politician_holdings WHERE filing_id = $1`,
      [filingId],
    );
    let n = Number(current.rows[0]?.n) || 0;
    const numbered = rows.map((row) => {
      n += 1;
      return { ...row, rowIndex: n, id: `${filingId}:${n}`, filingId };
    });
    for (let i = 0; i < numbered.length; i += 80) {
      const chunk = numbered.slice(i, i + 80);
      const params = [];
      const values = chunk.map((row) => {
        const cols = [
          row.id, filingId, row.rowIndex, row.asset, row.ticker, row.tickerNorm, row.tickerSource,
          row.tickerMatchConfidence, row.assetClass, row.owner, row.valueRange, row.valueMin,
          row.valueMax, row.valueMid, row.valueBound, row.ocr === true, row.ocrConfidence,
        ];
        const marks = cols.map((value) => {
          params.push(value);
          return `$${params.length}`;
        });
        return `(${marks.join(',')})`;
      });
      await this.q(
        `INSERT INTO politician_holdings (
           id, filing_id, row_index, asset, ticker, ticker_norm, ticker_source,
           ticker_match_confidence, asset_class, owner, value_range, value_min,
           value_max, value_mid, value_bound, ocr, ocr_confidence
         ) VALUES ${values.join(',')}`,
        params,
      );
    }
    return { inserted: numbered.length };
  };
  Store.prototype.listPendingAnnualOcr = async function listPendingAnnualOcr({ limit = 5, now = new Date() } = {}) {
    const nowMs = now instanceof Date ? now.getTime() : Date.parse(now);
    const { rows } = await this.q(
      `SELECT * FROM politician_annual_filings
       WHERE source = 'oge'
         AND (
           parse_status = 'pending_ocr'
           OR (parse_status = 'ocr_running' AND (ocr_claimed_at IS NULL OR ocr_claimed_at < $2::timestamptz))
         )
       ORDER BY filed_date DESC NULLS LAST
       LIMIT $1`,
      [limit, new Date(nowMs - OCR_CLAIM_MS).toISOString()],
    );
    return rows.map(annualFilingFromRow);
  };
}
