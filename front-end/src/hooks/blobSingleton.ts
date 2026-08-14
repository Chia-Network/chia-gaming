import { SessionController } from './SessionController';
import { fetchDeployPreset, WasmStateInit } from './WasmStateInit';
import { PeerConnectionResult } from '../types/ChiaGaming';
import { BlockchainPoller } from './BlockchainPoller';
import {
  clearSession,
  clearGameSessionPreservingHistory,
  flushSessionSave,
  markSavedSession,
  LiveSessionSave,
  SessionSave,
} from './save';
import { coerceToBytes } from '../util';
import { getGenesisChallenge } from '../constants/wallet-connect';
import { log } from '../services/log';
import {
  DIAGNOSTIC_LOG_LIMIT,
  recentEntries,
  WASM_NOTIFICATION_HISTORY_LIMIT,
} from '../lib/session/historyLimits';

export let sessionController: SessionController | null = null;
/** @deprecated alias for sessionController */
export { sessionController as blobSingleton };
export let initStarted = false;
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

function requireBigIntCounter(value: unknown, label: string): bigint {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number' && Number.isInteger(value)) return BigInt(value);
  if (typeof value === 'string') {
    try {
      return BigInt(value);
    } catch {
      /* fall through */
    }
  }
  throw new Error(`restoreSession: missing or invalid ${label}`);
}

function requireBoolean(value: unknown, label: string): boolean {
  if (typeof value === 'boolean') return value;
  throw new Error(`restoreSession: missing or invalid ${label}`);
}

function requireString(value: unknown, label: string): string {
  if (typeof value === 'string') return value;
  throw new Error(`restoreSession: missing or invalid ${label}`);
}

export function setInitStarted(value: boolean) {
  initStarted = value;
}

export function destroySessionController(): void {
  if (sessionController) {
    sessionController.cleanup();
    sessionController = null;
  }
  initStarted = false;
}

export function destroyFlushedTerminalSessionController(controller: SessionController): void {
  if (sessionController !== controller) {
    throw new Error('Terminal finalization lost ownership of its SessionController');
  }
  controller.cleanupAfterTerminalFlush();
  sessionController = null;
  initStarted = false;
}
/** @deprecated use destroySessionController */
export { destroySessionController as destroyBlobSingleton };

export async function configSessionController(
  sc: SessionController,
  iStarted: boolean,
  wasmStateInit: WasmStateInit,
  blockchain: BlockchainPoller,
  _uniqueId: string,
  channelTimeout?: number,
  unrollTimeout?: number,
): Promise<SessionController> {
  const wasmConnection = await wasmStateInit.getWasmConnection();
  sc.loadWasm(wasmConnection);
  const entropy = new Uint8Array(32);
  crypto.getRandomValues(entropy);
  const seedHex = Array.from(entropy, (b) => b.toString(16).padStart(2, '0')).join('');
  const rngId = wasmConnection.create_rng(seedHex);
  const address = await blockchain.rpc.getAddress();
  sc.rewardPuzzleHash = address.puzzleHash;
  sc.emitRewardAddress();
  const theirContribution = sc.theirContribution;
  const { game: cradle } = wasmStateInit.createGame(
    rngId,
    wasmConnection,
    iStarted,
    sc.myContribution,
    theirContribution,
    sc.rewardPuzzleHash,
    getGenesisChallenge(),
    channelTimeout,
    unrollTimeout,
  );
  sc.setGameSession(cradle);
  sc.attachBlockchain(blockchain);
  log('[wasm] activateSpend');
  sc.activateSpend();
  log('[wasm] session controller configured (handshake)');
  return sc;
}

export async function restoreSession(
  sc: SessionController,
  save: LiveSessionSave,
  wasmStateInit: WasmStateInit,
): Promise<void> {
  const wasmConnection = await wasmStateInit.getWasmConnection();
  sc.loadWasm(wasmConnection);
  const currentSchema = BigInt(wasmConnection.game_session_serialization_schema());
  if (save.live.gameSessionSchemaVersion !== currentSchema) {
    const savedSchema = save.live.gameSessionSchemaVersion.toString();
    await clearSession();
    markSavedSession();
    throw new Error(
      `Unsupported saved game format: cradle schema ${savedSchema}; current schema is ${currentSchema}`,
    );
  }

  const cradleBytes =
    save.live.serializedGameSession instanceof Uint8Array
      ? save.live.serializedGameSession
      : (() => {
          throw new Error('restoreSession serializedGameSession must be a Uint8Array');
        })();
  const cradle = wasmStateInit.deserializeGame(wasmConnection, cradleBytes);

  sc.messageNumber = requireBigIntCounter(save.live.messageNumber, 'messageNumber');
  sc.remoteNumber = requireBigIntCounter(save.live.remoteNumber, 'remoteNumber');
  sc.iStarted = requireBoolean(save.pairing.iStarted, 'iStarted');
  sc.pairingToken = requireString(save.pairing.token, 'pairingToken');
  if (!Array.isArray(save.live.unackedMessages)) {
    throw new Error('restoreSession: missing or invalid unackedMessages');
  }
  sc.unackedMessages = save.live.unackedMessages.map((m) => ({
    msgno: requireBigIntCounter(m.msgno, 'unackedMessages.msgno'),
    msg: m.msg,
  }));
  sc.wasmNotificationHistory = recentEntries(
    save.history.wasmNotificationHistory ?? [],
    WASM_NOTIFICATION_HISTORY_LIMIT,
  );
  sc.diagnosticLog = recentEntries(save.history.diagnosticLog ?? [], DIAGNOSTIC_LOG_LIMIT);
  sc.durabilityWarning = save.live.durabilityWarning;
  if (!Array.isArray(save.presentation.activeGameIds)) {
    throw new Error('restoreSession: missing or invalid activeGameIds');
  }
  sc.activeGameIds = [...save.presentation.activeGameIds];
  sc.restoreChannelStatus(
    save.presentation.channelStatus
      ? {
          ...save.presentation.channelStatus,
          coin: coerceToBytes(save.presentation.channelStatus.coin),
        }
      : null,
  );
  sc.myAlias = save.pairing.myAlias;
  sc.opponentAlias = save.pairing.opponentAlias;
  sc.lastOutcomeWin = save.presentation.lastOutcomeWin ?? undefined;
  if (!save.live.rewardPuzzleHash) {
    throw new Error('restoreSession: missing rewardPuzzleHash in persisted session');
  }
  sc.rewardPuzzleHash = save.live.rewardPuzzleHash;
  sc.markRestored();
  sc.setGameSession(cradle);

  log('[restore] session restored');
}

export function getOrCreateSessionController(
  blockchain: BlockchainPoller | null,
  peerConn: PeerConnectionResult,
  registerMessageHandler: (
    handler: (msgno: number, msg: Uint8Array) => void,
    ackHandler: (ack: number) => void,
    keepaliveHandler: () => void,
  ) => void,
  uniqueId: string,
  myContribution: bigint,
  theirContribution: bigint,
  iStarted: boolean,
  sessionSave?: SessionSave,
  pairingToken?: string,
  perGameAmount?: bigint,
  getFee?: () => bigint,
  channelTimeout?: number,
  unrollTimeout?: number,
): { sessionController: SessionController } {
  if (sessionController) {
    return { sessionController };
  }

  const wasmStateInit = new WasmStateInit(fetchDeployPreset);

  sessionController = new SessionController(
    blockchain,
    uniqueId,
    myContribution,
    theirContribution,
    peerConn,
  );
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

  registerMessageHandler(
    (msgno: number, msg: Uint8Array) => {
      sessionController?.deliverMessage(BigInt(msgno), msg);
    },
    (ack: number) => {
      sessionController?.receiveAck(BigInt(ack));
    },
    () => {
      sessionController?.receiveKeepalive();
    },
  );

  sessionController.kickSystem(2);

  // Only cradle restores go through restoreSession. pairingToken-only saves are
  // a pre-cradle handshake checkpoint (e.g. deploy-stale reload mid-accept).
  if (sessionSave?.phase === 'live') {
    const restoringObject = sessionController;
    const doRestore = async () => {
      try {
        await restoreSession(restoringObject, sessionSave, wasmStateInit);
      } catch (e) {
        console.error('[sessionController] restoreSession error:', e);
        log(`[sessionController] restoreSession error: ${String(e)}`);
        if (sessionController === restoringObject) {
          restoringObject.cleanup();
          sessionController = null;
          initStarted = false;
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
        await flushSessionSave();
        if (sessionController !== owningController) return;
        await clearGameSessionPreservingHistory();
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
        owningController.rxjsEmitter?.next({ type: 'error', error: msg });
      }
    };
    newSession();
  }

  return { sessionController };
}

/** @deprecated use getOrCreateSessionController */
export function getBlobSingleton(...args: Parameters<typeof getOrCreateSessionController>): {
  gameObject: SessionController;
} {
  const result = getOrCreateSessionController(...args);
  return { gameObject: result.sessionController };
}
