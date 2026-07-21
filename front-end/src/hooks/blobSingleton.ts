import { SessionController } from './SessionController';
import { fetchDeployPreset, WasmStateInit } from './WasmStateInit';
import {
  PeerConnectionResult,
} from '../types/ChiaGaming';
import { BlockchainPoller } from './BlockchainPoller';
import {
  clearSession,
  clearGameSessionPreservingHistory,
  flushSessionSave,
  markSavedSession,
  SessionSave,
} from './save';
import { coerceToBytes } from '../util';
import { log } from '../services/log';
import {
  DIAGNOSTIC_LOG_LIMIT,
  recentEntries,
  WASM_NOTIFICATION_HISTORY_LIMIT,
} from '../lib/session/historyLimits';

export var sessionController: SessionController | null = null;
/** @deprecated alias for sessionController */
export { sessionController as blobSingleton };
export var initStarted = false;

function requireBigIntCounter(value: unknown, label: string): bigint {
    if (typeof value === 'bigint') return value;
    if (typeof value === 'number' && Number.isInteger(value)) return BigInt(value);
    if (typeof value === 'string') {
        try { return BigInt(value); } catch { /* fall through */ }
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
/** @deprecated use destroySessionController */
export { destroySessionController as destroyBlobSingleton };

export async function configSessionController(
  sc: SessionController,
  iStarted: boolean,
  wasmStateInit: WasmStateInit,
  blockchain: BlockchainPoller,
  uniqueId: string,
  channelTimeout?: number,
  unrollTimeout?: number,
): Promise<SessionController> {
  let wasmConnection = await wasmStateInit.getWasmConnection();
  sc.loadWasm(wasmConnection);
  const entropy = new Uint8Array(32);
  crypto.getRandomValues(entropy);
  const seedHex = Array.from(entropy, b => b.toString(16).padStart(2, '0')).join('');
  let rngId = wasmConnection.create_rng(seedHex);
  let address = await blockchain.rpc.getAddress();
  sc.setBlockchainAddress(address);
  const theirContribution = sc.theirContribution;
  let { game: gameSession, puzzleHash } = wasmStateInit.createGame(rngId, wasmConnection, iStarted, sc.myContribution, theirContribution, address.puzzleHash, channelTimeout, unrollTimeout);
  sc.setGameSession(gameSession);
  sc.attachBlockchain(blockchain);
  log('[wasm] activateSpend');
  sc.activateSpend();
  log('[wasm] session controller configured (handshake)');
  return sc;
}

export async function restoreSession(
  sc: SessionController,
  save: SessionSave,
  wasmStateInit: WasmStateInit,
): Promise<void> {
  if (!save.serializedGameSession) {
    throw new Error('restoreSession called without serializedGameSession');
  }
  const wasmConnection = await wasmStateInit.getWasmConnection();
  sc.loadWasm(wasmConnection);
  const currentSchema = BigInt(wasmConnection.game_session_serialization_schema());
  if (save.gameSessionSchemaVersion === undefined || save.gameSessionSchemaVersion !== currentSchema) {
    const savedSchema = save.gameSessionSchemaVersion === undefined
      ? 'missing'
      : save.gameSessionSchemaVersion.toString();
    await clearSession();
    markSavedSession();
    throw new Error(
      `Unsupported saved game format: game session schema ${savedSchema}; current schema is ${currentSchema}`,
    );
  }

  const gameSessionBytes = save.serializedGameSession instanceof Uint8Array
    ? save.serializedGameSession
    : (() => { throw new Error('restoreSession serializedGameSession must be a Uint8Array'); })();
  const gameSession = wasmStateInit.deserializeGame(wasmConnection, gameSessionBytes);

  sc.messageNumber = requireBigIntCounter(save.messageNumber, 'messageNumber');
  sc.remoteNumber = requireBigIntCounter(save.remoteNumber, 'remoteNumber');
  sc.channelReady = requireBoolean(save.channelReady, 'channelReady');
  sc.iStarted = requireBoolean(save.iStarted, 'iStarted');
  sc.pairingToken = requireString(save.pairingToken, 'pairingToken');
  if (!Array.isArray(save.unackedMessages)) {
    throw new Error('restoreSession: missing or invalid unackedMessages');
  }
  sc.unackedMessages = save.unackedMessages.map(m => ({
    msgno: requireBigIntCounter(m.msgno, 'unackedMessages.msgno'),
    msg: m.msg,
  }));
  sc.wasmNotificationHistory = recentEntries(
    save.wasmNotificationHistory ?? [],
    WASM_NOTIFICATION_HISTORY_LIMIT,
  );
  sc.diagnosticLog = recentEntries(save.diagnosticLog ?? [], DIAGNOSTIC_LOG_LIMIT);
  sc.durabilityWarning = save.durabilityWarning;
  if (!Array.isArray(save.activeGameIds)) {
    throw new Error('restoreSession: missing or invalid activeGameIds');
  }
  sc.activeGameIds = [...save.activeGameIds];
  sc.activeGameId = save.activeGameIds[0] ?? save.activeGameId ?? null;
  sc.handState = save.handState ?? null;
  sc.lastChannelStatus = save.channelStatus
    ? { ...save.channelStatus, coin: coerceToBytes(save.channelStatus.coin) }
    : null;
  sc.myAlias = save.myAlias;
  sc.opponentAlias = save.opponentAlias;
  sc.lastOutcomeWin = save.lastOutcomeWin;
  sc.markRestored();
  sc.setGameSession(gameSession);

  log('[restore] session restored');
}

export function getOrCreateSessionController(
  blockchain: BlockchainPoller | null,
  peerConn: PeerConnectionResult,
  registerMessageHandler: (handler: (msgno: number, msg: Uint8Array) => void, ackHandler: (ack: number) => void, keepaliveHandler: () => void) => void,
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
  onTerminal?: () => void,
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
  if (getFee) sessionController.getFee = getFee;
  sessionController.setPeerKeepalive(() => peerConn.sendKeepalive());

  if (onTerminal) {
    const sc = sessionController;
    const sub = sc.getObservable().subscribe({
      next: (evt) => {
        if (evt.type === 'terminal') {
          sub.unsubscribe();
          onTerminal();
        }
      },
    });
  }

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

  // Only gameSession restores go through restoreSession. pairingToken-only saves are
  // a pre-game-session handshake checkpoint (e.g. deploy-stale reload mid-accept).
  if (sessionSave?.serializedGameSession) {
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
        const msg = e instanceof Error ? (e.stack || e.message)
          : typeof e === 'object' && e !== null && 'data' in e ? (e as any).data?.error ?? String(e)
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
export function getBlobSingleton(
  ...args: Parameters<typeof getOrCreateSessionController>
): { gameObject: SessionController } {
  const result = getOrCreateSessionController(...args);
  return { gameObject: result.sessionController };
}
