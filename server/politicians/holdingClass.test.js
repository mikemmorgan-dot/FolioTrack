import { describe, expect, it } from 'vitest';
import { classFromDescribedHolding, classFromHouseCode, classFromSenateType } from './holdingClass.js';

describe('described holdings from a 278e', () => {
  it('treats a bare issuer with a corporate suffix as stock', () => {
    expect(classFromDescribedHolding('APPLE INC')).toBe('stock');
    expect(classFromDescribedHolding('NVIDIA CORP')).toBe('stock');
    expect(classFromDescribedHolding('ALPHABET INC')).toBe('stock');
    expect(classFromDescribedHolding('***CARNIVAL CORP')).toBe('stock');
    expect(classFromDescribedHolding('WALT DISNEY CO')).toBe('stock');
    expect(classFromDescribedHolding('NVIDIACORP')).toBe('stock');
    expect(classFromDescribedHolding('MICROSOFTCORPORATION')).toBe('stock');
    expect(classFromDescribedHolding('ELILILLYANDCO')).toBe('stock');
    expect(classFromDescribedHolding('CHUBB LTD')).toBe('stock');
    expect(classFromDescribedHolding('NXP SEMICONDUCTORS NV')).toBe('stock');
    expect(classFromDescribedHolding('BUNGE GLOBAL SA')).toBe('stock');
    expect(classFromDescribedHolding('CRH PUBLIC LIMITED CO')).toBe('stock');
    expect(classFromDescribedHolding('SLB LIMITED')).toBe('stock');
    expect(classFromDescribedHolding('JOHNSON & JOHNSON')).toBe('stock');
    expect(classFromDescribedHolding('HOST HOTELS & RESORTS INC')).toBe('stock');
    expect(classFromDescribedHolding('WYNN RESORTS LTD')).toBe('stock');
    expect(classFromDescribedHolding('MGM RESORTS INTERNATIONAL')).toBe('stock');
    expect(classFromDescribedHolding('SIMON PROPERTY GROUP INC')).toBe('stock');
    expect(classFromDescribedHolding('AMERICAN TOWER CORP')).toBe('stock');
  });

  it('matches cryptocurrency, and does not treat an ownership percent as a coupon', () => {
    expect(classFromDescribedHolding('Cryptocurrency Wallet Virtual Link Key')).toBe('crypto');
    expect(classFromDescribedHolding('Bitcoin')).toBe('crypto');
    expect(classFromDescribedHolding('Etherium staked')).toBe('crypto');
    expect(classFromDescribedHolding(
      'Seven Springs LLC Location: Mt. Kisco, NY Underlying Asset: 25% equity interest in Shore Haven Apartments #1 Inc',
    )).toBe('real_estate');
  });

  it('prefers a golf club, resort, or tower over an incidental bank account', () => {
    expect(classFromDescribedHolding(
      'TRUMP NATIONAL GOLF CLUB LLC Location: Briarcliff Manor, NY Underlying Asset: U.S. Bank account. (value from bank account only)',
    )).toBe('private');
    expect(classFromDescribedHolding(
      'Jupiter Golf Club LLC Location: Jupiter, FL U.S. bank account',
    )).toBe('private');
    expect(classFromDescribedHolding(
      'Trump International Golf Club Scotland Limited Location: Aberdeen, Scotland Underlying Assets: golf club',
    )).toBe('private');
    expect(classFromDescribedHolding(
      'Turnberry Scotland LLC location: Turnberry, Scotland (value and income reflect golf course and resort only)',
    )).toBe('private');
    expect(classFromDescribedHolding(
      'Trump Tower Commercial LLC Location: New York, NY See Line 385 and US bank account',
    )).toBe('real_estate');
    expect(classFromDescribedHolding(
      '40 Wall Street LLC Location: New York, NY residential & commercial',
    )).toBe('real_estate');
    expect(classFromDescribedHolding(
      'The Trump Corporation Location: New York, NY The Trump Marks Real Estate Corp Underlying Assets: U.S. Bank account',
    )).toBe('real_estate');
    expect(classFromDescribedHolding(
      'VHPS LLC Location: Los Angeles, CA Underlying Assets: U.S.bank account',
    )).toBe('cash');
    expect(classFromDescribedHolding(
      'Fifty-Seventh Street Associates LLC Location: New York, NY Underlying Assets: U.S. bank account',
    )).toBe('cash');
  });

  it('keeps bonds, cash, and funds', () => {
    expect(classFromDescribedHolding('NETFLIX INC REG S DUE 11/15/2029 5.375')).toBe('bond');
    expect(classFromDescribedHolding('WHIRLPOOL CORP DEB')).toBe('bond');
    expect(classFromDescribedHolding('OCCIDENTAL PETE SR DEBS-REG')).toBe('bond');
    expect(classFromDescribedHolding('US TREASUR NT 4.25%01/30UST NOTE DUE 01/31/30')).toBe('bond');
    expect(classFromDescribedHolding('ALLEN TX INDPT SCH PERMA SR A BE/R/ 5.000 021527 DTD 111525')).toBe('bond');
    expect(classFromDescribedHolding('U.S. BROKERAGE ACCOUNT MONEY MARKET ACCOUNT (CASH) #12')).toBe('cash');
    expect(classFromDescribedHolding('STEPHENS INS BANKSWEEP PROGRAM')).toBe('cash');
    expect(classFromDescribedHolding('SPDR PORTFOLIO HIGH YIELD BOND ETF')).toBe('etf_fund');
    expect(classFromDescribedHolding('VANGUARD INDEX FUNDS VANGUARD GROWTH ETF')).toBe('etf_fund');
    expect(classFromDescribedHolding('ISHARES SILVER SHARES')).toBe('etf_fund');
    expect(classFromDescribedHolding('INVESTMENT IN GOLD BARS')).toBe('other');
  });
});

describe('House codes and Senate asset types stay on their own paths', () => {
  it('maps House asset-type codes and ignores the description', () => {
    expect(classFromHouseCode('ST')).toBe('stock');
    expect(classFromHouseCode('EF')).toBe('etf_fund');
    expect(classFromHouseCode('BA')).toBe('cash');
    expect(classFromHouseCode('RP')).toBe('real_estate');
    expect(classFromHouseCode('CT')).toBe('crypto');
    expect(classFromHouseCode('OL')).toBe('private');
    expect(classFromHouseCode('ZZ')).toBe('other');
    expect(classFromHouseCode(null)).toBeNull();
  });

  it('classifies Senate rows from the asset type, not from an issuer suffix', () => {
    expect(classFromSenateType('Corporate Securities', 'Stock', 'Caterpillar, Inc. Common Stock')).toBe('stock');
    expect(classFromSenateType('Corporate Securities', 'Stock', 'Komatsu')).toBe('stock');
    expect(classFromSenateType('Bank Deposit', '', 'Bank of Monroe')).toBe('cash');
    expect(classFromSenateType('Business Entity', 'Limited Liability Company (LLC)', 'Family LLC')).toBe('private');
    expect(classFromSenateType('', '', 'APPLE INC')).toBe('other');
  });
});
