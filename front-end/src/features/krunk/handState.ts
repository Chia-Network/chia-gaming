/** Krunk-owned terminal outcomes used by its browser UI. */
export type KrunkSettlementOutcome =
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

export interface PersistedKrunkHand<T> {
  gameType: 'krunk';
  version: bigint;
  state: T;
}
