import type { SpacepokerSettlementOutcome } from './handState';

export function isSpacepokerForfeitOutcome(outcome: SpacepokerSettlementOutcome): boolean {
  return outcome === 'forfeited_skipped_reveal'
    || outcome === 'forfeited_opponent_won'
    || outcome === 'forfeited_we_accepted';
}

export function spacepokerSettlementByUs(outcome: SpacepokerSettlementOutcome): boolean | null {
  switch (outcome) {
    case 'accept_settlement':
    case 'we_accepted':
    case 'forfeited_skipped_reveal':
    case 'forfeited_opponent_won':
    case 'forfeited_we_accepted':
    case 'timed_out_waiting_for_our_move':
    case 'attempt_to_move_failed':
    case 'slashed_opponent':
      return true;
    case 'opponent_timed_out':
    case 'opponent_slashed_us':
    case 'opponent_cheated':
      return false;
    case 'settled_cleanly':
      return null;
  }
}

export function spacepokerTerminalBadge(
  outcome: SpacepokerSettlementOutcome,
  side: 'ours' | 'theirs',
): 'winner' | 'timeout' | 'forfeit' | null {
  const byUs = spacepokerSettlementByUs(outcome);
  if (byUs == null) return null;
  if (side === 'ours') return byUs ? (isSpacepokerForfeitOutcome(outcome) ? 'forfeit' : 'timeout') : 'winner';
  return !byUs ? (isSpacepokerForfeitOutcome(outcome) ? 'forfeit' : 'timeout') : 'winner';
}

export function isSpacepokerTimeoutOrForfeit(outcome: SpacepokerSettlementOutcome): boolean {
  return outcome === 'timed_out_waiting_for_our_move'
    || outcome === 'opponent_timed_out'
    || isSpacepokerForfeitOutcome(outcome);
}
