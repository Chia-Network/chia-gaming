import type { SessionController, RestoreStatus } from '../../hooks/SessionController';
import type { CoinOfInterestEntry } from '../../types/ChiaGaming';
import { type DurableApplicationState, type TerminalSessionSave } from './saveEnvelope';
import { storageRepository } from './storageRepository';
import {
  channelStatusModelFromPayload,
  channelStatusPayloadFromModel,
  normalizeSessionPresentation,
} from './normalization';
import { recentDiagnosticEntries } from './historyLimits';
import { snapshotFromSessionModel } from './sessionSnapshot';
import type { SessionMachineState } from './sessionMachineTypes';
import type { SessionModel } from './types';

export interface SessionPersistDependencies {
  controller: SessionController;
  state: SessionMachineState;
  restoring: boolean;
  getRestoreStatus(): RestoreStatus;
  getRestoreError(): string | null;
}

export interface TerminalCapture {
  kind: 'terminal';
  controller: SessionController;
  model: SessionModel;
  identity: {
    iStarted: boolean;
    myAlias: string | null;
    opponentAlias: string | null;
  };
  coinsOfInterest: CoinOfInterestEntry[];
}

/**
 * Freeze one complete fixed-point boundary synchronously. Reducer/controller
 * work and generated durable obligations must drain before this call.
 */
export function buildDurableApplicationState(
  capture: ({ kind: 'live' } & SessionPersistDependencies) | TerminalCapture,
): DurableApplicationState | null {
  if (capture.kind === 'terminal') {
    const walletProviderScope = capture.controller.getWalletProviderScope();
    const terminal: TerminalSessionSave['terminal'] = {
      iStarted: capture.identity.iStarted,
      coinsOfInterest: structuredClone(capture.coinsOfInterest),
      myAlias: capture.identity.myAlias,
      opponentAlias: capture.identity.opponentAlias,
    };
    const presentation = snapshotFromSessionModel(capture.model, {
      channelStatus: channelStatusPayloadFromModel(capture.model.channel.status),
      waitingStateEnteredAt: null,
      cleanShutdownGraceStartedAt: null,
    });
    return storageRepository.patchApplicationState((root) => ({
      ...root,
      walletContext: structuredClone(walletProviderScope),
      session: {
        phase: 'terminal',
        terminal,
        presentation,
      },
    }));
  }

  const wasm = capture.controller.getWasmFields();
  if (!wasm) return null;
  const state = capture.state;
  const authoritativeStatus = wasm.channelStatus
    ? channelStatusModelFromPayload(wasm.channelStatus)
    : state.model.channel.status;
  const restoreStatus = capture.getRestoreStatus();
  const model = normalizeSessionPresentation({
    ...state.model,
    restore: {
      restoring: capture.restoring,
      status: restoreStatus,
      error: capture.getRestoreError(),
    },
    channel: { ...state.model.channel, status: authoritativeStatus },
    history: {
      ...state.model.history,
      wasmNotificationHistory: wasm.wasmNotificationHistory,
      diagnosticLog: recentDiagnosticEntries(wasm.diagnosticLog),
    },
  });
  if (wasm.rewardPuzzleHash === null) {
    throw new Error('Cannot persist an initialized session without a reward puzzle hash');
  }
  const rewardPuzzleHash = wasm.rewardPuzzleHash;
  const presentation = snapshotFromSessionModel(model, {
    channelStatus: wasm.channelStatus ? channelStatusPayloadFromModel(authoritativeStatus) : null,
    waitingStateEnteredAt: wasm.waitingStateEnteredAt,
    cleanShutdownGraceStartedAt: wasm.cleanShutdownGraceStartedAt,
  });
  const walletProviderScope = capture.controller.getWalletProviderScope();
  return storageRepository.patchApplicationState((root) => {
    const currentPairing =
      root.session?.phase === 'pre-handshake' || root.session?.phase === 'live'
        ? root.session.pairing
        : undefined;
    return {
      ...root,
      walletContext: structuredClone(walletProviderScope),
      session: {
        phase: 'live',
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
          rewardPuzzleHash,
          unackedMessages: wasm.unackedMessages,
          terminalHandoff: wasm.terminalHandoff,
          disposition: wasm.transportDisposition,
        },
        presentation,
      },
      history: {
        ...root.history,
        wasmNotificationHistory: wasm.wasmNotificationHistory,
        diagnosticLog: recentDiagnosticEntries(wasm.diagnosticLog),
      },
    };
  });
}
