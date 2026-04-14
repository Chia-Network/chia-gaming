import {
  init,
  config_scaffold,
  create_game_cradle,
  deliver_message,
  deposit_file,
  opening_coin,
  chia_identity,
  Spend,
  CoinSpend,
  SpendBundle,
  IChiaIdentity,
  DrainResult,
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
  PeerConnectionResult,
  BlockchainReport,
  CoinsetOrgBlockSpend,
  WatchReport,
  WasmEvent,
} from '../../types/ChiaGaming';
import { BLOCKCHAIN_SERVICE_URL, BLOCKCHAIN_WS_URL } from '../../settings';
import {
  FakeBlockchainInterface,
  fakeBlockchainInfo,
} from '../../hooks/FakeBlockchainInterface';
import { _resetForTests as resetSaveState } from '../../hooks/save';
import { BlockchainPoller } from '../../hooks/BlockchainPoller';
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
  return resolve(__dirname, '../../../..', name);
}

function preset_file(name: string) {
  deposit_file(name, fs.readFileSync(rooted(name), 'utf8'));
}

interface SimpleMessage { msgno: number; msg: string };

function makeStorage(): Storage {
  const store = new Map<string, string>();
  return {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => { store.set(key, value); },
    removeItem: (key: string) => { store.delete(key); },
    clear: () => { store.clear(); },
    get length() { return store.size; },
    key: (i: number) => [...store.keys()][i] ?? null,
  };
}

beforeAll(() => {
  (global as any).localStorage = makeStorage();
});

afterAll(() => {
  delete (global as any).localStorage;
});

const activeSubscriptions: Subscription[] = [];
const activeCradles: WasmBlobWrapperAdapter[] = [];
let testPoller: BlockchainPoller | null = null;

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
  testPoller?.stop();
  testPoller = null;
  fakeBlockchainInfo.close();
}

afterEach(() => {
  cleanupActiveResources();
  resetSaveState();
});

class WasmBlobWrapperAdapter {
  blob: WasmBlobWrapper | undefined;
  waiting_messages: Array<string>;

  constructor() {
    this.waiting_messages = [];
  }

  take_block(peak: number, blocks: CoinsetOrgBlockSpend[], block_report: WatchReport | undefined) {
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
    return !!this.blob?.isChannelReady();
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

async function action_with_messages(
  poller: BlockchainPoller,
  cradle1: WasmBlobWrapperAdapter,
  cradle2: WasmBlobWrapperAdapter,
) {
  let cradles = [cradle1, cradle2];
  let subscriptions: Subscription[] = [];

  subscriptions.push(addActiveSubscription(poller.getObservable().subscribe({
    next: (evt: BlockchainReport) => {
      cradles.forEach((c, i) => {
        let block_array = [];
        if (evt.block) {
          block_array = evt.block;
        }
        c.take_block(evt.peak, block_array, evt.report);
      });
    },
  })));

  let evt_results: Array<boolean> = [false, false];
  cradles.forEach((cradle, index) => {
    subscriptions.push(addActiveSubscription(cradle.getObservable().subscribe({
      next: (evt: WasmEvent) => {
        if (evt.type === 'notification' && evt.data) {
          const tag = typeof evt.data === 'object' ? Object.keys(evt.data)[0] : null;
          if (tag === 'ChannelStatus') {
            const cs = (evt.data as Record<string, Record<string, unknown>>).ChannelStatus;
            if (cs?.state === 'Active') {
              evt_results[index] = true;
            }
          }
        }
      },
    })));
  });
  try {
    while (!all_handshaked(cradles)) {
      for (let c = 0; c < 2; c++) {
        let outbound = cradles[c].outbound_messages();
        for (let i = 0; i < outbound.length; i++) {
          cradles[c ^ 1].deliver_message(outbound[i].msgno, outbound[i].msg);
        }
      }
      // Yield to async handlers without arbitrary sleep.
      await new Promise<void>((resolve) => setImmediate(resolve));
    }

    // If any evt_results are false, that means we did not get a setState msg from that cradle
    if (!evt_results.every((x) => x)) {
      throw 'we expected running state in both cradles';
    }
  } finally {
    subscriptions.forEach((sub) => sub.unsubscribe());
  }
}

async function initWasmBlobWrapper(
  blockchain: BlockchainPoller,
  uniqueId: string,
  iStarted: boolean,
  peer_conn: PeerConnectionResult,
  wasmStateInit: WasmStateInit,
) {
  const amount = 100n;

  // Ensure that each user has a wallet (register via WebSocket).
  await fakeBlockchainInfo.registerUser(uniqueId);
  let gameObject = new WasmBlobWrapper(
    blockchain,
    uniqueId,
    amount,
    peer_conn,
  );

  let calpokerHexes = await loadCalpoker(fetchHex);
  await configGameObject(gameObject, iStarted, wasmStateInit, calpokerHexes, blockchain, uniqueId, amount);

  return gameObject;
}


function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function isSimulatorAvailable(): Promise<boolean> {
  // HTTP health alone can be ready slightly before WS RPC accepts requests.
  // Probe both endpoints with short retries to reduce startup race flakiness.
  const attempts = [0, 150, 300, 600, 1000];
  for (const delayMs of attempts) {
    if (delayMs > 0) {
      await sleepMs(delayMs);
    }

    try {
      await fetch(`${BLOCKCHAIN_SERVICE_URL}/get_peak`, { method: 'POST' });

      const probe = new FakeBlockchainInterface(BLOCKCHAIN_WS_URL);
      try {
        await probe.registerUser(`ws-ready-probe-${Date.now()}-${getRandomInt(1_000_000)}`);
      } finally {
        probe.close();
      }

      return true;
    } catch {
      // Retry; simulator may still be in the HTTP-ready / WS-not-ready window.
    }
  }
  return false;
}

it(
  'loads',
  async () => {
    if (!(await isSimulatorAvailable())) {
      console.warn('Simulator not running at', BLOCKCHAIN_SERVICE_URL, '- skipping load_wasm test. Run ./ct.sh for full suite.');
      return;
    }
    await fakeBlockchainInfo.registerUser('block-producer');
    await fakeBlockchainInfo.startMonitoring();
    testPoller = new BlockchainPoller(fakeBlockchainInfo, 1000);
    testPoller.start();
    const poller = testPoller;

    const cradle1 = addActiveCradle(new WasmBlobWrapperAdapter());
    const cradle2 = addActiveCradle(new WasmBlobWrapperAdapter());
    try {
      let peer_conn1: PeerConnectionResult = {
        sendMessage: (msgno: number, message: string) => {
          cradle1.add_outbound_message(msgno, message);
        },
        sendAck: (_ackMsgno: number) => {},
        sendKeepalive: () => {},
        hostLog: (msg: string) => process.stderr.write(msg + '\n'),
        close: () => {},
      };
      let wasm_init1 = new WasmStateInit(fetchHex);
      storeInitArgs(async () => {}, WholeWasmObject);
      let wasm_blob1 = await initWasmBlobWrapper(
        poller,
        'a11ce000',
        true,
        peer_conn1,
        wasm_init1
      );
      cradle1.set_blob(wasm_blob1);

      let peer_conn2: PeerConnectionResult = {
        sendMessage: (msgno: number, message: string) => {
          cradle2.add_outbound_message(msgno, message);
        },
        sendAck: (_ackMsgno: number) => {},
        sendKeepalive: () => {},
        hostLog: (msg: string) => process.stderr.write(msg + '\n'),
        close: () => {},
      };
      let wasm_init2 = new WasmStateInit(fetchHex);
      let wasm_blob2 = await initWasmBlobWrapper(
        poller,
        'b0b77777',
        false,
        peer_conn2,
        wasm_init2
      );
      cradle2.set_blob(wasm_blob2);

      await action_with_messages(poller, cradle1, cradle2);
    } finally {
      cradle1.shutdown();
      cradle2.shutdown();
    }
  },
  120 * 1000,
);
