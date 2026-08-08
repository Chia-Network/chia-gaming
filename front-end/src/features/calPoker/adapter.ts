import { Program } from 'clvm-lib';
import {
  equalBaseTerms,
  reduceGameStateSnapshot,
  type DurableGameStateEvent,
  type GameFeatureRegistration,
} from '../../lib/gameAdapter';
import { calpokerStateCodec, type CalpokerHandState } from './stateCodec';

function initialState(iStarted: boolean): CalpokerHandState {
  return {
    playerHand: [],
    opponentHand: [],
    cardSelections: [],
    moveNumber: 0n,
    isPlayerTurn: !iStarted,
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

export function reduceCalpokerFeatureState(
  current: CalpokerHandState,
  event: CalpokerFeatureEvent,
): CalpokerHandState {
  if (event.type === 'game-message') {
    return { ...current, ...cardsFromReadable(event.readable, event.iStarted) };
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
  if (event.type === 'accepted-group') return current ?? initialState(event.iStarted);
  if (event.type === 'feature-state') {
    return calpokerStateCodec.decode(calpokerStateCodec.encode(event.state as CalpokerHandState));
  }
  if (!current) return null;
  if (event.type === 'local-turn') return { ...current, isPlayerTurn: event.isMyTurn };
  if (event.type === 'settled') return { ...current, isPlayerTurn: false };
  if (event.type === 'game-status') {
    return event.readable
      ? reduceCalpokerFeatureState(current, {
          type: 'opponent-moved',
          readable: event.readable,
          iStarted: event.iStarted,
        })
      : { ...current, isPlayerTurn: event.status === 'my-turn' };
  }
  return current;
}

export const calpokerRegistration: GameFeatureRegistration<'calpoker', CalpokerHandState> = {
  gameType: 'calpoker',
  displayName: 'California Poker',
  stateCodec: calpokerStateCodec,
  lifecycle: {
    proposalSenderGoesFirst: (iStarted) => !iStarted,
    initialTurn: (iStarted) => (iStarted ? 'their-turn' : 'my-turn'),
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
      return calpokerRegistration.validateTerms(terms) ? terms : null;
    },
  },
  decodeProposalTerms: (base) => ({ gameType: 'calpoker', ...base }),
  encodeProposalParameters(terms, iStarted) {
    return Program.fromList([
      Program.fromBigInt(terms.myContribution),
      Program.fromBigInt(this.lifecycle.proposalSenderGoesFirst(iStarted) ? 1n : 0n),
    ]);
  },
  validateTerms: (terms) =>
    terms.myContribution > 0n && terms.theirContribution > 0n && terms.gameTimeout > 0n,
  termsEqual: equalBaseTerms,
  persistence: {
    encodeExtras: () => ({}),
    decodeExtras: (base) => ({ gameType: 'calpoker', ...base }),
  },
  durableState: {
    reduce: reduceGameStateSnapshot,
    reduceEvent: reduceCalpokerDurableState,
  },
};
