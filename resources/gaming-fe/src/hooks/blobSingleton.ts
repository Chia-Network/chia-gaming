import { WasmBlobWrapper } from './WasmBlobWrapper';
import { WasmStateInit, loadCalpoker } from './WasmStateInit';
import {
  InternalBlockchainInterface,
  PeerConnectionResult,
} from '../types/ChiaGaming';
import {
  startNewSession,
  SessionSave,
  BlockchainType,
} from './save';
import { debugLog } from '../services/debugLog';

export var blobSingleton: WasmBlobWrapper | null = null;
export var initStarted = false;

export function setInitStarted(value: boolean) {
    initStarted = value;
}

async function fetchHex(fetchUrl: string): Promise<string> {
    return fetch(fetchUrl).then((wasm) => wasm.text());
}

export async function configGameObject(
  gameObject: WasmBlobWrapper,
  iStarted: boolean,
  wasmStateInit: WasmStateInit,
  calpokerHexes: {proposalHex: string, parserHex: string},
  blockchain: InternalBlockchainInterface,
  uniqueId: string,
  amount: bigint,
): Promise<WasmBlobWrapper> {
  let wasmConnection = await wasmStateInit.getWasmConnection();
  gameObject.loadWasm(wasmConnection);
  const entropy = new Uint8Array(32);
  crypto.getRandomValues(entropy);
  const seedHex = Array.from(entropy, b => b.toString(16).padStart(2, '0')).join('');
  let rngId = wasmConnection.create_rng(seedHex);
  let address = await blockchain.getAddress();
  gameObject.setBlockchainAddress(address);
  let { game: cradle, puzzleHash } = wasmStateInit.createGame(calpokerHexes.proposalHex, calpokerHexes.parserHex, rngId, wasmConnection, iStarted, amount, amount, address.puzzleHash);
  gameObject.setGameCradle(cradle);
  const initialSpend = await blockchain.do_initial_spend(uniqueId, puzzleHash, amount);
  let coin = initialSpend.coin;
  if (typeof coin !== 'string') {
    coin = wasmConnection.convert_coinset_to_coin_string(
      coin.parentCoinInfo,
      coin.puzzleHash,
      coin.amount.toString(),
    );
  }
  if (!coin) {
    throw new Error('failed to get opening coin for handshake');
  }
  debugLog('[wasm] activateSpend');
  gameObject.activateSpend(coin);
  debugLog('[wasm] game object configured (handshake)');
  return gameObject;
}

async function restoreSession(
  gameObject: WasmBlobWrapper,
  save: SessionSave,
  wasmStateInit: WasmStateInit,
): Promise<void> {
  const wasmConnection = await wasmStateInit.getWasmConnection();
  gameObject.loadWasm(wasmConnection);

  const cradle = wasmStateInit.deserializeGame(wasmConnection, save.serializedCradle);
  gameObject.setGameCradle(cradle);

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
  gameObject.markRestored();

  debugLog('[restore] session restored');
}

export function getBlobSingleton(
  blockchain: InternalBlockchainInterface,
  peerConn: PeerConnectionResult,
  registerMessageHandler: (handler: (msgno: number, msg: string) => void, ackHandler: (ack: number) => void, pingHandler: () => void) => void,
  uniqueId: string,
  amount: bigint,
  iStarted: boolean,
  sessionSave?: SessionSave,
  pairingToken?: string,
  perGameAmount?: bigint,
  blockchainType?: BlockchainType,
): { gameObject: WasmBlobWrapper } {
  if (blobSingleton) {
    return { gameObject: blobSingleton };
  }

  const doInternalLoadWasm = async () => {
    const fetchUrl = '/chia_gaming_wasm_bg.wasm';
    return fetch(fetchUrl)
      .then((wasm) => wasm.blob())
      .then((blob) => {
        return blob.arrayBuffer();
      });
  };

  const wasmStateInit = new WasmStateInit(doInternalLoadWasm, fetchHex);

  blobSingleton = new WasmBlobWrapper(
    blockchain,
    uniqueId,
    amount,
    peerConn,
  );
  blobSingleton.iStarted = iStarted;
  blobSingleton.pairingToken = pairingToken ?? '';
  blobSingleton.perGameAmount = perGameAmount ?? 0n;
  blobSingleton.blockchainType = blockchainType ?? 'simulator';
  blobSingleton.setPeerPingAndClose(
    () => peerConn.sendPing(),
    () => peerConn.close(),
  );

  registerMessageHandler(
    (msgno: number, msg: string) => {
      blobSingleton?.deliverMessage(msgno, msg);
    },
    (ack: number) => {
      blobSingleton?.receiveAck(ack);
    },
    () => {
      blobSingleton?.receivePing();
    },
  );

  blobSingleton.kickSystem(2);

  if (sessionSave) {
    const doRestore = async () => {
      try {
        await restoreSession(blobSingleton!, sessionSave, wasmStateInit);
      } catch (e) {
        console.error('[blobSingleton] restoreSession error:', e);
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
        console.error('[blobSingleton] newSession error:', e);
      }
    };
    newSession();
  }

  return { gameObject: blobSingleton };
}
