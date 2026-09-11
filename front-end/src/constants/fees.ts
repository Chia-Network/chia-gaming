/**
 * Chia's mempool treats a fee below 5 mojos per cost unit as zero
 * (`nonzero_fee_minimum_fpc`), so a fee between 1 and that threshold buys
 * nothing and, on a full mempool, is rejected as INVALID_FEE_TOO_CLOSE_TO_ZERO
 * rather than admitted as a free transaction. 5 mojo/cost x the ~20M cost of a
 * two-input, two-output spend is 100M mojos; the funding bundle is larger than
 * that, so this is the floor below which a fee definitely cannot work, not a
 * guarantee of inclusion.
 */
export const MIN_NONZERO_FEE_MOJOS = 100_000_000n;

export function isEffectivelyZeroFee(fee: bigint): boolean {
  return fee > 0n && fee < MIN_NONZERO_FEE_MOJOS;
}
