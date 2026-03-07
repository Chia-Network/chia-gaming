
import { WasmBlobWrapper } from './WasmBlobWrapper';
import { setupBlockchainConnection } from './useBlockchainConnection';
import { WasmStateInit, loadCalpoker } from './WasmStateInit';
import {
  InternalBlockchainInterface,
} from '../types/ChiaGaming';
import { getRandomInt, getEvenHexString } from '../util';
import { getGameSocket } from '../services/GameSocket';
import {
  startNewSession,
} from './save';

export var blobSingleton: any = null;
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
  let seed = getRandomInt(1<<31);
  let seedStr = getEvenHexString(seed);
  let rngId = wasmConnection.create_rng(seedStr);
  let identity = wasmConnection.chia_identity(rngId);
  let address = await blockchain.getAddress();
  gameObject.setBlockchainAddress(address);
  let cradle = wasmStateInit.createGame(calpokerHexes.proposalHex, calpokerHexes.parserHex, rngId, wasmConnection, identity.private_key, iStarted, amount, amount, address.puzzleHash);
  gameObject.setGameCradle(cradle);
  let coin = await wasmStateInit.createStartCoin(blockchain, uniqueId, identity, amount, wasmConnection);
  gameObject.activateSpend(coin.coinString);
  return gameObject;
}

export function getBlobSingleton(
  blockchain: InternalBlockchainInterface,
  searchParams: any,
  lobbyUrl: string,
  uniqueId: string,
  amount: number,
  iStarted: boolean,
) {
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
    searchParams,
    lobbyUrl,
    deliverMessage,
    (_saves: string[]) => {
      const systemState = blobSingleton.systemState();
      const newSession = async () => {
        startNewSession();
        let calpokerHexes = await loadCalpoker(fetchHex);
        await configGameObject(
          blobSingleton,
          iStarted,
          wasmStateInit,
          calpokerHexes,
          blockchain,
          uniqueId,
          amount
        );
      };

      blobSingleton.kickSystem(2);
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

  setupBlockchainConnection(uniqueId);

  return { gameObject: blobSingleton };
}
