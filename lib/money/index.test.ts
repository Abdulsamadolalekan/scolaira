import { describe, expect, it } from 'vitest';
import { addKobo, formatKobo, formatKoboDisplay, parseNaira, ZERO_KOBO } from './index';

describe('money utilities', () => {
  describe('parseNaira', () => {
    it('parses valid naira strings to integer kobo', () => {
      expect(parseNaira('0.00')).toBe(0);
      expect(parseNaira('1.00')).toBe(100);
      expect(parseNaira('150000.00')).toBe(15_000_000);
      // ₦9 trillion = 90 trillion kobo — well within JS safe integer range.
      // (MAX_SAFE_INTEGER kobo ≈ ₦90,071,992,547,409.91; far larger than any
      // individual student invoice or even per-term school total.)
      expect(parseNaira('9000000000000.00')).toBe(900_000_000_000_000);
    });

    it('rejects non-numeric, malformed, or missing-decimal inputs', () => {
      expect(() => parseNaira('')).toThrow();
      expect(() => parseNaira('abc')).toThrow();
      expect(() => parseNaira('100')).toThrow(); // no decimals
      expect(() => parseNaira('100.')).toThrow();
      expect(() => parseNaira('.00')).toThrow();
      expect(() => parseNaira('-1.00')).toThrow(); // negative via invalid reversal path
      expect(() => parseNaira('01.00')).toThrow(); // leading zeros (other than 0.00)
      expect(() => parseNaira('1.0')).toThrow(); // single decimal
      expect(() => parseNaira('1.000')).toThrow(); // three decimals
    });

    it('rejects amounts larger than MAX_SAFE_INTEGER in kobo', () => {
      // Number.MAX_SAFE_INTEGER kobo ≈ 9.007e13 naira; value below is larger.
      expect(() => parseNaira('999999999999999.00')).toThrow();
    });
  });

  describe('formatKobo', () => {
    it('formats zero', () => {
      expect(formatKobo(0)).toBe('0.00');
    });

    it('formats with always two decimals', () => {
      expect(formatKobo(50)).toBe('0.50');
      expect(formatKobo(75)).toBe('0.75');
      expect(formatKobo(100)).toBe('1.00');
      expect(formatKobo(12345)).toBe('123.45');
      expect(formatKobo(15_000_000)).toBe('150000.00');
    });

    it('rejects negative or non-integer kobo', () => {
      expect(() => formatKobo(-1)).toThrow();
      expect(() => formatKobo(1.5)).toThrow();
      expect(() => formatKobo(Number.NaN)).toThrow();
    });
  });

  describe('formatKoboDisplay', () => {
    it('adds Naira sign and thousands separators', () => {
      expect(formatKoboDisplay(0)).toBe('₦0.00');
      expect(formatKoboDisplay(10000000)).toBe('₦100,000.00');
      expect(formatKoboDisplay(4340000000)).toBe('₦43,400,000.00');
    });
  });

  describe('addKobo', () => {
    it('adds two kobo amounts without floating point error', () => {
      expect(
        addKobo(
          100 as unknown as ReturnType<typeof parseNaira>,
          250 as unknown as ReturnType<typeof parseNaira>,
        ),
      ).toBe(350);
    });

    it('throws on overflow', () => {
      const max = Number.MAX_SAFE_INTEGER;
      expect(() =>
        addKobo(
          max as unknown as ReturnType<typeof parseNaira>,
          1 as unknown as ReturnType<typeof parseNaira>,
        ),
      ).toThrow();
    });
  });

  describe('ZERO_KOBO', () => {
    it('is zero', () => {
      expect(ZERO_KOBO).toBe(0);
    });
  });

  describe('parse/format round-trip', () => {
    const cases = ['0.00', '0.50', '1.00', '150000.00', '9999999999.99'];
    it.each(cases)('case %s round-trips', (s) => {
      expect(formatKobo(parseNaira(s))).toBe(s);
    });
  });
});
