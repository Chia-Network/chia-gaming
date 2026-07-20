import type { GameplayEvent } from '../hooks/useGameSession';
import type { ChannelStatus } from '../types/ChiaGaming';

/** Outcomes that mean a voluntary game-level accept (not a hand proposal). */
const SETTLEMENT_ACCEPT_OUTCOMES = new Set([
  'accept_settlement',
  'we_accepted',
]);

/**
 * Gameplay events that should set the Game tab unread badge when the user
 * is on another tab. In-game Message / GameMessage is intentionally excluded.
 */
export function gameplayEventNeedsGameTabAttention(evt: GameplayEvent): boolean {
  if ('OpponentMoved' in evt || 'ProposalAccepted' in evt) return true;
  if ('Settled' in evt) {
    return SETTLEMENT_ACCEPT_OUTCOMES.has(evt.Settled.outcome);
  }
  return false;
}

/** Channel states that should set the Game tab unread badge (rising edge). */
export function channelStateNeedsGameTabAttention(state: ChannelStatus): boolean {
  return (
    state === 'ShuttingDown'
    || state === 'ShutdownTransactionPending'
    || state === 'GoingOnChain'
    || state === 'Unrolling'
  );
}
