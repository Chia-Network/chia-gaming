import type { SessionSave } from '../../hooks/save';
import { encodeGameTermsExtras } from '../gameRegistry';
import {
  DIAGNOSTIC_LOG_LIMIT,
  HUMAN_HISTORY_LIMIT,
  recentEntries,
  WASM_NOTIFICATION_HISTORY_LIMIT,
} from './historyLimits';
import type { HandTermsModel, SessionModel } from './types';

export function snapshotFromSessionModel(model: SessionModel): Partial<SessionSave> {
  const termsSnapshot = (terms: HandTermsModel) => ({
    my_contribution: terms.myContribution.toString(),
    their_contribution: terms.theirContribution.toString(),
    game_timeout: terms.gameTimeout.toString(),
    game_type: terms.gameType,
    ...encodeGameTermsExtras(terms),
  });

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

  return {
    humanHistory:
      model.history.humanHistory.length > 0
        ? recentEntries(model.history.humanHistory, HUMAN_HISTORY_LIMIT)
        : undefined,
    wasmNotificationHistory:
      model.history.wasmNotificationHistory.length > 0
        ? recentEntries(model.history.wasmNotificationHistory, WASM_NOTIFICATION_HISTORY_LIMIT)
        : undefined,
    diagnosticLog:
      model.history.diagnosticLog.length > 0
        ? recentEntries(model.history.diagnosticLog, DIAGNOSTIC_LOG_LIMIT)
        : undefined,
    activeGameIds: model.game.activeIds,
    activeGameType: model.game.activeGameType,
    handState: model.game.handState,
    currentHandGameIds:
      model.game.currentHandIds.length > 0 ? model.game.currentHandIds : undefined,
    lastDisplayedGameId: model.game.lastDisplayedId ?? undefined,
    gameInstances:
      persistedGameIds.length > 0
        ? Object.fromEntries(
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
          )
        : undefined,
    myRunningBalance: model.myRunningBalance !== 0n ? model.myRunningBalance.toString() : undefined,
    channelNotifQueue:
      model.channel.queue.length > 0
        ? model.channel.queue.map(({ id, kind, title, message }) => ({ id, kind, title, message }))
        : undefined,
    gameNotifQueue:
      model.game.queue.length > 0
        ? model.game.queue.map(({ id, kind, title, message }) => ({ id, kind, title, message }))
        : undefined,
    dismissedChannelStatus: model.channel.dismissedChannelStatus ?? undefined,
    cleanShutdownStarted: model.channel.cleanShutdownStarted || undefined,
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
    betweenHandLastTerms: termsSnapshot(model.betweenHand.lastTerms),
    betweenHandRejectedOnceTerms: model.betweenHand.rejectedOnceTerms
      ? termsSnapshot(model.betweenHand.rejectedOnceTerms)
      : undefined,
    betweenHandPendingRetryTerms: model.betweenHand.pendingRetryTerms
      ? termsSnapshot(model.betweenHand.pendingRetryTerms)
      : undefined,
    betweenHandCachedPeerProposal: model.betweenHand.cachedPeerProposal
      ? {
          id: model.betweenHand.cachedPeerProposal.id,
          groupIds: model.betweenHand.cachedPeerProposal.groupIds,
          ...termsSnapshot(model.betweenHand.cachedPeerProposal.terms),
        }
      : undefined,
    betweenHandReviewPeerProposal: model.betweenHand.reviewPeerProposal
      ? {
          id: model.betweenHand.reviewPeerProposal.id,
          groupIds: model.betweenHand.reviewPeerProposal.groupIds,
          ...termsSnapshot(model.betweenHand.reviewPeerProposal.terms),
        }
      : undefined,
    outgoingProposalGroupIds:
      model.betweenHand.outgoingProposalGroupIds.length > 0
        ? model.betweenHand.outgoingProposalGroupIds.map((groupIds) => [...groupIds])
        : undefined,
    acceptedProposalGroupIds:
      model.betweenHand.acceptedProposalGroupIds.length > 0
        ? model.betweenHand.acceptedProposalGroupIds.map((groupIds) => [...groupIds])
        : undefined,
    outgoingProposalTerms:
      Object.keys(model.betweenHand.outgoingProposalTerms).length > 0
        ? Object.fromEntries(
            Object.entries(model.betweenHand.outgoingProposalTerms).map(([id, terms]) => [
              id,
              termsSnapshot(terms),
            ]),
          )
        : undefined,
  };
}
