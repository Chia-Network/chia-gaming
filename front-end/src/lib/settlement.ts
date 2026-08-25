import { isSettlementOutcome, type SettlementOutcome } from '@games/host';

export type { SettlementOutcome } from '@games/host';
export { isSettlementOutcome };

const SETTLEMENT_OUTCOME_LABELS: Record<SettlementOutcome, string> = {
  accept_settlement: 'Accepted',
  settled_cleanly: 'Settled cleanly',
  opponent_timed_out: 'Opponent timed out',
  forfeited_skipped_reveal: 'Forfeited',
  lost: 'Lost',
  forfeited_we_accepted: 'Forfeited',
  we_accepted: 'Accepted',
  attempt_to_move_failed: 'Attempt to move failed',
  timed_out_waiting_for_our_move: 'Timed out waiting for our move',
  slashed_opponent: 'Slashed opponent',
  opponent_slashed_us: 'Opponent slashed us',
  opponent_cheated: 'Opponent cheated',
};

export function settlementLabel(outcome: SettlementOutcome): string {
  return SETTLEMENT_OUTCOME_LABELS[outcome];
}

export function isErrorSettlementOutcome(outcome: SettlementOutcome): boolean {
  return (
    outcome === 'forfeited_skipped_reveal' ||
    outcome === 'forfeited_we_accepted' ||
    outcome === 'timed_out_waiting_for_our_move' ||
    outcome === 'attempt_to_move_failed' ||
    outcome === 'opponent_slashed_us' ||
    outcome === 'opponent_cheated'
  );
}

export function parseSettlementShare(value: unknown): string | null {
  if (value == null) return null;
  if (
    typeof value === 'object' &&
    value !== null &&
    'Amount' in (value as Record<string, unknown>)
  ) {
    return String((value as Record<string, unknown>).Amount);
  }
  if (typeof value === 'object' && value !== null && 'amt' in (value as Record<string, unknown>)) {
    return String((value as Record<string, unknown>).amt);
  }
  return String(value);
}
