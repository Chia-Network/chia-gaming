
import { WasmBlobWrapper } from './WasmBlobWrapper';
import { GAME_SERVICE_URL } from '../settings';
// import getGameSocket from './getGameSocket';
import { setupBlockchainConnection } from './useBlockchainConnection';
import { WasmStateInit, loadCalpoker } from './WasmStateInit';
import {
  InternalBlockchainInterface,
} from '../types/ChiaGaming';
import { getSearchParams, empty, getRandomInt, getEvenHexString } from '../util';
import { GameSocketReturn, getGameSocket } from '../services/GameSocket';
import {
  findMatchingGame,
  loadSave,
  startNewSession,
  getSaveList,
} from './save';

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

export async function deserializeGameObject(
  log: (msg: string) => void,
  gameObject: WasmBlobWrapper,
  iStarted: boolean,
  wasmStateInit: WasmStateInit,
  blockchain:InternalBlockchainInterface,
  serializedGame: any,
  address: any,
): Promise<WasmBlobWrapper> {
  log(`${iStarted} deserializeGameObject with agreed state`);
  let wasmConnection = gameObject.getWasmConnection();
  if (!wasmConnection) {
    wasmConnection = await wasmStateInit.getWasmConnection();
    log(`${iStarted} deserializeGameObject got wasm connection`);
    gameObject.loadWasm(wasmConnection);
  }
  log(`${iStarted} deserializeGameObject setting address`);
  gameObject.setBlockchainAddress(address);
  log(`${iStarted} deserializeGameObject gameObject notified of wasm connection`);
  let cradle = wasmStateInit.deserializeGame(wasmConnection, serializedGame);
  log(`${iStarted} deserializeGameObject has new cradle`);
  gameObject.setGameCradle(cradle);
  log(`${iStarted} deserializeGameObject deserialized cradle`);
  return gameObject;
}

export function getBlobSingleton(
  blockchain: InternalBlockchainInterface,
  searchParams: any,
  lobbyUrl: string,
  uniqueId: string,
  amount: number,
  perGameAmount: number,
  iStarted: boolean,
  setUIState: (state: any) => void,
) {
  if (blobSingleton) {
    return blobSingleton;
  }

  const doInternalLoadWasm = async () => {
    const fetchUrl = GAME_SERVICE_URL + '/chia_gaming_wasm_bg.wasm';
    return fetch(fetchUrl)
      .then((wasm) => wasm.blob())
      .then((blob) => {
        return blob.arrayBuffer();
      });
  };

  const deliverMessage = (msg: string) => {
    blobSingleton?.deliverMessage(msg);
  };

  console.log('getGameSocket');
  const peerconn = getGameSocket(
    searchParams,
    lobbyUrl,
    deliverMessage,
    (saves: string[]) => {
      peerconn.hostLog(`${iStarted} peer saves ${saves}`);
      const systemState = blobSingleton.systemState();
      const handleMatchingSave = async (matchingSave: string) => {
        peerconn.hostLog(`${iStarted} peer has matching save ${matchingSave}`);
        const loadedSave = loadSave(matchingSave);
        setUIState(loadedSave.ui);
        await deserializeGameObject(
          peerconn.hostLog,
          blobSingleton,
          iStarted,
          wasmStateInit,
          blockchain,
          loadedSave.game,
          loadedSave.addressData
        );
      };
      const newSession = async () => {
        peerconn.hostLog(`${iStarted} new session`);
        startNewSession();
        let calpokerHex = await loadCalpoker(fetchHex);
        await configGameObject(blobSingleton, iStarted, wasmStateInit, calpokerHex, blockchain, uniqueId, amount);
      };
      const matchingSave = findMatchingGame(saves);
      const wasmStateInit = new WasmStateInit(doInternalLoadWasm, fetchHex);

      blobSingleton.kickSystem(2);
      if (matchingSave) {
        handleMatchingSave(matchingSave);
        return;
      }

      if ((systemState & 2) == 0) {
        peerconn.hostLog(`${iStarted} peer first time connection`);
        newSession();
        return;
      }
    },
    () => getSaveList()
  );

  peerconn.hostLog(`${iStarted} constructing wasm blob wrapper`);

  blobSingleton = new WasmBlobWrapper(
    blockchain,
    uniqueId,
    amount,
    perGameAmount,
    iStarted,
    doInternalLoadWasm,
    fetchHex,
    peerconn,
  );

  setupBlockchainConnection(uniqueId);

  return blobSingleton;
}
