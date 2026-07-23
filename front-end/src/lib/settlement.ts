/** Session-level settlement ids, used for protocol validation and banners. */
export type SettlementOutcome =
  | 'accept_settlement'
  | 'settled_cleanly'
  | 'opponent_timed_out'
  | 'forfeited_skipped_reveal'
  | 'forfeited_opponent_won'
  | 'forfeited_we_accepted'
  | 'we_accepted'
  | 'attempt_to_move_failed'
  | 'timed_out_waiting_for_our_move'
  | 'slashed_opponent'
  | 'opponent_slashed_us'
  | 'opponent_cheated';

const ALL_OUTCOMES: ReadonlySet<string> = new Set<SettlementOutcome>([
  'accept_settlement', 'settled_cleanly', 'opponent_timed_out',
  'forfeited_skipped_reveal', 'forfeited_opponent_won', 'forfeited_we_accepted',
  'we_accepted', 'attempt_to_move_failed', 'timed_out_waiting_for_our_move',
  'slashed_opponent', 'opponent_slashed_us', 'opponent_cheated',
]);

const LABELS: Record<SettlementOutcome, string> = {
  accept_settlement: 'Accepted',
  settled_cleanly: 'Settled cleanly',
  opponent_timed_out: 'Opponent timed out',
  forfeited_skipped_reveal: 'Forfeited',
  forfeited_opponent_won: 'Forfeited',
  forfeited_we_accepted: 'Forfeited',
  we_accepted: 'Accepted',
  attempt_to_move_failed: 'Attempt to move failed',
  timed_out_waiting_for_our_move: 'Timed out waiting for our move',
  slashed_opponent: 'Slashed opponent',
  opponent_slashed_us: 'Opponent slashed us',
  opponent_cheated: 'Opponent cheated',
};

export function isSettlementOutcome(value: unknown): value is SettlementOutcome {
  return typeof value === 'string' && ALL_OUTCOMES.has(value);
}

export function settlementLabel(outcome: SettlementOutcome): string {
  return LABELS[outcome];
}

export function isErrorSettlementOutcome(outcome: SettlementOutcome): boolean {
  return outcome === 'forfeited_skipped_reveal'
    || outcome === 'forfeited_opponent_won'
    || outcome === 'forfeited_we_accepted'
    || outcome === 'timed_out_waiting_for_our_move'
    || outcome === 'attempt_to_move_failed'
    || outcome === 'opponent_slashed_us'
    || outcome === 'opponent_cheated';
}

export function parseSettlementShare(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value === 'object' && value !== null && 'Amount' in (value as Record<string, unknown>)) {
    return String((value as Record<string, unknown>).Amount);
  }
  if (typeof value === 'object' && value !== null && 'amt' in (value as Record<string, unknown>)) {
    return String((value as Record<string, unknown>).amt);
  }
  return String(value);
}
