/**
 * Initial user preference, not a network minimum. Mempool admission depends on
 * the fee divided by the complete transaction cost and on current congestion.
 */
export const DEFAULT_TRANSACTION_FEE_MOJOS = 100_000_000n;
