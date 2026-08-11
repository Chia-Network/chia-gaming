import type { ChannelStatusPayload } from '../../types/ChiaGaming';
import type { SavedHandTerms, SessionPresentationSave } from './saveEnvelope';
import { encodeGameTermsExtras, validateGameTerms } from '../gameRegistry';
import { channelStatusPayloadFromModel } from './normalization';
import type { HandTermsModel, SessionModel } from './types';

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
  const termsSnapshot = (terms: HandTermsModel): SavedHandTerms => {
    if (!validateGameTerms(terms)) {
      throw new Error(`Session invariant broken: invalid ${terms.gameType} terms`);
    }
    const base = {
      my_contribution: terms.myContribution.toString(),
      their_contribution: terms.theirContribution.toString(),
      game_timeout: terms.gameTimeout.toString(),
    };
    if (terms.gameType === 'spacepoker') {
      const extras = encodeGameTermsExtras(terms);
      const unitSize = extras.spacepoker_unit_size;
      if (unitSize === undefined) {
        throw new Error('Session invariant broken: Space Poker terms are missing unit size');
      }
      return { ...base, game_type: terms.gameType, spacepoker_unit_size: unitSize };
    }
    return { ...base, game_type: terms.gameType };
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
  const hasValidLastTerms = validateGameTerms(model.betweenHand.lastTerms);
  if (hasPersistedHand && !hasValidLastTerms) {
    throw new Error(
      `Session invariant broken: persisted hand has invalid ${model.betweenHand.lastTerms.gameType} terms`,
    );
  }
  const proposalMemberIds = new Set<string>();
  let localOutgoingGroups = 0;
  for (const group of model.betweenHand.proposalGroups) {
    if (group.memberIds.length === 0 || group.primaryId !== group.memberIds[0]) {
      throw new Error('Session invariant broken: proposal primary ID must be its first member');
    }
    const expectedMembers = group.terms.gameType === 'krunk' ? 2 : 1;
    if (group.memberIds.length !== expectedMembers) {
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

  return {
    activeGameIds: model.game.activeIds,
    activeGameType: model.game.activeGameType,
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
    betweenHandCompose: {
      selected_game: model.betweenHand.compose.selectedGame,
      game_timeout: model.betweenHand.compose.gameTimeout.toString(),
      proposal_sent: model.betweenHand.compose.proposalSent,
      calpoker: { amount: model.betweenHand.compose.calpoker.amount.toString() },
      krunk: { amount: model.betweenHand.compose.krunk.amount.toString() },
      spacepoker: {
        unit_size: model.betweenHand.compose.spacepoker.unitSize.toString(),
        stack_size: model.betweenHand.compose.spacepoker.stackSize.toString(),
      },
    },
    betweenHandLastTerms: hasValidLastTerms ? termsSnapshot(model.betweenHand.lastTerms) : null,
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
