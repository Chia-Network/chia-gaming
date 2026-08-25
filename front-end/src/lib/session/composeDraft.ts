import type { ComposeDraftValue } from '@games/host';
import type { GameComposeDrafts } from '../gamePackage';
import {
  defaultGameComposeDraft,
  gameComposeDraftFromHandProposal,
  handProposalFromComposeDraft,
  REGISTERED_GAMES,
  updateGameComposeDraft,
  type CatalogGameType,
} from '../gameRegistry';
import type { HandProposal, RegisteredGameType } from './types';

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
  lastHandProposal: HandProposal,
): ComposeDraftState {
  return applyHandProposalToComposeDraft(
    {
      selectedGame: lastHandProposal.gameType,
      gameTimeout: lastHandProposal.gameTimeout,
      proposalSent: false,
      drafts: defaultComposeDrafts(perGameAmount),
    },
    lastHandProposal,
  );
}

export function applyHandProposalToComposeDraft(
  state: ComposeDraftState,
  handProposal: HandProposal | null,
): ComposeDraftState {
  if (handProposal === null) return state;
  return {
    ...state,
    selectedGame: handProposal.gameType,
    gameTimeout: handProposal.gameTimeout,
    proposalSent: false,
    drafts: {
      ...state.drafts,
      [handProposal.gameType]: gameComposeDraftFromHandProposal(handProposal),
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

export function composeDraftTerms(state: ComposeDraftState): HandProposal | null {
  const key = state.selectedGame;
  return handProposalFromComposeDraft(key, composeDraftValue(state, key), state.gameTimeout);
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
