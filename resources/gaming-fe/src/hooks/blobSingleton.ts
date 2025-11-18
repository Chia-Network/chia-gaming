
import { WasmBlobWrapper } from './WasmBlobWrapper';
import { GAME_SERVICE_URL } from '../settings';
// import getGameSocket from './getGameSocket';
import { setupBlockchainConnection } from './useBlockchainConnection';
import { WasmStateInit, loadCalpoker } from './WasmStateInit';
import {
  InternalBlockchainInterface,
} from '../types/ChiaGaming';
import { getSearchParams, empty, getRandomInt, getEvenHexString } from '../util';
import { getGameSocket } from '../services/GameSocket';

// TODO: Maybe migrate this file's contents to WasmStateInit.ts

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
  calpokerHex: string,
  blockchain:InternalBlockchainInterface,
  uniqueId: string,
  amount: number,
): Promise<WasmBlobWrapper> {
  let wasmConnection = await wasmStateInit.getWasmConnection();
  gameObject.loadWasm(wasmConnection);
  let seed = getRandomInt(1<<31);
  let seedStr = getEvenHexString(seed);
  console.log("configGameObject wasmConnection", wasmConnection);
  let rngId = wasmConnection.create_rng(seedStr);
  let identity = wasmConnection.chia_identity(rngId);
  let address = await blockchain.getAddress();
  gameObject.setBlockchainAddress(address);
  let cradle = wasmStateInit.createGame(calpokerHex, rngId, wasmConnection, identity.private_key, iStarted, amount, amount, address.puzzleHash);
  gameObject.setGameCradle(cradle);
  let coin = await wasmStateInit.createStartCoin(blockchain, uniqueId, identity, amount, wasmConnection);
  gameObject.activateSpend(coin.coinString);
  return gameObject;
}

export function getBlobSingleton(
  blockchain: InternalBlockchainInterface,
  lobbyUrl: string,
  uniqueId: string,
  amount: number,
  perGameAmount: number,
  iStarted: boolean,

) {
  if (blobSingleton) {
    return blobSingleton;
  }

  const deliverMessage = (msg: string) => {
    blobSingleton?.deliverMessage(msg);
  };
  const peercon = getGameSocket(lobbyUrl, deliverMessage, () => {
    blobSingleton?.kickSystem(2);
  });

  const doInternalLoadWasm = async () => {
    const fetchUrl = GAME_SERVICE_URL + '/chia_gaming_wasm_bg.wasm';
    return fetch(fetchUrl)
      .then((wasm) => wasm.blob())
      .then((blob) => {
        return blob.arrayBuffer();
      });
  };

  blobSingleton = new WasmBlobWrapper(
    blockchain,
    uniqueId,
    amount,
    perGameAmount,
    iStarted,
    doInternalLoadWasm,
    fetchHex,
    peercon,
  );

  setupBlockchainConnection(uniqueId);

  return blobSingleton;
}
