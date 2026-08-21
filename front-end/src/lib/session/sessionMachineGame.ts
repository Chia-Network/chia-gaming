import { applyHandProposalToComposeDraft } from './composeDraft';
import { gameSliceReducer, type GameSlice } from './gameSlice';
import {
  applyRegisteredFeatureState,
  isCatalogGameType,
  reduceRegisteredGameState,
  selectRegisteredGameOutcome,
} from '../gameRegistry';
import { clearProposalIds } from './sessionMachineProposals';
import { selectProposalGroupByMemberId } from './selectors';
import type {
  SessionMachineEvent,
  SessionMachineState,
  SessionMachineTransition,
} from './sessionMachineTypes';
import type { SessionModel } from './types';

export type DurableGameEvent = Extract<
  SessionMachineEvent,
  | { type: 'game' }
  | { type: 'notification-accepted-group' }
  | { type: 'notification-game-status' }
  | { type: 'notification-game-terminal' }
  | { type: 'notification-move-rejected' }
  | { type: 'notification-insufficient-balance' }
  | { type: 'notification-abandoned' }
  | { type: 'feature-state' }
  | { type: 'local-game-action-committed' }
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

function withGameInput(
  state: SessionMachineState,
  input: Parameters<typeof reduceRegisteredGameState>[2],
): SessionMachineTransition {
  const rawGameType =
    input.type === 'hand-started'
      ? input.init.handProposal.gameType
      : state.model.game.activeGameType;
  if (!isCatalogGameType(rawGameType)) {
    throw new Error(`Game input has non-catalog gameType ${rawGameType}`);
  }
  const handState = reduceRegisteredGameState(rawGameType, state.model.game.handState, input);
  return {
    state: {
      ...state,
      model: { ...state.model, game: { ...state.model.game, handState } },
    },
    effects: [],
  };
}

function assertNever(event: never): never {
  throw new Error(`Unhandled durable game event: ${JSON.stringify(event)}`);
}

export function reduceDurableGameEvent(
  state: SessionMachineState,
  event: DurableGameEvent,
): SessionMachineTransition {
  switch (event.type) {
    case 'game':
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
      const modelWithGame = withGameSlice(state.model, game);
      return withGameInput(
        {
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
        },
        {
          type: 'hand-started',
          init: {
            id: event.id,
            gameIds: proposal.memberIds,
            iStarted: event.iStarted,
            canAct: event.isMyTurn,
            origin: proposal.origin,
            handProposal: proposal.handProposal,
          },
        },
      );
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
      return event.moverShare === null
        ? withGameInput(projected, {
            type: 'game-message',
            gameId: event.id,
            readable: event.readable,
          })
        : withGameInput(projected, {
            type: 'opponent-moved',
            gameId: event.id,
            readable: event.readable,
            moverShare: event.moverShare,
          });
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
                proposalGroups: state.model.betweenHand.proposalGroups.filter(
                  (group) => group.disposition !== 'accepted',
                ),
              }
            : state.model.betweenHand,
        },
      };
      const transition = withGameInput(base, {
        type: 'hand-ended',
        gameId: event.id,
        terminal: event.terminal,
      });
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
    case 'notification-move-rejected':
      return withGameInput(state, {
        type: 'move-rejected',
        gameId: event.id,
        tag: event.tag,
        message: event.message,
      });
    case 'notification-insufficient-balance': {
      const proposal = selectProposalGroupByMemberId(state.model, event.id);
      if (!proposal) {
        throw new Error(`InsufficientBalance ${event.id} missing normalized proposal group`);
      }
      const game = gameSliceReducer(gameSliceFromModel(state.model), {
        type: 'remove-group',
        groupIds: proposal.memberIds,
      });
      const modelWithGame = withGameSlice(state.model, game);
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
      const game = gameSliceReducer(gameSliceFromModel(state.model), { type: 'abandoned' });
      return {
        state: {
          ...state,
          model: {
            ...withGameSlice(state.model, game),
            game: { ...withGameSlice(state.model, game).game, handState: null },
          },
        },
        effects: [{ type: 'clear-derived-game-presentation' }],
      };
    }
    case 'feature-state':
    case 'local-game-action-committed': {
      if (event.gameType !== state.model.game.activeGameType) {
        throw new Error(
          `Internal feature-state gameType ${event.gameType} does not match active ${state.model.game.activeGameType}`,
        );
      }
      if (!state.model.game.currentHandIds.includes(event.id)) {
        throw new Error(`Internal feature-state game id ${event.id} is not a current hand member`);
      }
      const handState = applyRegisteredFeatureState(
        event.gameType,
        state.model.game.handState,
        event.id,
        event.state,
      );
      const feature = {
        state: {
          ...state,
          model: { ...state.model, game: { ...state.model.game, handState } },
        },
        effects: [],
      };
      if (event.type === 'feature-state') return feature;
      const game = gameSliceReducer(gameSliceFromModel(feature.state.model), {
        type: 'local-turn',
        id: event.id,
        isMyTurn: false,
        channelState: feature.state.model.channel.status.state,
      });
      return {
        state: { ...feature.state, model: withGameSlice(feature.state.model, game) },
        effects: [],
      };
    }
    default:
      return assertNever(event);
  }
}
