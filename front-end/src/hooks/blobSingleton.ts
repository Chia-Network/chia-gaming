import { WasmBlobWrapper } from './WasmBlobWrapper';
import { WasmStateInit, loadCalpoker } from './WasmStateInit';
import {
  PeerConnectionResult,
} from '../types/ChiaGaming';
import { BlockchainPoller } from './BlockchainPoller';
import {
  startNewSession,
  SessionSave,
} from './save';
import { debugLog } from '../services/debugLog';

export var blobSingleton: WasmBlobWrapper | null = null;
export var initStarted = false;

export function setInitStarted(value: boolean) {
    initStarted = value;
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
  debugLog('[wasm] activateSpend');
  gameObject.activateSpend();
  debugLog('[wasm] game object configured (handshake)');
  return gameObject;
}

async function restoreSession(
  gameObject: WasmBlobWrapper,
  save: SessionSave,
  wasmStateInit: WasmStateInit,
  blockchain: BlockchainPoller,
): Promise<void> {
  const wasmConnection = await wasmStateInit.getWasmConnection();
  gameObject.loadWasm(wasmConnection);

  const cradle = wasmStateInit.deserializeGame(wasmConnection, save.serializedCradle);
  gameObject.setGameCradle(cradle);

  const watchedCoins = cradle.get_watching_coins();
  for (const { coin_name, coin_string } of watchedCoins) {
    blockchain.registerCoin(coin_name, coin_string);
  }
  debugLog(`[restore] re-registered ${watchedCoins.length} watched coins`);

  gameObject.messageNumber = save.messageNumber;
  gameObject.remoteNumber = save.remoteNumber;
  gameObject.channelReady = save.channelReady;
  gameObject.iStarted = save.iStarted;
  gameObject.pairingToken = save.pairingToken;
  gameObject.unackedMessages = [...save.unackedMessages];
  gameObject.pendingTransactions = [...save.pendingTransactions];
  gameObject.gameLog = [...save.gameLog];
  gameObject.debugLogHistory = [...save.debugLog];
  gameObject.activeGameId = save.activeGameId ?? null;
  gameObject.handState = save.handState ?? null;
  gameObject.lastChannelStatus = save.channelStatus ?? null;
  gameObject.myAlias = save.myAlias;
  gameObject.opponentAlias = save.opponentAlias;
  gameObject.showBetweenHandOverlay = save.showBetweenHandOverlay ?? false;
  gameObject.lastOutcomeWin = save.lastOutcomeWin;
  gameObject.chatMessages = save.chatMessages ?? [];
  gameObject.gameCoinHex = save.gameCoinHex ?? null;
  gameObject.gameTurnState = save.gameTurnState ?? 'my-turn';
  gameObject.gameTerminalType = save.gameTerminalType ?? 'none';
  gameObject.gameTerminalLabel = save.gameTerminalLabel ?? null;
  gameObject.gameTerminalReward = save.gameTerminalReward ?? null;
  gameObject.gameTerminalRewardCoin = save.gameTerminalRewardCoin ?? null;
  gameObject.myRunningBalance = save.myRunningBalance ?? '0';
  gameObject.channelAttentionActive = save.channelAttentionActive ?? false;
  gameObject.gameTerminalAttentionActive = save.gameTerminalAttentionActive ?? false;
  gameObject.markRestored();

  debugLog('[restore] session restored');
}

export function getBlobSingleton(
  blockchain: BlockchainPoller,
  peerConn: PeerConnectionResult,
  registerMessageHandler: (handler: (msgno: number, msg: string) => void, ackHandler: (ack: number) => void, keepaliveHandler: () => void) => void,
  uniqueId: string,
  amount: bigint,
  iStarted: boolean,
  sessionSave?: SessionSave,
  pairingToken?: string,
  perGameAmount?: bigint,
  getFee?: () => number,
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
    (msgno: number, msg: string) => {
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
        debugLog(`[blobSingleton] restoreSession error: ${String(e)}`);
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
        debugLog(`[blobSingleton] newSession error: ${msg}`);
        blobSingleton!.rxjsEmitter?.next({ type: 'error', error: msg });
      }
    };
    newSession();
  }

  return { gameObject: blobSingleton };
}
