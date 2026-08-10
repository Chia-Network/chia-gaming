import {
  applyTermsToComposeDraft,
  selectComposeGame,
  setComposeDraftAmount,
  setSpacepokerComposeDraft,
} from './composeDraft';
import { gameSliceReducer, type GameSlice } from './gameSlice';
import {
  decodeGameFeatureState,
  gameInitialTurn,
  reduceRegisteredGameState,
} from '../gameRegistry';
import { reduceSessionCommand } from './sessionMachineCommands';
import { reduceSessionNotification } from './sessionMachineNotifications';
import type {
  SessionMachineCoordination,
  SessionMachineEvent,
  SessionMachineState,
  SessionMachineTransition,
} from './sessionMachineTypes';
import type { HandTermsModel, SessionModel } from './types';

function proposalGroupMap(groups: readonly (readonly string[])[]): Record<string, string[]> {
  const result: Record<string, string[]> = {};
  for (const group of groups) {
    for (const id of group) result[id] = [...group];
  }
  return result;
}

function initialCoordination(
  model: SessionModel,
  firstGameAccepted: boolean,
  iProposedHand: boolean,
): SessionMachineCoordination {
  const proposalTermsById: Record<string, HandTermsModel> = {
    ...model.betweenHand.outgoingProposalTerms,
  };
  for (const proposal of [
    model.betweenHand.cachedPeerProposal,
    model.betweenHand.reviewPeerProposal,
  ]) {
    if (proposal) {
      for (const id of proposal.groupIds) proposalTermsById[id] = proposal.terms;
    }
  }
  for (const groupIds of model.betweenHand.acceptedProposalGroupIds) {
    for (const id of groupIds) proposalTermsById[id] = model.betweenHand.lastTerms;
  }
  return {
    firstGameAccepted,
    sameTermsRequested: false,
    expectingCounterProposal: false,
    iProposedHand,
    proposalTermsById,
    proposalGroupIdsById: proposalGroupMap([
      ...model.betweenHand.outgoingProposalGroupIds,
      ...model.betweenHand.acceptedProposalGroupIds,
      ...[model.betweenHand.cachedPeerProposal, model.betweenHand.reviewPeerProposal].flatMap(
        (proposal) => (proposal ? [proposal.groupIds] : []),
      ),
    ]),
    nextNotificationId: [...model.channel.queue, ...model.game.queue].reduce(
      (maximum, notification) => (notification.id > maximum ? notification.id : maximum),
      0n,
    ),
    rejectionTimerGeneration: 0,
    channelEnrichmentGeneration: 0,
    gameEnrichmentGeneration: {},
    hostOnChain: false,
  };
}

export function createSessionMachineState(
  model: SessionModel,
  options: { firstGameAccepted?: boolean; iProposedHand?: boolean } = {},
): SessionMachineState {
  return {
    model,
    coordination: initialCoordination(
      model,
      options.firstGameAccepted ?? model.channel.status.state === 'Active',
      options.iProposedHand ?? false,
    ),
  };
}

function gameSliceFromModel(model: SessionModel): GameSlice {
  return {
    handKey: model.game.handKey,
    activeIds: model.game.activeIds,
    currentHandIds: model.game.currentHandIds,
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
  const gameType =
    event.type === 'accepted-group'
      ? event.terms.gameType
      : event.type === 'feature-state'
        ? event.gameType
        : state.model.game.activeGameType;
  const handState = reduceRegisteredGameState(gameType, state.model.game.handState, event);
  return {
    state: {
      ...state,
      model: { ...state.model, game: { ...state.model.game, handState } },
    },
    effects: [{ type: 'set-hand-state', state: handState }],
  };
}

function withSessionPersistence(transition: SessionMachineTransition): SessionMachineTransition {
  return transition.effects.some((effect) => effect.type === 'persist-session')
    ? transition
    : { ...transition, effects: [...transition.effects, { type: 'persist-session' }] };
}

function clearProposalIds(
  state: SessionMachineState,
  requestedIds?: readonly string[],
): SessionMachineState {
  const betweenHand = state.model.betweenHand;
  const ids =
    requestedIds ??
    Array.from(
      new Set([
        ...Object.keys(state.coordination.proposalTermsById),
        ...Object.keys(state.coordination.proposalGroupIdsById),
        ...betweenHand.outgoingProposalIds,
      ]),
    );
  const tracked = new Set(ids);
  for (const id of ids) {
    for (const groupId of state.coordination.proposalGroupIdsById[id] ?? []) tracked.add(groupId);
  }
  const proposalTermsById = { ...state.coordination.proposalTermsById };
  const proposalGroupIdsById = { ...state.coordination.proposalGroupIdsById };
  for (const id of tracked) {
    delete proposalTermsById[id];
    delete proposalGroupIdsById[id];
  }
  return {
    ...state,
    model: {
      ...state.model,
      betweenHand: {
        ...betweenHand,
        outgoingProposalIds: betweenHand.outgoingProposalIds.filter((id) => !tracked.has(id)),
        outgoingProposalGroupIds: betweenHand.outgoingProposalGroupIds.filter(
          (group) => !group.some((id) => tracked.has(id)),
        ),
        outgoingProposalTerms: Object.fromEntries(
          Object.entries(betweenHand.outgoingProposalTerms).filter(([id]) => !tracked.has(id)),
        ),
      },
    },
    coordination: { ...state.coordination, proposalTermsById, proposalGroupIdsById },
  };
}

export function reduceSessionMachine(
  state: SessionMachineState,
  event: SessionMachineEvent,
): SessionMachineTransition {
  if (
    event.type === 'choose-same-terms' ||
    event.type === 'reject-current-proposal' ||
    event.type === 'open-compose' ||
    event.type === 'submit-compose' ||
    event.type === 'accept-review' ||
    event.type === 'reject-review' ||
    event.type === 'rejection-fallback-fired'
  ) {
    return reduceSessionCommand(state, event);
  }
  if (event.type === 'wasm-notification') {
    return reduceSessionNotification(
      state,
      event.notification,
      event.iStarted,
      reduceSessionMachine,
    );
  }
  let next = state;
  switch (event.type) {
    case 'game':
      next = {
        ...state,
        model: withGameSlice(
          state.model,
          gameSliceReducer(gameSliceFromModel(state.model), event.action),
        ),
      };
      break;
    case 'channel-status': {
      const channelState = {
        ...state,
        model: { ...state.model, channel: { ...state.model.channel, status: event.status } },
      };
      if (event.status.sessionDisposition === 'Abandoned') {
        const game = gameSliceReducer(gameSliceFromModel(channelState.model), {
          type: 'abandoned',
        });
        const payload = withDurableGameEvent(
          { ...channelState, model: withGameSlice(channelState.model, game) },
          { type: 'abandoned' },
        );
        return {
          state: payload.state,
          effects: [{ type: 'clear-derived-game-presentation' }],
        };
      }
      next = channelState;
      break;
    }
    case 'channel-coin-enriched':
      if (state.model.channel.status.state === event.state) {
        next = {
          ...state,
          model: {
            ...state.model,
            channel: {
              ...state.model.channel,
              status: { ...state.model.channel.status, coinHex: event.coinHex },
            },
          },
        };
      }
      break;
    case 'connection':
      next = {
        ...state,
        model: {
          ...state.model,
          channel: { ...state.model.channel, connection: event.connection },
        },
      };
      break;
    case 'host-projection':
      next = {
        ...state,
        model: {
          ...state.model,
          restore: event.restore,
          history: {
            ...state.model.history,
            wasmNotificationHistory: event.wasmNotificationHistory,
            diagnosticLog: event.diagnosticLog,
          },
          lastOutcomeWin: event.lastOutcomeWin,
        },
      };
      break;
    case 'clean-shutdown-started':
      next = {
        ...state,
        model: {
          ...state.model,
          channel: { ...state.model.channel, cleanShutdownStarted: event.started },
        },
      };
      break;
    case 'dismissed-channel-status':
      next = {
        ...state,
        model: {
          ...state.model,
          channel: { ...state.model.channel, dismissedChannelStatus: event.status },
        },
      };
      break;
    case 'push-channel-notification': {
      const queue =
        event.notification.kind === 'channel-state'
          ? [
              ...state.model.channel.queue.filter((item) => item.kind !== 'channel-state'),
              event.notification,
            ]
          : [...state.model.channel.queue, event.notification];
      next = { ...state, model: { ...state.model, channel: { ...state.model.channel, queue } } };
      break;
    }
    case 'push-game-notification':
      next = {
        ...state,
        model: {
          ...state.model,
          game: { ...state.model.game, queue: [...state.model.game.queue, event.notification] },
        },
      };
      break;
    case 'remove-game-notifications':
      next = {
        ...state,
        model: {
          ...state.model,
          game: {
            ...state.model.game,
            queue: state.model.game.queue.filter((item) => item.kind !== event.kind),
          },
        },
      };
      break;
    case 'dismiss-channel-notification':
      next = {
        ...state,
        model: {
          ...state.model,
          channel: { ...state.model.channel, queue: state.model.channel.queue.slice(1) },
        },
      };
      break;
    case 'dismiss-channel': {
      const dismissed = state.model.channel.queue[0];
      next = {
        ...state,
        model: {
          ...state.model,
          channel: {
            ...state.model.channel,
            dismissedChannelStatus:
              dismissed?.kind === 'channel-state'
                ? state.model.channel.status.state
                : state.model.channel.dismissedChannelStatus,
            queue: state.model.channel.queue.slice(1),
          },
        },
      };
      break;
    }
    case 'dismiss-game-notification':
      next = {
        ...state,
        model: {
          ...state.model,
          game: { ...state.model.game, queue: state.model.game.queue.slice(1) },
        },
      };
      break;
    case 'set-between-hand-mode':
      next = {
        ...state,
        model: { ...state.model, betweenHand: { ...state.model.betweenHand, mode: event.mode } },
      };
      break;
    case 'set-cached-proposal':
      next = {
        ...state,
        model: {
          ...state.model,
          betweenHand: { ...state.model.betweenHand, cachedPeerProposal: event.proposal },
        },
      };
      break;
    case 'set-review-proposal':
      next = {
        ...state,
        model: {
          ...state.model,
          betweenHand: { ...state.model.betweenHand, reviewPeerProposal: event.proposal },
        },
      };
      break;
    case 'set-rejected-terms':
      next = {
        ...state,
        model: {
          ...state.model,
          betweenHand: { ...state.model.betweenHand, rejectedOnceTerms: event.terms },
        },
      };
      break;
    case 'set-last-terms':
      next = {
        ...state,
        model: {
          ...state.model,
          betweenHand: { ...state.model.betweenHand, lastTerms: event.terms },
        },
      };
      break;
    case 'set-pending-retry-terms':
      next = {
        ...state,
        model: {
          ...state.model,
          betweenHand: { ...state.model.betweenHand, pendingRetryTerms: event.terms },
        },
      };
      break;
    case 'set-new-hand-requested':
      next = {
        ...state,
        model: {
          ...state.model,
          betweenHand: { ...state.model.betweenHand, newHandRequested: event.requested },
        },
      };
      break;
    case 'set-compose-draft':
      next = {
        ...state,
        model: {
          ...state.model,
          betweenHand: { ...state.model.betweenHand, compose: event.compose },
        },
      };
      break;
    case 'select-compose-game':
      next = {
        ...state,
        model: {
          ...state.model,
          betweenHand: {
            ...state.model.betweenHand,
            compose: selectComposeGame(state.model.betweenHand.compose, event.gameType),
          },
        },
      };
      break;
    case 'set-compose-timeout':
      next = {
        ...state,
        model: {
          ...state.model,
          betweenHand: {
            ...state.model.betweenHand,
            compose: { ...state.model.betweenHand.compose, gameTimeout: event.timeout },
          },
        },
      };
      break;
    case 'set-compose-amount':
      next = {
        ...state,
        model: {
          ...state.model,
          betweenHand: {
            ...state.model.betweenHand,
            compose: setComposeDraftAmount(
              state.model.betweenHand.compose,
              event.gameType,
              event.amount,
            ),
          },
        },
      };
      break;
    case 'set-spacepoker-compose':
      next = {
        ...state,
        model: {
          ...state.model,
          betweenHand: {
            ...state.model.betweenHand,
            compose: setSpacepokerComposeDraft(state.model.betweenHand.compose, event.draft),
          },
        },
      };
      break;
    case 'set-compose-proposal-sent':
      next = {
        ...state,
        model: {
          ...state.model,
          betweenHand: {
            ...state.model.betweenHand,
            compose: { ...state.model.betweenHand.compose, proposalSent: event.sent },
          },
        },
      };
      break;
    case 'track-proposal': {
      const proposalTermsById = { ...state.coordination.proposalTermsById };
      const proposalGroupIdsById = { ...state.coordination.proposalGroupIdsById };
      for (const id of event.ids) {
        proposalTermsById[id] = event.terms;
        proposalGroupIdsById[id] = [...event.ids];
      }
      const betweenHand = state.model.betweenHand;
      next = {
        ...state,
        model: event.outgoing
          ? {
              ...state.model,
              betweenHand: {
                ...betweenHand,
                outgoingProposalIds: [
                  ...betweenHand.outgoingProposalIds,
                  ...event.ids.filter((id) => !betweenHand.outgoingProposalIds.includes(id)),
                ],
                outgoingProposalGroupIds: [...betweenHand.outgoingProposalGroupIds, [...event.ids]],
                outgoingProposalTerms: {
                  ...betweenHand.outgoingProposalTerms,
                  ...Object.fromEntries(event.ids.map((id) => [id, event.terms])),
                },
              },
            }
          : state.model,
        coordination: { ...state.coordination, proposalTermsById, proposalGroupIdsById },
      };
      break;
    }
    case 'clear-proposals':
      next = clearProposalIds(state, event.ids);
      break;
    case 'begin-accepted-group': {
      const betweenHand = state.model.betweenHand;
      const alreadyTracked = betweenHand.acceptedProposalGroupIds.some(
        (group) =>
          group.length === event.groupIds.length &&
          group.every((id, index) => id === event.groupIds[index]),
      );
      const cleared = clearProposalIds(state, event.groupIds);
      next = {
        ...cleared,
        model: {
          ...cleared.model,
          betweenHand: {
            ...cleared.model.betweenHand,
            acceptedProposalGroupIds: alreadyTracked
              ? betweenHand.acceptedProposalGroupIds
              : [...betweenHand.acceptedProposalGroupIds, [...event.groupIds]],
          },
        },
      };
      for (const id of event.groupIds) {
        next.coordination.proposalGroupIdsById[id] = [...event.groupIds];
      }
      break;
    }
    case 'finish-proposal-wave':
      next = {
        ...state,
        model: {
          ...state.model,
          betweenHand: { ...state.model.betweenHand, acceptedProposalGroupIds: [] },
        },
      };
      break;
    case 'remove-accepted-group':
      next = {
        ...state,
        model: {
          ...state.model,
          betweenHand: {
            ...state.model.betweenHand,
            acceptedProposalGroupIds: state.model.betweenHand.acceptedProposalGroupIds.filter(
              (group) => !group.some((id) => event.groupIds.includes(id)),
            ),
          },
        },
      };
      break;
    case 'set-same-terms-requested':
      next = {
        ...state,
        coordination: { ...state.coordination, sameTermsRequested: event.requested },
      };
      break;
    case 'set-expecting-counter-proposal':
      next = {
        ...state,
        coordination: { ...state.coordination, expectingCounterProposal: event.expecting },
      };
      break;
    case 'set-first-game-accepted':
      next = {
        ...state,
        coordination: { ...state.coordination, firstGameAccepted: event.accepted },
      };
      break;
    case 'set-i-proposed-hand':
      next = { ...state, coordination: { ...state.coordination, iProposedHand: event.proposed } };
      break;
    case 'set-last-outcome':
      next = { ...state, coordination: { ...state.coordination, lastOutcome: event.outcome } };
      break;
    case 'hand-outcome':
      return {
        state: {
          ...state,
          coordination: { ...state.coordination, lastOutcome: event.outcome },
        },
        effects: [
          { type: 'controller-set-last-outcome', outcome: event.outcome },
          { type: 'persist-session' },
        ],
      };
    case 'notification-accepted-group': {
      const first = state.model.game.activeIds.length === 0;
      const cleared = clearProposalIds(state, event.groupIds);
      const game = gameSliceReducer(gameSliceFromModel(cleared.model), {
        type: 'accepted-group',
        groupIds: event.groupIds,
        acceptedId: event.id,
        amount: event.amount,
        startTurn: gameInitialTurn(event.terms.gameType, event.iStarted),
        gameType: event.terms.gameType,
      });
      const payload = withDurableGameEvent(
        {
          ...cleared,
          model: {
            ...withGameSlice(cleared.model, game),
            betweenHand: {
              ...cleared.model.betweenHand,
              acceptedProposalGroupIds: cleared.model.betweenHand.acceptedProposalGroupIds.some(
                (group) =>
                  group.length === event.groupIds.length &&
                  group.every((id, index) => id === event.groupIds[index]),
              )
                ? cleared.model.betweenHand.acceptedProposalGroupIds
                : [...cleared.model.betweenHand.acceptedProposalGroupIds, [...event.groupIds]],
              ...(first
                ? {
                    mode: 'decision' as const,
                    cachedPeerProposal: null,
                    reviewPeerProposal: null,
                    rejectedOnceTerms: null,
                    pendingRetryTerms: null,
                    newHandRequested: false,
                    lastTerms: event.terms,
                    compose: applyTermsToComposeDraft(
                      cleared.model.betweenHand.compose,
                      event.terms,
                    ),
                  }
                : {}),
            },
          },
          coordination: {
            ...cleared.coordination,
            proposalTermsById: {
              ...cleared.coordination.proposalTermsById,
              ...Object.fromEntries(event.groupIds.map((id) => [id, event.terms])),
            },
            ...(first
              ? {
                  iProposedHand: event.weProposed,
                  firstGameAccepted: true,
                  sameTermsRequested: false,
                  expectingCounterProposal: false,
                }
              : {}),
            proposalGroupIdsById: {
              ...cleared.coordination.proposalGroupIdsById,
              ...Object.fromEntries(event.groupIds.map((id) => [id, [...event.groupIds]])),
            },
          },
        },
        {
          type: 'accepted-group',
          id: event.id,
          groupIds: event.groupIds,
          iStarted: event.iStarted,
          iProposedHand: event.weProposed,
          terms: event.terms,
        },
      );
      return payload;
    }
    case 'notification-game-status': {
      const game = gameSliceReducer(gameSliceFromModel(state.model), {
        type: 'status',
        id: event.id,
        payload: event.payload,
        channelState: event.channelState,
      });
      return withDurableGameEvent(
        { ...state, model: withGameSlice(state.model, game) },
        {
          type: 'game-status',
          id: event.id,
          status: event.payload.status === 'my-turn' ? 'my-turn' : 'their-turn',
          readable: event.readable,
          moverShare: event.moverShare,
          iStarted: event.iStarted,
        },
      );
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
                cachedPeerProposal: null,
                reviewPeerProposal: null,
                acceptedProposalGroupIds: [],
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
      const game = gameSliceReducer(gameSliceFromModel(state.model), {
        type: 'remove-group',
        groupIds: event.groupIds,
      });
      const cleared = clearProposalIds(
        {
          ...state,
          model: {
            ...withGameSlice(state.model, game),
            betweenHand: {
              ...state.model.betweenHand,
              mode: 'compose-proposal',
              cachedPeerProposal: null,
              reviewPeerProposal: null,
              acceptedProposalGroupIds: state.model.betweenHand.acceptedProposalGroupIds.filter(
                (group) => !group.some((id) => event.groupIds.includes(id)),
              ),
            },
            game: {
              ...withGameSlice(state.model, game).game,
              queue: [...state.model.game.queue, event.notification],
            },
          },
        },
        event.groupIds,
      );
      return withDurableGameEvent(cleared, {
        type: 'remove-group',
        groupIds: event.groupIds,
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
    case 'feature-state': {
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
      return withDurableGameEvent(state, {
        type: 'feature-state',
        gameType: event.gameType,
        id: event.id,
        state: decoded,
      });
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
    case 'request-accept-proposal':
      return { state, effects: [{ type: 'controller-accept-proposal', id: event.id }] };
    case 'request-cancel-proposal':
      return { state, effects: [{ type: 'controller-cancel-proposal', id: event.id }] };
    case 'request-propose-game':
      return { state, effects: [{ type: 'controller-propose-game', terms: event.terms }] };
    case 'proposal-sent': {
      const tracked = reduceSessionMachine(
        {
          ...state,
          model: {
            ...state.model,
            betweenHand: {
              ...state.model.betweenHand,
              compose: { ...state.model.betweenHand.compose, proposalSent: true },
            },
          },
        },
        {
          type: 'track-proposal',
          ids: event.ids,
          terms: event.terms,
          outgoing: true,
        },
      );
      return { state: tracked.state, effects: [{ type: 'persist-session' }] };
    }
    case 'proposal-command-succeeded': {
      const betweenHand = state.model.betweenHand;
      if (event.command === 'accept-proposal') {
        if (event.context === 'accept-review') {
          return {
            state: {
              ...state,
              model: {
                ...state.model,
                betweenHand: { ...betweenHand, mode: 'decision' },
              },
            },
            effects: [{ type: 'persist-session' }],
          };
        }
        if (event.context === 'choose-same-terms') {
          return {
            state: {
              ...state,
              model: {
                ...state.model,
                betweenHand: { ...betweenHand, newHandRequested: false },
              },
              coordination: { ...state.coordination, sameTermsRequested: false },
            },
            effects: [{ type: 'persist-session' }],
          };
        }
      } else if (event.context === 'reject-current-proposal') {
        return {
          state: {
            ...state,
            model: {
              ...state.model,
              betweenHand: {
                ...betweenHand,
                cachedPeerProposal: null,
                rejectedOnceTerms: betweenHand.lastTerms,
                compose: applyTermsToComposeDraft(betweenHand.compose, betweenHand.lastTerms),
                mode: 'compose-proposal',
              },
            },
          },
          effects: [{ type: 'persist-session' }],
        };
      } else if (event.context === 'reject-review') {
        return {
          state: {
            ...state,
            model: {
              ...state.model,
              betweenHand: {
                ...betweenHand,
                reviewPeerProposal: null,
                compose: { ...betweenHand.compose, proposalSent: false },
                mode: 'compose-proposal',
              },
            },
          },
          effects: [{ type: 'persist-session' }],
        };
      }
      return { state, effects: [] };
    }
    case 'controller-command-failed': {
      const retryable =
        event.command === 'propose-game'
          ? {
              ...state,
              model: {
                ...state.model,
                betweenHand: {
                  ...state.model.betweenHand,
                  newHandRequested: false,
                  compose: { ...state.model.betweenHand.compose, proposalSent: false },
                },
              },
              coordination: { ...state.coordination, sameTermsRequested: false },
            }
          : state;
      return reduceSessionMachine(retryable, {
        type: 'enqueue-error',
        kind: 'action-failed',
        message: `${event.command} failed: ${event.message}`,
      });
    }
    case 'clean-shutdown-command-succeeded':
      return {
        state: {
          ...state,
          model: {
            ...state.model,
            channel: { ...state.model.channel, cleanShutdownStarted: true },
          },
        },
        effects: [{ type: 'persist-session' }],
      };
    case 'start-clean-shutdown':
      return { state, effects: [{ type: 'controller-clean-shutdown' }] };
    case 'go-on-chain':
      return { state, effects: [{ type: 'controller-go-on-chain' }] };
    case 'go-on-chain-result':
      return {
        state: {
          ...state,
          coordination: { ...state.coordination, hostOnChain: event.started },
        },
        effects: [],
      };
    case 'enqueue-error': {
      const notification = {
        id: state.coordination.nextNotificationId + 1n,
        kind: event.kind,
        title: event.kind === 'durability-error' ? 'Session Storage Error' : 'Error',
        message: event.message,
      };
      return {
        state: {
          ...state,
          model: {
            ...state.model,
            channel: {
              ...state.model.channel,
              queue: [...state.model.channel.queue, notification],
            },
          },
          coordination: {
            ...state.coordination,
            nextNotificationId: notification.id,
          },
        },
        effects: [{ type: 'persist-session' }],
      };
    }
    case 'coin-enrichment-completed': {
      const expected =
        event.target === 'channel'
          ? state.coordination.channelEnrichmentGeneration
          : state.coordination.gameEnrichmentGeneration[event.id];
      if (event.generation !== expected || !event.coinHex) return { state, effects: [] };
      if (event.target === 'channel') {
        if (
          event.channelState === undefined ||
          event.channelState !== state.model.channel.status.state ||
          event.id !== state.model.channel.status.state
        ) {
          return { state, effects: [] };
        }
        return withSessionPersistence(
          reduceSessionMachine(state, {
            type: 'channel-coin-enriched',
            state: event.channelState,
            coinHex: event.coinHex,
          }),
        );
      }
      const instance = state.model.game.instances[event.id];
      if (!instance) return { state, effects: [] };
      if (event.target === 'settlement') {
        if (instance.terminal.type === 'none') return { state, effects: [] };
        return withSessionPersistence(
          reduceSessionMachine(state, {
            type: 'game',
            action: {
              type: 'settled',
              id: event.id,
              terminal: { ...instance.terminal, rewardCoinHex: event.coinHex },
            },
          }),
        );
      }
      return withSessionPersistence(
        reduceSessionMachine(state, {
          type: 'game',
          action: { type: 'coin-enriched', id: event.id, coinHex: event.coinHex },
        }),
      );
    }
  }
  const shouldPersist =
    event.type === 'dismiss-channel-notification' ||
    event.type === 'dismiss-channel' ||
    event.type === 'dismiss-game-notification' ||
    event.type === 'select-compose-game' ||
    event.type === 'set-compose-timeout' ||
    event.type === 'set-compose-amount' ||
    event.type === 'set-spacepoker-compose' ||
    event.type === 'set-compose-draft' ||
    event.type === 'set-last-outcome';
  return {
    state: next,
    effects: shouldPersist && next !== state ? [{ type: 'persist-session' }] : [],
  };
}
