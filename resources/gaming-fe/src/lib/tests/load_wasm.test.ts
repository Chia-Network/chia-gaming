import {
  init,
  config_scaffold,
  create_game_cradle,
  deliver_message,
  deposit_file,
  opening_coin,
  idle,
  chia_identity,
  Spend,
  CoinSpend,
  SpendBundle,
  IChiaIdentity,
  IdleCallbacks,
  IdleResult,
} from '../../../node-pkg/chia_gaming_wasm.js';
import { Subscription } from 'rxjs';
import {
  WasmStateInit,
  storeInitArgs,
  loadCalpoker,
} from '../../hooks/WasmStateInit';
import { getSearchParams, empty, getRandomInt, getEvenHexString } from '../../util';
import WholeWasmObject from '../../../node-pkg/chia_gaming_wasm.js';
import {
  InternalBlockchainInterface,
  PeerConnectionResult,
  BlockchainReport,
} from '../../types/ChiaGaming';
import { BLOCKCHAIN_SERVICE_URL } from '../../settings';
import {
  FAKE_BLOCKCHAIN_ID,
  disconnectSimulatorBlockchain,
} from '../../hooks/FakeBlockchainInterface';
import { blockchainDataEmitter } from '../../hooks/BlockchainInfo';
import {
  blockchainConnector,
  BlockchainOutboundRequest,
} from '../../hooks/BlockchainConnector';
import { ChildFrameBlockchainInterface } from '../../hooks/ChildFrameBlockchainInterface';
import { configGameObject } from '../../hooks/blobSingleton';
import { WasmBlobWrapper } from '../../hooks/WasmBlobWrapper';
// @ts-ignore
import * as fs from 'fs';
// @ts-ignore
import { resolve } from 'path';
// @ts-ignore
import * as assert from 'assert';

async function fetchHex(key: string): Promise<string> {
  return fs.readFileSync(rooted(key), 'utf8');
}

function rooted(name: string) {
  // @ts-ignore
  return resolve(__dirname, '../../../../..', name);
}

function preset_file(name: string) {
  deposit_file(name, fs.readFileSync(rooted(name), 'utf8'));
}

interface SimpleMessage { msgno: number; msg: string };

const activeSubscriptions: Subscription[] = [];
const activeCradles: WasmBlobWrapperAdapter[] = [];

function addActiveSubscription(sub: Subscription): Subscription {
  activeSubscriptions.push(sub);
  return sub;
}

function addActiveCradle(cradle: WasmBlobWrapperAdapter): WasmBlobWrapperAdapter {
  activeCradles.push(cradle);
  return cradle;
}

function cleanupActiveResources() {
  while (activeSubscriptions.length > 0) {
    activeSubscriptions.pop()?.unsubscribe();
  }
  while (activeCradles.length > 0) {
    activeCradles.pop()?.shutdown();
  }
  disconnectSimulatorBlockchain();
}

afterEach(() => {
  cleanupActiveResources();
});

class WasmBlobWrapperAdapter {
  blob: WasmBlobWrapper | undefined;
  waiting_messages: Array<string>;

  constructor() {
    this.waiting_messages = [];
  }

  take_block(peak: number, blocks: any[], block_report: any) {
    this.blob?.blockNotification(peak, blocks, block_report);
  }

  getObservable() {
    if (!this.blob) {
      throw 'WasmBlobWrapperAdapter.getObservable() called before set_blob';
    }
    return this.blob.getObservable();
  }

  set_blob(blob: WasmBlobWrapper) {
    this.blob = blob;
    this.blob.kickSystem(2);
  }

  deliver_message(msgno: number, msg: string) {
    this.blob?.deliverMessage(msgno, msg);
  }

  handshaked(): boolean {
    return !!this.blob?.isHandshakeDone();
  }

  outbound_messages(): Array<SimpleMessage> {
    let w = this.waiting_messages;
    this.waiting_messages = [];
    return w;
  }

  add_outbound_message(msgno: number, msg: string) {
    this.waiting_messages.push({ msgno, msg });
  }

  shutdown() {
    this.blob?.cleanup();
  }
}

function all_handshaked(cradles: Array<WasmBlobWrapperAdapter>) {
  for (let c = 0; c < 2; c++) {
    if (!cradles[c].handshaked()) {
      return false;
    }
  }
  return true;
}

function wait(msec: number): Promise<void> {
  return new Promise((resolve, reject) => {
    setTimeout(resolve, msec);
  });
}

async function action_with_messages(
  blockchainInterface: ChildFrameBlockchainInterface,
  cradle1: WasmBlobWrapperAdapter,
  cradle2: WasmBlobWrapperAdapter,
) {
  console.log("action_with_messages START")
  let cradles = [cradle1, cradle2];
  let subscriptions: Subscription[] = [];

  subscriptions.push(addActiveSubscription(blockchainInterface.getObservable().subscribe({
    next: (evt: BlockchainReport) => {
      cradles.forEach((c, i) => {
        let block_array = [];
        if (evt.block) {
          block_array = evt.block;
        }
        console.log('pass on block', evt.peak, block_array, evt.report);
        c.take_block(evt.peak, block_array, evt.report);
      });
    },
  })));

  let evt_results: Array<boolean> = [false, false];
  cradles.forEach((cradle, index) => {
    subscriptions.push(addActiveSubscription(cradle.getObservable().subscribe({
      next: (evt) => {
        // console.log('WasmBlobWrapper Event: ', evt);
        if (
          evt.setGameConnectionState &&
          evt.setGameConnectionState.stateIdentifier === 'running'
        ) {
          evt_results[index] = true;
        }
      },
    })));
  });
  try {
    while (!all_handshaked(cradles)) {
      for (let c = 0; c < 2; c++) {
        let outbound = cradles[c].outbound_messages();
        for (let i = 0; i < outbound.length; i++) {
          console.log(`delivering message from cradle ${c}: ${JSON.stringify(outbound[i])}`);
          cradles[c ^ 1].deliver_message(outbound[i].msgno, outbound[i].msg);
        }
      }
      await wait(10);
    }

    // If any evt_results are false, that means we did not get a setState msg from that cradle
    if (!evt_results.every((x) => x)) {
      console.log('got running:', evt_results);
      throw 'we expected running state in both cradles';
    }
    console.log("action_with_messages END")
  } finally {
    subscriptions.forEach((sub) => sub.unsubscribe());
  }
}

async function initWasmBlobWrapper(
  blockchain: InternalBlockchainInterface,
  uniqueId: string,
  iStarted: boolean,
  peer_conn: PeerConnectionResult,
  wasmStateInit: WasmStateInit,
) {
  console.log("initWasmBlobWrapper start:", blockchain, uniqueId, iStarted, peer_conn,  wasmStateInit);
  const amount = 100;

  // Ensure that each user has a wallet.
  await fetch(`${BLOCKCHAIN_SERVICE_URL}/register?name=${uniqueId}`, {
    method: 'POST',
  });
  // let wbw = new WasmBlobWrapper(
  let gameObject = new WasmBlobWrapper(
    blockchain,
    uniqueId,
    amount,
    amount / 10,
    iStarted,
    doInternalLoadWasm,
    fetchHex,
    peer_conn,
  );

  let calpokerHexes = await loadCalpoker(fetchHex);
  configGameObject(gameObject, iStarted, wasmStateInit, calpokerHexes, blockchain, uniqueId, amount);

  console.log("initWasmBlobWrapper end");
  return gameObject;
}

const doInternalLoadWasm = async () => {
  return new ArrayBuffer(0);
};

it(
  'loads',
  async () => {
    const blockchainInterface = new ChildFrameBlockchainInterface();
    // The blockchain service does separate monitoring now.
    blockchainDataEmitter.select({
      selection: FAKE_BLOCKCHAIN_ID,
      uniqueId: 'block-producer',
    });

    const cradle1 = addActiveCradle(new WasmBlobWrapperAdapter());
    const cradle2 = addActiveCradle(new WasmBlobWrapperAdapter());
    try {
      let peer_conn1 = {
        sendMessage: (msgno: number, message: string) => {
          cradle1.add_outbound_message(msgno, message);
        },
        hostLog: (msg: string) => console.log(msg)
      };
      console.log("after peer_conn1");
      let wasm_init1 = new WasmStateInit(doInternalLoadWasm, fetchHex);
      storeInitArgs(() => {}, WholeWasmObject);
      console.log("afer WasmStateInit");

      let wasm_blob1 = await initWasmBlobWrapper(
        blockchainInterface,
        'a11ce000',
        true,
        peer_conn1,
        wasm_init1
      );
      console.log("after wasm_blob1");
      cradle1.set_blob(wasm_blob1);

      let peer_conn2 = {
        sendMessage: (msgno: number, message: string) => {
          cradle2.add_outbound_message(msgno, message);
        },
        hostLog: (msg: string) => console.log(msg)
      };
      let wasm_init2 = new WasmStateInit(doInternalLoadWasm, fetchHex);
      let wasm_blob2 = await initWasmBlobWrapper(
        blockchainInterface,
        'b0b77777',
        false,
        peer_conn2,
        wasm_init2
      );
      console.log("after wasm_blob2");

      cradle2.set_blob(wasm_blob2);

      console.log("Running action_with_messages");
      await action_with_messages(blockchainInterface, cradle1, cradle2);
    } finally {
      cradle1.shutdown();
      cradle2.shutdown();
    }
  },
  10 * 1000,
);
