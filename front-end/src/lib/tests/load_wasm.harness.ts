import { Program } from 'clvm-lib';
import { Subscription } from 'rxjs';
import { WasmStateInit, storeInitArgs, _resetWasmLoadForTests } from '../../hooks/WasmStateInit';
import WholeWasmObject from '../../../node-pkg/chia_gaming_wasm.js';
import { PeerConnectionResult, WasmEvent } from '../../types/ChiaGaming';
import { BLOCKCHAIN_SERVICE_URL } from '../../settings';
import { fakeBlockchainInfo } from '../../hooks/FakeBlockchainInterface';
import { _resetForTests as resetSaveState } from '../../hooks/save';
import { SESSION_DB_NAME } from '../session/indexedDb';
import { BlockchainPoller } from '../../hooks/BlockchainPoller';
import { configSessionController } from '../../hooks/blobSingleton';
import { SessionController } from '../../hooks/SessionController';
import { createRegisteredGameHand, snapshotRegisteredGameHand } from '../gameRegistry';
import { calpokerStateCodec } from '@games/calpoker/ui/serialize';
import { spacepokerStateCodec } from '@games/spacepoker/ui/serialize';
import { initialKrunkGameState, KrunkHandler, krunkStateCodec } from '@games/krunk/ui/serialize';
import type { HandProposal, PersistedGameState } from '../session/types';
import 'fake-indexeddb/auto';
// @ts-expect-error Node.js types are not included in the frontend TypeScript configuration.
import * as fs from 'fs';
// @ts-expect-error Node.js types are not included in the frontend TypeScript configuration.
import { resolve } from 'path';
// @ts-expect-error Node.js types are not included in the frontend TypeScript configuration.
import * as assert from 'assert';

function rooted(name: string) {
  // @ts-expect-error Node.js types are not included in the frontend TypeScript configuration.
  return resolve(__dirname, '../../../..', name);
}

export async function fetchPreset(key: string): Promise<Uint8Array> {
  return new Uint8Array(fs.readFileSync(rooted(key)));
}

interface SimpleMessage {
  msgno: number;
  msg: Uint8Array;
}

function makeStorage(): Storage {
  const store = new Map<string, string>();
  return {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => {
      store.set(key, value);
    },
    removeItem: (key: string) => {
      store.delete(key);
    },
    clear: () => {
      store.clear();
    },
    get length() {
      return store.size;
    },
    key: (i: number) => [...store.keys()][i] ?? null,
  };
}

function setTestGlobal(key: string, value: unknown) {
  Object.defineProperty(globalThis, key, {
    configurable: true,
    writable: true,
    value,
  });
}

function clearTestGlobal(key: string) {
  Reflect.deleteProperty(globalThis, key);
}

beforeAll(() => {
  setTestGlobal('localStorage', makeStorage());
});

beforeEach(async () => {
  resetSaveState();
  _resetWasmLoadForTests();
  storeInitArgs(async () => {}, WholeWasmObject);
  await new Promise<void>((resolve) => {
    const request = indexedDB.deleteDatabase(SESSION_DB_NAME);
    request.onsuccess = () => resolve();
    request.onerror = () => resolve();
    request.onblocked = () => resolve();
  });
});

afterAll(async () => {
  clearTestGlobal('localStorage');
});

const activeSubscriptions: Subscription[] = [];
const activeCradles: SessionControllerAdapter[] = [];
let testPoller: BlockchainPoller | null = null;

export function addActiveSubscription(sub: Subscription): Subscription {
  activeSubscriptions.push(sub);
  return sub;
}

export function addActiveCradle(cradle: SessionControllerAdapter): SessionControllerAdapter {
  activeCradles.push(cradle);
  return cradle;
}

async function cleanupActiveResources() {
  while (activeSubscriptions.length > 0) {
    activeSubscriptions.pop()?.unsubscribe();
  }
  while (activeCradles.length > 0) {
    activeCradles.pop()?.shutdown();
  }
  testPoller?.stop();
  testPoller = null;
  await fakeBlockchainInfo.disconnect();
}

afterEach(async () => {
  try {
    await cleanupActiveResources();
    resetSaveState();
    // Drain microtask queue to catch late async errors.  Widened from 50ms to
    // give in-flight teardown async (poller RPCs rejecting on disconnect, the
    // submit queue, reconnect loop) time to settle inside the test boundary so
    // it fails here with a real message instead of escaping past afterAll.
    await new Promise<void>((r) => setTimeout(r, 300));
  } catch (e) {
    throw new Error(`[load_wasm cleanup failed]\n${String(e)}`, { cause: e });
  }
});

export class SessionControllerAdapter {
  blob: SessionController | undefined;
  waiting_messages: Array<SimpleMessage>;

  constructor() {
    this.waiting_messages = [];
  }

  getObservable() {
    if (!this.blob) {
      throw 'SessionControllerAdapter.getObservable() called before set_blob';
    }
    return this.blob.getObservable();
  }

  set_blob(blob: SessionController) {
    this.blob = blob;
    this.blob.kickSystem(2);
  }

  deliver_message(msgno: number, msg: Uint8Array) {
    this.blob?.deliverMessage(BigInt(msgno), msg);
  }

  handshaked(): boolean {
    return !!this.blob?.isChannelReady();
  }

  observedActiveStatus(): boolean {
    return this.blob?.lastChannelStatus?.state === 'Active';
  }

  outbound_messages(): Array<SimpleMessage> {
    const w = this.waiting_messages;
    this.waiting_messages = [];
    return w;
  }

  add_outbound_message(msgno: number, msg: Uint8Array) {
    this.waiting_messages.push({ msgno, msg });
  }

  shutdown() {
    this.blob?.cleanup();
  }
}

function all_handshaked(cradles: Array<SessionControllerAdapter>) {
  for (let c = 0; c < 2; c++) {
    if (!cradles[c].handshaked()) {
      return false;
    }
  }
  return true;
}

function debugCradleState(cradle: SessionControllerAdapter): string {
  const blob = cradle.blob as any;
  if (!blob) return 'no-blob';
  return [
    `ready=${cradle.handshaked()}`,
    `active=${cradle.observedActiveStatus()}`,
    `outbound=${cradle.waiting_messages.length}`,
    `system=${blob.systemState?.()}`,
    `queue=${blob.eventQueue?.length}`,
    `drain=${blob.drainScheduled}`,
    `launcher=${blob.launcherProvided}`,
    `pendingSends=${blob.pendingOutboundSends?.length}`,
  ].join('/');
}

export async function flushWrapperDrain(cradles: Array<SessionControllerAdapter>): Promise<void> {
  await Promise.all(cradles.map((cradle) => cradle.blob?.flushPendingWork() ?? Promise.resolve()));
}

export function assertCradleRoundTrip(stage: string, controller: SessionController): Uint8Array {
  const wasmFields = controller.getWasmFields();
  const serialized = wasmFields?.serializedGameSession;
  assert.ok(serialized instanceof Uint8Array, `${stage}: expected serialized cradle bytes`);
  assert.equal(
    wasmFields?.gameSessionSchemaVersion,
    BigInt(WholeWasmObject.game_session_serialization_schema()),
    `${stage}: expected current cradle schema`,
  );
  assert.ok(serialized.byteLength > 0, `${stage}: expected non-empty serialized cradle`);
  // Fingerprint immediately: if serialize_game_session returned a WASM-memory view,
  // later WASM activity would mutate these bytes in place.
  const ownedFingerprint = Uint8Array.from(serialized);
  const state = controller.getProtocolStatePretty() ?? 'unknown';
  try {
    const restoredId = WholeWasmObject.restore_session(serialized, `reload-regression-${stage}`);
    assert.equal(typeof restoredId, 'number');
    const reserialized = WholeWasmObject.serialize_game_session(restoredId);
    assert.deepEqual(
      serialized,
      ownedFingerprint,
      `${stage}: serialized cradle bytes mutated after further WASM use ` +
        `(byteLength=${serialized.byteLength} byteOffset=${serialized.byteOffset})`,
    );
    assert.deepEqual(
      reserialized,
      serialized,
      `${stage}: restored cradle should reserialize identically`,
    );
  } catch (e) {
    throw new Error(
      `${stage}: ${serialized.byteLength} byte cradle failed immediate restore; ` +
        `protocol=${state}\n${String(e)}`,
      { cause: e },
    );
  }
  return serialized;
}

export async function pollOnce(poller: BlockchainPoller): Promise<void> {
  await (poller as unknown as { pollOnce: () => Promise<void> }).pollOnce();
}

export async function action_with_messages(
  poller: BlockchainPoller,
  cradle1: SessionControllerAdapter,
  cradle2: SessionControllerAdapter,
) {
  const cradles = [cradle1, cradle2];
  const subscriptions: Subscription[] = [];

  // The poller drives each cradle's coin polling directly via report_coin_states.
  cradles.forEach((c) => {
    if (c.blob) poller.attachGameSession(c.blob);
  });

  let evt_results: Array<boolean> = cradles.map((c) => c.observedActiveStatus());
  cradles.forEach((cradle, index) => {
    subscriptions.push(
      addActiveSubscription(
        cradle.getObservable().subscribe({
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
        }),
      ),
    );
  });
  try {
    let iterations = 0;
    const startedAt = Date.now();
    while (!all_handshaked(cradles)) {
      iterations++;
      let deliveredOutbound = false;
      for (let c = 0; c < 2; c++) {
        const outbound = cradles[c].outbound_messages();
        for (let i = 0; i < outbound.length; i++) {
          deliveredOutbound = true;
          cradles[c ^ 1].deliver_message(outbound[i].msgno, outbound[i].msg);
        }
      }
      await flushWrapperDrain(cradles);
      if (!deliveredOutbound && !all_handshaked(cradles)) {
        await pollOnce(poller);
        await flushWrapperDrain(cradles);
      }
      if (!deliveredOutbound && !all_handshaked(cradles)) {
        await fakeBlockchainInfo.farmBlock();
        await pollOnce(poller);
        await flushWrapperDrain(cradles);
      }
      evt_results = evt_results.map((seen, index) => seen || cradles[index].observedActiveStatus());
      if (Date.now() - startedAt > 30_000) {
        throw new Error(
          `handshake loop timed out after ${iterations} iterations` +
            ` connected=${fakeBlockchainInfo.isConnected()}` +
            ` ready=${cradles.map((c) => c.handshaked()).join(',')}` +
            ` active=${cradles.map((c) => c.observedActiveStatus()).join(',')}` +
            ` outbound=${cradles.map((c) => c.waiting_messages.length).join(',')}` +
            ` states=${cradles.map(debugCradleState).join(' | ')}`,
        );
      }
    }

    // If any evt_results are false, that means we did not get a setState msg from that cradle
    if (!evt_results.every((x) => x)) {
      throw new Error(
        `we expected running state in both cradles, got active=${evt_results.join(',')} ready=${cradles.map((c) => c.handshaked()).join(',')}`,
      );
    }
  } finally {
    subscriptions.forEach((sub) => sub.unsubscribe());
    cradles.forEach((c) => {
      if (c.blob) poller.detachGameSession(c.blob);
    });
  }
}

export async function exchangeUntilIdle(cradles: SessionControllerAdapter[]): Promise<void> {
  let idleRounds = 0;
  for (let round = 0; round < 100 && idleRounds < 2; round += 1) {
    let delivered = false;
    for (let index = 0; index < cradles.length; index += 1) {
      for (const outbound of cradles[index].outbound_messages()) {
        delivered = true;
        cradles[index ^ 1].deliver_message(outbound.msgno, outbound.msg);
      }
    }
    await flushWrapperDrain(cradles);
    idleRounds = delivered ? 0 : idleRounds + 1;
  }
  if (idleRounds < 2) throw new Error('peer message exchange did not quiesce');
}

export async function createActivePair(
  poller: BlockchainPoller,
  index: number,
): Promise<[SessionControllerAdapter, SessionControllerAdapter]> {
  const cradles = [
    addActiveCradle(new SessionControllerAdapter()),
    addActiveCradle(new SessionControllerAdapter()),
  ] as [SessionControllerAdapter, SessionControllerAdapter];
  const peerConnections = cradles.map(
    (cradle): PeerConnectionResult => ({
      sendMessage: (msgno: number, message: Uint8Array) => {
        cradle.add_outbound_message(msgno, message);
        return true;
      },
      sendAck: () => true,
      sendKeepalive: () => true,
      hostLog: () => {},
      close: () => {},
    }),
  );
  const first = await initSessionController(
    poller,
    `cafe000${index}`,
    true,
    peerConnections[0],
    new WasmStateInit(fetchPreset),
  );
  const second = await initSessionController(
    poller,
    `dead000${index}`,
    false,
    peerConnections[1],
    new WasmStateInit(fetchPreset),
  );
  first.pairingToken = `restore-games-${index}-first`;
  second.pairingToken = `restore-games-${index}-second`;
  first.perGameAmount = 100n;
  second.perGameAmount = 100n;
  first.onSaveNeeded = () => Promise.resolve();
  second.onSaveNeeded = () => Promise.resolve();
  cradles[0].set_blob(first);
  cradles[1].set_blob(second);
  await action_with_messages(poller, cradles[0], cradles[1]);
  return cradles;
}

export function postMoveHandState(
  handProposal: HandProposal,
  ids: string[],
): { handState: PersistedGameState; moverId: string; move: Program | null } {
  const hand = createRegisteredGameHand(handProposal.gameType, {
    parameters: handProposal.parameters,
    members: ids.map((_, index) => ({
      playerAContribution:
        handProposal.gameType === 'krunk' && index !== 0 ? 0n : handProposal.playerAContribution,
      playerBContribution:
        handProposal.gameType === 'krunk' && index === 0 ? 0n : handProposal.playerBContribution,
      ourTurn: handProposal.gameType === 'krunk' ? index === 1 : true,
    })),
  });
  const accepted = snapshotRegisteredGameHand(handProposal.gameType, hand);
  if (handProposal.gameType === 'calpoker') {
    const state = calpokerStateCodec.decode(accepted);
    assert.ok(state);
    return {
      handState: calpokerStateCodec.encode({
        ...state,
        moveNumber: 1n,
        isPlayerTurn: false,
      }),
      moverId: ids[0],
      move: null,
    };
  }
  if (handProposal.gameType === 'spacepoker') {
    const state = spacepokerStateCodec.decode(accepted);
    assert.ok(state);
    return {
      handState: spacepokerStateCodec.encode({
        ...state,
        gameState: { ...state.gameState, myTurn: false },
      }),
      moverId: ids[0],
      move: null,
    };
  }
  const state = krunkStateCodec.decode(accepted);
  assert.ok(state);
  const moverIndex = state.members.findIndex((game) => game.role === 'alice');
  assert.notEqual(moverIndex, -1, 'krunk: receiver must own exactly one alice member');
  const members = [...state.members] as [(typeof state.members)[0], (typeof state.members)[1]];
  members[moverIndex] = {
    ...initialKrunkGameState('alice'),
    handler: KrunkHandler.AliceWaiting,
    myTurn: false,
    secretWord: 'CRANE',
  };
  return {
    handState: krunkStateCodec.encode({
      ...state,
      members,
    }),
    moverId: ids[moverIndex],
    move: Program.fromBytes(new TextEncoder().encode('CRANE')),
  };
}

export async function initSessionController(
  blockchain: BlockchainPoller,
  uniqueId: string,
  iStarted: boolean,
  peer_conn: PeerConnectionResult,
  wasmStateInit: WasmStateInit,
) {
  const myContribution = 100n;
  const theirContribution = 100n;

  await fakeBlockchainInfo.registerUser(uniqueId);
  const gameObject = new SessionController(
    blockchain,
    uniqueId,
    myContribution,
    theirContribution,
    peer_conn,
  );

  await configSessionController(gameObject, iStarted, wasmStateInit, blockchain, uniqueId);

  return gameObject;
}

function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function isSimulatorAvailable(): Promise<boolean> {
  const attempts = [0, 150, 300, 600, 1000];
  for (const delayMs of attempts) {
    if (delayMs > 0) {
      await sleepMs(delayMs);
    }
    try {
      await fetch(`${BLOCKCHAIN_SERVICE_URL}/health`, { method: 'POST' });
      return true;
    } catch {
      // Retry; simulator may still be starting up.
    }
  }
  return false;
}

export async function startSimulator(userIds: string[]): Promise<BlockchainPoller | null> {
  if (!(await isSimulatorAvailable())) {
    const msg = `Simulator not running at ${BLOCKCHAIN_SERVICE_URL}`;
    if (process.env.LOAD_WASM_REQUIRE_SIM) {
      throw new Error(`[load_wasm] ${msg} (LOAD_WASM_REQUIRE_SIM set)`);
    }
    console.warn(msg, '- skipping load_wasm test. Run ./ct.sh for full suite.');
    return null;
  }
  const setup = await fakeBlockchainInfo.beginConnect('block-producer');
  await setup.finalize();
  for (const userId of userIds) {
    await fakeBlockchainInfo.registerUser(userId);
  }
  testPoller = new BlockchainPoller(fakeBlockchainInfo, 1000, 2000);
  testPoller.start();
  return testPoller;
}
