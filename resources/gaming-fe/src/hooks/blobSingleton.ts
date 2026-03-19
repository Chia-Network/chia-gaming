
import { WasmBlobWrapper } from './WasmBlobWrapper';
import { WasmStateInit, loadCalpoker } from './WasmStateInit';
import {
  InternalBlockchainInterface,
  PeerIdentity,
} from '../types/ChiaGaming';
import { getGameSocket } from '../services/GameSocket';
import {
  startNewSession,
} from './save';

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
  const supportsDirectHandshake = typeof (wasmConnection as unknown as { start_handshake?: unknown }).start_handshake === 'function';
  if (supportsDirectHandshake) {
    gameObject.startHandshake();
    return gameObject;
  }

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
  gameObject.activateSpend(coin);
  return gameObject;
}

export function getBlobSingleton(
  blockchain: InternalBlockchainInterface,
  peerIdentity: PeerIdentity,
  lobbyUrl: string,
  uniqueId: string,
  amount: bigint,
  iStarted: boolean,
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

  const deliverMessage = (msgno: number, msg: string) => {
    blobSingleton?.deliverMessage(msgno, msg);
  };

  const wasmStateInit = new WasmStateInit(doInternalLoadWasm, fetchHex);
  const peerconn = getGameSocket(
    peerIdentity,
    lobbyUrl,
    deliverMessage,
    (_saves: string[]) => {
      const systemState = blobSingleton!.systemState();
      const newSession = async () => {
        try {
          startNewSession();
          let calpokerHexes = await loadCalpoker(fetchHex);
          await configGameObject(
            blobSingleton!,
            iStarted,
            wasmStateInit,
            calpokerHexes,
            blockchain,
            uniqueId,
            amount
          );
        } catch (e) {
          console.error('[blobSingleton] newSession error:', e);
        }
      };

      blobSingleton!.kickSystem(2);
      if ((systemState & 2) == 0) {
        newSession();
        return;
      }
    },
    () => []
  );

  blobSingleton = new WasmBlobWrapper(
    blockchain,
    uniqueId,
    amount,
    peerconn,
  );

  // Blockchain is already configured by WalletConnectHeading in the same
  // window (via blockchainDataEmitter.select). No postMessage bridge needed.

  return { gameObject: blobSingleton };
}
