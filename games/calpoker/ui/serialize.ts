import { Program } from 'clvm-lib';
import { defineGameStateCodec, type DurableGameStateEvent } from '../../host';
import { CalpokerOutcome, projectCalpokerFinalDisplay } from './outcome';

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

function initialState(isMyTurn: boolean): CalpokerHandState {
  return {
    playerHand: [],
    opponentHand: [],
    cardSelections: [],
    moveNumber: 0n,
    isPlayerTurn: isMyTurn,
  };
}

function cardsFromReadable(
  readable: Uint8Array,
  iStarted: boolean,
): Pick<CalpokerHandState, 'playerHand' | 'opponentHand'> {
  const lists = Program.deserialize(readable)
    .toList()
    .map((list) => list.toList().map((card) => card.toBigInt()));
  return iStarted
    ? { playerHand: lists[1], opponentHand: lists[0] }
    : { playerHand: lists[0], opponentHand: lists[1] };
}

type CalpokerFeatureEvent =
  | { type: 'opponent-moved'; readable: Uint8Array; iStarted: boolean }
  | { type: 'game-message'; readable: Uint8Array; iStarted: boolean };

function selectedCardsToBitfield(selectedCards: bigint[], hand: bigint[]): bigint {
  return hand.reduce(
    (bitfield, cardId, index) =>
      selectedCards.includes(cardId) ? bitfield | (1n << BigInt(index)) : bitfield,
    0n,
  );
}

export function isCalpokerOutcomeReadable(readable: Uint8Array | number[]): boolean {
  try {
    const result = Program.deserialize(Uint8Array.from(readable)).toList();
    return result.length === 6 && result[3].toList().length > 0 && result[4].toList().length > 0;
  } catch {
    return false;
  }
}

function assertCalpokerOutcomeStage(current: CalpokerHandState): void {
  if (current.moveNumber < 2n) {
    throw new Error(
      `Calpoker final readable arrived before local selections were submitted (moveNumber=${current.moveNumber})`,
    );
  }
  if (
    current.playerHand.length !== 8 ||
    current.opponentHand.length !== 8 ||
    current.cardSelections?.length !== 4 ||
    !current.cardSelections.every((card) => current.playerHand.includes(card))
  ) {
    throw new Error('Calpoker final readable arrived without complete local hand selections');
  }
}

export function calpokerOutcomeFromState(
  current: CalpokerHandState,
  readable: Uint8Array | number[],
  iStarted: boolean,
): CalpokerOutcome {
  return new CalpokerOutcome(
    iStarted,
    selectedCardsToBitfield(current.cardSelections ?? [], current.playerHand),
    iStarted ? current.opponentHand : current.playerHand,
    iStarted ? current.playerHand : current.opponentHand,
    readable,
  );
}

export function reduceCalpokerFeatureState(
  current: CalpokerHandState,
  event: CalpokerFeatureEvent,
): CalpokerHandState {
  if (event.type === 'game-message') {
    return { ...current, ...cardsFromReadable(event.readable, event.iStarted) };
  }
  if (isCalpokerOutcomeReadable(event.readable)) {
    assertCalpokerOutcomeStage(current);
    const outcome = calpokerOutcomeFromState(current, event.readable, event.iStarted);
    const display = projectCalpokerFinalDisplay(outcome);
    return {
      ...current,
      playerHand: display.playerCards,
      opponentHand: display.opponentCards,
      cardSelections: [],
      isPlayerTurn: true,
      displaySnapshot: {
        gameState: 'final',
        winner: display.winner,
        playerBestHandCardIds: display.playerBestHandCardIds,
        opponentBestHandCardIds: display.opponentBestHandCardIds,
        playerHaloCardIds: display.playerHaloCardIds,
        opponentHaloCardIds: display.opponentHaloCardIds,
        playerDisplayText: display.playerDisplayText,
        opponentDisplayText: display.opponentDisplayText,
      },
    };
  }
  return {
    ...current,
    ...(current.moveNumber === 1n && !event.iStarted
      ? cardsFromReadable(event.readable, event.iStarted)
      : {}),
    isPlayerTurn: true,
  };
}

export function reduceCalpokerDurableState(
  current: CalpokerHandState | null,
  event: DurableGameStateEvent,
): CalpokerHandState | null {
  if (event.type === 'abandoned' || event.type === 'remove-group') return null;
  if (event.type === 'accepted-group') return current ?? initialState(event.isMyTurn);
  if (event.type === 'feature-state') {
    const state = calpokerStateCodec.isState(event.state) ? event.state : null;
    if (state === null) throw new Error('Invalid Calpoker feature-state payload');
    return state;
  }
  if (!current) return null;
  if (event.type === 'local-turn') return { ...current, isPlayerTurn: event.isMyTurn };
  if (event.type === 'settled') return { ...current, isPlayerTurn: false };
  if (event.type === 'game-status') {
    return event.readable
      ? reduceCalpokerFeatureState(current, {
          type: event.moverShare === null ? 'game-message' : 'opponent-moved',
          readable: event.readable,
          iStarted: event.iStarted,
        })
      : { ...current, isPlayerTurn: event.status === 'my-turn' };
  }
  return current;
}
