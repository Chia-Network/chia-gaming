import { WasmBlobWrapper } from './WasmBlobWrapper';
import { WasmStateInit, loadCalpoker } from './WasmStateInit';
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

export function setInitStarted(value: boolean) {
    initStarted = value;
}

export function injectDaemonError(): boolean {
    if (!blobSingleton) return false;
    blobSingleton.rxjsEmitter?.next({
        type: 'error',
        error: '[DEBUG] Simulated daemon application error',
    });
    return true;
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
  calpokerHexes: {proposalHex: string, parserHex: string},
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
  let { game: cradle, puzzleHash } = wasmStateInit.createGame(calpokerHexes.proposalHex, calpokerHexes.parserHex, rngId, wasmConnection, iStarted, amount, amount, address.puzzleHash);
  gameObject.setGameCradle(cradle);
  log('[wasm] activateSpend');
  gameObject.activateSpend();
  log('[wasm] game object configured (handshake)');
  return gameObject;
}

async function restoreSession(
  gameObject: WasmBlobWrapper,
  save: SessionState,
  wasmStateInit: WasmStateInit,
  blockchain: BlockchainPoller,
): Promise<void> {
  if (!save.serializedCradle) {
    throw new Error('restoreSession called without serializedCradle');
  }
  const wasmConnection = await wasmStateInit.getWasmConnection();
  gameObject.loadWasm(wasmConnection);

  const cradleBytes = base64ToUint8(save.serializedCradle);
  const cradle = wasmStateInit.deserializeGame(wasmConnection, cradleBytes);
  gameObject.setGameCradle(cradle);

  const watchedCoins = cradle.get_watching_coins();
  for (const { coin_name, coin_string } of watchedCoins) {
    blockchain.registerCoin(coin_name, coin_string);
  }
  log(`[restore] re-registered ${watchedCoins.length} watched coins`);

  gameObject.messageNumber = save.messageNumber ?? 1;
  gameObject.remoteNumber = save.remoteNumber ?? 0;
  gameObject.channelReady = save.channelReady ?? false;
  gameObject.iStarted = save.iStarted ?? false;
  gameObject.pairingToken = save.pairingToken ?? '';
  gameObject.unackedMessages = (save.unackedMessages ?? []).map(m => ({ msgno: m.msgno, msg: base64ToUint8(m.msg) }));
  gameObject.pendingTransactions = [...(save.pendingTransactions ?? [])];
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
      blobSingleton?.deliverMessage(msgno, msg);
    },
    (ack: number) => {
      blobSingleton?.receiveAck(ack);
    },
    () => {
      blobSingleton?.receiveKeepalive();
    },
  );

  blobSingleton.kickSystem(2);

  if (sessionSave) {
    const doRestore = async () => {
      try {
        await restoreSession(blobSingleton!, sessionSave, wasmStateInit, blockchain);
      } catch (e) {
        console.error('[blobSingleton] restoreSession error:', e);
        log(`[blobSingleton] restoreSession error: ${String(e)}`);
      }
    };
    doRestore();
  } else {
    const newSession = async () => {
      try {
        startNewSession();
        const calpokerHexes = await loadCalpoker(fetchHex);
        await configGameObject(
          blobSingleton!,
          iStarted,
          wasmStateInit,
          calpokerHexes,
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
