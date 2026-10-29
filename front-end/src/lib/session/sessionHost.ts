import { getGenesisChallenge } from '../../constants/wallet-connect';
import { log } from '../../services/log';
import { PeerConnectionResult } from '../../types/ChiaGaming';
import { coerceToBytes } from '../../util';
import type { SessionWallet } from '../wallet/sessionWallet';
import { channelFundingRuntime } from './channelFundingRuntime';
import {
  recentDiagnosticEntries,
  recentEntries,
  WASM_NOTIFICATION_HISTORY_LIMIT,
} from './historyLimits';
import { type RehydratedDurableApplicationState } from './persistence';
import { SessionController } from './SessionController';
import { clearGameSessionState } from './sessionStateTransitions';
import { storageRepository } from './storageRepository';
import { fetchDeployPreset, WasmStateInit } from './WasmStateInit';

export let sessionController: SessionController | null = null;
let transactionPublishNerfed = false;
const transactionPublishNerfListeners = new Set<(nerfed: boolean) => void>();

function applyTransactionPublishNerfPolicy(nerfed: boolean): void {
  transactionPublishNerfed = nerfed;
  for (const listener of transactionPublishNerfListeners) {
    listener(nerfed);
  }
}

export function isTransactionPublishNerfed(): boolean {
  return transactionPublishNerfed;
}

export function setTransactionPublishNerfed(nerfed: boolean): void {
  if (sessionController) {
    sessionController.setTransactionPublishNerfed(nerfed);
  } else {
    applyTransactionPublishNerfPolicy(nerfed);
  }
}

export function subscribeTransactionPublishNerfed(listener: (nerfed: boolean) => void): () => void {
  transactionPublishNerfListeners.add(listener);
  return () => transactionPublishNerfListeners.delete(listener);
}

function requireBoolean(value: unknown, label: string): boolean {
  if (typeof value === 'boolean') return value;
  throw new Error(`restoreSession: missing or invalid ${label}`);
}

function requireString(value: unknown, label: string): string {
  if (typeof value === 'string') return value;
  throw new Error(`restoreSession: missing or invalid ${label}`);
}

export function destroySessionController(): void {
  if (sessionController) {
    sessionController.cleanup();
    sessionController = null;
  }
}

export function destroyFlushedTerminalSessionController(controller: SessionController): void {
  if (sessionController !== controller) {
    throw new Error('Terminal finalization lost ownership of its SessionController');
  }
  controller.cleanup();
  sessionController = null;
}
export async function configSessionController(
  sc: SessionController,
  iStarted: boolean,
  wasmStateInit: WasmStateInit,
  blockchain: SessionWallet,
  _uniqueId: string,
  channelTimeout?: number,
  unrollTimeout?: number,
  rewardPuzzleHashOverride?: string,
): Promise<SessionController> {
  const wasmConnection = await wasmStateInit.getWasmConnection();
  sc.loadWasm(wasmConnection);
  const peer = sc.getPeerProtocol();
  const result = await peer.open_channel(
    {
      proposer_amount: (iStarted ? sc.myContribution : sc.theirContribution).toString(),
      responder_amount: (iStarted ? sc.theirContribution : sc.myContribution).toString(),
      channel_timeout: channelTimeout?.toString(),
      unroll_timeout: unrollTimeout?.toString(),
    },
    iStarted,
    getGenesisChallenge(),
    async () => rewardPuzzleHashOverride ?? (await blockchain.rpc.getAddress()).puzzleHash,
  );
  if (!result) return sc;
  sc.rewardPuzzleHash = result.rewardPuzzleHash;
  sc.emitRewardAddress();
  sc.setGameSession(peer);
  sc.attachBlockchain(blockchain);
  log('[wasm] activateSpend');
  sc.activateSpend();
  log('[wasm] session controller configured (handshake)');
  return sc;
}

export async function restoreSession(
  sc: SessionController,
  bootstrap: RehydratedDurableApplicationState,
  wasmStateInit: WasmStateInit,
): Promise<void> {
  if (bootstrap.state.session?.phase !== 'live') {
    throw new Error('restoreSession requires a live durable session');
  }
  const save = bootstrap.state;
  const session = bootstrap.state.session;
  const wasmConnection = await wasmStateInit.getWasmConnection();
  sc.loadWasm(wasmConnection);
  const currentSchema = BigInt(wasmConnection.game_session_serialization_schema());
  if (session.live.gameSessionSchemaVersion !== currentSchema) {
    const savedSchema = session.live.gameSessionSchemaVersion.toString();
    throw new Error(
      `Unsupported saved game format: cradle schema ${savedSchema}; current schema is ${currentSchema}`,
    );
  }

  const cradleBytes =
    session.live.serializedGameSession instanceof Uint8Array
      ? session.live.serializedGameSession
      : (() => {
          throw new Error('restoreSession serializedGameSession must be a Uint8Array');
        })();

  if (sc.getGameSessionId() !== session.pairing.gameSessionId) {
    throw new Error('restoreSession: reliable session id does not match persisted pairing');
  }
  sc.restoreTransportCheckpoint(session.live);
  const cradle = wasmStateInit.deserializeGame(cradleBytes, sc.getPeerProtocol());
  sc.iStarted = requireBoolean(session.pairing.iStarted, 'iStarted');
  sc.pairingToken = requireString(session.pairing.token, 'pairingToken');
  if (session.live.disposition !== 'active') {
    throw new Error('restoreSession: live reliable transport is not active');
  }
  sc.wasmNotificationHistory = recentEntries(
    save.history.wasmNotificationHistory ?? [],
    WASM_NOTIFICATION_HISTORY_LIMIT,
  );
  sc.diagnosticLog = recentDiagnosticEntries(save.history.diagnosticLog ?? []);
  sc.restorePresentationTiming({
    waitingStateEnteredAt: session.presentation.waitingStateEnteredAt,
    cleanShutdownGraceStartedAt: session.presentation.cleanShutdownGraceStartedAt,
  });
  sc.restoreChannelStatus(
    session.presentation.channelStatus
      ? {
          ...session.presentation.channelStatus,
          coin: coerceToBytes(session.presentation.channelStatus.coin),
        }
      : null,
  );
  sc.myAlias = session.pairing.myAlias;
  sc.opponentAlias = session.pairing.opponentAlias;
  if (!session.live.rewardPuzzleHash) {
    throw new Error('restoreSession: missing rewardPuzzleHash in persisted session');
  }
  sc.rewardPuzzleHash = session.live.rewardPuzzleHash;
  sc.setGameSession(cradle);

  log('[restore] session restored');
}

export function getOrCreateSessionController(
  blockchain: SessionWallet | null,
  peerConn: PeerConnectionResult,
  uniqueId: string,
  myContribution: bigint,
  theirContribution: bigint,
  iStarted: boolean,
  sessionBootstrap?: RehydratedDurableApplicationState,
  pairingToken?: string,
  perGameAmount?: bigint,
  getFee?: () => bigint,
  channelTimeout?: number,
  unrollTimeout?: number,
): SessionController {
  if (sessionController) {
    return sessionController;
  }

  const wasmStateInit = new WasmStateInit(fetchDeployPreset);

  sessionController = new SessionController(
    blockchain,
    uniqueId,
    myContribution,
    theirContribution,
    peerConn,
    channelFundingRuntime,
    sessionBootstrap?.state.walletContext ?? undefined,
  );
  if (sessionBootstrap?.state.session?.phase === 'live') {
    sessionController.restoreTransportCheckpoint(sessionBootstrap.state.session.live);
  }
  sessionController.iStarted = iStarted;
  sessionController.pairingToken = pairingToken ?? '';
  sessionController.perGameAmount = perGameAmount ?? 0n;
  sessionController.setTransactionPublishNerfPolicy((nerfed, apply) => {
    applyTransactionPublishNerfPolicy(nerfed);
    apply(nerfed);
  });
  sessionController.setTransactionPublishNerfed(transactionPublishNerfed);
  if (getFee) sessionController.getFee = getFee;
  sessionController.setPeerKeepalive(() => peerConn.sendKeepalive());

  sessionController.initializeExecution(
    sessionBootstrap?.state.session?.phase === 'live',
    sessionBootstrap,
  );
  sessionController.kickSystem(2);

  // Only cradle restores go through restoreSession. pairingToken-only saves are
  // a pre-cradle handshake checkpoint (e.g. deploy-stale reload mid-accept).
  if (sessionBootstrap?.state.session?.phase === 'live') {
    const restoringObject = sessionController;
    const doRestore = async () => {
      try {
        await restoreSession(restoringObject, sessionBootstrap, wasmStateInit);
      } catch (e) {
        console.error('[sessionController] restoreSession error:', e);
        log(`[sessionController] restoreSession error: ${String(e)}`);
        if (sessionController === restoringObject) {
          restoringObject.cleanup();
          sessionController = null;
        }
        throw e;
      }
    };
    void restoringObject.beginRestore(doRestore()).catch(() => {});
  } else {
    const owningController = sessionController;
    const newSession = async () => {
      try {
        if (!blockchain) {
          throw new Error('Cannot start a new session without a blockchain connection');
        }
        // Pending handshake fields must already be on disk (Shell). Flush before
        // asset fetch so a stale-deploy reload can Resume into newSession again.
        await storageRepository.checkpointDomainMutations();
        if (sessionController !== owningController) return;
        const snapshot = storageRepository.patchApplicationState(clearGameSessionState);
        await storageRepository.write(snapshot);
        if (sessionController !== owningController) return;
        await configSessionController(
          owningController,
          iStarted,
          wasmStateInit,
          blockchain,
          uniqueId,
          channelTimeout,
          unrollTimeout,
        );
      } catch (e) {
        if (sessionController !== owningController) return;
        const msg =
          e instanceof Error
            ? e.stack || e.message
            : typeof e === 'object' && e !== null && 'data' in e
              ? ((e as any).data?.error ?? String(e))
              : String(e);
        console.error('[sessionController] newSession error:', e);
        log(`[sessionController] newSession error: ${msg}`);
        owningController.receiveEvent({ type: 'error', error: msg });
      }
    };
    newSession();
  }

  return sessionController;
}
