import { WasmBlobWrapper } from './WasmBlobWrapper';
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
import { log } from '../services/log';

export var blobSingleton: WasmBlobWrapper | null = null;
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

export function destroyBlobSingleton(): void {
    if (blobSingleton) {
        blobSingleton.cleanup();
        blobSingleton = null;
    }
    initStarted = false;
}

async function fetchHex(fetchUrl: string): Promise<string> {
    const resp = await fetch(fetchUrl);
    if (!resp.ok) {
        throw new Error(`fetchHex ${fetchUrl}: HTTP ${resp.status} ${resp.statusText}`);
    }
    return resp.text();
}

export async function configGameObject(
  gameObject: WasmBlobWrapper,
  iStarted: boolean,
  wasmStateInit: WasmStateInit,
  gameHexes: GameHexes,
  blockchain: BlockchainPoller,
  uniqueId: string,
  amount: bigint,
): Promise<WasmBlobWrapper> {
  let wasmConnection = await wasmStateInit.getWasmConnection();
  gameObject.loadWasm(wasmConnection);
  const entropy = new Uint8Array(32);
  crypto.getRandomValues(entropy);
  const seedHex = Array.from(entropy, b => b.toString(16).padStart(2, '0')).join('');
  let rngId = wasmConnection.create_rng(seedHex);
  let address = await blockchain.rpc.getAddress();
  gameObject.setBlockchainAddress(address);
  let { game: cradle, puzzleHash } = wasmStateInit.createGame(gameHexes, rngId, wasmConnection, iStarted, amount, amount, address.puzzleHash);
  gameObject.setGameCradle(cradle);
  log('[wasm] activateSpend');
  gameObject.activateSpend();
  log('[wasm] game object configured (handshake)');
  return gameObject;
}

export async function restoreSession(
  gameObject: WasmBlobWrapper,
  save: SessionState,
  wasmStateInit: WasmStateInit,
): Promise<void> {
  if (!save.serializedCradle) {
    throw new Error('restoreSession called without serializedCradle');
  }
  const wasmConnection = await wasmStateInit.getWasmConnection();
  gameObject.loadWasm(wasmConnection);

  const cradleBytes = base64ToUint8(save.serializedCradle);
  const cradle = wasmStateInit.deserializeGame(wasmConnection, cradleBytes);

  // Restore JS-side delivery state before installing the cradle. setGameCradle()
  // can immediately spill buffered peer messages and replay unacked outbound
  // messages, so it must observe the saved counters and queues.
  gameObject.messageNumber = parseBigIntCounter(save.messageNumber, 1n);
  gameObject.remoteNumber = parseBigIntCounter(save.remoteNumber, 0n);
  gameObject.channelReady = save.channelReady ?? false;
  gameObject.iStarted = save.iStarted ?? false;
  gameObject.pairingToken = save.pairingToken ?? '';
  gameObject.unackedMessages = (save.unackedMessages ?? []).map(m => ({
    msgno: parseBigIntCounter(m.msgno, 0n),
    msg: base64ToUint8(m.msg),
  }));
  gameObject.history = [...(save.history ?? [])];
  gameObject.logHistory = [...(save.log ?? [])];
  gameObject.activeGameId = save.activeGameId ?? null;
  gameObject.handState = save.handState ?? null;
  gameObject.lastChannelStatus = save.channelStatus ?? null;
  gameObject.myAlias = save.myAlias;
  gameObject.opponentAlias = save.opponentAlias;
  gameObject.lastOutcomeWin = save.lastOutcomeWin;
  gameObject.chatMessages = save.chatMessages ?? [];
  gameObject.markRestored();
  gameObject.setGameCradle(cradle);

  // The transaction manager (in the deserialized cradle) already knows which
  // coins to watch; the poller will pick them up via get_coins_to_poll.

  log('[restore] session restored');
}

export function getBlobSingleton(
  blockchain: BlockchainPoller,
  peerConn: PeerConnectionResult,
  registerMessageHandler: (handler: (msgno: number, msg: Uint8Array) => void, ackHandler: (ack: number) => void, keepaliveHandler: () => void) => void,
  uniqueId: string,
  amount: bigint,
  iStarted: boolean,
  sessionSave?: SessionState,
  pairingToken?: string,
  perGameAmount?: bigint,
  getFee?: () => bigint,
): { gameObject: WasmBlobWrapper } {
  if (blobSingleton) {
    return { gameObject: blobSingleton };
  }

  const wasmStateInit = new WasmStateInit(fetchHex);

  blobSingleton = new WasmBlobWrapper(
    blockchain,
    uniqueId,
    amount,
    peerConn,
  );
  blobSingleton.iStarted = iStarted;
  blobSingleton.pairingToken = pairingToken ?? '';
  blobSingleton.perGameAmount = perGameAmount ?? 0n;
  if (getFee) blobSingleton.getFee = getFee;
  blobSingleton.setPeerKeepalive(() => peerConn.sendKeepalive());

  registerMessageHandler(
    (msgno: number, msg: Uint8Array) => {
      blobSingleton?.deliverMessage(BigInt(msgno), msg);
    },
    (ack: number) => {
      blobSingleton?.receiveAck(BigInt(ack));
    },
    () => {
      blobSingleton?.receiveKeepalive();
    },
  );

  blobSingleton.kickSystem(2);

  if (sessionSave) {
    const restoringObject = blobSingleton;
    const doRestore = async () => {
      try {
        await restoreSession(restoringObject, sessionSave, wasmStateInit);
      } catch (e) {
        console.error('[blobSingleton] restoreSession error:', e);
        log(`[blobSingleton] restoreSession error: ${String(e)}`);
        if (blobSingleton === restoringObject) {
          restoringObject.cleanup();
          blobSingleton = null;
          initStarted = false;
        }
        throw e;
      }
    };
    void restoringObject.beginRestore(doRestore()).catch(() => {
      // The wrapper has already emitted an error event and the singleton has
      // been cleared so a later resume cannot reuse partial restore state.
    });
  } else {
    const newSession = async () => {
      try {
        startNewSession();
        const gameHexes = await loadGameHexes(fetchHex);
        await configGameObject(
          blobSingleton!,
          iStarted,
          wasmStateInit,
          gameHexes,
          blockchain,
          uniqueId,
          amount,
        );
      } catch (e) {
        const msg = e instanceof Error ? (e.stack || e.message)
          : typeof e === 'object' && e !== null && 'data' in e ? (e as any).data?.error ?? String(e)
          : String(e);
        console.error('[blobSingleton] newSession error:', e);
        log(`[blobSingleton] newSession error: ${msg}`);
        blobSingleton!.rxjsEmitter?.next({ type: 'error', error: msg });
      }
    };
    newSession();
  }

  return { gameObject: blobSingleton };
}
