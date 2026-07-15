import { SessionController } from './SessionController';
import { WasmStateInit, loadGameHexes, GameHexes } from './WasmStateInit';
import {
  PeerConnectionResult,
} from '../types/ChiaGaming';
import { BlockchainPoller } from './BlockchainPoller';
import {
  clearSession,
  clearGameSessionPreservingHistory,
  flushSessionState,
  markSavedSession,
  startNewSession,
  SessionState,
} from './save';
import { coerceToBytes } from '../util';
import { log } from '../services/log';
import {
  DIAGNOSTIC_LOG_LIMIT,
  recentEntries,
  WASM_NOTIFICATION_HISTORY_LIMIT,
} from '../lib/session/historyLimits';
import { recoverFromMissingDeployAsset, resolveDeployAssetUrl } from '../lib/deployFreshness';

export var sessionController: SessionController | null = null;
/** @deprecated alias for sessionController */
export { sessionController as blobSingleton };
export var initStarted = false;

function parseBigIntCounter(value: unknown, fallback: bigint): bigint {
    if (typeof value === 'bigint') return value;
    if (typeof value === 'number' && Number.isInteger(value)) return BigInt(value);
    if (typeof value === 'string') {
        try { return BigInt(value); } catch { /* fall through */ }
    }
    return fallback;
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

async function fetchPreset(fetchUrl: string): Promise<Uint8Array> {
    const url = resolveDeployAssetUrl(fetchUrl);
    const resp = await fetch(url);
    if (!resp.ok) {
        await recoverFromMissingDeployAsset(
            'fetchPreset',
            url,
            resp.status,
            resp.statusText,
        );
    }
    return new Uint8Array(await resp.arrayBuffer());
}

async function fetchHexString(fetchUrl: string): Promise<string> {
    const url = resolveDeployAssetUrl(fetchUrl);
    const resp = await fetch(url);
    if (!resp.ok) {
        await recoverFromMissingDeployAsset(
            'fetchHexString',
            url,
            resp.status,
            resp.statusText,
        );
    }
    return resp.text();
}

export async function configSessionController(
  sc: SessionController,
  iStarted: boolean,
  wasmStateInit: WasmStateInit,
  gameHexes: GameHexes,
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
  let { game: cradle, puzzleHash } = wasmStateInit.createGame(gameHexes, rngId, wasmConnection, iStarted, sc.myContribution, theirContribution, address.puzzleHash, channelTimeout, unrollTimeout);
  sc.setGameCradle(cradle);
  sc.attachBlockchain(blockchain);
  log('[wasm] activateSpend');
  sc.activateSpend();
  log('[wasm] session controller configured (handshake)');
  return sc;
}

export async function restoreSession(
  sc: SessionController,
  save: SessionState,
  wasmStateInit: WasmStateInit,
): Promise<void> {
  if (!save.serializedCradle) {
    throw new Error('restoreSession called without serializedCradle');
  }
  const wasmConnection = await wasmStateInit.getWasmConnection();
  sc.loadWasm(wasmConnection);
  const currentSchema = BigInt(wasmConnection.cradle_serialization_schema());
  if (save.cradleSchemaVersion === undefined || save.cradleSchemaVersion !== currentSchema) {
    const savedSchema = save.cradleSchemaVersion === undefined
      ? 'missing'
      : save.cradleSchemaVersion.toString();
    await clearSession();
    markSavedSession();
    throw new Error(
      `Unsupported saved game format: cradle schema ${savedSchema}; current schema is ${currentSchema}`,
    );
  }

  const cradleBytes = save.serializedCradle instanceof Uint8Array
    ? save.serializedCradle
    : (() => { throw new Error('restoreSession serializedCradle must be a Uint8Array'); })();
  const cradle = wasmStateInit.deserializeGame(wasmConnection, cradleBytes);

  sc.messageNumber = parseBigIntCounter(save.messageNumber, 1n);
  sc.remoteNumber = parseBigIntCounter(save.remoteNumber, 0n);
  sc.channelReady = save.channelReady ?? false;
  sc.iStarted = save.iStarted ?? false;
  sc.pairingToken = save.pairingToken ?? '';
  sc.unackedMessages = (save.unackedMessages ?? []).map(m => ({
    msgno: parseBigIntCounter(m.msgno, 0n),
    msg: m.msg,
  }));
  sc.wasmNotificationHistory = recentEntries(
    save.wasmNotificationHistory ?? [],
    WASM_NOTIFICATION_HISTORY_LIMIT,
  );
  sc.diagnosticLog = recentEntries(save.diagnosticLog ?? [], DIAGNOSTIC_LOG_LIMIT);
  sc.durabilityWarning = save.durabilityWarning;
  sc.activeGameId = save.activeGameId ?? null;
  sc.activeGameIds = save.activeGameIds && save.activeGameIds.length > 0
    ? [...save.activeGameIds]
    : save.activeGameId ? [save.activeGameId] : [];
  sc.handState = save.handState ?? null;
  sc.lastChannelStatus = save.channelStatus
    ? { ...save.channelStatus, coin: coerceToBytes(save.channelStatus.coin) }
    : null;
  sc.myAlias = save.myAlias;
  sc.opponentAlias = save.opponentAlias;
  sc.lastOutcomeWin = save.lastOutcomeWin;
  sc.markRestored();
  sc.setGameCradle(cradle);

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
  sessionSave?: SessionState,
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

  const wasmStateInit = new WasmStateInit(fetchPreset);

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

  // Only cradle restores go through restoreSession. pairingToken-only saves are
  // a pre-cradle handshake checkpoint (e.g. deploy-stale reload mid-accept).
  if (sessionSave?.serializedCradle) {
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
        await flushSessionState();
        if (sessionController !== owningController) return;
        const gameHexes = await loadGameHexes(fetchHexString);
        if (sessionController !== owningController) return;
        await clearGameSessionPreservingHistory();
        if (sessionController !== owningController) return;
        startNewSession();
        await configSessionController(
          owningController,
          iStarted,
          wasmStateInit,
          gameHexes,
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
