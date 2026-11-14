// Asset classes for annual holdings. Codes are the House Clerk list at
// https://fd.house.gov/reference/asset-type-codes.aspx. A code that is not
// in that list stays "other" rather than being folded into a nearby class.

import { isDebtDescription, isExchangeTraded } from './nameMatch.js';

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

export function classFromDescribedHolding(name) {
  const text = String(name || '');
  if (isExchangeTraded(text) || /\bmutual fund\b/i.test(text) || /\betf\b/i.test(text)) return 'etf_fund';
  if (isDebtDescription(text)) return 'bond';
  if (/\b(bitcoin|ethereum|crypto)\b/i.test(text)) return 'crypto';
  if (/\b(real estate|real property|unimproved|residence|commercial building|vineyard)\b/i.test(text)) {
    return 'real_estate';
  }
  if (/\b(checking|savings|money market|bank account|certificate of deposit)\b/i.test(text)) return 'cash';
  if (/\b(401\(k\)|403\(b\)|ira|pension|retirement)\b/i.test(text)) return 'retirement';
  if (/\b(llc|l\.l\.c|limited partnership|llp)\b/i.test(text)) return 'private';
  if (/\bcommon stock\b/i.test(text) || /\bstocks?\b/i.test(text)) return 'stock';
  return 'other';
}

export function mapMatchedClass(assetClass) {
  if (assetClass === 'etf' || assetClass === 'fund') return 'etf_fund';
  if (assetClass === 'bond') return 'bond';
  if (assetClass === 'crypto') return 'crypto';
  if (assetClass === 'stock') return 'stock';
  return 'other';
}
