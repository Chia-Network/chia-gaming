import type { KrunkSettlementOutcome } from './handState';

export function krunkSettlementStatus(
  outcome: KrunkSettlementOutcome,
  opponentLabel: string,
): string | null {
  switch (outcome) {
    case 'accept_settlement':
    case 'we_accepted':
    case 'settled_cleanly':
      return null;
    case 'opponent_timed_out':
      return `${opponentLabel} timed out.`;
    case 'forfeited_skipped_reveal':
    case 'forfeited_we_accepted':
    case 'forfeited_opponent_won':
      return 'We forfeited.';
    case 'attempt_to_move_failed':
      return 'Attempt to move failed.';
    case 'timed_out_waiting_for_our_move':
      return 'You timed out.';
    case 'slashed_opponent':
      return `Slashed ${opponentLabel}.`;
    case 'opponent_slashed_us':
      return `${opponentLabel} slashed us.`;
    case 'opponent_cheated':
      return `${opponentLabel} cheated.`;
  }
}
