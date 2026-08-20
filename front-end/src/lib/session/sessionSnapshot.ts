import type { ChannelStatusPayload } from '../../types/ChiaGaming';
import type { SavedHandTerms, SessionPresentationSave } from './saveEnvelope';
import { encodeComposeDraftState } from './persistenceBetweenHands';
import {
  encodeGameTermsExtras,
  isCatalogGameType,
  packageFor,
  validateGameTerms,
} from '../gameRegistry';
import { channelStatusPayloadFromModel } from './normalization';
import type { HandTermsModel, RegisteredGameType, SessionModel } from './types';

export interface SessionPresentationFacts {
  channelStatus?: ChannelStatusPayload | null;
  lastOutcomeWin?: 'win' | 'lose' | 'tie' | null;
  waitingStateEnteredAt?: bigint | null;
  cleanShutdownGraceStartedAt?: bigint | null;
}

export function snapshotFromSessionModel(
  model: SessionModel,
  facts: SessionPresentationFacts = {},
): SessionPresentationSave {
  const requireCatalogGameType = (gameType: string, label: string): RegisteredGameType => {
    if (!isCatalogGameType(gameType)) {
      throw new Error(`Session invariant broken: ${label} ${gameType} is not a catalog gameType`);
    }
    return gameType;
  };

  const termsSnapshot = (terms: HandTermsModel): SavedHandTerms => {
    if (!validateGameTerms(terms)) {
      throw new Error(`Session invariant broken: invalid ${terms.gameType} terms`);
    }
    return {
      my_contribution: terms.myContribution.toString(),
      their_contribution: terms.theirContribution.toString(),
      game_timeout: terms.gameTimeout.toString(),
      game_type: requireCatalogGameType(terms.gameType, 'terms.gameType'),
      ...encodeGameTermsExtras(terms),
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
  const lastTerms = model.betweenHand.lastTerms;
  if (hasPersistedHand && lastTerms === null) {
    throw new Error('Session invariant broken: persisted hand is missing betweenHandLastTerms');
  }
  const proposalMemberIds = new Set<string>();
  let localOutgoingGroups = 0;
  for (const group of model.betweenHand.proposalGroups) {
    if (group.memberIds.length === 0 || group.primaryId !== group.memberIds[0]) {
      throw new Error('Session invariant broken: proposal primary ID must be its first member');
    }
    if (!packageFor(group.terms.gameType).validateHandMembership(group.memberIds, null)) {
      throw new Error(
        `Session invariant broken: ${group.terms.gameType} proposal has ${group.memberIds.length} members`,
      );
    }
    if (
      (group.disposition === 'incoming-cached' || group.disposition === 'incoming-review') &&
      group.origin !== 'peer'
    ) {
      throw new Error('Session invariant broken: incoming proposal is not peer-originated');
    }
    if (group.disposition === 'outgoing') {
      if (group.origin !== 'local') {
        throw new Error('Session invariant broken: outgoing proposal is not local');
      }
      localOutgoingGroups += 1;
    }
    for (const id of group.memberIds) {
      if (proposalMemberIds.has(id)) {
        throw new Error(`Session invariant broken: proposal member ${id} belongs to two groups`);
      }
      proposalMemberIds.add(id);
    }
  }
  if (localOutgoingGroups > 1) {
    throw new Error('Session invariant broken: multiple local outgoing proposal groups');
  }

  if (model.game.handState !== null) {
    requireCatalogGameType(model.game.handState.gameType, 'handState.gameType');
  }

  return {
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
    lastOutcomeWin:
      facts.lastOutcomeWin === undefined ? (model.lastOutcomeWin ?? null) : facts.lastOutcomeWin,
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
    betweenHandLastTerms: lastTerms === null ? null : termsSnapshot(lastTerms),
    betweenHandRejectedOnceTerms: model.betweenHand.rejectedOnceTerms
      ? termsSnapshot(model.betweenHand.rejectedOnceTerms)
      : null,
    betweenHandPendingRetryTerms: model.betweenHand.pendingRetryTerms
      ? termsSnapshot(model.betweenHand.pendingRetryTerms)
      : null,
    proposalGroups: model.betweenHand.proposalGroups.map((group) => ({
      primary_id: group.primaryId,
      member_ids: [...group.memberIds],
      origin: group.origin,
      disposition: group.disposition,
      terms: termsSnapshot(group.terms),
    })),
    waitingStateEnteredAt: facts.waitingStateEnteredAt ?? null,
    cleanShutdownGraceStartedAt: facts.cleanShutdownGraceStartedAt ?? null,
  };
}
