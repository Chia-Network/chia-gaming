import { Program } from 'clvm-lib';
import {
  createGameHand,
  isSettlementOutcome,
  type GameHand,
  type GameHandInitialization,
  type GameUpdate,
  type PersistedGameState,
  type SettlementOutcome,
} from '../../host';
import { CalpokerOutcome, projectCalpokerFinalDisplay, type CalpokerOutcomeShape } from './outcome';

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

export interface CalpokerError {
  tag: string;
  message: string;
}

export interface CalpokerHandState {
  gameId: string;
  perPlayerStake: bigint;
  playerHand: bigint[];
  opponentHand: bigint[];
  moveNumber: bigint;
  isPlayerTurn: boolean;
  iStarted: boolean;
  settlementOutcome: SettlementOutcome | null;
  cardSelections?: bigint[];
  displaySnapshot?: CalpokerDisplaySnapshot;
  outcome?: CalpokerOutcomeShape<bigint>;
}

/** Test/helper envelope only; persistence treats the state as opaque. */
export const calpokerStateCodec = {
  gameType: 'calpoker',
  encode: (state: CalpokerHandState): PersistedGameState<CalpokerHandState> => ({
    gameType: 'calpoker',
    state,
  }),
  decode: (value: unknown): CalpokerHandState | null =>
    typeof value === 'object' &&
    value !== null &&
    (value as Partial<PersistedGameState>).gameType === 'calpoker'
      ? ((value as PersistedGameState<CalpokerHandState>).state ?? null)
      : null,
};

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

function isBigintArray(value: unknown): value is bigint[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'bigint');
}

function isCalpokerOutcome(value: unknown): value is CalpokerOutcomeShape<bigint> {
  if (typeof value !== 'object' || value === null) return false;
  const outcome = value as Partial<CalpokerOutcomeShape<bigint>>;
  return (
    (outcome.my_win_outcome === 'win' ||
      outcome.my_win_outcome === 'lose' ||
      outcome.my_win_outcome === 'tie') &&
    isCardArray(outcome.my_cards) &&
    isCardArray(outcome.their_cards) &&
    isCardArray(outcome.my_final_hand) &&
    isCardArray(outcome.their_final_hand) &&
    isCardArray(outcome.my_used_cards) &&
    isCardArray(outcome.their_used_cards) &&
    isBigintArray(outcome.my_hand_value) &&
    isBigintArray(outcome.their_hand_value)
  );
}

export function isCalpokerHandState(value: unknown): value is CalpokerHandState {
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
    typeof state.gameId === 'string' &&
    state.gameId.length > 0 &&
    typeof state.perPlayerStake === 'bigint' &&
    state.perPlayerStake > 0n &&
    typeof state.moveNumber === 'bigint' &&
    state.moveNumber >= 0n &&
    state.moveNumber <= 3n &&
    typeof state.isPlayerTurn === 'boolean' &&
    typeof state.iStarted === 'boolean' &&
    (state.settlementOutcome === null || isSettlementOutcome(state.settlementOutcome)) &&
    (state.displaySnapshot === undefined || isDisplaySnapshot(state.displaySnapshot)) &&
    (state.outcome === undefined || isCalpokerOutcome(state.outcome))
  );
}

function initialState(init: GameHandInitialization): CalpokerHandState {
  const proposerStarted = init.origin === 'local' ? init.iStarted : !init.iStarted;
  const proposerGoesFirst = !proposerStarted;
  const isMyTurn = init.origin === 'local' ? proposerGoesFirst : !proposerGoesFirst;
  return {
    gameId: init.gameIds[0]!,
    perPlayerStake: init.handProposal.myContribution,
    playerHand: [],
    opponentHand: [],
    cardSelections: [],
    moveNumber: 0n,
    isPlayerTurn: isMyTurn,
    iStarted: init.iStarted,
    settlementOutcome: null,
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
  | { type: 'opponent-moved'; readable: Uint8Array }
  | { type: 'game-message'; readable: Uint8Array };

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

function calpokerOutcomeShape(outcome: CalpokerOutcome): CalpokerOutcomeShape<bigint> {
  return {
    my_win_outcome: outcome.my_win_outcome,
    my_cards: outcome.my_cards,
    their_cards: outcome.their_cards,
    my_final_hand: outcome.my_final_hand,
    their_final_hand: outcome.their_final_hand,
    my_used_cards: outcome.my_used_cards,
    their_used_cards: outcome.their_used_cards,
    my_hand_value: outcome.my_hand_value,
    their_hand_value: outcome.their_hand_value,
  };
}

export function reduceCalpokerFeatureState(
  current: CalpokerHandState,
  event: CalpokerFeatureEvent,
): CalpokerHandState {
  if (event.type === 'game-message') {
    return { ...current, ...cardsFromReadable(event.readable, current.iStarted) };
  }
  if (isCalpokerOutcomeReadable(event.readable)) {
    assertCalpokerOutcomeStage(current);
    const outcome = calpokerOutcomeFromState(current, event.readable, current.iStarted);
    const display = projectCalpokerFinalDisplay(outcome);
    return {
      ...current,
      playerHand: display.playerCards,
      opponentHand: display.opponentCards,
      cardSelections: [],
      isPlayerTurn: true,
      outcome: calpokerOutcomeShape(outcome),
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
    ...(current.moveNumber === 1n && !current.iStarted
      ? cardsFromReadable(event.readable, current.iStarted)
      : {}),
    isPlayerTurn: true,
  };
}

export function reduceCalpokerHandState(
  current: CalpokerHandState,
  event: GameUpdate,
): CalpokerHandState {
  if (event.type === 'hand-ended') {
    return { ...current, isPlayerTurn: false, settlementOutcome: event.outcome };
  }
  if (event.type === 'move-readable' || event.type === 'message-readable') {
    return reduceCalpokerFeatureState(current, {
      type: event.type === 'move-readable' ? 'opponent-moved' : 'game-message',
      readable: event.readable,
    });
  }
  return current;
}

export function createCalpokerHand(init: GameHandInitialization): GameHand<CalpokerHandState> {
  if (init.gameIds.length !== 1 || init.handProposal.gameType !== 'calpoker') {
    throw new Error('California Poker requires one game and California Poker proposal terms');
  }
  return createGameHand(initialState(init), reduceCalpokerHandState);
}
