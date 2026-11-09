import type { CoinOfInterestEntry, WalletProviderScope } from '../../types/ChiaGaming';
import { recentDiagnosticEntries } from './historyLimits';
import {
  channelStatusModelFromPayload,
  channelStatusPayloadFromModel,
  normalizeSessionPresentation,
} from './normalization';
import { type DurableApplicationState, type TerminalSessionSave } from './saveEnvelope';
import type { RestoreStatus, WasmFields } from './SessionController';
import { snapshotFromSessionModel } from './sessionSnapshot';
import type { SessionModel } from './types';

export interface SessionPersistDependencies {
  wasm: WasmFields | null;
  model: SessionModel;
  walletProviderScope: WalletProviderScope;
  restoring: boolean;
  restoreStatus: RestoreStatus;
  restoreError: string | null;
}

export interface TerminalCapture {
  kind: 'terminal';
  walletProviderScope: WalletProviderScope;
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
  root: DurableApplicationState,
  capture: ({ kind: 'live' } & SessionPersistDependencies) | TerminalCapture,
): DurableApplicationState | null {
  if (capture.kind === 'terminal') {
    const walletProviderScope = capture.walletProviderScope;
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
    return {
      ...root,
      walletContext: structuredClone(walletProviderScope),
      session: {
        phase: 'terminal',
        terminal,
        presentation,
      },
    };
  }

  const wasm = capture.wasm;
  if (!wasm) return null;
  const authoritativeStatus = wasm.channelStatus
    ? channelStatusModelFromPayload(wasm.channelStatus)
    : capture.model.channel.status;
  const restoreStatus = capture.restoreStatus;
  const model = normalizeSessionPresentation({
    ...capture.model,
    restore: {
      restoring: capture.restoring,
      status: restoreStatus,
      error: capture.restoreError,
    },
    channel: { ...capture.model.channel, status: authoritativeStatus },
    history: {
      ...capture.model.history,
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
  const walletProviderScope = capture.walletProviderScope;
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
}
