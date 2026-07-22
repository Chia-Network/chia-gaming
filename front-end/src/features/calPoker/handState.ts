/** Calpoker-owned terminal outcomes used by its browser UI. */
export type CalpokerSettlementOutcome =
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

export interface CalpokerDisplaySnapshot {
  gameState: string;
  winner: string | null;
  playerBestHandCardIds: bigint[];
  opponentBestHandCardIds: bigint[];
  playerHaloCardIds: bigint[];
  opponentHaloCardIds: bigint[];
  playerDisplayText: string;
  opponentDisplayText: string;
}

export interface CalpokerHandState {
  playerHand: bigint[];
  opponentHand: bigint[];
  moveNumber: bigint;
  isPlayerTurn: boolean;
  cardSelections?: bigint[];
  displaySnapshot?: CalpokerDisplaySnapshot;
  settlementOutcome?: CalpokerSettlementOutcome | null;
  settlementOnChain?: boolean | null;
}

export interface PersistedCalpokerHand {
  gameType: 'calpoker';
  version: bigint;
  state: CalpokerHandState;
}
