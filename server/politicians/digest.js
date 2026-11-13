// One digest per poll. Held tickers are listed first. The body names model
// portfolios only — never a client, an account, or a dollar balance.

import { escapeHtml, FOLIOTRACK_URL } from '../alerts/email.js';
import { matchableAssetClass, officeLabel, ownerLabel, partyLabel, txLabel } from './normalize.js';

const TRADE_CAP = 30;
const REVIEW_CAP = 8;

function modelsFor(trade, heldByNorm) {
  if (!matchableAssetClass(trade.assetClass) || !trade.tickerNorm) return [];
  return heldByNorm.get(trade.tickerNorm) || [];
}

function candidateTag(row) {
  return row?.filerStatus === 'candidate' ? 'Candidate' : '';
}

function lineFor(trade) {
  const who = trade.personName || 'Unknown';
  const office = officeLabel(trade.office);
  const party = partyLabel(trade.party);
  const candidate = candidateTag(trade);
  const side = txLabel(trade.txType, trade.partial);
  const ticker = trade.ticker || '—';
  const when = trade.txDate || '—';
  const disclosed = trade.disclosedDate || '—';
  const lag = trade.lagDays == null ? '—' : `${trade.lagDays}d`;
  const models = (trade.heldModels || []).map((m) => m.name || m.key).filter(Boolean);
  const held = models.length ? `In your models: ${models.join(', ')}` : '';
  return [
    `${who} (${office}${candidate ? `, ${candidate}` : ''}${party ? `, ${party}` : ''}) ${side} ${ticker}`,
    trade.asset || '',
    `${ownerLabel(trade.owner)} · ${trade.amountRange || '—'}`,
    `Traded ${when} · disclosed ${disclosed} · lag ${lag}`,
    held,
    trade.sourceUrl || '',
  ].filter(Boolean).join('\n');
}

export function buildPoliticianDigest({
  trades = [],
  reviews = [],
  heldByNorm = new Map(),
  heldOnly = false,
  appUrl = FOLIOTRACK_URL,
} = {}) {
  const decorated = (trades || []).map((trade) => ({
    ...trade,
    heldModels: modelsFor(trade, heldByNorm),
  }));
  const held = decorated.filter((t) => t.heldModels.length);
  const rest = heldOnly ? [] : decorated.filter((t) => !t.heldModels.length);
  held.sort((a, b) => String(b.disclosedDate || '').localeCompare(String(a.disclosedDate || '')));
  rest.sort((a, b) => String(b.disclosedDate || '').localeCompare(String(a.disclosedDate || '')));
  const shown = [...held, ...rest];
  const reviewRows = heldOnly ? [] : (reviews || []).slice(0, REVIEW_CAP);
  if (!shown.length && !reviewRows.length) return null;

  const extra = Math.max(0, shown.length - TRADE_CAP);
  const visible = shown.slice(0, TRADE_CAP);
  const noun = shown.length === 1 ? 'trade' : 'trades';
  const subject = shown.length
    ? `FolioTrack: ${shown.length} new politician ${noun}${held.length ? ` (${held.length} in your models)` : ''}`
    : `FolioTrack: ${reviewRows.length} politician filing${reviewRows.length === 1 ? '' : 's'} need review`;

  const textParts = [
    'FolioTrack politician trades',
    '',
  ];
  if (held.length) {
    textParts.push('In your models', '');
    for (const trade of visible.filter((t) => t.heldModels.length)) {
      textParts.push(lineFor(trade), '');
    }
  }
  const others = visible.filter((t) => !t.heldModels.length);
  if (others.length) {
    textParts.push(held.length ? 'Other new trades' : 'New trades', '');
    for (const trade of others) textParts.push(lineFor(trade), '');
  }
  if (extra) textParts.push(`+ ${extra} more in FolioTrack`, '');
  if (reviewRows.length) {
    textParts.push('Needs manual review (no amounts were guessed)', '');
    for (const row of reviewRows) {
      const candidate = candidateTag(row);
      textParts.push(`${row.personName || 'Unknown'} (${officeLabel(row.office)}${candidate ? `, ${candidate}` : ''}) ${row.filedDate || ''}`);
      if (row.parseNote) textParts.push(row.parseNote);
      if (row.sourceUrl) textParts.push(row.sourceUrl);
      textParts.push('');
    }
  }
  textParts.push(appUrl);
  const text = textParts.join('\n');

  const itemHtml = (trade) => `<li style="margin:0 0 12px">
    <div><strong>${escapeHtml(trade.personName || 'Unknown')}</strong> · ${escapeHtml(officeLabel(trade.office))}${candidateTag(trade) ? ` · ${escapeHtml(candidateTag(trade))}` : ''}${partyLabel(trade.party) ? ` · ${escapeHtml(partyLabel(trade.party))}` : ''}</div>
    <div>${escapeHtml(txLabel(trade.txType, trade.partial))} ${escapeHtml(trade.ticker || '—')}${trade.heldModels.length ? ` · <strong>In your models: ${escapeHtml(trade.heldModels.map((m) => m.name || m.key).join(', '))}</strong>` : ''}</div>
    <div>${escapeHtml(trade.asset || '')}</div>
    <div>${escapeHtml(ownerLabel(trade.owner))} · ${escapeHtml(trade.amountRange || '—')}</div>
    <div>Traded ${escapeHtml(trade.txDate || '—')} · disclosed ${escapeHtml(trade.disclosedDate || '—')} · lag ${escapeHtml(trade.lagDays == null ? '—' : `${trade.lagDays} days`)}</div>
    ${trade.sourceUrl ? `<div><a href="${escapeHtml(trade.sourceUrl)}">Source filing</a></div>` : ''}
  </li>`;

  const html = `<!DOCTYPE html>
<html><body style="font-family:sans-serif;color:#111;line-height:1.45">
<h2 style="margin:0 0 12px">FolioTrack politician trades</h2>
${held.length ? `<h3 style="margin:16px 0 8px">In your models</h3><ul style="padding-left:18px">${visible.filter((t) => t.heldModels.length).map(itemHtml).join('')}</ul>` : ''}
${others.length ? `<h3 style="margin:16px 0 8px">${held.length ? 'Other new trades' : 'New trades'}</h3><ul style="padding-left:18px">${others.map(itemHtml).join('')}</ul>` : ''}
${extra ? `<p>+ ${extra} more in FolioTrack</p>` : ''}
${reviewRows.length ? `<h3 style="margin:16px 0 8px">Needs manual review</h3><ul style="padding-left:18px">${reviewRows.map((row) => `<li style="margin:0 0 10px"><div><strong>${escapeHtml(row.personName || 'Unknown')}</strong> · ${escapeHtml(officeLabel(row.office))}${candidateTag(row) ? ` · ${escapeHtml(candidateTag(row))}` : ''}</div><div>${escapeHtml(row.parseNote || 'Open the filing. Amounts were not guessed.')}</div>${row.sourceUrl ? `<div><a href="${escapeHtml(row.sourceUrl)}">Source filing</a></div>` : ''}</li>`).join('')}</ul>` : ''}
<p><a href="${escapeHtml(appUrl)}">Open FolioTrack</a></p>
</body></html>`;

  return { subject, text, html, held: held.length, listed: visible.length };
}
