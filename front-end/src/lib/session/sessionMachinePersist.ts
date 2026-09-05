import type { SessionController, RestoreStatus } from '../../hooks/SessionController';
import {
  loadState,
  saveSession,
  saveTerminalSession,
  type SessionCacheUpdate,
  type SessionPresentationSave,
} from '../../hooks/save';
import { channelStatusModelFromPayload, normalizeSessionPresentation } from './normalization';
import { isTerminalChannelSnapshot } from './selectors';
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

/** Assemble at effect execution time from WASM facts and machine authority. */
export function assembleSessionSave(dependencies: SessionPersistDependencies): {
  live: Extract<SessionCacheUpdate, { scope: 'live' }>;
  terminal: boolean;
  presentation: SessionPresentationSave;
  terminalIStarted: boolean;
  myAlias?: string;
  opponentAlias?: string;
} | null {
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
    history: {
      ...state.model.history,
      wasmNotificationHistory: wasm.wasmNotificationHistory,
      diagnosticLog: wasm.diagnosticLog,
    },
  });
  const current = loadState();
  const currentPairing =
    current.phase === 'pre-handshake' || current.phase === 'live' ? current.pairing : undefined;
  const currentPresentation = current.phase === 'live' ? current.presentation : null;
  if (wasm.rewardPuzzleHash === null) {
    throw new Error('Cannot persist an initialized session without a reward puzzle hash');
  }
  const presentation = snapshotFromSessionModel(model, {
    channelStatus: wasm.channelStatus ?? null,
    waitingStateEnteredAt: currentPresentation?.waitingStateEnteredAt ?? null,
    cleanShutdownGraceStartedAt: currentPresentation?.cleanShutdownGraceStartedAt ?? null,
  });
  return {
    terminal: isTerminalChannelSnapshot(authoritativeStatus),
    presentation,
    terminalIStarted: wasm.iStarted,
    myAlias: wasm.myAlias,
    opponentAlias: wasm.opponentAlias,
    live: {
      scope: 'live',
      pairing: {
        token: wasm.pairingToken,
        peerId: currentPairing?.peerId,
        gameSessionId: wasm.gameSessionId,
        iStarted: wasm.iStarted,
        myContribution: wasm.myContribution,
        theirContribution: wasm.theirContribution,
        perGameAmount: wasm.perGameAmount,
        channelTimeout: currentPairing?.channelTimeout,
        unrollTimeout: currentPairing?.unrollTimeout,
        myAlias: wasm.myAlias,
        opponentAlias: wasm.opponentAlias,
      },
      live: {
        serializedGameSession: wasm.serializedGameSession,
        gameSessionSchemaVersion: wasm.gameSessionSchemaVersion,
        messageNumber: wasm.messageNumber,
        remoteNumber: wasm.remoteNumber,
        rewardPuzzleHash: wasm.rewardPuzzleHash,
        unackedMessages: wasm.unackedMessages,
        disposition: wasm.transportDisposition,
        durabilityWarning: wasm.durabilityWarning,
      },
      presentation,
      history: {
        wasmNotificationHistory: wasm.wasmNotificationHistory,
        diagnosticLog: wasm.diagnosticLog,
      },
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
      terminal: {
        iStarted: assembled.terminalIStarted,
        coinsOfInterest: dependencies.controller.getCoinsOfInterest(),
        myAlias: assembled.myAlias ?? null,
        opponentAlias: assembled.opponentAlias ?? null,
      },
      presentation: assembled.live.presentation,
    });
  } else {
    await (dependencies.save ?? saveSession)(assembled.live);
  }
}
