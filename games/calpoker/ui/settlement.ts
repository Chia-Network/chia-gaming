import type { SettlementOutcome } from '../../host';

export function isForfeitOutcome(outcome: SettlementOutcome): boolean {
  return outcome === 'forfeited_skipped_reveal' || outcome === 'forfeited_we_accepted';
}

export function settlementByUs(outcome: SettlementOutcome): boolean | null {
  switch (outcome) {
    case 'accept_settlement':
    case 'we_accepted':
    case 'forfeited_skipped_reveal':
    case 'forfeited_we_accepted':
    case 'lost':
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
  outcome: SettlementOutcome,
  side: 'ours' | 'theirs',
  handCompleted = false,
): 'winner' | 'timeout' | 'forfeit' | null {
  if (handCompleted && !isForfeitOutcome(outcome)) {
    return null;
  }
  if (
    outcome === 'accept_settlement' ||
    outcome === 'we_accepted' ||
    outcome === 'settled_cleanly' ||
    outcome === 'lost'
  ) {
    return null;
  }
  const byUs = settlementByUs(outcome);
  if (byUs == null) return null;
  if (side === 'ours') {
    if (byUs) return isForfeitOutcome(outcome) ? 'forfeit' : 'timeout';
    return 'winner';
  }
  if (!byUs) return isForfeitOutcome(outcome) ? 'forfeit' : 'timeout';
  return 'winner';
}

export function calpokerSettlementVerb(outcome: SettlementOutcome): string {
  if (isForfeitOutcome(outcome)) return 'forfeited';
  if (outcome === 'lost') return 'loses';
  if (outcome === 'attempt_to_move_failed') return 'moved too late';
  if (
    outcome === 'accept_settlement' ||
    outcome === 'we_accepted' ||
    outcome === 'settled_cleanly'
  ) {
    return 'settled';
  }
  if (outcome === 'slashed_opponent') return 'slashed opponent';
  if (outcome === 'opponent_slashed_us') return 'was slashed';
  if (outcome === 'opponent_cheated') return 'cheated';
  return 'timed out';
}
