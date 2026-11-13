// Party is not on the disclosure filing. The House Clerk member list and the
// Senate contact XML are free official rosters. A name that does not match
// exactly one person stays unlabelled rather than being assigned a party.

import { nameFold } from './normalize.js';

function decodeXml(text) {
  return String(text)
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&apos;/g, "'");
}

function tagText(block, name) {
  const m = block.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`, 'i'));
  return m ? decodeXml(m[1]).replace(/\s+/g, ' ').trim() : '';
}

export function parseHouseRoster(xml) {
  const members = [];
  const re = /<member>([\s\S]*?)<\/member>/gi;
  let m;
  while ((m = re.exec(String(xml))) !== null) {
    const block = m[1];
    const party = tagText(block, 'party').toUpperCase();
    const last = tagText(block, 'lastname');
    const first = tagText(block, 'firstname');
    const state = (block.match(/<state\s+postal-code="([A-Z]{2})"/i) || [])[1] || '';
    const districtText = tagText(block, 'district');
    let district = null;
    if (/at large/i.test(districtText)) district = 0;
    else if (/^\d+/.test(districtText)) district = Number.parseInt(districtText, 10);
    if (!last || !state || !/^[DRI]$/.test(party)) continue;
    members.push({
      party,
      last,
      first,
      state,
      district,
      lastFold: nameFold(last),
      firstFold: nameFold(first).split(' ')[0] || '',
    });
  }
  return members;
}

export function parseSenateRoster(xml) {
  const members = [];
  const re = /<member>([\s\S]*?)<\/member>/gi;
  let m;
  while ((m = re.exec(String(xml))) !== null) {
    const block = m[1];
    const party = tagText(block, 'party').toUpperCase();
    const last = tagText(block, 'last_name');
    const first = tagText(block, 'first_name');
    const state = tagText(block, 'state').toUpperCase();
    if (!last || !/^[A-Z]{2}$/.test(state) || !/^[DRI]$/.test(party)) continue;
    members.push({
      party,
      last,
      first,
      state,
      lastFold: nameFold(last),
      firstFold: nameFold(first).split(' ')[0] || '',
    });
  }
  return members;
}

function firstToken(value) {
  return nameFold(value).split(' ').filter(Boolean)[0] || '';
}

export function matchHouseParty(filing, roster) {
  const sd = String(filing?.stateDst || '');
  if (!/^[A-Z]{2}\d{2}$/.test(sd)) return { party: null, state: null, district: null };
  const state = sd.slice(0, 2);
  const district = Number.parseInt(sd.slice(2), 10);
  const last = nameFold(filing.last);
  const first = firstToken(filing.first);
  const pool = (roster || []).filter((m) => m.state === state && m.district === district && m.lastFold === last);
  const hits = pool.length > 1 && first
    ? pool.filter((m) => m.firstFold === first)
    : pool;
  if (hits.length !== 1) return { party: null, state, district: String(district).padStart(2, '0') };
  return { party: hits[0].party, state, district: String(district).padStart(2, '0') };
}

export function matchSenateParty(filing, roster) {
  const last = nameFold(filing?.last);
  const first = firstToken(filing?.first);
  if (!last) return { party: null, state: null };
  const pool = (roster || []).filter((m) => m.lastFold === last);
  const hits = pool.length > 1 && first
    ? pool.filter((m) => m.firstFold === first)
    : pool;
  if (hits.length !== 1) return { party: null, state: null };
  return { party: hits[0].party, state: hits[0].state };
}
