import protocolConstants from 'chia-gaming-protocol-constants';

/**
 * Initial user preference, not a network minimum. Rust raises any nonzero fee
 * to the minimum for the transaction's cost.
 */
export const DEFAULT_TRANSACTION_FEE_MOJOS = 100_000_000n;

const MINIMUM_OPENING_FEE_MOJOS =
  BigInt(protocolConstants.fees.minMojosPerCost) * BigInt(protocolConstants.fees.openingCostShare);

/** The opening fee Rust will request for a configured fee. Zero disables fees. */
export function openingFeeMojos(configured: bigint): bigint {
  if (configured === 0n) return 0n;
  return configured > MINIMUM_OPENING_FEE_MOJOS ? configured : MINIMUM_OPENING_FEE_MOJOS;
}
