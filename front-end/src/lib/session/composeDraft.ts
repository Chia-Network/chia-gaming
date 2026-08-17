import type { GameComposeDrafts } from '../gameAdapter';
import {
  defaultGameComposeDraft,
  gameComposeDraftFromTerms,
  gameTermsFromComposeDraft,
  REGISTERED_GAMES,
  updateGameComposeDraft,
} from '../gameRegistry';
import type { HandTermsModel, RegisteredGameType } from './types';

export type ComposeDraftValues = GameComposeDrafts & {
  gameTimeout: bigint;
  proposalSent: boolean;
};

export type ComposeDraftState = ComposeDraftValues & { selectedGame: RegisteredGameType };

function defaultComposeDrafts(perGameAmount: bigint): GameComposeDrafts {
  // Object construction erases each key's draft type; the registration record
  // guarantees one correctly typed default for every RegisteredGameType.
  return Object.fromEntries(
    REGISTERED_GAMES.map(({ gameType }) => [
      gameType,
      defaultGameComposeDraft(gameType, perGameAmount),
    ]),
  ) as GameComposeDrafts;
}

export const EMPTY_COMPOSE_DRAFT_STATE: ComposeDraftState = {
  ...defaultComposeDrafts(0n),
  selectedGame: 'calpoker',
  gameTimeout: 15n,
  proposalSent: false,
};

export function createComposeDraftState(
  perGameAmount: bigint,
  lastTerms: HandTermsModel,
): ComposeDraftState {
  const state: ComposeDraftState = {
    ...defaultComposeDrafts(perGameAmount),
    selectedGame: lastTerms.gameType,
    gameTimeout: lastTerms.gameTimeout,
    proposalSent: false,
  };
  return applyTermsToComposeDraft(state, lastTerms);
}

export function applyTermsToComposeDraft(
  state: ComposeDraftState,
  terms: HandTermsModel,
): ComposeDraftState {
  const common = {
    ...state,
    selectedGame: terms.gameType,
    gameTimeout: terms.gameTimeout,
    proposalSent: false,
  };
  return { ...common, [terms.gameType]: gameComposeDraftFromTerms(terms) };
}

export function selectComposeGame(
  state: ComposeDraftState,
  selectedGame: RegisteredGameType,
): ComposeDraftState {
  return { ...state, selectedGame };
}

export function setComposeDraftAmount(
  state: ComposeDraftState,
  gameType: 'calpoker' | 'krunk',
  amount: bigint,
): ComposeDraftState {
  return {
    ...state,
    [gameType]: updateGameComposeDraft(gameType, state[gameType], { amount }),
  };
}

export function setSpacepokerComposeDraft(
  state: ComposeDraftState,
  draft: Partial<ComposeDraftState['spacepoker']>,
): ComposeDraftState {
  return {
    ...state,
    spacepoker: updateGameComposeDraft('spacepoker', state.spacepoker, draft),
  };
}

export function composeDraftTerms(state: ComposeDraftState): HandTermsModel | null {
  return gameTermsFromComposeDraft(
    state.selectedGame,
    state[state.selectedGame],
    state.gameTimeout,
  );
}

export function composeDraftCanSubmit(
  state: ComposeDraftState,
  maxPerHandMojos: bigint | null,
): boolean {
  const terms = composeDraftTerms(state);
  return (
    !state.proposalSent &&
    terms !== null &&
    (maxPerHandMojos === null || terms.myContribution <= maxPerHandMojos)
  );
}
