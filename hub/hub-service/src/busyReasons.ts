/**
 * Closed set of reasons a player app reports itself unavailable, in canonical
 * display order. Mirrors the front-end `lib/hubPresence` BusyReason union; the
 * two apps are separate packages, so this is kept in sync manually like
 * `PlayerStatus`.
 */
export type BusyReason =
  | 'in-session'
  | 'restoring'
  | 'starting'
  | 'wallet-disconnected'
  | 'blockchain-not-ready';

export const BUSY_REASON_ORDER: readonly BusyReason[] = [
  'in-session',
  'restoring',
  'starting',
  'wallet-disconnected',
  'blockchain-not-ready',
];

const BUSY_REASON_SET: ReadonlySet<string> = new Set(BUSY_REASON_ORDER);

/**
 * Keep only known reasons, drop duplicates, and sort into canonical order.
 * Accepts the raw decoded `br` value; a non-list or unknown token yields `[]`.
 */
export function normalizeBusyReasons(value: unknown): BusyReason[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<BusyReason>();
  for (const item of value) {
    if (typeof item === 'string' && BUSY_REASON_SET.has(item)) {
      seen.add(item as BusyReason);
    }
  }
  return BUSY_REASON_ORDER.filter((reason) => seen.has(reason));
}
