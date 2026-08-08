import type {
  ActionFailedPayload,
  ChannelStatusPayload,
  GameSettledPayload,
  GameStatusPayload,
  WasmNotification,
} from '../../types/ChiaGaming';
import { coerceToBytes } from '../../util';
import { gameTermsEqual } from '../gameRegistry';
import { durableNotificationKind } from './sessionTransition';
import {
  gameplayEventForActionFailed,
  gameplayEventForMoveRejected,
  gameplayEventsForGameStatus,
  parseAmount,
  parseGameStatusTerminalInfo,
  parseIncomingProposal,
  settledEventForInfo,
  terminalInfoFromGameSettled,
} from './gameSessionEvents';
import { channelStatusModelFromPayload } from './normalization';
import { isTerminalGameStatus, type NonTerminalGameStatusPayload } from './presentation';
import type {
  SessionMachineEffect,
  SessionMachineEvent,
  SessionMachineState,
  SessionMachineTransition,
} from './sessionMachineTypes';

const ERROR_CHANNEL_STATUSES = new Set(['ResolvedStale', 'Failed']);
const LOCAL_CANCEL_REASONS = new Set(['SupersededByIncoming', 'PeerProposalPending', 'GameActive']);

type Reducer = (state: SessionMachineState, event: SessionMachineEvent) => SessionMachineTransition;

export function reduceSessionNotification(
  state: SessionMachineState,
  notification: WasmNotification,
  iStarted: boolean,
  reduce: Reducer,
): SessionMachineTransition {
  let current = state;
  const effects: SessionMachineEffect[] = [];
  const step = (event: SessionMachineEvent) => {
    const transition = reduce(current, event);
    current = transition.state;
    effects.push(...transition.effects);
  };
  const nextId = () => {
    const id = current.coordination.nextNotificationId + 1n;
    current = {
      ...current,
      coordination: { ...current.coordination, nextNotificationId: id },
    };
    return id;
  };
  const cancelStale = (exceptId?: string) => {
    const proposals = [
      current.model.betweenHand.cachedPeerProposal,
      current.model.betweenHand.reviewPeerProposal,
    ];
    for (const proposal of proposals) {
      if (proposal && proposal.id !== exceptId) {
        effects.push({ type: 'controller-cancel-proposal', id: proposal.id });
      }
    }
  };

  if ('ChannelStatus' in notification) {
    const payload = notification.ChannelStatus as ChannelStatusPayload | undefined;
    if (!payload) return { state, effects: [] };
    const status = channelStatusModelFromPayload(payload);
    step({ type: 'channel-status', status });
    const generation = current.coordination.channelEnrichmentGeneration + 1;
    current = {
      ...current,
      coordination: { ...current.coordination, channelEnrichmentGeneration: generation },
    };
    if (coerceToBytes(payload.coin)) {
      effects.push({
        type: 'request-coin-enrichment',
        target: 'channel',
        id: status.state,
        generation,
        coin: payload.coin,
        channelState: status.state,
      });
    }
    if (
      current.model.channel.dismissedChannelStatus !== null &&
      current.model.channel.dismissedChannelStatus !== payload.state
    ) {
      step({ type: 'dismissed-channel-status', status: null });
    }
    if (
      ERROR_CHANNEL_STATUSES.has(payload.state) &&
      current.model.channel.dismissedChannelStatus !== payload.state
    ) {
      step({
        type: 'push-channel-notification',
        notification: {
          id: nextId(),
          kind: 'channel-state',
          title: 'Error',
          message: status.advisory ?? '',
          payload: status,
        },
      });
    }
    if (payload.state === 'Active') {
      if (current.model.channel.connection.stateIdentifier !== 'running') {
        step({ type: 'connection', connection: { stateIdentifier: 'running', stateDetail: [] } });
      }
      if (!current.coordination.firstGameAccepted) {
        step({ type: 'set-first-game-accepted', accepted: true });
        step({ type: 'game', action: { type: 'channel-active' } });
        const cached = current.model.betweenHand.cachedPeerProposal;
        if (cached) {
          step({ type: 'set-review-proposal', proposal: cached });
          step({ type: 'set-cached-proposal', proposal: null });
          step({ type: 'set-between-hand-mode', mode: 'review-incoming-proposal' });
        } else {
          step({ type: 'set-between-hand-mode', mode: 'compose-proposal' });
        }
      }
    }
    if (payload.state === 'ShuttingDown' || payload.state === 'ShutdownTransactionPending') {
      step({ type: 'clean-shutdown-started', started: true });
    }
    return { state: current, effects };
  }

  if ('ProposalMade' in notification) {
    const incoming = parseIncomingProposal(notification.ProposalMade);
    if (!incoming) {
      effects.push({ type: 'controller-go-on-chain' });
      return { state: current, effects };
    }
    step({
      type: 'track-proposal',
      ids: incoming.groupIds,
      terms: incoming.terms,
      outgoing: false,
    });
    if (incoming.groupIds.length > 1 && incoming.id !== incoming.groupIds[0]) {
      return { state: current, effects };
    }
    if (current.model.game.activeIds.length > 0) {
      effects.push({ type: 'controller-cancel-proposal', id: incoming.id });
      return { state: current, effects };
    }
    if (current.model.game.handKey === 0) {
      step({ type: 'set-cached-proposal', proposal: incoming });
      return { state: current, effects };
    }
    const between = current.model.betweenHand;
    const matchesLast = gameTermsEqual(incoming.terms, between.lastTerms);
    if (between.mode === 'decision') {
      if (current.coordination.expectingCounterProposal) {
        effects.push({ type: 'timer-cancel', key: 'rejection-fallback' });
        current = {
          ...current,
          coordination: { ...current.coordination, expectingCounterProposal: false },
          model: {
            ...current.model,
            betweenHand: {
              ...between,
              pendingRetryTerms: null,
              newHandRequested: false,
              reviewPeerProposal: incoming,
              mode: 'review-incoming-proposal',
            },
          },
        };
      } else if (matchesLast && current.coordination.sameTermsRequested) {
        current = {
          ...current,
          coordination: { ...current.coordination, sameTermsRequested: false },
          model: {
            ...current.model,
            betweenHand: { ...between, pendingRetryTerms: null, newHandRequested: false },
          },
        };
        effects.push({ type: 'controller-accept-proposal', id: incoming.id });
      } else if (current.coordination.sameTermsRequested && !matchesLast) {
        for (const id of between.outgoingProposalIds) {
          if (id !== incoming.id) effects.push({ type: 'controller-cancel-proposal', id });
        }
        step({ type: 'clear-proposals' });
        current = {
          ...current,
          coordination: { ...current.coordination, sameTermsRequested: false },
          model: {
            ...current.model,
            betweenHand: {
              ...current.model.betweenHand,
              pendingRetryTerms: null,
              newHandRequested: false,
              reviewPeerProposal: incoming,
              mode: 'review-incoming-proposal',
            },
          },
        };
      } else if (between.pendingRetryTerms) {
        const retry = between.pendingRetryTerms;
        step({ type: 'set-pending-retry-terms', terms: null });
        if (matchesLast) {
          effects.push(
            { type: 'controller-cancel-proposal', id: incoming.id },
            { type: 'controller-propose-game', terms: retry },
          );
        } else {
          step({ type: 'set-review-proposal', proposal: incoming });
          step({ type: 'set-between-hand-mode', mode: 'review-incoming-proposal' });
        }
      } else {
        step({ type: 'set-cached-proposal', proposal: incoming });
      }
    } else if (between.mode === 'compose-proposal') {
      if (between.pendingRetryTerms) {
        const retry = between.pendingRetryTerms;
        step({ type: 'set-pending-retry-terms', terms: null });
        if (matchesLast) {
          effects.push(
            { type: 'controller-cancel-proposal', id: incoming.id },
            { type: 'controller-propose-game', terms: retry },
          );
        } else {
          step({ type: 'set-compose-proposal-sent', sent: false });
          step({ type: 'set-review-proposal', proposal: incoming });
          step({ type: 'set-between-hand-mode', mode: 'review-incoming-proposal' });
        }
      } else if (gameTermsEqual(incoming.terms, between.rejectedOnceTerms)) {
        effects.push({ type: 'controller-cancel-proposal', id: incoming.id });
        step({ type: 'set-rejected-terms', terms: null });
      } else {
        step({ type: 'set-review-proposal', proposal: incoming });
        step({ type: 'set-between-hand-mode', mode: 'review-incoming-proposal' });
      }
    } else {
      step({ type: 'set-review-proposal', proposal: incoming });
    }
    effects.push({ type: 'persist-session' });
    return { state: current, effects };
  }

  const durableKind = durableNotificationKind(notification);
  if (durableKind === 'accepted-group') {
    const accepted = notification.ProposalAccepted!;
    const id = String(accepted.id);
    const amount = parseAmount(accepted.amount);
    if (amount == null) throw new Error(`ProposalAccepted ${id} missing amount`);
    const groupIds = current.coordination.proposalGroupIdsById[id] ?? [id];
    const terms = current.coordination.proposalTermsById[id];
    if (!terms) throw new Error(`ProposalAccepted ${id} missing tracked game terms`);
    const first = current.model.game.activeIds.length === 0;
    step({
      type: 'notification-accepted-group',
      id,
      groupIds,
      amount,
      terms,
      weProposed: groupIds.some((groupId) =>
        current.model.betweenHand.outgoingProposalIds.includes(groupId),
      ),
      iStarted,
    });
    if (first) cancelStale(id);
    effects.push({ type: 'emit-gameplay', event: { ProposalAccepted: { id: accepted.id } } });
    return { state: current, effects };
  }

  if (durableKind === 'settlement') {
    const settled = notification.GameSettled as GameSettledPayload | undefined;
    if (!settled) return { state, effects: [] };
    const id = String(settled.id);
    const terminal = terminalInfoFromGameSettled(settled, null);
    step({ type: 'notification-game-terminal', id, terminal });
    const gameplay = settledEventForInfo(id, terminal);
    effects.push({
      type: 'emit-gameplay',
      event: gameplay ?? {
        GameError: {
          gameId: id,
          reason: terminal.label ?? 'settlement error',
          source: 'terminal',
        },
      },
    });
    if (current.model.game.activeIds.length === 0) {
      cancelStale();
      step({ type: 'clear-proposals' });
    }
    const generation = (current.coordination.gameEnrichmentGeneration[id] ?? 0) + 1;
    current = {
      ...current,
      coordination: {
        ...current.coordination,
        gameEnrichmentGeneration: {
          ...current.coordination.gameEnrichmentGeneration,
          [id]: generation,
        },
      },
    };
    effects.push({
      type: 'request-coin-enrichment',
      target: 'settlement',
      id,
      generation,
      coin: settled.coin_id,
    });
    return { state: current, effects };
  }

  if (durableKind === 'game-status') {
    const status = notification.GameStatus as GameStatusPayload | undefined;
    if (!status) return { state, effects: [] };
    const id = String(status.id);
    if (isTerminalGameStatus(status.status)) {
      const terminal = parseGameStatusTerminalInfo(status, null, 'their-turn');
      step({ type: 'notification-game-terminal', id, terminal });
      for (const event of gameplayEventsForGameStatus(
        notification,
        current.model.game.activeIds,
        null,
      )) {
        effects.push({ type: 'emit-gameplay', event });
      }
      if (terminal.type === 'game-error' || terminal.type === 'ended-cancelled') {
        effects.push({
          type: 'emit-gameplay',
          event: {
            GameError: { gameId: id, reason: terminal.label ?? terminal.type, source: 'terminal' },
          },
        });
      }
      if (current.model.game.activeIds.length === 0) {
        cancelStale();
        step({ type: 'clear-proposals' });
      }
      return { state: current, effects };
    }
    const payload: NonTerminalGameStatusPayload = { ...status, status: status.status };
    step({
      type: 'notification-game-status',
      id,
      payload,
      channelState: current.model.channel.status.state,
      readable: coerceToBytes(status.other_params?.readable),
      moverShare: parseAmount(status.other_params?.mover_share),
      iStarted,
    });
    for (const event of gameplayEventsForGameStatus(
      notification,
      current.model.game.activeIds,
      null,
    )) {
      effects.push({ type: 'emit-gameplay', event });
    }
    const generation = (current.coordination.gameEnrichmentGeneration[id] ?? 0) + 1;
    current = {
      ...current,
      coordination: {
        ...current.coordination,
        gameEnrichmentGeneration: {
          ...current.coordination.gameEnrichmentGeneration,
          [id]: generation,
        },
      },
    };
    effects.push({
      type: 'request-coin-enrichment',
      target: 'game',
      id,
      generation,
      coin: status.coin_id,
    });
    return { state: current, effects };
  }

  if (durableKind === 'insufficient-balance') {
    const insufficient = notification.InsufficientBalance as Record<string, unknown> | undefined;
    const id = String(insufficient?.id ?? '');
    const groupIds = current.coordination.proposalGroupIdsById[id] ?? [id];
    step({
      type: 'notification-insufficient-balance',
      id,
      groupIds,
      notification: {
        id: nextId(),
        kind: 'insufficient-bal',
        title: 'Notice',
        message: 'Insufficient balance for that proposal. The hand could not start.',
      },
    });
    cancelStale();
    return { state: current, effects };
  }

  if ('ProposalCancelled' in notification) {
    const id = String(notification.ProposalCancelled?.id ?? '');
    const reason = String(
      (notification.ProposalCancelled as Record<string, unknown> | undefined)?.reason ?? '',
    );
    const before = current;
    const terms = id ? (before.coordination.proposalTermsById[id] ?? null) : null;
    const wasOurs = id ? before.model.betweenHand.outgoingProposalIds.includes(id) : false;
    if (id) {
      step({ type: 'clear-proposals', ids: before.coordination.proposalGroupIdsById[id] ?? [id] });
      const cached = before.model.betweenHand.cachedPeerProposal;
      if (cached?.id === id || cached?.groupIds.includes(id))
        step({ type: 'set-cached-proposal', proposal: null });
      const review = before.model.betweenHand.reviewPeerProposal;
      if (review?.id === id || review?.groupIds.includes(id)) {
        step({ type: 'set-review-proposal', proposal: null });
        step({ type: 'set-between-hand-mode', mode: 'compose-proposal' });
      }
    }
    if (LOCAL_CANCEL_REASONS.has(reason) && terms) {
      step({ type: 'set-pending-retry-terms', terms });
    } else if (reason === 'CancelledByPeer') {
      step({ type: 'set-pending-retry-terms', terms: null });
      step({ type: 'set-compose-proposal-sent', sent: false });
      const sameTerms = before.coordination.sameTermsRequested && wasOurs;
      step({ type: 'set-same-terms-requested', requested: false });
      step({ type: 'set-new-hand-requested', requested: false });
      if (sameTerms) {
        const generation = current.coordination.rejectionTimerGeneration + 1;
        current = {
          ...current,
          coordination: {
            ...current.coordination,
            expectingCounterProposal: true,
            rejectionTimerGeneration: generation,
          },
        };
        effects.push({
          type: 'timer-schedule',
          key: 'rejection-fallback',
          generation,
          delayMs: 300,
        });
      } else {
        step({
          type: 'push-game-notification',
          notification: {
            id: nextId(),
            kind: 'proposal-rejected',
            title: 'Notice',
            message: 'Your proposal was rejected by the other side.',
          },
        });
      }
    } else {
      step({ type: 'set-pending-retry-terms', terms: null });
    }
    effects.push({ type: 'persist-session' });
    return { state: current, effects };
  }

  if ('MoveRejected' in notification && notification.MoveRejected) {
    effects.push({
      type: 'emit-gameplay',
      event: gameplayEventForMoveRejected(notification.MoveRejected),
    });
  } else if ('ActionFailed' in notification && notification.ActionFailed) {
    const failed = notification.ActionFailed as ActionFailedPayload;
    const gameplay = gameplayEventForActionFailed(failed);
    if (gameplay) effects.push({ type: 'emit-gameplay', event: gameplay });
    step({ type: 'enqueue-error', kind: 'action-failed', message: String(failed.reason) });
  }
  return { state: current, effects };
}
