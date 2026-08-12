import {
  isValidSessionAmountString,
  isValidTimeoutString,
  parseSessionAmount,
} from '../session/peerSessionParams';

describe('peerSessionParams', () => {
  describe('isValidSessionAmountString', () => {
    it('accepts positive decimal bigint strings', () => {
      expect(isValidSessionAmountString('1')).toBe(true);
      expect(isValidSessionAmountString('100')).toBe(true);
      expect(isValidSessionAmountString('999999999999')).toBe(true);
    });

    it('rejects empty, zero, negative, and non-numeric values', () => {
      expect(isValidSessionAmountString(undefined)).toBe(false);
      expect(isValidSessionAmountString('')).toBe(false);
      expect(isValidSessionAmountString('0')).toBe(false);
      expect(isValidSessionAmountString('-1')).toBe(false);
      expect(isValidSessionAmountString('not-a-number')).toBe(false);
      expect(isValidSessionAmountString('1.5')).toBe(false);
      expect(isValidSessionAmountString('0x10')).toBe(false);
      expect(isValidSessionAmountString('08')).toBe(false);
    });
  });

  describe('isValidTimeoutString', () => {
    it('treats omitted timeouts as valid (defaults apply later)', () => {
      expect(isValidTimeoutString(undefined)).toBe(true);
    });

    it('accepts only the hub range 3-30', () => {
      expect(isValidTimeoutString('3')).toBe(true);
      expect(isValidTimeoutString('15')).toBe(true);
      expect(isValidTimeoutString('30')).toBe(true);
      expect(isValidTimeoutString('2')).toBe(false);
      expect(isValidTimeoutString('31')).toBe(false);
      expect(isValidTimeoutString('nope')).toBe(false);
    });

    it('rejects leading-zero decimals without throwing', () => {
      expect(isValidTimeoutString('08')).toBe(false);
      expect(isValidTimeoutString('015')).toBe(false);
    });
  });

  describe('parseSessionAmount', () => {
    it('parses positive amounts', () => {
      expect(parseSessionAmount('42')).toBe(42n);
    });

    it('throws on invalid amounts', () => {
      expect(() => parseSessionAmount('0')).toThrow(/positive/);
      expect(() => parseSessionAmount('bad')).toThrow(/invalid session amount/);
      expect(() => parseSessionAmount('08')).toThrow(/invalid session amount/);
    });
  });
});
