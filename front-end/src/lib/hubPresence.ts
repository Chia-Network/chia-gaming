import type { SessionPhase } from '../types/ChiaGaming';

/**
 * Closed set of reasons a player app reports itself unavailable to the hub,
 * listed in display priority order. Hub availability stays a boolean; these
 * reasons only explain why the player is busy so the lobby can describe it.
 */
export type BusyReason =
  | 'in-session'
  | 'restoring'
  | 'starting'
  | 'wallet-disconnected'
  | 'blockchain-not-ready';

/** Canonical display and serialization order for busy reasons. */
export const BUSY_REASON_ORDER: readonly BusyReason[] = [
  'in-session',
  'restoring',
  'starting',
  'wallet-disconnected',
  'blockchain-not-ready',
];

const BUSY_REASON_SET: ReadonlySet<string> = new Set(BUSY_REASON_ORDER);

export function isBusyReason(value: unknown): value is BusyReason {
  return typeof value === 'string' && BUSY_REASON_SET.has(value);
}

/**
 * Keep only known reasons, drop duplicates, and sort into canonical order.
 * Both the client (before send) and the hub (on receive) use this so an
 * unknown or reordered token never leaks past the boundary.
 */
export function normalizeBusyReasons(reasons: readonly unknown[]): BusyReason[] {
  const seen = new Set<BusyReason>();
  for (const reason of reasons) {
    if (isBusyReason(reason)) seen.add(reason);
  }
  return BUSY_REASON_ORDER.filter((reason) => seen.has(reason));
}

/**
 * Hub presence: availability plus, when busy, a non-empty canonical reason set.
 * Callers that only gate matchmaking read `busy`; the lobby reads `reasons`.
 */
export type HubPresence = { busy: false } | { busy: true; reasons: readonly BusyReason[] };

export interface HubPresenceInputs {
  sessionPhase: SessionPhase;
  /** Defaults to true (a connected wallet). */
  walletConnected?: boolean;
  /** Defaults to true (the backend is ready for play). */
  blockchainReady?: boolean;
  /** A non-terminal live / pre-handshake cradle is present. */
  hasCradle?: boolean;
  /** The current save is a terminal session (never a restore obligation). */
  terminalSave?: boolean;
  /** An accept transition is in flight. */
  pending?: boolean;
  /** A fresh-start persist is in flight. */
  persistInFlight?: boolean;
}

/**
 * Single source of truth for the hub busy signal. Availability is the boolean
 * `busy`; `reasons` is a non-empty canonical list whenever `busy` is true.
 *
 * The restore obligation follows the presence of a non-terminal cradle rather
 * than a transient `restoring` flag, so a reconnect `identify` cannot clear
 * busy that session registration just set.
 */
export function computeHubPresence(inputs: HubPresenceInputs): HubPresence {
  const walletConnected = inputs.walletConnected ?? true;
  const blockchainReady = inputs.blockchainReady ?? true;
  const reasons: BusyReason[] = [];
  if (inputs.sessionPhase !== 'none' && inputs.sessionPhase !== 'resolved') {
    reasons.push('in-session');
  }
  if (!!inputs.hasCradle && !inputs.terminalSave) {
    reasons.push('restoring');
  }
  if (!!inputs.pending || !!inputs.persistInFlight) {
    reasons.push('starting');
  }
  if (!walletConnected) reasons.push('wallet-disconnected');
  if (!blockchainReady) reasons.push('blockchain-not-ready');
  if (reasons.length === 0) return { busy: false };
  return { busy: true, reasons: normalizeBusyReasons(reasons) };
}
