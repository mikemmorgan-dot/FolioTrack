import { describe, expect, it } from 'vitest';
import {
  consumeHouseAnnualOcrPage,
  createHouseAnnualOcrParse,
  houseAnnualOcrResult,
  ocrHouseValueRange,
} from './parseHouseAnnualOcr.js';

function word(text, x, y, confidence = 85) {
  return { text, confidence, bbox: { x0: x, y0: y, x1: x + Math.max(8, String(text).length * 6), y1: y + 10 } };
}

describe('House OCR value ranges', () => {
  it('accepts statutory ranges and the 001→000 OCR typo only when the ceiling is exact', () => {
    expect(ocrHouseValueRange('$15,001 - $50,000')).toMatchObject({ kind: 'range', label: '$15,001 - $50,000', typo: false });
    expect(ocrHouseValueRange('$15 001 $50 000')).toMatchObject({ kind: 'range', label: '$15,001 - $50,000' });
    expect(ocrHouseValueRange('$15 000 $50 000')).toBeNull();
    expect(ocrHouseValueRange('$1,000-$15,000')).toMatchObject({ kind: 'range', label: '$1,001 - $15,000', typo: true });
    expect(ocrHouseValueRange('$1 000 $15,000')).toBeNull();
    expect(ocrHouseValueRange('$100 000 $150 000')).toBeNull();
    expect(ocrHouseValueRange('$2 - $9')).toBeNull();
    expect(ocrHouseValueRange('Over $50,000,000')).toMatchObject({ kind: 'at_least' });
    expect(ocrHouseValueRange('Undetermined')).toMatchObject({ kind: 'undetermined' });
  });
});

describe('House Form A and amendment-letter OCR', () => {
  it('reads an Escobar-style amendment letter and stops at Schedule B', () => {
    const state = createHouseAnnualOcrParse();
    consumeHouseAnnualOcrPage(state, [
      word('Re', 20, 20), word('Amendments', 50, 20), word('to', 130, 20), word('Previously', 160, 20), word('Filed', 250, 20),
      word('Schedule', 20, 80), word('A', 90, 80),
      word('ASSET', 20, 100), word('VALUE', 300, 100),
      word('TIAA', 20, 130), word('CREF', 60, 130), word('Total', 110, 130), word('Global', 160, 130), word('Stock', 220, 130),
      word('$100,001', 300, 130), word('-', 370, 130), word('$250,000', 390, 130),
      word('TIAA', 20, 160), word('S&P', 60, 160), word('500', 100, 160), word('Index', 140, 160), word('R2', 190, 160),
      word('$15,001', 300, 160), word('-', 370, 160), word('$50,000', 390, 160),
      word('University', 20, 190), word('of', 100, 190), word('TX', 130, 190), word('Optional', 160, 190),
      word('Retirement', 220, 190), word('Plan', 300, 190),
      word('Sarah', 20, 210), word('Raskin', 70, 210), word('Sale', 140, 210), word('(full)', 180, 210),
      word('11/11/2024', 230, 210), word('$50,001', 300, 210), word('-', 370, 210), word('$100,000', 390, 210),
      word('Schedule', 20, 230), word('B', 90, 230),
      word('NY', 20, 260), word('529', 50, 260), word('Conservative', 90, 260), word('Sale', 220, 260),
      word('$15,001', 300, 260), word('-', 370, 260), word('$50,000', 390, 260),
    ]);
    const parsed = houseAnnualOcrResult(state);
    expect(parsed.status).toBe('parsed');
    expect(parsed.holdings.map((row) => row.asset)).toEqual([
      'TIAA CREF Total Global Stock',
      'TIAA S&P 500 Index R2',
    ]);
    expect(parsed.holdings[0]).toMatchObject({
      valueRange: '$100,001 - $250,000',
      ocr: true,
      ocrConfidence: 85,
    });
    expect(parsed.holdings.some((row) => /529/.test(row.asset))).toBe(false);
    expect(parsed.note).toMatch(/OCR/);
  });

  it('drops a low-confidence row instead of guessing the value', () => {
    const state = createHouseAnnualOcrParse();
    consumeHouseAnnualOcrPage(state, [
      word('Schedule', 20, 20), word('A', 90, 20),
      word('USAA', 20, 50, 40), word('Cash', 70, 50, 40),
      word('$1,001', 300, 50, 40), word('-', 360, 50, 40), word('$15,000', 380, 50, 40),
      word('Vanguard', 20, 80), word('Total', 90, 80), word('Stock', 140, 80),
      word('$15,001', 300, 80), word('-', 370, 80), word('$50,000', 390, 80),
    ]);
    const parsed = houseAnnualOcrResult(state);
    expect(parsed.holdings).toHaveLength(1);
    expect(parsed.holdings[0].asset).toMatch(/Vanguard/);
    expect(parsed.droppedLowConfidence).toBe(1);
    expect(parsed.unreadableCount).toBe(1);
    expect(parsed.status).toBe('partial');
  });

  it('does not treat a narrative mention of Schedule A as an empty parsed report', () => {
    const state = createHouseAnnualOcrParse();
    consumeHouseAnnualOcrPage(state, [
      word('Accordingly', 20, 20), word('Schedule', 120, 20), word('A', 200, 20),
      word('of', 220, 20), word('my', 250, 20), word('financial', 280, 20), word('disclosure', 360, 20),
      word('include', 20, 50), word('the', 80, 50), word('following', 120, 50), word('asset', 200, 50),
    ]);
    const parsed = houseAnnualOcrResult(state);
    expect(parsed.status).not.toBe('parsed');
    expect(parsed.holdings).toEqual([]);
    expect(parsed.note || '').not.toMatch(/none disclosed/i);
  });
});
