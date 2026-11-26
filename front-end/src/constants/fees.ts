import protocolConstants from 'chia-gaming-protocol-constants';

/** The network minimum, in mojos per cost, that Rust enforces for any nonzero rate. */
export const MINIMUM_FEE_PER_COST = BigInt(protocolConstants.fees.minMojosPerCost);
export const EXPEDITED_FEE_PER_COST = 10n;
export const DEFAULT_FEE_PER_COST = MINIMUM_FEE_PER_COST;

const OPENING_COST_SHARE = BigInt(protocolConstants.fees.openingCostShare);
const FEE_SPEND_COST_ALLOWANCE = BigInt(protocolConstants.fees.feeSpendCostAllowance);
/** The median cost of a protocol spend in the simulator suite. Only used for estimates. */
const TYPICAL_TRANSACTION_COST = 10_000_000n;

function effectiveRate(feePerCost: bigint): bigint {
  if (feePerCost === 0n) return 0n;
  return feePerCost > MINIMUM_FEE_PER_COST ? feePerCost : MINIMUM_FEE_PER_COST;
}

/** The opening fee Rust will pay at this rate. Zero disables fees. */
export function openingFeeMojos(feePerCost: bigint): bigint {
  return effectiveRate(feePerCost) * OPENING_COST_SHARE;
}

/** An estimate for a typical later transaction, such as closing the session. */
export function transactionFeeEstimate(feePerCost: bigint): bigint {
  return effectiveRate(feePerCost) * (TYPICAL_TRANSACTION_COST + FEE_SPEND_COST_ALLOWANCE);
}
