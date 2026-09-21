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
  getState(): SessionMachineState;
  restoring: boolean;
  getRestoreStatus(): RestoreStatus;
  getRestoreError(): string | null;
}

export interface PreparedDurableApplicationStateCapture {
  write(): Promise<void>;
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

function liveTransform(
  dependencies: SessionPersistDependencies,
): ((state: DurableApplicationState) => DurableApplicationState) | null {
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
  if (wasm.rewardPuzzleHash === null) {
    throw new Error('Cannot persist an initialized session without a reward puzzle hash');
  }
  const rewardPuzzleHash = wasm.rewardPuzzleHash;
  const presentation = snapshotFromSessionModel(model, {
    channelStatus: wasm.channelStatus ? channelStatusPayloadFromModel(authoritativeStatus) : null,
    waitingStateEnteredAt: wasm.waitingStateEnteredAt,
    cleanShutdownGraceStartedAt: wasm.cleanShutdownGraceStartedAt,
  });
  const walletProviderScope = dependencies.controller.getWalletProviderScope();
  return (root) => {
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
  };
}

function terminalTransform(capture: TerminalCapture) {
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
  return (root: DurableApplicationState): DurableApplicationState => ({
    ...root,
    walletContext: structuredClone(walletProviderScope),
    session: {
      phase: 'terminal',
      terminal,
      presentation,
    },
  });
}

/**
 * Commit one complete fixed-point boundary before I/O. Reducer/controller work,
 * generated effects, adapter flights, and projection-only warnings stay transient.
 */
export function captureDurableApplicationState(
  capture:
    | ({ kind: 'live' } & SessionPersistDependencies)
    | TerminalCapture
    | {
        kind: 'transform';
        transform(state: DurableApplicationState): DurableApplicationState;
      },
): PreparedDurableApplicationStateCapture | null {
  const transform =
    capture.kind === 'live'
      ? liveTransform(capture)
      : capture.kind === 'terminal'
        ? terminalTransform(capture)
        : capture.transform;
  if (!transform) return null;

  return storageRepository.prepareApplicationStateCapture(transform);
}
