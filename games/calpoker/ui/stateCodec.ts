import { defineGameStateCodec } from '../../host';

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
}

function isCardArray(value: unknown): value is bigint[] {
  return (
    Array.isArray(value) &&
    value.every((item) => typeof item === 'bigint' && item >= 0n && item < 52n) &&
    new Set(value).size === value.length
  );
}

function isDisplaySnapshot(value: unknown): value is CalpokerDisplaySnapshot {
  if (typeof value !== 'object' || value === null) return false;
  const snapshot = value as Partial<CalpokerDisplaySnapshot>;
  return (
    typeof snapshot.gameState === 'string' &&
    (snapshot.winner === null || typeof snapshot.winner === 'string') &&
    isCardArray(snapshot.playerBestHandCardIds) &&
    isCardArray(snapshot.opponentBestHandCardIds) &&
    isCardArray(snapshot.playerHaloCardIds) &&
    isCardArray(snapshot.opponentHaloCardIds) &&
    typeof snapshot.playerDisplayText === 'string' &&
    typeof snapshot.opponentDisplayText === 'string'
  );
}

function isCalpokerHandState(value: unknown): value is CalpokerHandState {
  if (typeof value !== 'object' || value === null) return false;
  const state = value as Partial<CalpokerHandState>;
  if (!isCardArray(state.playerHand) || !isCardArray(state.opponentHand)) return false;
  if (state.playerHand.length !== state.opponentHand.length) {
    return false;
  }
  if (new Set([...state.playerHand, ...state.opponentHand]).size !== state.playerHand.length * 2) {
    return false;
  }
  if (
    state.cardSelections !== undefined &&
    (!isCardArray(state.cardSelections) ||
      state.cardSelections.length > 4 ||
      state.cardSelections.some((card) => !state.playerHand!.includes(card)))
  ) {
    return false;
  }
  return (
    typeof state.moveNumber === 'bigint' &&
    state.moveNumber >= 0n &&
    state.moveNumber <= 3n &&
    typeof state.isPlayerTurn === 'boolean' &&
    (state.displaySnapshot === undefined || isDisplaySnapshot(state.displaySnapshot))
  );
}

export const calpokerStateCodec = defineGameStateCodec<CalpokerHandState>({
  gameType: 'calpoker',
  version: 1n,
  canRemountFinished: true,
  isState: isCalpokerHandState,
});
