import { Program } from 'clvm-lib';
import {
  equalBaseTerms,
  reduceGameStateSnapshot,
  type DurableGameStateEvent,
  type GameFeatureRegistration,
  type TermsFor,
} from '../../lib/gameAdapter';
import { CalpokerOutcome, projectCalpokerFinalDisplay } from './outcome';
import { calpokerStateCodec, type CalpokerHandState } from './stateCodec';

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

export function validateCalpokerTerms(terms: TermsFor<'calpoker'>): boolean {
  return (
    terms.myContribution === terms.theirContribution &&
    terms.myContribution > 0n &&
    terms.gameTimeout > 0n
  );
}

export const calpokerRegistration: GameFeatureRegistration<'calpoker', CalpokerHandState> = {
  gameType: 'calpoker',
  displayName: 'California Poker',
  stateCodec: calpokerStateCodec,
  handMembershipDescription: 'exactly one currentHandGameId',
  validateHandMembership: (gameIds) => gameIds.length === 1,
  decodeFeatureState: (value) => (calpokerStateCodec.isState(value) ? value : null),
  lifecycle: {
    proposalSenderGoesFirst: (iStarted) => !iStarted,
  },
  compose: {
    defaultDraft: (perGameAmount) => ({ amount: perGameAmount }),
    draftFromTerms: (terms) => ({ amount: terms.myContribution }),
    updateDraft: (current, update) => ({ ...current, ...update }),
    toTerms(draft, gameTimeout) {
      const terms = {
        gameType: 'calpoker' as const,
        myContribution: draft.amount,
        theirContribution: draft.amount,
        gameTimeout,
      };
      return validateCalpokerTerms(terms) ? terms : null;
    },
  },
  decodeProposalTerms(base) {
    const terms = { gameType: 'calpoker' as const, ...base };
    return validateCalpokerTerms(terms) ? terms : null;
  },
  encodeProposalParameters(terms, iStarted) {
    return Program.fromList([
      Program.fromBigInt(terms.myContribution),
      Program.fromBigInt(this.lifecycle.proposalSenderGoesFirst(iStarted) ? 1n : 0n),
    ]);
  },
  validateTerms: validateCalpokerTerms,
  termsEqual: equalBaseTerms,
  persistence: {
    encodeExtras: () => ({}),
    decodeExtras(base) {
      const terms = { gameType: 'calpoker' as const, ...base };
      return validateCalpokerTerms(terms) ? terms : null;
    },
  },
  durableState: {
    reduce: reduceGameStateSnapshot,
    reduceEvent: reduceCalpokerDurableState,
  },
};
