import type { CalpokerSettlementOutcome } from './handState';

function isForfeitOutcome(outcome: CalpokerSettlementOutcome): boolean {
  return outcome === 'forfeited_skipped_reveal'
    || outcome === 'forfeited_opponent_won'
    || outcome === 'forfeited_we_accepted';
}

export function hasTerminalCalpokerSettlement(
  settlementOutcome: CalpokerSettlementOutcome | null | undefined,
): boolean {
  return settlementOutcome != null;
}

export function settlementByUs(outcome: CalpokerSettlementOutcome): boolean | null {
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

export function calpokerTimeoutBadge(
  outcome: CalpokerSettlementOutcome,
  side: 'ours' | 'theirs',
  onChain: boolean | null | undefined,
): 'winner' | 'timeout' | 'forfeit' | null {
  if (!onChain) return null;
  const byUs = settlementByUs(outcome);
  if (byUs == null) return null;
  if (side === 'ours') return byUs ? (isForfeitOutcome(outcome) ? 'forfeit' : 'timeout') : 'winner';
  return !byUs ? (isForfeitOutcome(outcome) ? 'forfeit' : 'timeout') : 'winner';
}

export function calpokerSettlementVerb(outcome: CalpokerSettlementOutcome): string {
  if (isForfeitOutcome(outcome)) return 'forfeited';
  if (outcome === 'attempt_to_move_failed') return 'moved too late';
  if (outcome === 'accept_settlement' || outcome === 'we_accepted' || outcome === 'settled_cleanly') return 'settled';
  if (outcome === 'slashed_opponent') return 'slashed opponent';
  if (outcome === 'opponent_slashed_us') return 'was slashed';
  if (outcome === 'opponent_cheated') return 'cheated';
  return 'timed out';
}
