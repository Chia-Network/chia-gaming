import type { SessionController, RestoreStatus } from '../../hooks/SessionController';
import {
  getBlockchainType,
  saveSession,
  saveTerminalSession,
  type SessionSave,
} from '../../hooks/save';
import { channelStatusModelFromPayload, normalizeSessionPresentation } from './normalization';
import { snapshotFromSessionModel } from './sessionSnapshot';
import type { SessionMachineState } from './sessionMachineTypes';

export interface SessionPersistDependencies {
  controller: SessionController;
  getState(): SessionMachineState;
  restoring: boolean;
  getRestoreStatus(): RestoreStatus;
  getRestoreError(): string | null;
  save?: typeof saveSession;
  saveTerminal?: typeof saveTerminalSession;
}

/** Assemble at effect execution time, after any preceding hand-state commit. */
export function assembleSessionSave(
  dependencies: SessionPersistDependencies,
): { save: Partial<SessionSave>; terminal: boolean } | null {
  const wasm = dependencies.controller.getWasmFields();
  if (!wasm) return null;
  const state = dependencies.getState();
  const authoritativeStatus = wasm.channelStatus
    ? channelStatusModelFromPayload(wasm.channelStatus)
    : state.model.channel.status;
  const restoreStatus = dependencies.getRestoreStatus();
  const model = normalizeSessionPresentation({
    ...state.model,
    restore: {
      restoring: dependencies.restoring,
      status: restoreStatus,
      error: dependencies.getRestoreError(),
      hubReconciled: restoreStatus === 'restored',
    },
    channel: { ...state.model.channel, status: authoritativeStatus },
    game: { ...state.model.game, handState: wasm.handState },
    history: {
      ...state.model.history,
      wasmNotificationHistory: wasm.wasmNotificationHistory,
      diagnosticLog: wasm.diagnosticLog,
    },
    lastOutcomeWin: wasm.lastOutcomeWin,
  });
  const snapshot = snapshotFromSessionModel(model);
  delete snapshot.humanHistory;
  delete snapshot.diagnosticLog;
  return {
    terminal: authoritativeStatus.sessionDisposition === 'Abandoned',
    save: {
      blockchainType: getBlockchainType(),
      serializedGameSession: wasm.serializedGameSession,
      gameSessionSchemaVersion: wasm.gameSessionSchemaVersion,
      pairingToken: wasm.pairingToken,
      messageNumber: wasm.messageNumber,
      remoteNumber: wasm.remoteNumber,
      iStarted: wasm.iStarted,
      myContribution: wasm.myContribution,
      theirContribution: wasm.theirContribution,
      perGameAmount: wasm.perGameAmount,
      rewardPuzzleHash: wasm.rewardPuzzleHash,
      unackedMessages: wasm.unackedMessages,
      activeGameIds: model.game.activeIds,
      moveReplayJournal: wasm.moveReplayJournal,
      iProposedHand: state.coordination.iProposedHand,
      activeGameType: model.game.activeGameType,
      handState: model.game.handState,
      channelStatus: wasm.channelStatus,
      myAlias: wasm.myAlias,
      opponentAlias: wasm.opponentAlias,
      lastOutcomeWin: wasm.lastOutcomeWin,
      durabilityWarning: wasm.durabilityWarning,
      ...snapshot,
    },
  };
}

export async function persistSessionSnapshot(
  dependencies: SessionPersistDependencies,
): Promise<void> {
  const assembled = assembleSessionSave(dependencies);
  if (!assembled) return;
  if (assembled.terminal) {
    await (dependencies.saveTerminal ?? saveTerminalSession)({
      ...assembled.save,
      coinsOfInterest: dependencies.controller.getCoinsOfInterest(),
    });
  } else {
    await (dependencies.save ?? saveSession)(assembled.save);
  }
}
