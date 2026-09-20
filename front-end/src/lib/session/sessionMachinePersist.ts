import type { SessionController, RestoreStatus } from '../../hooks/SessionController';
import { loadState, saveSession, type SessionCacheUpdate } from '../../hooks/save';
import { channelStatusModelFromPayload, normalizeSessionPresentation } from './normalization';
import { recentDiagnosticEntries } from './historyLimits';
import { snapshotFromSessionModel } from './sessionSnapshot';
import type { SessionMachineState } from './sessionMachineTypes';

export interface SessionPersistDependencies {
  controller: SessionController;
  getState(): SessionMachineState;
  restoring: boolean;
  getRestoreStatus(): RestoreStatus;
  getRestoreError(): string | null;
  save?: typeof saveSession;
  clearDurabilityWarning?: boolean;
}

export interface PreparedSessionPersistence {
  write(): Promise<void>;
}

/** Assemble at effect execution time from WASM facts and machine authority. */
export function assembleSessionSave(dependencies: SessionPersistDependencies): {
  live: Extract<SessionCacheUpdate, { scope: 'live' }>;
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
    },
    channel: { ...state.model.channel, status: authoritativeStatus },
    history: {
      ...state.model.history,
      wasmNotificationHistory: wasm.wasmNotificationHistory,
      diagnosticLog: recentDiagnosticEntries(wasm.diagnosticLog),
    },
  });
  const current = loadState();
  const currentPairing =
    current.phase === 'pre-handshake' || current.phase === 'live' ? current.pairing : undefined;
  if (wasm.rewardPuzzleHash === null) {
    throw new Error('Cannot persist an initialized session without a reward puzzle hash');
  }
  const presentation = snapshotFromSessionModel(model, {
    channelStatus: wasm.channelStatus ?? null,
    waitingStateEnteredAt: wasm.waitingStateEnteredAt,
    cleanShutdownGraceStartedAt: wasm.cleanShutdownGraceStartedAt,
  });
  return {
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
        terminalHandoff: wasm.terminalHandoff,
        disposition: wasm.transportDisposition,
        durabilityWarning: dependencies.clearDurabilityWarning ? undefined : wasm.durabilityWarning,
        fundingOutbox: wasm.fundingOutbox,
      },
      presentation,
      history: {
        wasmNotificationHistory: wasm.wasmNotificationHistory,
        diagnosticLog: recentDiagnosticEntries(wasm.diagnosticLog),
      },
    },
  };
}

/**
 * Capture every active-session persistence input before returning. The write
 * may yield, but it never reads mutable machine, WASM, transport, or save
 * assembly state again.
 */
export function prepareSessionPersistence(
  dependencies: SessionPersistDependencies,
): PreparedSessionPersistence | null {
  const assembled = assembleSessionSave(dependencies);
  if (!assembled) return null;
  const live = structuredClone(assembled.live);
  const save = dependencies.save ?? saveSession;
  return {
    write: () => save(live),
  };
}

export async function persistSessionSnapshot(
  dependencies: SessionPersistDependencies,
): Promise<void> {
  await prepareSessionPersistence(dependencies)?.write();
}
