// Asset classes for annual holdings. Codes are the House Clerk list at
// https://fd.house.gov/reference/asset-type-codes.aspx. A code that is not
// in that list stays "other" rather than being folded into a nearby class.

import { isDebtDescription, isExchangeTraded, isPrivateFund } from './nameMatch.js';

export const HOLDING_CLASSES = [
  'stock',
  'etf_fund',
  'bond',
  'real_estate',
  'private',
  'cash',
  'retirement',
  'crypto',
  'other',
];

export const CLASS_LABELS = {
  stock: 'Stock',
  etf_fund: 'ETF / fund',
  bond: 'Bond / muni',
  real_estate: 'Real estate',
  private: 'Private business',
  cash: 'Cash / bank',
  retirement: 'Retirement account',
  crypto: 'Crypto',
  other: 'Other',
};

// Official House asset-type codes.
const HOUSE_CODE_CLASS = {
  ST: 'stock',
  RS: 'stock',
  EF: 'etf_fund',
  MF: 'etf_fund',
  '5F': 'etf_fund',
  ET: 'bond',
  AB: 'bond',
  CS: 'bond',
  GS: 'bond',
  CT: 'crypto',
  RP: 'real_estate',
  RE: 'real_estate',
  RF: 'real_estate',
  RN: 'real_estate',
  FA: 'real_estate',
  BA: 'cash',
  '4K': 'retirement',
  IR: 'retirement',
  IH: 'retirement',
  PE: 'retirement',
  DB: 'retirement',
  FN: 'retirement',
  VA: 'retirement',
  OL: 'private',
  OI: 'private',
  PS: 'private',
  HE: 'private',
  HN: 'private',
};

export function classFromHouseCode(code) {
  if (!code) return null;
  return HOUSE_CODE_CLASS[String(code).toUpperCase()] || 'other';
}

export function holdingClassLabel(assetClass) {
  return CLASS_LABELS[assetClass] || CLASS_LABELS.other;
}

// A model badge matches the same tickers as a trade badge, plus an ETF/fund
// holding stored under the combined annual class.
export function holdingMatchable(assetClass) {
  return assetClass === 'stock' || assetClass === 'etf_fund' || assetClass === 'etf' || assetClass === 'fund';
}

function textClass(blob) {
  const s = String(blob || '').toLowerCase();
  if (!s.trim()) return 'other';
  if (/\bcrypto|bitcoin|ethereum\b/.test(s)) return 'crypto';
  if (/non-public|privately held|limited liability|\bllc\b|limited partnership|\bllp\b|ownership interest|business entity/.test(s)) {
    return 'private';
  }
  if (/real estate|real property|unimproved land|residential|commercial property|\bfarm\b/.test(s)) {
    return 'real_estate';
  }
  if (/bank deposit|checking|savings|money market|certificate of deposit|\bcds?\b/.test(s)) return 'cash';
  if (/401\(k\)|403\(b\)|\bira\b|retirement|pension|thrift savings|annuity/.test(s)) return 'retirement';
  if (/mutual fund|exchange traded|\betf\b|\betn\b/.test(s)) return 'etf_fund';
  if (/municipal|\bbond\b|\bnote\b|treasury|government secur|debenture/.test(s)) return 'bond';
  if (/\bstock\b|common stock|corporate secur|adr\b/.test(s)) return 'stock';
  return 'other';
}

export function classFromSenateType(type, subtype, name) {
  const subtypeFirst = textClass(`${subtype || ''} ${type || ''}`);
  if (subtypeFirst !== 'other') return subtypeFirst;
  return textClass(`${type || ''} ${subtype || ''} ${name || ''}`);
}

// A percent that is ownership ("25% equity interest"), not a coupon.
function ownershipStake(text) {
  return /\d+(?:\.\d+)?\s*%\s*(?:equity|ownership|stake)\b/i.test(text)
    || /\b(?:equity|ownership|percentage)\s+interest\b/i.test(text)
    || /\b\d+(?:\.\d+)?\s*%\s+interest\s+in\b/i.test(text);
}

// Coupons, due dates, and the abbreviations 278e brokerage lines use for
// munis and debentures ("DEBS", "BDS", "NTS", "DTD", "BE/R/").
function explicitDebt(text) {
  if (/\b(?:bonds?|notes?|debentures?|debs?|bds|nts|munis?|municipals?)\b/i.test(text)) return true;
  if (/\bcallable\b/i.test(text)) return true;
  if (/\btreasur/i.test(text)) return true;
  if (/\bdue\b/i.test(text)) return true;
  if (/\bDTD\b/.test(text) || /BE\/R\//.test(text) || /\bB\/E\b/.test(text)) return true;
  if (/\b(?:CNTY|COUNTY|PARISH|INDPT|ISD)\b/i.test(text)) return true;
  if (/\bSCH\s+(?:DIST|BRD|BD)\b/i.test(text)) return true;
  if (/\b(?:AUTH|AGENCY)\b/i.test(text) && /\b(?:REV|FACS|HLTH|HEALTH|HSG|WTR|SWR|ELEC|UTIL|IMP)\b/i.test(text)) return true;
  if (/\b(?:WTR|SWR|ELEC|UTIL|PWR)\b/i.test(text) && /\bREV\b/i.test(text)) return true;
  if (/\bFING\s+AGY\b/i.test(text) || /\bGO\s+BDS\b/i.test(text)) return true;
  if (/\bST\b/i.test(text) && /\b(?:HLTH|HEALTH|EDL|EDUC|HWY|TPK)\b/i.test(text)) return true;
  return false;
}

function describedDebt(text) {
  if (explicitDebt(text)) return true;
  if (ownershipStake(text)) return false;
  return isDebtDescription(text);
}

// "ETF" as its own token or glued on the end ("BONDETF"). A substring match
// would treat NETFLIX as a fund.
function mentionsEtf(text) {
  if (isExchangeTraded(text)) return true;
  const tokens = String(text || '').toUpperCase().match(/[A-Z0-9]+/g) || [];
  return tokens.some((token) => token === 'ETF' || token === 'ETFS' || (token.endsWith('ETF') && token.length > 3));
}

function fundHolding(text) {
  if (isPrivateFund(text)) return 'private';
  if (mentionsEtf(text) || /\bmutual funds?\b/i.test(text) || /\bfunds?\b/i.test(text)) {
    return 'etf_fund';
  }
  if (/\b(?:ishares|spdr)\b/i.test(text)) return 'etf_fund';
  if (/\bINST\b/i.test(text) && /\b(?:GOVT|GOVERNMENT)\b/i.test(text)) return 'etf_fund';
  return null;
}

const CORPORATE_SUFFIX = new Set([
  'INC', 'INCORPORATED', 'CORP', 'CORPORATION', 'PLC', 'LTD', 'CO', 'COMPANY',
  'HOLDINGS', 'HOLDING', 'HLDGS', 'NV', 'SA', 'AG', 'SE',
  'N.V', 'N.V.', 'S.A', 'S.A.', 'LIMITED',
]);

const GLUED_SUFFIX = /(?:INC(?:CL(?:ASS)?)?|INCORPORATED|CORPORATION|CORP|LTD|PLC|COMPANY|CO)$/;

// Bare issuer names: "APPLE INC", "NVIDIA CORP", "NVIDIACORP", "ELILILLYANDCO".
// "Limited" spelled out counts only when the line is not an operating company.
export function hasCorporateSuffix(text) {
  if (/\bpublic limited\b/i.test(text)) return true;
  if (/\bN\.V\b\.?|\bS\.A\b\.?/i.test(text)) return true;
  const tokens = String(text || '').toUpperCase().match(/[A-Z0-9.]+/g) || [];
  for (const raw of tokens) {
    const token = raw.replace(/\.+$/g, '');
    if (CORPORATE_SUFFIX.has(token) || CORPORATE_SUFFIX.has(raw)) return true;
    const glued = token.match(GLUED_SUFFIX);
    if (glued && token.length > glued[0].length) return true;
  }
  return false;
}

function cryptoHolding(text) {
  return /\b(?:bitcoin|ethereum|etherium|crypto(?:currency)?)\b/i.test(text);
}

function realEstatePhrase(text) {
  return /\b(?:real estate|real property|unimproved|residence|commercial building|vineyard)\b/i.test(text);
}

function operatingCompany(text) {
  if (/\b(?:llc|l\.l\.c\.?|limited partnership|llp)\b/i.test(text)) return true;
  if (/\blimited\b/i.test(text) && !/\bpublic limited\b/i.test(text)
    && /\b(?:location|underlying|golf|club|resort)\b/i.test(text)) {
    return true;
  }
  return false;
}

function propertyWords(text) {
  return /\b(?:tower|apartments?|propert(?:y|ies)|residential)\b/i.test(text);
}

function businessAsideFromCash(text) {
  return /\bgolf\b/i.test(text)
    || /\bresorts?\b/i.test(text)
    || /\bclub\b/i.test(text)
    || propertyWords(text)
    || realEstatePhrase(text)
    || /\b(?:trademark|payroll)\b/i.test(text);
}

// An LLC whose only described asset is a bank account is cash. A golf club
// or tower that also mentions a bank account is not.
function bankAccountOnly(text) {
  if (!/\b(?:bank account|checking|savings|money market|certificate of deposit)\b/i.test(text)) return false;
  return !businessAsideFromCash(text);
}

function cashHolding(text) {
  return /\b(?:checking|savings|money market|bank account|certificate of deposit|banksweep|bank sweep)\b/i.test(text);
}

function stockSignals(text) {
  if (/\b(?:common stock|stocks?|cap stk)\b/i.test(text)) return true;
  if (/\bCOM\b/i.test(text) || /\bCLASS\b/i.test(text) || /\bCL\s*[A-C]\b/i.test(text)) return true;
  if (/\bREIT\b/i.test(text)) return true;
  return hasCorporateSuffix(text);
}

// Capitalized security lines with no suffix ("JOHNSON & JOHNSON").
function bareIssuer(text) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  if (t.length < 3 || t.length > 80) return false;
  if (/\b(?:location|underlying|see line|gold|silver|artwork|wallet)\b/i.test(t)) return false;
  const upper = (t.match(/[A-Z]/g) || []).length;
  const lower = (t.match(/[a-z]/g) || []).length;
  if (upper + lower < 3) return false;
  if (lower > 0 && upper / (upper + lower) < 0.85) return false;
  return true;
}

// 278e prints a description, not a House asset-type code. Order matters:
// a coupon or due date beats INC, and a golf club or tower beats an
// incidental "U.S. bank account" in the underlying-assets text.
export function classFromDescribedHolding(name) {
  const text = String(name || '');
  if (!text.trim()) return 'other';
  if (/\bmoney market\b|banksweep|bank sweep/i.test(text) && !mentionsEtf(text)) return 'cash';
  const fund = fundHolding(text);
  if (fund) return fund;
  if (describedDebt(text)) return 'bond';
  if (cryptoHolding(text)) return 'crypto';
  if (realEstatePhrase(text)) return 'real_estate';
  if (operatingCompany(text) && propertyWords(text)) return 'real_estate';
  if (/\bgolf\s+(?:club|course)\b/i.test(text)) return 'private';
  if (/\bresorts?\b/i.test(text) && operatingCompany(text)) return 'private';
  // COM on a short brokerage line is common stock, including "X LLC COM".
  if (/\bCOM\b/i.test(text) && !/\b(?:location|underlying)\b/i.test(text)) return 'stock';
  if (operatingCompany(text)) return bankAccountOnly(text) ? 'cash' : 'private';
  if (cashHolding(text)) return 'cash';
  if (/\b(?:401\(k\)|403\(b\)|ira|pension|retirement)\b/i.test(text)) return 'retirement';
  if (stockSignals(text) || bareIssuer(text)) return 'stock';
  return 'other';
}

function holdingName(row) {
  return String(row?.asset ?? row?.description ?? '').trim();
}

function storedClass(row) {
  const value = String(row?.assetClass || '').trim();
  return value || 'other';
}

// A House code on the row, or still printed in the asset text as [ST].
function houseCode(row, source) {
  const explicit = row?.assetCode ?? row?.asset_code;
  if (explicit != null && String(explicit).trim()) return String(explicit).trim().toUpperCase();
  if (source !== 'house') return null;
  const codes = [...String(row?.asset || '').matchAll(/\[([A-Z0-9]{2})\]/g)];
  return codes.length ? codes[codes.length - 1][1].toUpperCase() : null;
}

// Present when ingest passed the Senate columns, including an empty type.
function senateFields(row) {
  if (!row) return null;
  const type = row.assetType ?? row.asset_type;
  const subtype = row.assetSubtype ?? row.asset_subtype;
  if (type == null && subtype == null) return null;
  return { type: type || '', subtype: subtype || '' };
}

// One classifier for ingest and for the person-page chart.
// House asset-type codes win, then Senate asset types, then the description.
// The stored class is the fallback when that raw text is missing. The holding
// table keeps the asset name, not the House code or the Senate type. A House
// or Senate row that no longer carries the code or type keeps the class
// ingest saved from it. The description is not a substitute: options coded
// OP, and a Senate line whose type says Stock, both disagree with the name.
export function classifyHolding(row, source) {
  const src = String(source || row?.source || '').toLowerCase();
  const code = houseCode(row, src);
  if (code) return classFromHouseCode(code) || 'other';
  const senate = senateFields(row);
  if (senate) return classFromSenateType(senate.type, senate.subtype, holdingName(row));
  const name = holdingName(row);
  if ((src === 'house' || src === 'senate') && row?.assetClass) return row.assetClass;
  if (name) return classFromDescribedHolding(name);
  return storedClass(row);
}

export function mapMatchedClass(assetClass) {
  if (assetClass === 'etf' || assetClass === 'fund') return 'etf_fund';
  if (assetClass === 'bond') return 'bond';
  if (assetClass === 'crypto') return 'crypto';
  if (assetClass === 'stock') return 'stock';
  return 'other';
}
