import { applyHandProposalToComposeDraft } from './composeDraft';
import { gameSliceReducer, type GameSlice } from './gameSlice';
import {
  decodeGameFeatureState,
  isCatalogGameType,
  reduceRegisteredGameState,
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
  | { type: 'hand-outcome' }
  | { type: 'notification-accepted-group' }
  | { type: 'notification-game-status' }
  | { type: 'notification-game-terminal' }
  | { type: 'notification-insufficient-balance' }
  | { type: 'notification-abandoned' }
  | { type: 'feature-state' }
  | { type: 'feature-state-with-local-turn' }
  | { type: 'local-game-action-committed' }
  | { type: 'durable-local-turn' }
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

function withDurableGameEvent(
  state: SessionMachineState,
  event: Parameters<typeof reduceRegisteredGameState>[2],
): SessionMachineTransition {
  const rawGameType =
    event.type === 'accepted-group'
      ? event.handProposal.gameType
      : event.type === 'feature-state'
        ? event.gameType
        : state.model.game.activeGameType;
  if (!isCatalogGameType(rawGameType)) {
    throw new Error(`Durable game event has non-catalog gameType ${rawGameType}`);
  }
  const handState = reduceRegisteredGameState(rawGameType, state.model.game.handState, event);
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
    case 'hand-outcome':
      return {
        state: {
          ...state,
          coordination: { ...state.coordination, lastOutcomeWin: event.outcomeWin },
        },
        effects: [
          { type: 'controller-set-last-outcome', outcomeWin: event.outcomeWin },
          { type: 'persist-session' },
        ],
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
      return withDurableGameEvent(
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
          type: 'accepted-group',
          id: event.id,
          groupIds: proposal.memberIds,
          iStarted: event.iStarted,
          isMyTurn: event.isMyTurn,
          origin: proposal.origin,
          handProposal: proposal.handProposal,
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
      const featureTurn =
        event.payload.status === 'my-turn' || event.payload.status === 'their-turn'
          ? event.payload.status
          : null;
      if (event.readable === null && featureTurn === null) {
        return { state: projected, effects: [] };
      }
      return withDurableGameEvent(projected, {
        type: 'game-status',
        id: event.id,
        status: featureTurn ?? 'their-turn',
        readable: event.readable,
        moverShare: event.moverShare,
        iStarted: event.iStarted,
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
      return withDurableGameEvent(base, {
        type: 'settled',
        id: event.id,
        terminal: event.terminal,
      });
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
      return withDurableGameEvent(cleared, {
        type: 'remove-group',
        groupIds: proposal.memberIds,
      });
    }
    case 'notification-abandoned': {
      const game = gameSliceReducer(gameSliceFromModel(state.model), { type: 'abandoned' });
      const payload = withDurableGameEvent(
        { ...state, model: withGameSlice(state.model, game) },
        { type: 'abandoned' },
      );
      return {
        state: payload.state,
        effects: [{ type: 'clear-derived-game-presentation' }],
      };
    }
    case 'feature-state':
    case 'feature-state-with-local-turn':
    case 'local-game-action-committed': {
      if (event.gameType !== state.model.game.activeGameType) {
        throw new Error(
          `Internal feature-state gameType ${event.gameType} does not match active ${state.model.game.activeGameType}`,
        );
      }
      if (!state.model.game.currentHandIds.includes(event.id)) {
        throw new Error(`Internal feature-state game id ${event.id} is not a current hand member`);
      }
      const decoded = decodeGameFeatureState(event.gameType, event.state);
      if (decoded === null) {
        throw new Error(`Internal feature-state payload is invalid for ${event.gameType}`);
      }
      const feature = withDurableGameEvent(state, {
        type: 'feature-state',
        gameType: event.gameType,
        id: event.id,
        state: decoded,
      });
      if (event.type === 'feature-state') return feature;
      const isMyTurn = event.type === 'feature-state-with-local-turn' ? event.isMyTurn : false;
      const game = gameSliceReducer(gameSliceFromModel(feature.state.model), {
        type: 'local-turn',
        id: event.id,
        isMyTurn,
        channelState: feature.state.model.channel.status.state,
      });
      return withDurableGameEvent(
        { ...feature.state, model: withGameSlice(feature.state.model, game) },
        { type: 'local-turn', id: event.id, isMyTurn },
      );
    }
    case 'durable-local-turn': {
      const game = gameSliceReducer(gameSliceFromModel(state.model), {
        type: 'local-turn',
        id: event.id,
        isMyTurn: event.isMyTurn,
        channelState: event.channelState,
      });
      return withDurableGameEvent(
        { ...state, model: withGameSlice(state.model, game) },
        { type: 'local-turn', id: event.id, isMyTurn: event.isMyTurn },
      );
    }
    default:
      return assertNever(event);
  }
}
