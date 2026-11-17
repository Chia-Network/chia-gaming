/**
 * Mojos the wallet is short of funding `buyIn` plus the opening `fee`, or 0n
 * when it is enough. An unknown balance is never reported as short.
 */
export function fundingShortfall(balance: bigint | undefined, buyIn: string, fee: bigint): bigint {
  if (balance === undefined) return 0n;
  const needed = BigInt(buyIn) + fee;
  return balance < needed ? needed - balance : 0n;
}
