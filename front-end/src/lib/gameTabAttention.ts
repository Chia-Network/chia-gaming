import type { GameplayEvent } from '@games/host';
import type { ChannelStatus } from '../types/ChiaGaming';

/** Outcomes that mean a voluntary game-level accept (not a hand proposal). */
const SETTLEMENT_ACCEPT_OUTCOMES = new Set(['accept_settlement', 'we_accepted']);

/**
 * Gameplay events that should set the Game tab unread badge when the user
 * is on another tab. In-game Message / GameMessage is intentionally excluded.
 */
export function gameplayEventNeedsGameTabAttention(evt: GameplayEvent): boolean {
  if ('OpponentMoved' in evt) return true;
  if ('Settled' in evt) {
    return SETTLEMENT_ACCEPT_OUTCOMES.has(evt.Settled.outcome);
  }
  return false;
}

/** A changed hand key with accepted game ids means a new hand started. */
export function acceptedHandNeedsGameTabAttention(
  previousHandKey: number,
  handKey: number,
  currentHandGameIds: readonly string[],
): boolean {
  return handKey !== previousHandKey && currentHandGameIds.length > 0;
}

/** Channel states that should set the Game tab unread badge (rising edge). */
export function channelStateNeedsGameTabAttention(state: ChannelStatus): boolean {
  return (
    state === 'ShuttingDown' ||
    state === 'ShutdownTransactionPending' ||
    state === 'GoingOnChain' ||
    state === 'Unrolling'
  );
}

/**
 * True when a peer hand proposal id newly appears or is replaced.
 * Used for both decision-mode cache and review-mode proposals so a user on
 * another tab is notified even when betweenHandMode does not change.
 * Clearing (non-null → null) and restore/hydration (same id) do not fire.
 */
export function peerProposalIdNeedsGameTabAttention(
  prevId: string | null,
  nextId: string | null,
): boolean {
  return nextId != null && nextId !== prevId;
}
