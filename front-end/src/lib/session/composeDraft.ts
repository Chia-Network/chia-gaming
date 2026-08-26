import { REGISTERED_GAMES } from '../gameRegistry';
import type { HandProposal, RegisteredGameType } from './types';

export interface ComposeDraftState {
  selectedGame: RegisteredGameType;
  gameTimeout: bigint;
  proposalSent: boolean;
}

export function emptyComposeDraftState(): ComposeDraftState {
  return {
    selectedGame: REGISTERED_GAMES[0].gameType,
    gameTimeout: 15n,
    proposalSent: false,
  };
}

export function createComposeDraftState(lastHandProposal: HandProposal): ComposeDraftState {
  return {
    selectedGame: lastHandProposal.gameType,
    gameTimeout: lastHandProposal.gameTimeout,
    proposalSent: false,
  };
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
  };
}

export function selectComposeGame(
  state: ComposeDraftState,
  selectedGame: RegisteredGameType,
): ComposeDraftState {
  return { ...state, selectedGame };
}
