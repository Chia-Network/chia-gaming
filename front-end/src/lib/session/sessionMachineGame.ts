import { applyHandProposalToComposeDraft } from './composeDraft';
import { gameSliceReducer, type GameSlice } from './gameSlice';
import {
  createRegisteredGameHand,
  restoreRegisteredGameHandState,
  snapshotRegisteredGameHand,
} from '../gameRegistry';
import { Program } from 'clvm-lib';
import type { GameHandInitialization, GameUpdate, PersistedGameState } from '@games/host';
import { selectPendingProposal } from './selectors';
import { proposalOrigin } from './sessionMachineProposals';
import type {
  SessionMachineEvent,
  SessionMachineState,
  SessionMachineTransition,
} from './sessionMachineTypes';
import type { RegisteredGameType, SessionModel } from './types';

export type DurableGameEvent = Extract<
  SessionMachineEvent,
  | { type: 'game' }
  | { type: 'notification-accepted-group' }
  | { type: 'notification-game-status' }
  | { type: 'notification-game-terminal' }
  | { type: 'notification-abandoned' }
  | { type: 'hand-state-changed' }
  | { type: 'local-game-action-committed' }
  | { type: 'local-action-applied' }
>;

function gameSliceFromModel(model: SessionModel): GameSlice {
  return {
    handKey: model.game.handKey,
    activeIds: model.game.activeIds,
    currentHandIds: model.game.currentHandIds,
    currentHandOrigin: model.game.currentHandOrigin,
    instances: model.game.instances,
    lastDisplayedId: model.game.lastDisplayedId,
    activeGameType: model.game.activeGameType,
  };
}

function withGameSlice(model: SessionModel, game: GameSlice): SessionModel {
  return { ...model, game: { ...model.game, ...game } };
}

type DurableGameEventWithHandState = DurableGameEvent & {
  readonly handState?: PersistedGameState | null;
};

export interface ActiveGameHandContext {
  create(gameType: RegisteredGameType, init: GameHandInitialization): PersistedGameState;
  receive(update: GameUpdate): PersistedGameState;
  restore(checkpoint: PersistedGameState | null): void;
  clear(): void;
}

function withHandState(
  state: SessionMachineState,
  handState: PersistedGameState | null,
): SessionMachineTransition {
  return {
    state: {
      ...state,
      model: { ...state.model, game: { ...state.model.game, handState } },
    },
    effects: [],
  };
}

function memberIndexForProtocolId(state: SessionMachineState, id: string): number {
  const matches = state.model.game.currentHandIds
    .map((candidate, index) => (candidate === id ? index : -1))
    .filter((index) => index >= 0);
  if (matches.length !== 1) {
    throw new Error(`Game update protocol id ${id} must occur exactly once in current hand IDs`);
  }
  return matches[0]!;
}

function reduceHandSnapshot(
  state: SessionMachineState,
  saved: PersistedGameState | null,
  update: GameUpdate,
): PersistedGameState {
  const gameType = state.model.game.activeGameType;
  if (saved === null) {
    throw new Error('Game update requires persisted game-owned hand state');
  }
  const hand = restoreRegisteredGameHandState(gameType, saved);
  hand.receive(update);
  return snapshotRegisteredGameHand(gameType, hand);
}

function reduceHandUpdateAcrossSnapshots(
  state: SessionMachineState,
  update: GameUpdate,
  suppliedHandState: PersistedGameState | null | undefined,
  activeHand?: ActiveGameHandContext,
): SessionMachineTransition {
  activeHand?.receive(update);
  const handState =
    suppliedHandState ?? reduceHandSnapshot(state, state.model.game.handState, update);
  return {
    state: {
      ...state,
      model: {
        ...state.model,
        game: { ...state.model.game, handState },
      },
    },
    effects: [],
  };
}

function assertNever(event: never): never {
  throw new Error(`Unhandled durable game event: ${JSON.stringify(event)}`);
}

export function reduceDurableGameEvent(
  state: SessionMachineState,
  event: DurableGameEventWithHandState,
  activeHand?: ActiveGameHandContext,
): SessionMachineTransition {
  switch (event.type) {
    case 'game': {
      if (event.action.type === 'abandoned') activeHand?.clear();
      return {
        state: {
          ...state,
          model: withGameSlice(
            state.model,
            gameSliceReducer(gameSliceFromModel(state.model), event.action),
          ),
        },
        effects: [],
      };
    }
    case 'notification-accepted-group': {
      const firstMember = event.members[0];
      if (!firstMember) throw new Error('ProposalAcceptedGroup has no members');
      const acceptedIds = event.members.map((member) => member.id);
      const proposal = selectPendingProposal(state.model, event.proposalId);
      if (!proposal) {
        throw new Error(`ProposalAcceptedGroup ${event.proposalId} missing pending proposal`);
      }
      const pendingProposals = state.model.betweenHand.pendingProposals.filter(
        (candidate) => candidate.id !== proposal.id,
      );
      const game = gameSliceReducer(gameSliceFromModel(state.model), {
        type: 'accepted-group',
        groupIds: acceptedIds,
        members: event.members.map((member) => ({
          amount: (member.playerAContribution + member.playerBContribution).toString(),
          startTurn: member.ourTurn ? 'my-turn' : 'their-turn',
        })),
        origin: proposalOrigin(proposal),
        gameType: proposal.handProposal.gameType,
      });
      const modelWithGame = withGameSlice(state.model, game);
      const initialized = {
        ...state,
        model: {
          ...modelWithGame,
          game: { ...modelWithGame.game, handState: null },
          betweenHand: {
            ...state.model.betweenHand,
            pendingProposals,
            mode: 'decision' as const,
            rejectedOnceHandProposal: null,
            pendingRetryHandProposal: null,
            newHandRequested: false,
            lastHandProposal: proposal.handProposal,
            compose: applyHandProposalToComposeDraft(
              state.model.betweenHand.compose,
              proposal.handProposal,
            ),
          },
        },
        coordination: {
          ...state.coordination,
          firstGameAccepted: true,
          sameTermsRequested: false,
        },
      };
      const init: GameHandInitialization = {
        members: event.members.map((member) => ({
          playerAContribution: member.playerAContribution,
          playerBContribution: member.playerBContribution,
          ourTurn: member.ourTurn,
          readableParameters: Program.deserialize(member.readableParameters),
        })),
      };
      const handState =
        event.handState ??
        activeHand?.create(proposal.handProposal.gameType, init) ??
        snapshotRegisteredGameHand(
          proposal.handProposal.gameType,
          createRegisteredGameHand(proposal.handProposal.gameType, init),
        );
      return withHandState(initialized, handState);
    }
    case 'notification-game-status': {
      const game = gameSliceReducer(gameSliceFromModel(state.model), {
        type: 'status',
        id: event.id,
        payload: event.payload,
        channelState: event.channelState,
      });
      const projected = { ...state, model: withGameSlice(state.model, game) };
      if (event.readable === null) {
        return { state: projected, effects: [] };
      }
      const readable = Program.deserialize(event.readable);
      const update: GameUpdate =
        event.moverShare === null
          ? {
              type: 'message-readable',
              memberIndex: memberIndexForProtocolId(projected, event.id),
              readable,
            }
          : {
              type: 'move-readable',
              memberIndex: memberIndexForProtocolId(projected, event.id),
              readable,
              moverShare: event.moverShare,
            };
      return reduceHandUpdateAcrossSnapshots(projected, update, event.handState, activeHand);
    }
    case 'notification-game-terminal': {
      const game = gameSliceReducer(gameSliceFromModel(state.model), {
        type: 'settled',
        id: event.id,
        terminal: event.terminal,
      });
      const isLast = game.activeIds.length === 0;
      const base = {
        ...state,
        model: {
          ...withGameSlice(state.model, game),
          betweenHand: isLast
            ? {
                ...state.model.betweenHand,
                mode: 'decision' as const,
              }
            : state.model.betweenHand,
        },
      };
      const update: GameUpdate = {
        type: 'hand-ended',
        memberIndex: memberIndexForProtocolId(base, event.id),
        outcome: event.terminal.outcome,
      };
      return reduceHandUpdateAcrossSnapshots(base, update, event.handState, activeHand);
    }
    case 'notification-abandoned': {
      activeHand?.clear();
      const game = gameSliceReducer(gameSliceFromModel(state.model), { type: 'abandoned' });
      return {
        state: {
          ...state,
          model: {
            ...withGameSlice(state.model, game),
            game: {
              ...withGameSlice(state.model, game).game,
              handState: null,
            },
          },
        },
        effects: [{ type: 'clear-derived-game-presentation' }],
      };
    }
    case 'hand-state-changed': {
      if (event.gameType !== state.model.game.activeGameType) {
        throw new Error(
          `Internal hand state gameType ${event.gameType} does not match active ${state.model.game.activeGameType}`,
        );
      }
      const handState = event.handState ?? { gameType: event.gameType, state: event.state };
      return {
        state: {
          ...state,
          model: { ...state.model, game: { ...state.model.game, handState } },
        },
        effects: [],
      };
    }
    case 'local-game-action-committed': {
      if (event.gameType !== state.model.game.activeGameType) {
        throw new Error(
          `Internal committed gameType ${event.gameType} does not match active ${state.model.game.activeGameType}`,
        );
      }
      if (
        !state.model.game.activeIds.includes(event.id) ||
        !state.model.game.currentHandIds.includes(event.id)
      ) {
        throw new Error(`Internal committed game id ${event.id} is not an active hand member`);
      }
      const handState = event.handState ?? { gameType: event.gameType, state: event.state };
      return {
        state: {
          ...state,
          model: {
            ...state.model,
            game: { ...state.model.game, handState },
          },
        },
        effects: [],
      };
    }
    case 'local-action-applied': {
      const game = gameSliceReducer(gameSliceFromModel(state.model), {
        type: 'local-turn',
        id: event.id,
        isMyTurn: false,
        channelState: state.model.channel.status.state,
      });
      return {
        state: { ...state, model: withGameSlice(state.model, game) },
        effects: [],
      };
    }
    default:
      return assertNever(event);
  }
}
