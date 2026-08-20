import { Program } from 'clvm-lib';
import {
  equalBaseTerms,
  readClvmAtom,
  readClvmFlag,
  readClvmList,
  readClvmProgram,
  type DurableGameStateEvent,
  type FactoryParameterCodec,
  type GameFeatureRegistration,
  type HandTermsModel,
} from '../../host';
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

export type CalpokerFactoryParameters = {
  perPlayerStake: bigint;
  senderGoesFirst: boolean;
};

export const calpokerFactoryParameters: FactoryParameterCodec<CalpokerFactoryParameters> = {
  decode(value) {
    const program = readClvmProgram(value);
    if (!program) return null;
    const items = readClvmList(program, 2);
    if (!items) return null;
    const perPlayerStake = readClvmAtom(items[0]);
    const senderGoesFirst = readClvmFlag(items[1]);
    if (perPlayerStake === null || perPlayerStake <= 0n || senderGoesFirst === null) return null;
    return { perPlayerStake, senderGoesFirst };
  },
  encode(params) {
    return Program.fromList([
      Program.fromBigInt(params.perPlayerStake),
      Program.fromBigInt(params.senderGoesFirst ? 1n : 0n),
    ]);
  },
};

export function validateCalpokerTerms(terms: HandTermsModel): boolean {
  return (
    terms.myContribution === terms.theirContribution &&
    terms.myContribution > 0n &&
    terms.gameTimeout > 0n
  );
}

export const calpokerRegistration: GameFeatureRegistration<
  CalpokerHandState,
  CalpokerHandState,
  { amount: bigint },
  CalpokerFactoryParameters
> = {
  gameType: 'calpoker',
  displayName: 'California Poker',
  stateCodec: calpokerStateCodec,
  factoryParameters: calpokerFactoryParameters,
  describeTerms: (terms, { formatMojos }) => `Stake ${formatMojos(terms.myContribution)} each`,
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
        gameType: 'calpoker',
        myContribution: draft.amount,
        theirContribution: draft.amount,
        gameTimeout,
      };
      return validateCalpokerTerms(terms) ? terms : null;
    },
  },
  toFactoryParameters(terms, iStarted) {
    return {
      perPlayerStake: terms.myContribution,
      senderGoesFirst: this.lifecycle.proposalSenderGoesFirst(iStarted),
    };
  },
  decodeProposalTerms(base, params) {
    if (params.perPlayerStake !== base.myContribution) return null;
    const terms = { gameType: 'calpoker', ...base };
    return validateCalpokerTerms(terms) ? terms : null;
  },
  validateTerms: validateCalpokerTerms,
  termsEqual: equalBaseTerms,
  persistence: {
    encodeExtras: () => ({}),
    decodeExtras(base) {
      const terms = { gameType: 'calpoker', ...base };
      return validateCalpokerTerms(terms) ? terms : null;
    },
  },
  durableState: {
    reduceEvent: reduceCalpokerDurableState,
  },
};
