// Senate eFD annual reports.
//
// Search is the same DataTables POST as a PTR, with report_types [7] (Annual)
// and filer_types [1] (senators). Electronic reports are HTML at
// /search/view/annual/{uuid}/. Part 3 is the asset table. A paper scan is
// /search/view/paper/{uuid}/ and is stored as a link, not read.
// The ticker in a Yahoo link is the ticker the Senate printed. A row with no
// link keeps a null ticker until the name matcher runs.

import { load } from 'cheerio';
import { canonicalTicker, normalizeOwner, parseUsDate } from './normalize.js';
import { parseAssetValue } from './assetValue.js';
import { classFromSenateType } from './holdingClass.js';
import { SENATE_BASE } from './parseSenate.js';

export function parseSenateAnnualSearchRow(row) {
  if (!Array.isArray(row) || row.length < 5) return null;
  const link = String(row[3] || '');
  const href = /href="([^"]+)"/i.exec(link);
  if (!href) return null;
  const label = link.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  if (!/annual/i.test(label)) return null;
  const path = href[1];
  const uuid = /\/(?:annual|paper)\/([0-9a-f-]{36})\//i.exec(path);
  if (!uuid) return null;
  const yearMatch = label.match(/(?:CY\s*)?(20\d{2})/);
  const kind = /\/paper\//i.test(path) ? 'paper' : 'annual';
  return {
    source: 'senate',
    filingKey: uuid[1].toLowerCase(),
    first: String(row[0] || '').trim(),
    last: String(row[1] || '').trim(),
    filer: String(row[2] || '').trim(),
    filedDate: parseUsDate(row[4]),
    path,
    kind,
    reportYear: yearMatch ? Number(yearMatch[1]) : null,
    filingKind: /amendment/i.test(label) ? 'amendment' : 'original',
    sourceUrl: path.startsWith('http') ? path : `${SENATE_BASE}${path}`,
  };
}

function cellText(el, $) {
  return $(el).text().replace(/\s+/g, ' ').trim();
}

function tickerFromCell(el, $) {
  const href = $(el).find('a[href*="s="]').attr('href') || '';
  const fromLink = /[?&]s=([A-Za-z0-9.-]+)/.exec(href);
  return canonicalTicker(fromLink ? fromLink[1] : '');
}

function assetName(el, $, ticker) {
  const strong = $(el).find('strong').first().text().replace(/\s+/g, ' ').trim();
  const base = strong || cellText(el, $);
  if (!ticker) return base;
  const stripped = base.replace(new RegExp(`^${ticker}\\s*[-–—:]\\s*`, 'i'), '').trim();
  return stripped || base;
}

export function parseSenateAnnualHtml(html) {
  const $ = load(String(html || ''));
  const tables = $('table').toArray();
  let table = null;
  let headers = [];
  for (const el of tables) {
    const heads = $(el).find('th').toArray().map((th) => $(th).text().replace(/\s+/g, ' ').trim().toLowerCase());
    if (heads.includes('asset') && heads.includes('value') && heads.includes('owner')) {
      table = el;
      headers = heads;
      break;
    }
  }
  if (!table) {
    return {
      status: 'needs_manual_review',
      holdings: [],
      excludedCount: 0,
      unreadableCount: 0,
      note: 'The electronic annual report had no Part 3 asset table.',
    };
  }
  const col = (name) => headers.indexOf(name);
  const assetI = col('asset');
  const typeI = col('asset type');
  const ownerI = col('owner');
  const valueI = col('value');
  const holdings = [];
  let excluded = 0;
  let unreadable = 0;
  $(table).find('tbody tr').each((_, tr) => {
    const cells = $(tr).find('td').toArray();
    if (!cells.length || assetI < 0 || valueI < 0) return;
    const assetCell = cells[assetI];
    if (!assetCell) return;
    const ticker = tickerFromCell(assetCell, $);
    const asset = assetName(assetCell, $, ticker);
    const typeCell = typeI >= 0 ? cells[typeI] : null;
    const typeBits = typeCell
      ? $(typeCell).contents().toArray().map((node) => $(node).text().replace(/\s+/g, ' ').trim()).filter(Boolean)
      : [];
    const type = typeBits[0] || '';
    const subtype = typeBits.slice(1).join(' ');
    const owner = normalizeOwner(ownerI >= 0 ? cellText(cells[ownerI], $) : '', { blankIsSelf: true });
    const value = parseAssetValue(cellText(cells[valueI], $));
    if (!asset) {
      unreadable += 1;
      return;
    }
    if (value.kind === 'excluded') {
      excluded += 1;
      return;
    }
    if (value.kind !== 'range' && value.kind !== 'at_least') {
      unreadable += 1;
      return;
    }
    const mappedOwner = owner === 'child' ? 'dependent' : owner;
    holdings.push({
      asset,
      ticker,
      assetClass: classFromSenateType(type, subtype, asset),
      owner: mappedOwner,
      valueRange: value.label,
      valueMin: value.min,
      valueMax: value.max,
      valueMid: value.mid,
      valueBound: value.kind === 'at_least' ? 'at_least' : 'range',
    });
  });
  if (!holdings.length && !excluded) {
    return {
      status: 'needs_manual_review',
      holdings: [],
      excludedCount: excluded,
      unreadableCount: unreadable,
      note: 'Part 3 had no row with a statutory value range. Nothing was guessed.',
    };
  }
  const bits = [];
  if (excluded) bits.push(`${excluded} item${excluded === 1 ? '' : 's'} with value None or not disclosed ${excluded === 1 ? 'was' : 'were'} left out`);
  if (unreadable) bits.push(`${unreadable} row${unreadable === 1 ? '' : 's'} had a value that was not a statutory range and ${unreadable === 1 ? 'was' : 'were'} not guessed`);
  return {
    status: unreadable ? 'partial' : 'parsed',
    holdings,
    excludedCount: excluded,
    unreadableCount: unreadable,
    note: bits.length ? `${bits.join('. ')}.` : null,
  };
}

export function reviewPaperAnnual(note = 'Paper annual report. The Senate publishes this as a scanned image, so the holdings were not guessed.') {
  return {
    status: 'needs_manual_review',
    holdings: [],
    excludedCount: 0,
    unreadableCount: 0,
    note,
  };
}
