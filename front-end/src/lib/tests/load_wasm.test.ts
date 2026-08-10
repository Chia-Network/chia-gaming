import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { Subject, Subscription } from 'rxjs';
import { Program } from 'clvm-lib';
import { WasmStateInit, storeInitArgs, _resetWasmLoadForTests } from '../../hooks/WasmStateInit';
import WholeWasmObject from '../../../node-pkg/chia_gaming_wasm.js';
import { PeerConnectionResult, WasmEvent } from '../../types/ChiaGaming';
import { BLOCKCHAIN_SERVICE_URL } from '../../settings';
import { fakeBlockchainInfo } from '../../hooks/FakeBlockchainInterface';
import {
  _resetForTests as resetSaveState,
  flushSessionSave,
  hasSavedSessionMarker,
  peekSession,
  saveSession,
} from '../../hooks/save';
import { SESSION_DB_NAME } from '../session/indexedDb';
import { BlockchainPoller } from '../../hooks/BlockchainPoller';
import { configSessionController } from '../../hooks/blobSingleton';
import { restoreSession } from '../../hooks/blobSingleton';
import { SessionController } from '../../hooks/SessionController';
import {
  canRemountFinishedGameState,
  encodeGameProposalParameters,
  reduceRegisteredGameState,
} from '../gameRegistry';
import {
  channelStatusModelFromPayload,
  createSessionModel,
  INITIAL_GAME_TERMINAL_MODEL,
  sessionModelFromSave,
  snapshotFromSessionModel,
} from '../session/model';
import { createSessionMachineState } from '../session/sessionMachine';
import { persistSessionSnapshot } from '../session/sessionMachinePersist';
import { SessionMachineRuntime } from '../session/sessionMachineRuntime';
import { validateSessionSaveEnvelope } from '../session/persistence';
import { calpokerStateCodec } from '../../features/calPoker/stateCodec';
import { spacepokerStateCodec } from '../../features/spacePoker/stateCodec';
import {
  initialKrunkGameState,
  KrunkHandler,
  krunkStateCodec,
  type KrunkGameState,
} from '../../features/krunk/stateCodec';
import { CalpokerOutcome } from '../../features/calPoker/outcome';
import {
  shouldAutoFireCalpokerMove,
  useCalpokerHand,
  type UseCalpokerHandResult,
} from '../../features/calPoker/useCalpokerHand';
import { krunkBoardNotice } from '../../features/krunk/useKrunkHand';
import { terminalInfoFromGameSettled, type GameplayEvent } from '../session/gameSessionEvents';
import type { GameTerminalModel, HandTermsModel, PersistedGameState } from '../session/types';
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

async function fetchPreset(key: string): Promise<Uint8Array> {
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

function addActiveSubscription(sub: Subscription): Subscription {
  activeSubscriptions.push(sub);
  return sub;
}

function addActiveCradle(cradle: SessionControllerAdapter): SessionControllerAdapter {
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

class SessionControllerAdapter {
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

async function flushWrapperDrain(cradles: Array<SessionControllerAdapter>): Promise<void> {
  await Promise.all(cradles.map((cradle) => cradle.blob?.flushPendingWork() ?? Promise.resolve()));
}

function assertCradleRoundTrip(stage: string, controller: SessionController): Uint8Array {
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

async function pollOnce(poller: BlockchainPoller): Promise<void> {
  await (poller as unknown as { pollOnce: () => Promise<void> }).pollOnce();
}

async function action_with_messages(
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

async function exchangeUntilIdle(cradles: SessionControllerAdapter[]): Promise<void> {
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

async function createActivePair(
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

function postMoveHandState(
  terms: HandTermsModel,
  ids: string[],
): { handState: PersistedGameState; moverId: string; move: Program | null } {
  const accepted = reduceRegisteredGameState(terms.gameType, null, {
    type: 'accepted-group',
    id: ids[0],
    groupIds: ids,
    iStarted: false,
    iProposedHand: false,
    terms,
  });
  assert.ok(accepted, `${terms.gameType}: accepted group must create hand state`);
  if (terms.gameType === 'calpoker') {
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
  if (terms.gameType === 'spacepoker') {
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
  const mover = Object.entries(state.games).find(([, game]) => game.role === 'alice');
  assert.ok(mover, 'krunk: receiver must own exactly one alice member');
  return {
    handState: krunkStateCodec.encode({
      games: {
        ...state.games,
        [mover[0]]: {
          ...initialKrunkGameState('alice'),
          handler: KrunkHandler.AliceWaiting,
          myTurn: false,
          secretWord: 'CRANE',
        },
      },
    }),
    moverId: mover[0],
    move: Program.fromBytes(new TextEncoder().encode('CRANE')),
  };
}

async function initSessionController(
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

async function isSimulatorAvailable(): Promise<boolean> {
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

it(
  'persists and reloads real handshake and post-move game cradles',
  async () => {
    try {
      if (!(await isSimulatorAvailable())) {
        // In CI the sim is supposed to be up; treating "no sim" as a silent skip
        // means a broken harness reports green.  When LOAD_WASM_REQUIRE_SIM is
        // set (the workflow sets it), make it a hard failure instead.
        const msg = `Simulator not running at ${BLOCKCHAIN_SERVICE_URL}`;
        if (process.env.LOAD_WASM_REQUIRE_SIM) {
          throw new Error(`[load_wasm] ${msg} (LOAD_WASM_REQUIRE_SIM set)`);
        }
        console.warn(msg, '- skipping load_wasm test. Run ./ct.sh for full suite.');
        return;
      }
      const setup = await fakeBlockchainInfo.beginConnect('block-producer');
      await setup.finalize();
      for (let index = 0; index < 3; index += 1) {
        await fakeBlockchainInfo.registerUser(`cafe000${index}`);
        await fakeBlockchainInfo.registerUser(`dead000${index}`);
      }
      testPoller = new BlockchainPoller(fakeBlockchainInfo, 1000, 2000);
      testPoller.start();
      const poller = testPoller;

      const cradle1 = addActiveCradle(new SessionControllerAdapter());
      const cradle2 = addActiveCradle(new SessionControllerAdapter());
      const peer_conn1: PeerConnectionResult = {
        sendMessage: (msgno: number, message: Uint8Array) => {
          cradle1.add_outbound_message(msgno, message);
          return true;
        },
        sendAck: (_ackMsgno: number) => true,
        sendKeepalive: () => true,
        hostLog: (msg: string) => process.stderr.write(msg + '\n'),
        close: () => {},
      };
      const wasm_init1 = new WasmStateInit(fetchPreset);
      storeInitArgs(async () => {}, WholeWasmObject);
      const wasm_blob1 = await initSessionController(
        poller,
        'a11ce000',
        true,
        peer_conn1,
        wasm_init1,
      );
      wasm_blob1.onSaveNeeded = () => {
        const fields = wasm_blob1.getWasmFields();
        if (!fields) {
          return Promise.reject(
            new Error('Cannot persist session: WASM cradle serialization failed'),
          );
        }
        return saveSession({
          ...fields,
          pairingToken: 'reload-regression-p1',
        });
      };
      cradle1.set_blob(wasm_blob1);

      const peer_conn2: PeerConnectionResult = {
        sendMessage: (msgno: number, message: Uint8Array) => {
          cradle2.add_outbound_message(msgno, message);
          return true;
        },
        sendAck: (_ackMsgno: number) => true,
        sendKeepalive: () => true,
        hostLog: (msg: string) => process.stderr.write(msg + '\n'),
        close: () => {},
      };
      const wasm_init2 = new WasmStateInit(fetchPreset);
      const wasm_blob2 = await initSessionController(
        poller,
        'b0b77777',
        false,
        peer_conn2,
        wasm_init2,
      );
      wasm_blob2.onSaveNeeded = () => {
        const fields = wasm_blob2.getWasmFields();
        if (!fields) {
          return Promise.reject(
            new Error('Cannot persist session: WASM cradle serialization failed'),
          );
        }
        return saveSession({
          ...fields,
          pairingToken: 'reload-regression-p2',
        });
      };
      cradle2.set_blob(wasm_blob2);

      await flushWrapperDrain([cradle1, cradle2]);
      assertCradleRoundTrip('initiator-sent-a', wasm_blob1);
      assertCradleRoundTrip('receiver-waiting-for-a', wasm_blob2);

      const sentA = cradle1.outbound_messages();
      assert.equal(sentA.length, 1, 'initiator should have one HandshakeA message');

      cradle2.deliver_message(sentA[0].msgno, sentA[0].msg);
      assertCradleRoundTrip('receiver-processed-a-sent-b', wasm_blob2);
      await flushWrapperDrain([cradle2]);
      const sentB = cradle2.outbound_messages();
      assert.equal(sentB.length, 1, 'receiver should have one HandshakeB message');

      cradle1.deliver_message(sentB[0].msgno, sentB[0].msg);
      assertCradleRoundTrip('initiator-processed-b-needs-launcher', wasm_blob1);
      await flushWrapperDrain([cradle1]);
      assertCradleRoundTrip('initiator-provided-launcher-sent-c', wasm_blob1);
      const sentC = cradle1.outbound_messages();
      assert.equal(sentC.length, 1, 'initiator should have one HandshakeC message');

      cradle2.deliver_message(sentC[0].msgno, sentC[0].msg);
      assertCradleRoundTrip('receiver-processed-c-sent-d', wasm_blob2);
      await flushWrapperDrain([cradle2]);
      const sentD = cradle2.outbound_messages();
      assert.equal(sentD.length, 1, 'receiver should have one HandshakeD message');

      cradle1.deliver_message(sentD[0].msgno, sentD[0].msg);
      assertCradleRoundTrip('initiator-processed-d-waiting-for-height', wasm_blob1);
      await fakeBlockchainInfo.farmBlock();
      await pollOnce(poller);
      assertCradleRoundTrip('initiator-height-observed-needs-coin-spend', wasm_blob1);
      await flushWrapperDrain([cradle1]);
      assertCradleRoundTrip('initiator-wallet-offer-complete-sent-e', wasm_blob1);
      const sentE = cradle1.outbound_messages();
      assert.equal(sentE.length, 1, 'initiator should have one HandshakeE message');

      cradle2.deliver_message(sentE[0].msgno, sentE[0].msg);
      const makingOfferAcceptanceBytes = assertCradleRoundTrip(
        'receiver-processed-e-making-offer-acceptance',
        wasm_blob2,
      );
      // Stop live durability saves before the explicit snapshot so a late
      // onSaveNeeded cannot overwrite the cradle under test.
      wasm_blob1.onSaveNeeded = () => Promise.resolve();
      wasm_blob2.onSaveNeeded = () => Promise.resolve();
      void saveSession({
        serializedGameSession: makingOfferAcceptanceBytes,
        gameSessionSchemaVersion: BigInt(WholeWasmObject.game_session_serialization_schema()),
        pairingToken: 'reload-regression',
      });
      await flushSessionSave();

      // Simulate marker-only boot + preference patches while resume dialog is open.
      resetSaveState();
      assert.ok(hasSavedSessionMarker());
      void saveSession({ diagnosticLog: ['boot-before-resume'] });
      await flushSessionSave();

      resetSaveState();
      const reloaded = await peekSession();
      assert.ok(reloaded?.serializedGameSession instanceof Uint8Array);
      assert.equal(
        reloaded.serializedGameSession.byteLength,
        makingOfferAcceptanceBytes.byteLength,
      );
      assert.deepEqual(reloaded.serializedGameSession, makingOfferAcceptanceBytes);
      assert.ok(
        reloaded.diagnosticLog?.includes('boot-before-resume'),
        'preference patch during marker-only boot must be retained',
      );
      const restoredId = WholeWasmObject.restore_session(
        reloaded.serializedGameSession,
        'reload-regression-seed',
      );
      assert.equal(typeof restoredId, 'number');

      await flushWrapperDrain([cradle2]);
      assertCradleRoundTrip('receiver-wallet-offer-complete-sent-f', wasm_blob2);

      await action_with_messages(poller, cradle1, cradle2);
      await runRealCalpokerCompletionCase(poller);
      await runRealGameRestoreCases(poller);
      await runRealKrunkCompletionCase(poller);
    } catch (e) {
      throw new Error(`[load_wasm loads failed]\n${String(e)}`, { cause: e });
    }
  },
  300 * 1000,
);

async function runRealCalpokerCompletionCase(poller: BlockchainPoller): Promise<void> {
  const cradles = await createActivePair(poller, 4);
  const controllers = cradles.map((cradle) => cradle.blob!) as [
    SessionController,
    SessionController,
  ];
  const terms: HandTermsModel = {
    gameType: 'calpoker',
    myContribution: 20n,
    theirContribution: 20n,
    gameTimeout: 15n,
  };
  const runtimes: SessionMachineRuntime[] = [];
  const errors: unknown[] = [];
  const gameplayEvents: GameplayEvent[][] = [[], []];
  const gameplaySubjects = [new Subject<GameplayEvent>(), new Subject<GameplayEvent>()];
  const statuses: Array<Array<{ id: string; moverShare: unknown }>> = [[], []];
  const stageTrace: Array<Array<{ runtime: bigint; controller: bigint }>> = [[], []];
  const submittedMoves = [0, 0];
  let hookRenderer: ReactTestRenderer | null = null;

  for (const [index, controller] of controllers.entries()) {
    const status = controller.lastChannelStatus;
    assert.ok(status, `calpoker initial deal player ${index}: missing active channel status`);
    const runtime = new SessionMachineRuntime(
      createSessionMachineState(
        createSessionModel({
          channel: { status: channelStatusModelFromPayload(status) },
          game: { handKey: 1 },
          betweenHand: { mode: 'compose-proposal', lastTerms: terms },
        }),
      ),
      {
        controller,
        iStarted: index === 0,
        restoring: false,
        getRestoreStatus: () => 'idle',
        getRestoreError: () => null,
        emitGameplay: (event) => {
          gameplayEvents[index].push(event);
          gameplaySubjects[index].next(event);
        },
        onError: (error) => errors.push(error),
        persist: async () => {},
      },
    );
    runtime.setRender((state) => {
      const runtimeHand = calpokerStateCodec.decode(state.model.game.handState);
      const controllerHand = calpokerStateCodec.decode(controller.handState);
      if (runtimeHand && controllerHand) {
        stageTrace[index].push({
          runtime: runtimeHand.moveNumber,
          controller: controllerHand.moveNumber,
        });
      }
    });
    runtimes.push(runtime);
    controller.onFeatureStateTransition = (gameType, id, state) =>
      runtime.transitionFeatureState(gameType, id, state);
    controller.onSaveNeeded = () => Promise.resolve();
    addActiveSubscription(
      controller.getObservable().subscribe((event) => {
        if (event.type !== 'notification') return;
        const gameStatus = event.data.GameStatus;
        if (gameStatus) {
          statuses[index].push({
            id: String(gameStatus.id),
            moverShare: gameStatus.other_params?.mover_share,
          });
        }
        runtime.dispatch({
          type: 'wasm-notification',
          notification: event.data,
          iStarted: index === 0,
        });
      }),
    );
  }

  const exchange = async () => {
    await exchangeUntilIdle(cradles);
    await flushWrapperDrain(cradles);
    assert.deepEqual(errors, []);
  };
  const hand = (index: number) => {
    const state = calpokerStateCodec.decode(runtimes[index].getState().model.game.handState);
    assert.ok(state, `calpoker initial deal player ${index}: missing hand state`);
    return state;
  };
  const latestOpponentMove = (index: number) => {
    const event = [...gameplayEvents[index]]
      .reverse()
      .find((candidate) => 'OpponentMoved' in candidate);
    assert.ok(event && 'OpponentMoved' in event);
    return event.OpponentMoved;
  };
  const submitSelections = (index: number, gameId: string, selections: bigint[]) => {
    assert.equal(
      runtimes[index].transitionFeatureState('calpoker', gameId, {
        ...hand(index),
        cardSelections: selections,
        moveNumber: 2n,
        isPlayerTurn: false,
      }),
      true,
    );
    submittedMoves[index] += 1;
    controllers[index].makeMove(
      gameId,
      Program.fromList(selections.map((card) => Program.fromBigInt(card))),
    );
  };
  const submitNil = (index: number, gameId: string, moveNumber: bigint) => {
    assert.equal(
      runtimes[index].transitionFeatureState('calpoker', gameId, {
        ...hand(index),
        moveNumber,
        isPlayerTurn: false,
      }),
      true,
    );
    submittedMoves[index] += 1;
    controllers[index].makeMove(gameId, null);
  };
  const autofireOpening = (index: number, gameId: string) => {
    const state = hand(index);
    if (!shouldAutoFireCalpokerMove(false, state.isPlayerTurn, state.moveNumber)) return;
    submitNil(index, gameId, state.moveNumber + 1n);
  };

  try {
    runtimes[0].dispatch({ type: 'submit-compose', terms });
    await exchange();
    const review = runtimes[1].getState().model.betweenHand.reviewPeerProposal;
    assert.ok(review, 'calpoker initial deal receiver must observe the real proposal');
    const gameId = review.groupIds[0];

    runtimes[1].dispatch({ type: 'accept-review' });
    await exchange();
    assert.deepEqual(hand(0).playerHand, []);
    assert.deepEqual(hand(1).playerHand, []);

    submitNil(1, gameId, 1n);
    await exchange();
    assert.deepEqual(hand(0).playerHand, []);
    assert.deepEqual(hand(1).playerHand, []);

    submitNil(0, gameId, 1n);
    await exchange();

    const bob = hand(0);
    const alice = hand(1);
    assert.equal(alice.playerHand.length, 8);
    assert.equal(alice.opponentHand.length, 8);
    assert.equal(bob.playerHand.length, 8);
    assert.equal(bob.opponentHand.length, 8);
    assert.deepEqual(alice.playerHand, bob.opponentHand);
    assert.deepEqual(alice.opponentHand, bob.playerHand);
    assert.ok(
      statuses[0].some((entry) => entry.id === gameId && entry.moverShare == null),
      'Bob must receive the initial deal as an advisory GameMessage',
    );
    assert.ok(
      statuses[1].some((entry) => entry.id === gameId && entry.moverShare != null),
      'Alice must derive the initial deal from Bob’s authoritative move',
    );

    const aliceSelections = alice.playerHand.slice(0, 4);
    submitSelections(1, gameId, aliceSelections);
    await exchange();

    const bobSelections = hand(0).playerHand.slice(0, 4);
    submitSelections(0, gameId, bobSelections);
    await exchange();
    const aliceOutcome = new CalpokerOutcome(
      false,
      15n,
      hand(1).playerHand,
      hand(1).opponentHand,
      latestOpponentMove(1).readable,
    );

    submitNil(1, gameId, 3n);
    await exchange();
    const bobOutcome = new CalpokerOutcome(
      true,
      15n,
      hand(0).opponentHand,
      hand(0).playerHand,
      latestOpponentMove(0).readable,
    );

    assert.deepEqual(aliceOutcome.my_cards, bobOutcome.their_cards);
    assert.deepEqual(aliceOutcome.their_cards, bobOutcome.my_cards);
    assert.deepEqual(aliceOutcome.my_final_hand, bobOutcome.their_final_hand);
    assert.deepEqual(aliceOutcome.their_final_hand, bobOutcome.my_final_hand);
    assert.equal(
      aliceOutcome.my_win_outcome === 'tie'
        ? bobOutcome.my_win_outcome
        : aliceOutcome.my_win_outcome === 'win'
          ? 'lose'
          : 'win',
      bobOutcome.my_win_outcome,
    );
    assert.deepEqual(
      gameplayEvents.map((events) => events.filter((event) => 'OpponentMoved' in event).length),
      [3, 2],
      'the five-step hand must emit exactly one authoritative event per move',
    );
    for (const [index, runtime] of runtimes.entries()) {
      assert.ok(
        calpokerStateCodec.decode(runtime.getState().model.game.handState),
        `calpoker completion player ${index}: durable state must remain valid`,
      );
    }

    controllers[0].acceptSettlement(gameId);
    await exchange();
    for (const runtime of runtimes) {
      assert.deepEqual(runtime.getState().model.game.activeIds, []);
    }

    assert.equal(
      runtimes[0].transitionFeatureState('calpoker', gameId, {
        ...hand(0),
        moveNumber: 2n,
        isPlayerTurn: true,
      }),
      true,
      'a late terminal mount projection must still belong to the completed hand',
    );
    const firstHandKeys = runtimes.map((runtime) => runtime.getState().model.game.handKey);
    runtimes[0].dispatch({ type: 'choose-same-terms' });
    await exchange();
    const secondProposal = runtimes[1].getState().model.betweenHand.cachedPeerProposal;
    assert.ok(secondProposal, 'second Calpoker hand receiver must cache the same-terms proposal');
    const secondGameId = secondProposal.groupIds[0];
    assert.notEqual(secondGameId, gameId);
    runtimes[1].dispatch({ type: 'choose-same-terms' });
    await exchange();

    assert.deepEqual(
      runtimes.map((runtime) => runtime.getState().model.game.handKey),
      firstHandKeys.map((key) => key + 1),
      'second hand must receive a fresh mount key on both players',
    );
    assert.deepEqual(
      runtimes.map((runtime) => runtime.getState().coordination.iProposedHand),
      [true, false],
      'proposal ownership must describe the current hand, not channel initiation',
    );
    assert.deepEqual(
      runtimes.map((runtime) => runtime.getState().model.game.currentHandIds),
      [[secondGameId], [secondGameId]],
    );
    stageTrace.forEach((trace) => {
      trace.length = 0;
    });
    const secondStartup = [hand(0), hand(1)].map((state) => ({
      moveNumber: state.moveNumber,
      isPlayerTurn: state.isPlayerTurn,
    }));
    autofireOpening(0, secondGameId);
    autofireOpening(1, secondGameId);
    await exchange();
    assert.deepEqual(
      secondStartup,
      [
        { moveNumber: 0n, isPlayerTurn: false },
        { moveNumber: 0n, isPlayerTurn: true },
      ],
      'fresh durable state must agree with the new Rust referee turn',
    );
    assert.deepEqual(submittedMoves, [2, 4], 'only Alice must autofire the second opening');

    submitNil(0, secondGameId, 1n);
    await exchange();
    const secondAlice = hand(1);
    const secondBob = hand(0);
    assert.deepEqual(secondAlice.playerHand, secondBob.opponentHand);
    assert.deepEqual(secondAlice.opponentHand, secondBob.playerHand);

    const hookHands: Array<UseCalpokerHandResult | undefined> = [undefined, undefined];
    const hookOutcomes: Array<CalpokerOutcome | undefined> = [undefined, undefined];
    function HookHarness({ index }: { index: number }) {
      hookHands[index] = useCalpokerHand(
        controllers[index],
        secondGameId,
        index === 0,
        gameplaySubjects[index],
        (outcome) => {
          hookOutcomes[index] = outcome;
          runtimes[index].dispatch({
            type: 'hand-outcome',
            outcomeWin: outcome.my_win_outcome,
          });
        },
        (isMyTurn) =>
          runtimes[index].dispatch({
            type: 'durable-local-turn',
            id: secondGameId,
            isMyTurn,
          }),
        INITIAL_GAME_TERMINAL_MODEL,
        controllers[index].handState ?? undefined,
        true,
        'restored',
      );
      return null;
    }
    act(() => {
      hookRenderer = create(
        React.createElement(
          React.Fragment,
          null,
          React.createElement(HookHarness, { index: 0 }),
          React.createElement(HookHarness, { index: 1 }),
        ),
      );
    });

    const stages = (index: number) => {
      const runtimeHand = hand(index);
      const controllerHand = calpokerStateCodec.decode(controllers[index].handState);
      assert.ok(controllerHand);
      assert.ok(hookHands[index]);
      return {
        runtime: runtimeHand.moveNumber,
        controller: controllerHand.moveNumber,
        hook: hookHands[index].moveNumber,
      };
    };
    assert.deepEqual(stages(0), { runtime: 1n, controller: 1n, hook: 1n });
    assert.deepEqual(stages(1), { runtime: 1n, controller: 1n, hook: 1n });

    act(() => {
      hookHands[1]!.setCardSelections(secondAlice.playerHand.slice(0, 4));
      hookHands[1]!.handleMakeMove();
    });
    assert.deepEqual(stages(1), { runtime: 2n, controller: 2n, hook: 2n });
    await act(async () => {
      await exchange();
    });

    act(() => {
      hookHands[0]!.setCardSelections(hand(0).playerHand.slice(0, 4));
      hookHands[0]!.handleMakeMove();
    });
    assert.deepEqual(stages(0), { runtime: 2n, controller: 2n, hook: 2n });

    await act(async () => {
      await exchange();
    });
    await act(async () => {
      await exchange();
    });

    assert.ok(hookOutcomes[0], 'Bob must receive Alice’s final move readable');
    assert.ok(hookOutcomes[1], 'Alice must receive Bob’s final-result readable');
    assert.ok(
      stages(1).runtime >= 2n && stages(1).controller >= 2n && stages(1).hook >= 2n,
      'Alice selection stage must remain submitted through final-result delivery',
    );
    for (const trace of stageTrace) {
      const submittedIndex = trace.findIndex((entry) => entry.runtime >= 2n);
      if (submittedIndex >= 0) {
        assert.ok(
          trace
            .slice(submittedIndex)
            .every((entry) => entry.runtime >= 2n && entry.controller >= 2n),
          `Calpoker durable stage regressed after selection submission: ${JSON.stringify(
            trace.map((entry) => ({
              runtime: String(entry.runtime),
              controller: String(entry.controller),
            })),
          )}`,
        );
      }
    }

    controllers[0].acceptSettlement(secondGameId);
    await act(async () => {
      await exchange();
    });
    for (const runtime of runtimes) {
      assert.deepEqual(runtime.getState().model.game.activeIds, []);
    }
  } finally {
    if (hookRenderer) act(() => hookRenderer?.unmount());
    runtimes.forEach((runtime) => runtime.dispose());
    controllers.forEach((controller) => {
      controller.onFeatureStateTransition = null;
      controller.onSaveNeeded = null;
    });
  }
}

async function runRealGameRestoreCases(poller: BlockchainPoller): Promise<void> {
  const cases: Array<{ terms: HandTermsModel; expectedMembers: number; canRemount: boolean }> = [
    {
      terms: {
        gameType: 'calpoker',
        myContribution: 100n,
        theirContribution: 100n,
        gameTimeout: 15n,
      },
      expectedMembers: 1,
      canRemount: true,
    },
    {
      terms: {
        gameType: 'spacepoker',
        myContribution: 100n,
        theirContribution: 100n,
        gameTimeout: 15n,
        unitSizeMojos: 10n,
      },
      expectedMembers: 1,
      canRemount: true,
    },
    {
      terms: {
        gameType: 'krunk',
        myContribution: 100n,
        theirContribution: 100n,
        gameTimeout: 15n,
      },
      expectedMembers: 2,
      canRemount: true,
    },
  ];

  for (const [index, testCase] of cases.entries()) {
    const cradles = await createActivePair(poller, index);
    const proposer = cradles[0].blob!;
    const mover = cradles[1].blob!;
    const ids = proposer.proposeGame({
      game_type: testCase.terms.gameType,
      timeout: testCase.terms.gameTimeout,
      parameters: encodeGameProposalParameters(testCase.terms, true),
    });
    assert.equal(ids.length, testCase.expectedMembers);
    await exchangeUntilIdle(cradles);
    mover.acceptProposal(ids[0]);
    await exchangeUntilIdle(cradles);
    assert.deepEqual(mover.activeGameIds, ids);

    const postMove = postMoveHandState(testCase.terms, ids);
    const beforeMove = Uint8Array.from(mover.getWasmFields()!.serializedGameSession);
    mover.makeMove(postMove.moverId, postMove.move);
    await flushWrapperDrain([cradles[1]]);
    const afterMove = mover.getWasmFields()!;
    assert.notDeepEqual(
      afterMove.serializedGameSession,
      beforeMove,
      `${testCase.terms.gameType}: actual WASM move must change serialized protocol state`,
    );
    mover.setHandState(postMove.handState);

    const status = mover.lastChannelStatus;
    assert.ok(status, `${testCase.terms.gameType}: active controller must have channel status`);
    const model = createSessionModel({
      channel: { status: channelStatusModelFromPayload(status) },
      game: {
        handKey: 1,
        activeIds: ids,
        currentHandIds: ids,
        lastDisplayedId: postMove.moverId,
        activeGameType: testCase.terms.gameType,
        handState: postMove.handState,
        instances: Object.fromEntries(
          ids.map((id) => [
            id,
            {
              id,
              amount: '100',
              coinHex: null,
              presentation: 'off-chain-their-turn' as const,
              terminal: INITIAL_GAME_TERMINAL_MODEL,
            },
          ]),
        ),
      },
      betweenHand: { lastTerms: testCase.terms },
    });
    await saveSession({
      ...afterMove,
      pairingToken: `real-restore-${testCase.terms.gameType}`,
      ...snapshotFromSessionModel(model),
    });
    await flushSessionSave();

    resetSaveState();
    const reloaded = await peekSession();
    assert.ok(reloaded, `${testCase.terms.gameType}: IndexedDB peek must return saved session`);
    assert.deepEqual(reloaded.currentHandGameIds, ids);
    assert.deepEqual(reloaded.activeGameIds, ids);

    const restored = new SessionController(poller, `feed000${index}`, 100n, 100n, {
      sendMessage: () => true,
      sendAck: () => true,
      sendKeepalive: () => true,
      hostLog: () => {},
      close: () => {},
    });
    try {
      await restored.beginRestore(
        restoreSession(restored, reloaded, new WasmStateInit(fetchPreset)),
      );
      assert.equal(restored.getRestoreStatus(), 'restored');
      assert.deepEqual(restored.activeGameIds, ids);
      assert.deepEqual(restored.handState, postMove.handState);
      assert.deepEqual(
        restored.getWasmFields()!.serializedGameSession,
        reloaded.serializedGameSession,
      );

      const restoredModel = sessionModelFromSave(reloaded);
      assert.deepEqual(restoredModel.game.currentHandIds, ids);
      assert.deepEqual(restoredModel.game.handState, postMove.handState);
      assert.equal(canRemountFinishedGameState(restoredModel.game.handState), testCase.canRemount);
      if (testCase.terms.gameType === 'krunk') {
        const krunk = krunkStateCodec.decode(restoredModel.game.handState);
        assert.ok(krunk);
        assert.deepEqual(Object.keys(krunk.games), ids);
        assert.notEqual(krunk.games[ids[0]].role, krunk.games[ids[1]].role);
      }
    } finally {
      restored.cleanup();
    }

    cradles.forEach((cradle) => cradle.shutdown());
    resetSaveState();
    await new Promise<void>((resolve) => {
      const request = indexedDB.deleteDatabase(SESSION_DB_NAME);
      request.onsuccess = () => resolve();
      request.onerror = () => resolve();
      request.onblocked = () => resolve();
    });
  }
}

interface KrunkSettlementTrace {
  phase: 'before-settled' | 'after-settled';
  gameId: string;
  state: KrunkGameState;
  terminal: GameTerminalModel;
  amount: string;
  myContribution: string;
  theirContribution: string;
}

async function runRealKrunkCompletionCase(poller: BlockchainPoller): Promise<void> {
  const cradles = await createActivePair(poller, 3);
  const controllers = cradles.map((cradle) => cradle.blob!) as [
    SessionController,
    SessionController,
  ];
  const terms: HandTermsModel = {
    gameType: 'krunk',
    myContribution: 100n,
    theirContribution: 100n,
    gameTimeout: 15n,
  };
  const traces: Array<
    Array<{ currentHandIds: string[]; payloadIds: string[]; activeIds: string[] }>
  > = [[], []];
  const errors: unknown[] = [];
  const runtimes: SessionMachineRuntime[] = [];
  const settlementTraces: KrunkSettlementTrace[][] = [[], []];

  const settlementTrace = (
    index: number,
    gameId: string,
    phase: KrunkSettlementTrace['phase'],
    terminal: GameTerminalModel,
  ): KrunkSettlementTrace => {
    const machine = runtimes[index].getState();
    const hand = krunkStateCodec.decode(machine.model.game.handState);
    const state = hand?.games[gameId];
    const amount = machine.model.game.instances[gameId]?.amount;
    assert.ok(state, `krunk completion player ${index}: missing state for ${gameId}`);
    assert.ok(amount, `krunk completion player ${index}: missing amount for ${gameId}`);
    return {
      phase,
      gameId,
      state,
      terminal,
      amount,
      myContribution: state.role === 'alice' ? amount : '0',
      theirContribution: state.role === 'alice' ? '0' : amount,
    };
  };

  for (const [index, controller] of controllers.entries()) {
    const status = controller.lastChannelStatus;
    assert.ok(status, `krunk completion player ${index}: missing active channel status`);
    const persist = async () => {
      const runtime = runtimes[index];
      assert.ok(
        runtime,
        `krunk completion player ${index}: persistence before runtime registration`,
      );
      const machine = runtime.getState();
      const currentHandIds = [...machine.model.game.currentHandIds];
      const hand = krunkStateCodec.decode(controller.handState);
      const payloadIds = hand ? Object.keys(hand.games) : [];
      traces[index].push({
        currentHandIds,
        payloadIds,
        activeIds: [...machine.model.game.activeIds],
      });
      await persistSessionSnapshot({
        controller,
        getState: () => runtime.getState(),
        restoring: false,
        getRestoreStatus: () => 'idle',
        getRestoreError: () => null,
        save: async (save) => {
          await saveSession(save);
          validateSessionSaveEnvelope((await peekSession())!);
        },
      });
    };
    const runtime = new SessionMachineRuntime(
      createSessionMachineState(
        createSessionModel({
          channel: { status: channelStatusModelFromPayload(status) },
          game: { handKey: 1 },
          betweenHand: { mode: 'compose-proposal', lastTerms: terms },
        }),
        { firstGameAccepted: true, iProposedHand: index === 0 },
      ),
      {
        controller,
        iStarted: index === 0,
        restoring: false,
        getRestoreStatus: () => 'idle',
        getRestoreError: () => null,
        emitGameplay: (event) => {
          if (!('Settled' in event)) return;
          const instance = runtimes[index].getState().model.game.instances[event.Settled.gameId];
          assert.ok(instance, `krunk completion player ${index}: missing settled instance`);
          settlementTraces[index].push(
            settlementTrace(index, event.Settled.gameId, 'after-settled', instance.terminal),
          );
        },
        onError: (error) => errors.push(error),
        persist,
      },
    );
    runtimes.push(runtime);
    controller.onFeatureStateTransition = (gameType, id, state) =>
      runtime.transitionFeatureState(gameType, id, state);
    controller.onSaveNeeded = persist;
    addActiveSubscription(
      controller.getObservable().subscribe((event) => {
        if (event.type === 'notification') {
          if ('GameSettled' in event.data && event.data.GameSettled) {
            const id = String(event.data.GameSettled.id);
            settlementTraces[index].push(
              settlementTrace(
                index,
                id,
                'before-settled',
                terminalInfoFromGameSettled(event.data.GameSettled, null),
              ),
            );
          }
          runtime.dispatch({
            type: 'wasm-notification',
            notification: event.data,
            iStarted: index === 0,
          });
        }
      }),
    );
  }

  const flushPersistence = async () => {
    await flushWrapperDrain(cradles);
    await Promise.all(controllers.map((controller) => controller.flushPendingSave()));
    await flushSessionSave();
    await Promise.resolve();
    assert.deepEqual(errors, []);
  };
  const exchangeAndPersist = async () => {
    await exchangeUntilIdle(cradles);
    await flushPersistence();
  };
  const word = Program.fromBytes(new TextEncoder().encode('CRANE'));

  try {
    runtimes[0].dispatch({ type: 'submit-compose', terms });
    await exchangeAndPersist();
    const review = runtimes[1].getState().model.betweenHand.reviewPeerProposal;
    assert.ok(review, 'krunk completion receiver must observe the real proposal');
    const ids = review.groupIds;
    assert.equal(ids.length, 2);

    runtimes[1].dispatch({ type: 'accept-review' });
    await exchangeAndPersist();

    controllers[0].makeMove(ids[0], word);
    await exchangeAndPersist();
    controllers[1].makeMove(ids[0], word);
    await exchangeAndPersist();
    controllers[0].makeMove(ids[0], null);
    await exchangeAndPersist();

    controllers[1].makeMove(ids[1], word);
    await exchangeAndPersist();
    controllers[0].makeMove(ids[1], word);
    await exchangeAndPersist();
    controllers[1].makeMove(ids[1], null);
    await exchangeAndPersist();

    for (const [index, runtime] of runtimes.entries()) {
      assert.deepEqual(runtime.getState().model.game.activeIds, []);
      assert.deepEqual(runtime.getState().model.game.currentHandIds, ids);
      const hand = krunkStateCodec.decode(runtime.getState().model.game.handState);
      assert.ok(hand);
      assert.deepEqual(Object.keys(hand.games), ids);
      assert.ok(
        traces[index].some(
          (trace) =>
            trace.activeIds.length === 1 &&
            trace.currentHandIds.join(',') === ids.join(',') &&
            trace.payloadIds.join(',') === ids.join(','),
        ),
        `krunk completion player ${index}: must persist the full pair after one member settles`,
      );
      for (const trace of traces[index]) {
        if (trace.currentHandIds.length === 0) continue;
        assert.deepEqual(
          trace.payloadIds,
          trace.currentHandIds,
          `krunk completion player ${index}: invalid persistence trace`,
        );
      }
    }

    for (const id of ids) {
      const byPlayer = settlementTraces.map((playerTraces, index) => {
        const before = playerTraces.filter(
          (trace) => trace.gameId === id && trace.phase === 'before-settled',
        );
        const after = playerTraces.filter(
          (trace) => trace.gameId === id && trace.phase === 'after-settled',
        );
        assert.equal(
          before.length,
          1,
          `krunk completion player ${index}: one terminal notification for ${id}`,
        );
        assert.equal(
          after.length,
          1,
          `krunk completion player ${index}: one terminal gameplay projection for ${id}`,
        );
        assert.equal(
          after[0].state.moverShare,
          before[0].state.moverShare,
          `krunk completion player ${index}: Settled must preserve moverShare for ${id}`,
        );
        if (before[0].state.outcome !== null) {
          assert.equal(
            after[0].state.outcome,
            before[0].state.outcome,
            `krunk completion player ${index}: Settled must preserve outcome for ${id}`,
          );
        }
        assert.equal(after[0].terminal.outcome, 'accept_settlement');
        assert.equal(after[0].terminal.myReward, before[0].terminal.myReward);
        return after[0];
      });

      assert.notEqual(byPlayer[0].state.role, byPlayer[1].state.role);
      assert.deepEqual(
        [byPlayer[0].state.outcome, byPlayer[1].state.outcome].sort(),
        ['lose', 'win'],
        `krunk completion ${id}: outcomes must be complementary`,
      );
      assert.equal(byPlayer[0].amount, byPlayer[1].amount);
      assert.equal(byPlayer[0].myContribution, byPlayer[1].theirContribution);
      assert.equal(byPlayer[0].theirContribution, byPlayer[1].myContribution);
      assert.equal(
        BigInt(byPlayer[0].terminal.myReward!) + BigInt(byPlayer[1].terminal.myReward!),
        BigInt(byPlayer[0].amount),
        `krunk completion ${id}: local shares must partition the game amount`,
      );

      const notices = [
        krunkBoardNotice(byPlayer[0].state, 'Bob', byPlayer[0].terminal, byPlayer[0].amount),
        krunkBoardNotice(byPlayer[1].state, 'Alice', byPlayer[1].terminal, byPlayer[1].amount),
      ];
      const winner = byPlayer[0].state.outcome === 'win' ? 0 : 1;
      const loser = winner ^ 1;
      const won = byPlayer[winner].terminal.myReward;
      assert.ok(won);
      if (byPlayer[winner].state.role === 'alice') {
        assert.equal(
          notices[winner]?.text,
          `${winner === 0 ? 'Bob' : 'Alice'} didn't win anything.`,
        );
        assert.equal(notices[loser]?.text, "You didn't win anything.");
      } else {
        assert.equal(notices[winner]?.text, `You won ${won} mojo!`);
        assert.equal(notices[loser]?.text, `${winner === 0 ? 'Alice' : 'Bob'} won ${won} mojo!`);
      }
    }

    const traceCountsBeforeSecondHand = traces.map((playerTraces) => playerTraces.length);
    runtimes[0].dispatch({ type: 'choose-same-terms' });
    await exchangeAndPersist();
    const cachedSecondProposal = runtimes[1].getState().model.betweenHand.cachedPeerProposal;
    assert.ok(cachedSecondProposal, 'krunk completion receiver must cache the same-terms proposal');
    const secondIds = cachedSecondProposal.groupIds;
    assert.equal(secondIds.length, 2);
    assert.notDeepEqual(secondIds, ids);

    runtimes[1].dispatch({ type: 'choose-same-terms' });
    await exchangeAndPersist();

    for (const [index, runtime] of runtimes.entries()) {
      assert.deepEqual(runtime.getState().model.game.currentHandIds, secondIds);
      const hand = krunkStateCodec.decode(runtime.getState().model.game.handState);
      assert.ok(hand);
      assert.deepEqual(Object.keys(hand.games), secondIds);
      const secondHandTraces = traces[index]
        .slice(traceCountsBeforeSecondHand[index])
        .filter(
          (trace) =>
            trace.currentHandIds.length === secondIds.length &&
            trace.currentHandIds.every((id, idIndex) => id === secondIds[idIndex]),
        );
      assert.ok(
        secondHandTraces.length >= 2,
        `krunk completion player ${index}: each second-hand member acceptance must persist`,
      );
      for (const trace of secondHandTraces) {
        assert.deepEqual(trace.currentHandIds, secondIds);
        assert.deepEqual(trace.payloadIds, secondIds);
      }
    }
  } finally {
    runtimes.forEach((runtime) => runtime.dispose());
    controllers.forEach((controller) => {
      controller.onFeatureStateTransition = null;
      controller.onSaveNeeded = null;
    });
  }
}
