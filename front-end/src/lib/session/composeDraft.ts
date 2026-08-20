import type { ComposeDraftValue, GameComposeDrafts } from '@games/host';
import {
  defaultGameComposeDraft,
  gameComposeDraftFromTerms,
  gameTermsFromComposeDraft,
  REGISTERED_GAMES,
  updateGameComposeDraft,
  type CatalogGameType,
} from '../gameRegistry';
import type { HandTermsModel, RegisteredGameType } from './types';

export interface ComposeDraftState {
  selectedGame: RegisteredGameType;
  gameTimeout: bigint;
  proposalSent: boolean;
  drafts: GameComposeDrafts;
}

function defaultComposeDrafts(perGameAmount: bigint): GameComposeDrafts {
  return Object.fromEntries(
    REGISTERED_GAMES.map(({ gameType }) => [
      gameType,
      defaultGameComposeDraft(gameType, perGameAmount),
    ]),
  );
}

export function composeDraftValue(
  state: ComposeDraftState,
  gameType: CatalogGameType,
): ComposeDraftValue {
  const value = state.drafts[gameType];
  if (value === undefined) {
    throw new Error(`Missing compose draft for ${gameType}`);
  }
  return value;
}

export function emptyComposeDraftState(): ComposeDraftState {
  return {
    selectedGame: REGISTERED_GAMES[0].gameType,
    gameTimeout: 15n,
    proposalSent: false,
    drafts: defaultComposeDrafts(0n),
  };
}

export function createComposeDraftState(
  perGameAmount: bigint,
  lastTerms: HandTermsModel,
): ComposeDraftState {
  return applyTermsToComposeDraft(
    {
      selectedGame: lastTerms.gameType,
      gameTimeout: lastTerms.gameTimeout,
      proposalSent: false,
      drafts: defaultComposeDrafts(perGameAmount),
    },
    lastTerms,
  );
}

export function applyTermsToComposeDraft(
  state: ComposeDraftState,
  terms: HandTermsModel | null,
): ComposeDraftState {
  if (terms === null) return state;
  return {
    ...state,
    selectedGame: terms.gameType,
    gameTimeout: terms.gameTimeout,
    proposalSent: false,
    drafts: {
      ...state.drafts,
      [terms.gameType]: gameComposeDraftFromTerms(terms),
    },
  };
}

export function selectComposeGame(
  state: ComposeDraftState,
  selectedGame: RegisteredGameType,
): ComposeDraftState {
  return { ...state, selectedGame };
}

export function updateSelectedComposeDraft(
  state: ComposeDraftState,
  update: Partial<ComposeDraftValue>,
): ComposeDraftState {
  const key = state.selectedGame;
  return {
    ...state,
    drafts: {
      ...state.drafts,
      [key]: updateGameComposeDraft(key, composeDraftValue(state, key), update),
    },
  };
}

export function composeDraftTerms(state: ComposeDraftState): HandTermsModel | null {
  const key = state.selectedGame;
  return gameTermsFromComposeDraft(key, composeDraftValue(state, key), state.gameTimeout);
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
