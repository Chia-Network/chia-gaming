import type { ChannelStatusPayload } from '../../types/ChiaGaming';
import type { SavedHandProposal, SessionPresentationSave } from './saveEnvelope';
import { encodeComposeDraftState } from './persistenceBetweenHands';
import { isCatalogGameType, validateHandProposal } from '../gameRegistry';
import { channelStatusPayloadFromModel } from './normalization';
import { isUncancelledProposal } from './proposalPolicy';
import type { HandProposal, RegisteredGameType, SessionModel } from './types';

export interface SessionPresentationFacts {
  channelStatus?: ChannelStatusPayload | null;
  waitingStateEnteredAt: bigint | null;
  cleanShutdownGraceStartedAt: bigint | null;
}

export function snapshotFromSessionModel(
  model: SessionModel,
  facts: SessionPresentationFacts = {
    waitingStateEnteredAt: null,
    cleanShutdownGraceStartedAt: null,
  },
): SessionPresentationSave {
  const requireCatalogGameType = (gameType: string, label: string): RegisteredGameType => {
    if (!isCatalogGameType(gameType)) {
      throw new Error(`Session invariant broken: ${label} ${gameType} is not a catalog gameType`);
    }
    return gameType;
  };

  const handProposalSnapshot = (handProposal: HandProposal): SavedHandProposal => {
    if (!validateHandProposal(handProposal)) {
      throw new Error(`Session invariant broken: invalid ${handProposal.gameType} hand proposal`);
    }
    return {
      sender_is_player_a: handProposal.senderIsPlayerA,
      game_timeout: handProposal.gameTimeout.toString(),
      game_type: requireCatalogGameType(handProposal.gameType, 'handProposal.gameType'),
      parameters: handProposal.parameters,
    };
  };

  const persistedGameIds = Array.from(
    new Set([
      ...model.game.activeIds,
      ...model.game.currentHandIds,
      ...(model.game.lastDisplayedId === null ? [] : [model.game.lastDisplayedId]),
    ]),
  );
  for (const id of persistedGameIds) {
    if (!model.game.instances[id]) {
      throw new Error(`Session invariant broken: game ${id} is missing its keyed instance`);
    }
  }
  const hasPersistedHand = persistedGameIds.length > 0 || model.game.handState !== null;
  if (model.game.currentHandIds.length > 0 && model.game.currentHandOrigin === null) {
    throw new Error('Session invariant broken: current hand is missing its origin');
  }
  if (model.game.currentHandIds.length === 0 && model.game.currentHandOrigin !== null) {
    throw new Error('Session invariant broken: hand origin has no current hand');
  }
  const lastHandProposal = model.betweenHand.lastHandProposal;
  if (hasPersistedHand && lastHandProposal === null) {
    throw new Error(
      'Session invariant broken: persisted hand is missing betweenHandLastHandProposal',
    );
  }
  const proposalIds = new Set<string>();
  let uncancelledProposals = 0;
  for (const proposal of model.betweenHand.pendingProposals) {
    if (proposalIds.has(proposal.id)) {
      throw new Error(`Session invariant broken: pending proposal ${proposal.id} appears twice`);
    }
    proposalIds.add(proposal.id);
    if (isUncancelledProposal(proposal)) uncancelledProposals += 1;
  }
  if (uncancelledProposals > 1) {
    throw new Error('Session invariant broken: multiple uncancelled proposals');
  }

  if (model.game.handState !== null) {
    requireCatalogGameType(model.game.handState.gameType, 'handState.gameType');
  }

  return {
    handKey: BigInt(model.game.handKey),
    activeGameIds: model.game.activeIds,
    activeGameType: requireCatalogGameType(model.game.activeGameType, 'activeGameType'),
    handState: model.game.handState,
    currentHandGameIds: model.game.currentHandIds,
    currentHandOrigin: model.game.currentHandOrigin,
    lastDisplayedGameId: model.game.lastDisplayedId,
    gameInstances: Object.fromEntries(
      persistedGameIds.map((id) => {
        const instance = model.game.instances[id];
        return [
          id,
          {
            id: instance.id,
            amount: instance.amount,
            coinHex: instance.coinHex,
            presentation: instance.presentation,
            terminal: instance.terminal,
          },
        ];
      }),
    ),
    channelStatus:
      facts.channelStatus === undefined
        ? channelStatusPayloadFromModel(model.channel.status)
        : facts.channelStatus,
    myRunningBalance: model.myRunningBalance.toString(),
    channelNotifQueue: model.channel.queue.map(({ id, kind, title, message }) => ({
      id,
      kind,
      title,
      message,
    })),
    gameNotifQueue: model.game.queue.map(({ id, kind, title, message }) => ({
      id,
      kind,
      title,
      message,
    })),
    dismissedChannelStatus: model.channel.dismissedChannelStatus,
    cleanShutdownStarted: model.channel.cleanShutdownStarted,
    betweenHandMode: model.betweenHand.mode,
    betweenHandCompose: encodeComposeDraftState(model.betweenHand.compose),
    betweenHandLastHandProposal:
      lastHandProposal === null ? null : handProposalSnapshot(lastHandProposal),
    betweenHandRejectedOnceHandProposal: model.betweenHand.rejectedOnceHandProposal
      ? handProposalSnapshot(model.betweenHand.rejectedOnceHandProposal)
      : null,
    betweenHandPendingRetryHandProposal: model.betweenHand.pendingRetryHandProposal
      ? handProposalSnapshot(model.betweenHand.pendingRetryHandProposal)
      : null,
    newHandRequested: model.betweenHand.newHandRequested,
    pendingProposals: model.betweenHand.pendingProposals.map((proposal) => ({
      id: proposal.id,
      lifecycle: proposal.lifecycle,
      hand_proposal: handProposalSnapshot(proposal.handProposal),
    })),
    waitingStateEnteredAt: facts.waitingStateEnteredAt,
    cleanShutdownGraceStartedAt: facts.cleanShutdownGraceStartedAt,
  };
}
