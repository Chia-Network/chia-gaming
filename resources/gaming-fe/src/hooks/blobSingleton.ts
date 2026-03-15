
import { WasmBlobWrapper } from './WasmBlobWrapper';
import { setupBlockchainConnection } from './useBlockchainConnection';
import { WasmStateInit, loadCalpoker } from './WasmStateInit';
import {
  InternalBlockchainInterface,
  PeerIdentity,
} from '../types/ChiaGaming';
import { blockchainDataEmitter } from './BlockchainInfo';
import { FAKE_BLOCKCHAIN_ID } from './FakeBlockchainInterface';
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
  amount: number,
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
  let coin = await wasmStateInit.createStartCoin(blockchain, uniqueId, puzzleHash, amount, wasmConnection);
  gameObject.activateSpend(coin.coinString);
  return gameObject;
}

export function getBlobSingleton(
  blockchain: InternalBlockchainInterface,
  peerIdentity: PeerIdentity,
  lobbyUrl: string,
  uniqueId: string,
  amount: number,
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
    iStarted,
    peerconn,
  );

  const isInIframe = window.parent !== window;
  if (isInIframe) {
    setupBlockchainConnection(uniqueId);
  } else {
    blockchainDataEmitter.select({ selection: FAKE_BLOCKCHAIN_ID, uniqueId });
  }

  return { gameObject: blobSingleton };
}
