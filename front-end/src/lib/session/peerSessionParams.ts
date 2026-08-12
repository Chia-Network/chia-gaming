/**
 * Trust-boundary validation for peer/hub session start parameters.
 *
 * Bad inbound amounts or timeouts must be rejected at intake (reject the peer
 * proposal / ignore the advisory). They must never reach session start logic
 * that could tear down a finished freeze or IndexedDB checkpoint.
 */

export const MIN_TIMEOUT_BLOCKS = 3;
export const MAX_TIMEOUT_BLOCKS = 30;

/** Canonical decimal bigint text: no sign, no hex, no leading zeros (`08`). */
const DECIMAL_BIGINT_STRING = /^(0|[1-9]\d*)$/;

export function parseOptionalBigInt(raw: string | undefined): bigint | undefined {
  if (!raw || !DECIMAL_BIGINT_STRING.test(raw)) return undefined;
  try {
    return BigInt(raw);
  } catch {
    return undefined;
  }
}

/** Positive decimal bigint string (session buy-in amounts). */
export function isValidSessionAmountString(raw: string | undefined): boolean {
  if (raw === undefined || !DECIMAL_BIGINT_STRING.test(raw)) return false;
  try {
    return BigInt(raw) > 0n;
  } catch {
    return false;
  }
}

export function parseSessionAmount(raw: string): bigint {
  if (!DECIMAL_BIGINT_STRING.test(raw)) {
    throw new Error(`invalid session amount: ${raw}`);
  }
  let amount: bigint;
  try {
    amount = BigInt(raw);
  } catch (e) {
    throw new Error(`invalid session amount: ${raw}`, { cause: e });
  }
  if (amount <= 0n) {
    throw new Error(`session amount must be positive, got ${raw}`);
  }
  return amount;
}

export function isValidTimeoutString(v: string | undefined): boolean {
  if (v === undefined) return true;
  const n = parseOptionalBigInt(v);
  return n !== undefined && n >= BigInt(MIN_TIMEOUT_BLOCKS) && n <= BigInt(MAX_TIMEOUT_BLOCKS);
}

/**
 * After Accept, `transitionToFreshSession` only retires the finished freeze once
 * the live checkpoint write has landed. Failures or user Cancel before that must
 * end the peer attempt only — never clear IndexedDB / blank results. Once
 * replaceSession has successfully replaced the checkpoint, full attempt teardown
 * is required.
 */
export function startFailureDisposition(
  persistCommitted: boolean,
): 'abandon-peer-only' | 'cancel-attempt' {
  return persistCommitted ? 'cancel-attempt' : 'abandon-peer-only';
}
