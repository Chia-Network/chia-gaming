import { SessionController } from './SessionController';
import { WasmStateInit, loadGameHexes, GameHexes } from './WasmStateInit';
import {
  PeerConnectionResult,
} from '../types/ChiaGaming';
import { BlockchainPoller } from './BlockchainPoller';
import {
  startNewSession,
  SessionState,
  base64ToUint8,
} from './save';
import { coerceToBytes } from '../util';
import { log } from '../services/log';

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

async function fetchHex(fetchUrl: string): Promise<string> {
    const resp = await fetch(fetchUrl);
    if (!resp.ok) {
        throw new Error(`fetchHex ${fetchUrl}: HTTP ${resp.status} ${resp.statusText}`);
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

  const cradleBytes = base64ToUint8(save.serializedCradle);
  const cradle = wasmStateInit.deserializeGame(wasmConnection, cradleBytes);

  sc.messageNumber = parseBigIntCounter(save.messageNumber, 1n);
  sc.remoteNumber = parseBigIntCounter(save.remoteNumber, 0n);
  sc.channelReady = save.channelReady ?? false;
  sc.iStarted = save.iStarted ?? false;
  sc.pairingToken = save.pairingToken ?? '';
  sc.unackedMessages = (save.unackedMessages ?? []).map(m => ({
    msgno: parseBigIntCounter(m.msgno, 0n),
    msg: base64ToUint8(m.msg),
  }));
  sc.history = [...(save.history ?? [])];
  sc.logHistory = [...(save.log ?? [])];
  sc.activeGameId = save.activeGameId ?? null;
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

  const wasmStateInit = new WasmStateInit(fetchHex);

  sessionController = new SessionController(
    blockchain,
    uniqueId,
    peerConn,
  );
  sessionController.myContribution = myContribution;
  sessionController.theirContribution = theirContribution;
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

  if (sessionSave) {
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
    const newSession = async () => {
      try {
        if (!blockchain) {
          throw new Error('Cannot start a new session without a blockchain connection');
        }
        startNewSession();
        const gameHexes = await loadGameHexes(fetchHex);
        await configSessionController(
          sessionController!,
          iStarted,
          wasmStateInit,
          gameHexes,
          blockchain,
          uniqueId,
          channelTimeout,
          unrollTimeout,
        );
      } catch (e) {
        const msg = e instanceof Error ? (e.stack || e.message)
          : typeof e === 'object' && e !== null && 'data' in e ? (e as any).data?.error ?? String(e)
          : String(e);
        console.error('[sessionController] newSession error:', e);
        log(`[sessionController] newSession error: ${msg}`);
        sessionController!.rxjsEmitter?.next({ type: 'error', error: msg });
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
