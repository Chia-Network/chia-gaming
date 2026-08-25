import { applyHandProposalToComposeDraft } from './composeDraft';
import { gameSliceReducer, type GameSlice } from './gameSlice';
import {
  createRegisteredGameHand,
  isCatalogGameType,
  restoreRegisteredGameHandState,
  snapshotRegisteredGameHand,
  selectRegisteredGameOutcome,
} from '../gameRegistry';
import type { GameHandInitialization, GameUpdate, PersistedGameState } from '@games/host';
import { clearProposalIds } from './sessionMachineProposals';
import { selectProposalGroupByMemberId } from './selectors';
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
  | { type: 'notification-move-rejected' }
  | { type: 'notification-insufficient-balance' }
  | { type: 'notification-abandoned' }
  | { type: 'hand-state-changed' }
  | { type: 'local-game-action-staged' }
  | { type: 'local-game-action-applied' }
  | { type: 'local-action-applied' }
  | { type: 'discard-pending-candidate' }
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

function withoutPendingIds(model: SessionModel, ids: readonly string[]): SessionModel {
  if (!ids.some((id) => model.game.pendingCandidates[id])) return model;
  const removed = new Set(ids);
  return {
    ...model,
    game: {
      ...model.game,
      pendingCandidates: Object.fromEntries(
        Object.entries(model.game.pendingCandidates).filter(([id]) => !removed.has(id)),
      ),
    },
  };
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

function fallbackHandInitialization(state: SessionMachineState): GameHandInitialization {
  const handProposal = state.model.betweenHand.lastHandProposal;
  if (handProposal === null) {
    throw new Error('Game update requires accepted hand terms');
  }
  if (state.model.game.currentHandIds[0] === undefined) {
    throw new Error('Game update requires a current hand member');
  }
  return {
    gameIds: state.model.game.currentHandIds,
    iStarted: true,
    origin: state.model.game.currentHandOrigin ?? 'local',
    handProposal,
  };
}

function reduceWithTransientHand(
  state: SessionMachineState,
  update: GameUpdate,
): PersistedGameState {
  const gameType = state.model.game.activeGameType;
  const saved = state.model.game.handState;
  const hand =
    saved === null
      ? createRegisteredGameHand(gameType, fallbackHandInitialization(state))
      : restoreRegisteredGameHandState(gameType, saved);
  hand.receive(update);
  return snapshotRegisteredGameHand(gameType, hand);
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
      const cleared =
        event.action.type === 'remove-group'
          ? withoutPendingIds(state.model, event.action.groupIds)
          : event.action.type === 'settled'
            ? withoutPendingIds(state.model, [event.action.id])
            : event.action.type === 'abandoned'
              ? { ...state.model, game: { ...state.model.game, pendingCandidates: {} } }
              : state.model;
      return {
        state: {
          ...state,
          model: withGameSlice(
            cleared,
            gameSliceReducer(gameSliceFromModel(cleared), event.action),
          ),
        },
        effects: [],
      };
    }
    case 'notification-accepted-group': {
      const proposal = selectProposalGroupByMemberId(state.model, event.id);
      if (!proposal) {
        throw new Error(`ProposalAccepted ${event.id} missing normalized proposal group`);
      }
      const first =
        state.model.game.currentHandIds.length !== proposal.memberIds.length ||
        state.model.game.currentHandIds.some((id, index) => id !== proposal.memberIds[index]);
      const acceptedGroup = { ...proposal, disposition: 'accepted' as const };
      const proposalGroups = [
        ...state.model.betweenHand.proposalGroups.filter(
          (group) => !group.memberIds.some((id) => acceptedGroup.memberIds.includes(id)),
        ),
        acceptedGroup,
      ];
      const game = gameSliceReducer(gameSliceFromModel(state.model), {
        type: 'accepted-group',
        groupIds: proposal.memberIds,
        acceptedId: event.id,
        amount: event.amount,
        startTurn: event.isMyTurn ? 'my-turn' : 'their-turn',
        origin: proposal.origin,
        gameType: proposal.handProposal.gameType,
      });
      const modelWithGame = withGameSlice(
        first
          ? { ...state.model, game: { ...state.model.game, pendingCandidates: {} } }
          : state.model,
        game,
      );
      const initialized = {
        ...state,
        model: {
          ...modelWithGame,
          game: first ? { ...modelWithGame.game, handState: null } : modelWithGame.game,
          betweenHand: {
            ...state.model.betweenHand,
            proposalGroups,
            ...(first
              ? {
                  mode: 'decision' as const,
                  rejectedOnceHandProposal: null,
                  pendingRetryHandProposal: null,
                  newHandRequested: false,
                  lastHandProposal: proposal.handProposal,
                  compose: applyHandProposalToComposeDraft(
                    state.model.betweenHand.compose,
                    proposal.handProposal,
                  ),
                }
              : {}),
          },
        },
        coordination: {
          ...state.coordination,
          ...(first
            ? {
                firstGameAccepted: true,
                sameTermsRequested: false,
                expectingCounterProposal: false,
              }
            : {}),
        },
      };
      if (!first) return { state: initialized, effects: [] };
      const init: GameHandInitialization = {
        gameIds: proposal.memberIds,
        iStarted: event.iStarted,
        origin: proposal.origin,
        handProposal: proposal.handProposal,
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
      const update: GameUpdate =
        event.moverShare === null
          ? {
              type: 'message-readable',
              gameId: event.id,
              readable: event.readable,
            }
          : {
              type: 'move-readable',
              gameId: event.id,
              readable: event.readable,
              moverShare: event.moverShare,
            };
      return withHandState(
        projected,
        event.handState ??
          activeHand?.receive(update) ??
          reduceWithTransientHand(projected, update),
      );
    }
    case 'notification-game-terminal': {
      if (state.model.game.pendingCandidates[event.id]) {
        activeHand?.restore(state.model.game.handState);
      }
      const modelWithoutPending = withoutPendingIds(state.model, [event.id]);
      const game = gameSliceReducer(gameSliceFromModel(modelWithoutPending), {
        type: 'settled',
        id: event.id,
        terminal: event.terminal,
      });
      const isLast = game.activeIds.length === 0;
      const base = {
        ...state,
        model: {
          ...withGameSlice(modelWithoutPending, game),
          betweenHand: isLast
            ? {
                ...state.model.betweenHand,
                mode: 'decision' as const,
                proposalGroups: state.model.betweenHand.proposalGroups.filter(
                  (group) => group.disposition !== 'accepted',
                ),
              }
            : state.model.betweenHand,
        },
      };
      const update: GameUpdate = {
        type: 'hand-ended',
        gameId: event.id,
        outcome: event.terminal.outcome,
      };
      const transition = withHandState(
        base,
        event.handState ?? activeHand?.receive(update) ?? reduceWithTransientHand(base, update),
      );
      const gameType = transition.state.model.game.activeGameType;
      if (!isCatalogGameType(gameType)) return transition;
      const outcomeWin = selectRegisteredGameOutcome(
        gameType,
        transition.state.model.game.handState,
        event.id,
      );
      if (outcomeWin === null) return transition;
      return {
        state: {
          ...transition.state,
          coordination: { ...transition.state.coordination, lastOutcomeWin: outcomeWin },
        },
        effects: [{ type: 'controller-set-last-outcome', outcomeWin }, { type: 'persist-session' }],
      };
    }
    case 'notification-move-rejected': {
      activeHand?.restore(state.model.game.handState);
      return {
        state: { ...state, model: withoutPendingIds(state.model, [event.id]) },
        effects: [{ type: 'persist-session' }],
      };
    }
    case 'notification-insufficient-balance': {
      const proposal = selectProposalGroupByMemberId(state.model, event.id);
      if (!proposal) {
        throw new Error(`InsufficientBalance ${event.id} missing normalized proposal group`);
      }
      const game = gameSliceReducer(gameSliceFromModel(state.model), {
        type: 'remove-group',
        groupIds: proposal.memberIds,
      });
      const modelWithGame = withoutPendingIds(withGameSlice(state.model, game), proposal.memberIds);
      const cleared = clearProposalIds(
        {
          ...state,
          model: {
            ...modelWithGame,
            betweenHand: {
              ...state.model.betweenHand,
              mode: 'compose-proposal',
            },
            game: {
              ...modelWithGame.game,
              queue: [...state.model.game.queue, event.notification],
            },
          },
        },
        proposal.memberIds,
      );
      const removesCurrentHand = proposal.memberIds.some((id) =>
        state.model.game.currentHandIds.includes(id),
      );
      if (removesCurrentHand) activeHand?.clear();
      return removesCurrentHand
        ? {
            state: {
              ...cleared,
              model: {
                ...cleared.model,
                game: { ...cleared.model.game, handState: null },
              },
            },
            effects: [],
          }
        : { state: cleared, effects: [] };
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
              pendingCandidates: {},
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
        effects: [{ type: 'persist-session' }],
      };
    }
    case 'local-game-action-staged': {
      if (event.gameType !== state.model.game.activeGameType) {
        throw new Error(
          `Internal pending candidate gameType ${event.gameType} does not match active ${state.model.game.activeGameType}`,
        );
      }
      if (!state.model.game.activeIds.includes(event.id)) {
        throw new Error(`Internal pending candidate game id ${event.id} is not active`);
      }
      if (!state.model.game.currentHandIds.includes(event.id)) {
        throw new Error(
          `Internal pending candidate game id ${event.id} is not a current hand member`,
        );
      }
      if (state.model.game.pendingCandidates[event.id]) {
        throw new Error(`Internal pending candidate already exists for game ${event.id}`);
      }
      return {
        state: {
          ...state,
          model: {
            ...state.model,
            game: {
              ...state.model.game,
              pendingCandidates: {
                ...state.model.game.pendingCandidates,
                [event.id]: {
                  gameType: event.gameType,
                  id: event.id,
                  action: event.action,
                  state: event.state,
                },
              },
            },
          },
        },
        effects: [{ type: 'persist-session' }],
      };
    }
    case 'local-game-action-applied': {
      if (event.gameType !== state.model.game.activeGameType) {
        throw new Error(
          `Internal applied candidate gameType ${event.gameType} does not match active ${state.model.game.activeGameType}`,
        );
      }
      if (
        !state.model.game.activeIds.includes(event.id) ||
        !state.model.game.currentHandIds.includes(event.id)
      ) {
        throw new Error(
          `Internal applied candidate game id ${event.id} is not an active hand member`,
        );
      }
      if (state.model.game.pendingCandidates[event.id]) {
        throw new Error(`Internal applied candidate conflicts with pending game ${event.id}`);
      }
      const handState = event.handState ?? { gameType: event.gameType, state: event.state };
      const applied = {
        ...state,
        model: {
          ...state.model,
          game: { ...state.model.game, handState },
        },
      };
      const game = gameSliceReducer(gameSliceFromModel(applied.model), {
        type: 'local-turn',
        id: event.id,
        isMyTurn: false,
        channelState: applied.model.channel.status.state,
      });
      return {
        state: { ...applied, model: withGameSlice(applied.model, game) },
        effects: [{ type: 'persist-session' }],
      };
    }
    case 'local-action-applied': {
      const pending = state.model.game.pendingCandidates[event.id];
      if (!pending) return { state, effects: [] };
      if (pending.action !== event.action) {
        throw new Error(
          `LocalActionApplied ${event.id} action ${event.action} does not match pending ${pending.action}`,
        );
      }
      const handState = event.handState ?? {
        gameType: pending.gameType,
        state: pending.state,
      };
      const promoted = {
        ...state,
        model: {
          ...state.model,
          game: {
            ...state.model.game,
            handState,
            pendingCandidates: Object.fromEntries(
              Object.entries(state.model.game.pendingCandidates).filter(([id]) => id !== event.id),
            ),
          },
        },
      };
      const game = gameSliceReducer(gameSliceFromModel(promoted.model), {
        type: 'local-turn',
        id: event.id,
        isMyTurn: false,
        channelState: promoted.model.channel.status.state,
      });
      return {
        state: { ...promoted, model: withGameSlice(promoted.model, game) },
        effects: [{ type: 'persist-session' }],
      };
    }
    case 'discard-pending-candidate': {
      const pending = state.model.game.pendingCandidates[event.id];
      if (!pending) return { state, effects: [] };
      if (event.action !== undefined && pending.action !== event.action) {
        return { state, effects: [] };
      }
      activeHand?.restore(state.model.game.handState);
      return {
        state: { ...state, model: withoutPendingIds(state.model, [event.id]) },
        effects: [{ type: 'persist-session' }],
      };
    }
    default:
      return assertNever(event);
  }
}
