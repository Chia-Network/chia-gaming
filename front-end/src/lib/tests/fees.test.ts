import { MIN_NONZERO_FEE_MOJOS, isEffectivelyZeroFee } from '../../constants/fees';

describe('isEffectivelyZeroFee', () => {
  it('treats zero as allowed (a free transaction)', () => {
    expect(isEffectivelyZeroFee(0n)).toBe(false);
  });

  it('treats any nonzero fee below the floor as effectively zero', () => {
    expect(isEffectivelyZeroFee(1n)).toBe(true);
    expect(isEffectivelyZeroFee(MIN_NONZERO_FEE_MOJOS - 1n)).toBe(true);
  });

  it('treats the floor and above as allowed', () => {
    expect(isEffectivelyZeroFee(MIN_NONZERO_FEE_MOJOS)).toBe(false);
    expect(isEffectivelyZeroFee(MIN_NONZERO_FEE_MOJOS + 1n)).toBe(false);
  });
});
