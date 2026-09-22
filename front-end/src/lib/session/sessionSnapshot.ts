import type { ChannelStatusPayload } from '../../types/ChiaGaming';
import type { SessionPresentationSave } from './saveEnvelope';
import { isCatalogGameType, validateHandProposal } from '../gameRegistry';
import { channelStatusPayloadFromModel } from './normalization';
import { isUncancelledProposal } from './proposalPolicy';
import type { RegisteredGameType, SessionModel } from './types';

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
  for (const proposal of [
    lastHandProposal,
    model.betweenHand.rejectedOnceHandProposal,
    model.betweenHand.pendingRetryHandProposal,
    ...model.betweenHand.pendingProposals.map(({ handProposal }) => handProposal),
  ]) {
    if (proposal !== null && !validateHandProposal(proposal)) {
      throw new Error(`Session invariant broken: invalid ${proposal.gameType} hand proposal`);
    }
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
    gameInstances: Object.fromEntries(persistedGameIds.map((id) => [id, model.game.instances[id]])),
    channelStatus:
      facts.channelStatus === undefined
        ? channelStatusPayloadFromModel(model.channel.status)
        : facts.channelStatus,
    cleanShutdownStarted: model.channel.cleanShutdownStarted,
    betweenHandMode: model.betweenHand.mode,
    betweenHandCompose: {
      selectedGame: model.betweenHand.compose.selectedGame,
      gameTimeout: model.betweenHand.compose.gameTimeout,
    },
    betweenHandLastHandProposal: lastHandProposal,
    betweenHandRejectedOnceHandProposal: model.betweenHand.rejectedOnceHandProposal,
    betweenHandPendingRetryHandProposal: model.betweenHand.pendingRetryHandProposal,
    newHandRequested: model.betweenHand.newHandRequested,
    pendingProposals: model.betweenHand.pendingProposals,
    waitingStateEnteredAt: facts.waitingStateEnteredAt,
    cleanShutdownGraceStartedAt: facts.cleanShutdownGraceStartedAt,
  };
}
