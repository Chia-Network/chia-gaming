import type { ChannelStatus } from '../types/ChiaGaming';
import type { SessionModel } from './session/types';

/** Outcomes that mean a voluntary game-level accept (not a hand proposal). */
const SETTLEMENT_ACCEPT_OUTCOMES = new Set(['accept_settlement', 'we_accepted']);

/**
 * Gameplay events that should set the Game tab unread badge when the user
 * is on another tab. In-game Message / GameMessage is intentionally excluded.
 */
export function gameModelNeedsGameTabAttention(
  previous: SessionModel['game'],
  current: SessionModel['game'],
): boolean {
  for (const [id, instance] of Object.entries(current.instances)) {
    const before = previous.instances[id];
    const becameOurTurn =
      before !== undefined &&
      before.presentation !== instance.presentation &&
      (instance.presentation === 'off-chain-my-turn' ||
        instance.presentation === 'on-chain-my-turn');
    if (becameOurTurn) return true;

    if (
      before?.terminal.outcome !== instance.terminal.outcome &&
      instance.terminal.outcome != null &&
      SETTLEMENT_ACCEPT_OUTCOMES.has(instance.terminal.outcome)
    ) {
      return true;
    }
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
