import type {
  ActionFailedPayload,
  GameSettledPayload,
  GameStatusPayload,
  WasmNotification,
} from '../../types/ChiaGaming';
import { coerceToBytes } from '../../util';
import { handProposalsEqual } from '../gameRegistry';
import { parseAmount } from '../wasm/parseAmount';
import { durableNotificationKind } from './sessionTransition';
import { proposalGroupFromProposalMade } from './incomingProposal';
import { parseGameStatusTerminalInfo, terminalInfoFromGameSettled } from './gameSessionEvents';
import { channelStatusModelFromPayload } from './normalization';
import { isTerminalGameStatus, type NonTerminalGameStatusPayload } from './presentation';
import { selectProposalGroupByDisposition, selectProposalGroupByMemberId } from './selectors';
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
    const proposals = current.model.betweenHand.proposalGroups.filter(
      (group) => group.origin === 'peer' && group.disposition !== 'accepted',
    );
    for (const proposal of proposals) {
      if (proposal.primaryId !== exceptId) {
        effects.push({ type: 'controller-cancel-proposal', id: proposal.primaryId });
      }
    }
  };

  if ('ChannelStatus' in notification) {
    const payload = notification.ChannelStatus;
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
        const cached = selectProposalGroupByDisposition(current.model, 'incoming-cached');
        if (cached) {
          step({
            type: 'set-proposal-disposition',
            primaryId: cached.primaryId,
            disposition: 'incoming-review',
          });
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
    const incoming = proposalGroupFromProposalMade(notification.ProposalMade);
    if (!incoming) {
      effects.push({ type: 'controller-go-on-chain' });
      return { state: current, effects };
    }
    step({
      type: 'upsert-proposal-group',
      group: incoming,
    });
    if (incoming.primaryId !== incoming.memberIds[0]) {
      return { state: current, effects };
    }
    if (current.model.game.activeIds.length > 0) {
      effects.push({ type: 'controller-cancel-proposal', id: incoming.primaryId });
      return { state: current, effects };
    }
    if (current.model.game.handKey === 0) {
      return { state: current, effects };
    }
    const between = current.model.betweenHand;
    const matchesLast = handProposalsEqual(incoming.handProposal, between.lastHandProposal);
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
              pendingRetryHandProposal: null,
              newHandRequested: false,
              proposalGroups: between.proposalGroups.map((group) =>
                group.primaryId === incoming.primaryId
                  ? { ...group, disposition: 'incoming-review' as const }
                  : group,
              ),
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
            betweenHand: { ...between, pendingRetryHandProposal: null, newHandRequested: false },
          },
        };
        effects.push({ type: 'controller-accept-proposal', id: incoming.primaryId });
      } else if (current.coordination.sameTermsRequested && !matchesLast) {
        const outgoingMemberIds: string[] = [];
        for (const group of between.proposalGroups) {
          if (
            group.origin === 'local' &&
            group.disposition === 'outgoing' &&
            group.primaryId !== incoming.primaryId
          ) {
            effects.push({ type: 'controller-cancel-proposal', id: group.primaryId });
            outgoingMemberIds.push(...group.memberIds);
          }
        }
        if (outgoingMemberIds.length > 0) {
          step({ type: 'clear-proposals', ids: outgoingMemberIds });
        }
        current = {
          ...current,
          coordination: { ...current.coordination, sameTermsRequested: false },
          model: {
            ...current.model,
            betweenHand: {
              ...current.model.betweenHand,
              pendingRetryHandProposal: null,
              newHandRequested: false,
              proposalGroups: current.model.betweenHand.proposalGroups.map((group) =>
                group.primaryId === incoming.primaryId
                  ? { ...group, disposition: 'incoming-review' as const }
                  : group,
              ),
              mode: 'review-incoming-proposal',
            },
          },
        };
      } else if (between.pendingRetryHandProposal) {
        const retry = between.pendingRetryHandProposal;
        step({ type: 'set-pending-retry-terms', handProposal: null });
        if (matchesLast) {
          effects.push(
            { type: 'controller-cancel-proposal', id: incoming.primaryId },
            { type: 'controller-propose-game', handProposal: retry },
          );
        } else {
          step({
            type: 'set-proposal-disposition',
            primaryId: incoming.primaryId,
            disposition: 'incoming-review',
          });
          step({ type: 'set-between-hand-mode', mode: 'review-incoming-proposal' });
        }
      } else {
        // The normalized group already carries its cached disposition.
      }
    } else if (between.mode === 'compose-proposal') {
      if (between.pendingRetryHandProposal) {
        const retry = between.pendingRetryHandProposal;
        step({ type: 'set-pending-retry-terms', handProposal: null });
        if (matchesLast) {
          effects.push(
            { type: 'controller-cancel-proposal', id: incoming.primaryId },
            { type: 'controller-propose-game', handProposal: retry },
          );
        } else {
          step({ type: 'set-compose-proposal-sent', sent: false });
          step({
            type: 'set-proposal-disposition',
            primaryId: incoming.primaryId,
            disposition: 'incoming-review',
          });
          step({ type: 'set-between-hand-mode', mode: 'review-incoming-proposal' });
        }
      } else if (handProposalsEqual(incoming.handProposal, between.rejectedOnceHandProposal)) {
        effects.push({ type: 'controller-cancel-proposal', id: incoming.primaryId });
        step({ type: 'set-rejected-terms', handProposal: null });
      } else {
        step({
          type: 'set-proposal-disposition',
          primaryId: incoming.primaryId,
          disposition: 'incoming-review',
        });
        step({ type: 'set-between-hand-mode', mode: 'review-incoming-proposal' });
      }
    } else {
      step({
        type: 'set-proposal-disposition',
        primaryId: incoming.primaryId,
        disposition: 'incoming-review',
      });
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
    if (typeof accepted.our_turn !== 'boolean') {
      throw new Error(`ProposalAccepted ${id} missing Rust turn authority`);
    }
    const previousHandIds = current.model.game.currentHandIds;
    step({
      type: 'notification-accepted-group',
      id,
      amount,
      iStarted,
      isMyTurn: accepted.our_turn,
    });
    const first =
      previousHandIds.length !== current.model.game.currentHandIds.length ||
      previousHandIds.some(
        (groupId, index) => groupId !== current.model.game.currentHandIds[index],
      );
    if (first) cancelStale(id);
    return { state: current, effects };
  }

  if (durableKind === 'settlement') {
    const settled = notification.GameSettled as GameSettledPayload | undefined;
    if (!settled) return { state, effects: [] };
    const id = String(settled.id);
    const terminal = terminalInfoFromGameSettled(settled, null);
    step({ type: 'notification-game-terminal', id, terminal });
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
      if (current.model.game.activeIds.length === 0) {
        cancelStale();
        step({ type: 'clear-proposals' });
      }
      return { state: current, effects };
    }
    const instance = current.model.game.instances[id];
    if (instance && instance.terminal.type !== 'none') {
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
    step({
      type: 'notification-insufficient-balance',
      id,
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
    const proposal = id ? selectProposalGroupByMemberId(before.model, id) : null;
    const terms = proposal?.handProposal ?? null;
    const wasOurs = proposal?.origin === 'local';
    if (id) {
      step({ type: 'clear-proposals', ids: proposal?.memberIds ?? [id] });
      if (proposal?.disposition === 'incoming-review') {
        step({ type: 'set-between-hand-mode', mode: 'compose-proposal' });
      }
    }
    if (LOCAL_CANCEL_REASONS.has(reason) && terms) {
      step({ type: 'set-pending-retry-terms', handProposal: terms });
    } else if (reason === 'CancelledByPeer') {
      step({ type: 'set-pending-retry-terms', handProposal: null });
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
      step({ type: 'set-pending-retry-terms', handProposal: null });
    }
    effects.push({ type: 'persist-session' });
    return { state: current, effects };
  }

  if ('MoveRejected' in notification && notification.MoveRejected) {
    step({
      type: 'notification-move-rejected',
      id: String(notification.MoveRejected.id),
      tag: String(notification.MoveRejected.tag),
      message: String(notification.MoveRejected.message),
    });
  } else if ('ActionFailed' in notification && notification.ActionFailed) {
    const failed = notification.ActionFailed as ActionFailedPayload;
    step({ type: 'enqueue-error', kind: 'action-failed', message: String(failed.reason) });
  }
  return { state: current, effects };
}
