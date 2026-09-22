import { applyHandProposalToComposeDraft } from './composeDraft';
import { gameSliceReducer } from './gameSlice';
import { Program } from 'clvm-lib';
import type { GameHandInitialization, GameUpdate, PersistedGameState } from '@games/host';
import { selectPendingProposal } from './selectors';
import { proposalOrigin } from './sessionMachineProposals';
import type {
  SessionMachineEvent,
  SessionMachineState,
  SessionMachineTransition,
} from './sessionMachineTypes';
import type { RegisteredGameType } from './types';

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

export interface ActiveGameHandContext {
  create(gameType: RegisteredGameType, init: GameHandInitialization): PersistedGameState;
  receive(update: GameUpdate): PersistedGameState;
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

function updateActiveHand(
  state: SessionMachineState,
  update: GameUpdate,
  activeHand: ActiveGameHandContext | undefined,
): SessionMachineTransition {
  if (!activeHand) throw new Error('Game package mutation requires an active hand context');
  return withHandState(state, activeHand.receive(update));
}

function assertNever(event: never): never {
  throw new Error(`Unhandled durable game event: ${JSON.stringify(event)}`);
}

export function reduceDurableGameEvent(
  state: SessionMachineState,
  event: DurableGameEvent,
  activeHand?: ActiveGameHandContext,
): SessionMachineTransition {
  switch (event.type) {
    case 'game': {
      if (event.action.type === 'abandoned') activeHand?.clear();
      return {
        state: {
          ...state,
          model: { ...state.model, game: gameSliceReducer(state.model.game, event.action) },
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
      const game = gameSliceReducer(state.model.game, {
        type: 'accepted-group',
        groupIds: acceptedIds,
        members: event.members.map((member) => ({
          amount: (member.playerAContribution + member.playerBContribution).toString(),
          startTurn: member.ourTurn ? 'my-turn' : 'their-turn',
        })),
        origin: proposalOrigin(proposal),
        gameType: proposal.handProposal.gameType,
      });
      const initialized = {
        ...state,
        model: {
          ...state.model,
          game: { ...game, handState: null },
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
      if (!activeHand) throw new Error('Game acceptance requires an active hand context');
      return withHandState(initialized, activeHand.create(proposal.handProposal.gameType, init));
    }
    case 'notification-game-status': {
      const game = gameSliceReducer(state.model.game, {
        type: 'status',
        id: event.id,
        payload: event.payload,
        channelState: event.channelState,
      });
      const projected = { ...state, model: { ...state.model, game } };
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
      return updateActiveHand(projected, update, activeHand);
    }
    case 'notification-game-terminal': {
      const game = gameSliceReducer(state.model.game, {
        type: 'settled',
        id: event.id,
        terminal: event.terminal,
      });
      const isLast = game.activeIds.length === 0;
      const base = {
        ...state,
        model: {
          ...state.model,
          game,
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
      return updateActiveHand(base, update, activeHand);
    }
    case 'notification-abandoned': {
      activeHand?.clear();
      const game = gameSliceReducer(state.model.game, { type: 'abandoned' });
      return {
        state: {
          ...state,
          model: { ...state.model, game },
        },
        effects: [],
      };
    }
    case 'hand-state-changed': {
      if (event.handState.gameType !== state.model.game.activeGameType) {
        throw new Error(
          `Internal hand state gameType ${event.handState.gameType} does not match active ${state.model.game.activeGameType}`,
        );
      }
      return withHandState(state, event.handState);
    }
    case 'local-game-action-committed': {
      if (event.handState.gameType !== state.model.game.activeGameType) {
        throw new Error(
          `Internal committed gameType ${event.handState.gameType} does not match active ${state.model.game.activeGameType}`,
        );
      }
      if (
        !state.model.game.activeIds.includes(event.id) ||
        !state.model.game.currentHandIds.includes(event.id)
      ) {
        throw new Error(`Internal committed game id ${event.id} is not an active hand member`);
      }
      return withHandState(state, event.handState);
    }
    case 'local-action-applied': {
      const game = gameSliceReducer(state.model.game, {
        type: 'local-turn',
        id: event.id,
        isMyTurn: false,
        channelState: state.model.channel.status.state,
      });
      return {
        state: { ...state, model: { ...state.model, game } },
        effects: [],
      };
    }
    default:
      return assertNever(event);
  }
}
