import {
  init,
  config_scaffold,
  create_game_session,
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
  loadGameHexes,
} from '../../hooks/WasmStateInit';
import { getSearchParams, empty, getRandomInt, getEvenHexString } from '../../util';
import WholeWasmObject from '../../../node-pkg/chia_gaming_wasm.js';
import {
  PeerConnectionResult,
  WasmEvent,
} from '../../types/ChiaGaming';
import { BLOCKCHAIN_SERVICE_URL } from '../../settings';
import {
  fakeBlockchainInfo,
} from '../../hooks/FakeBlockchainInterface';
import {
  _resetForTests as resetSaveState,
  flushSessionState,
  hasSavedSessionMarker,
  peekSession,
  saveSession,
} from '../../hooks/save';
import { SESSION_DB_NAME } from '../session/indexedDb';
import { setDiagSink } from '../../services/log';
import { BlockchainPoller } from '../../hooks/BlockchainPoller';
import { configSessionController } from '../../hooks/blobSingleton';
import { SessionController } from '../../hooks/SessionController';
import 'fake-indexeddb/auto';
// @ts-ignore
import * as fs from 'fs';
// @ts-ignore
import { resolve } from 'path';
// @ts-ignore
import * as assert from 'assert';

function rooted(name: string) {
  // @ts-ignore
  return resolve(__dirname, '../../../..', name);
}

async function fetchPreset(key: string): Promise<Uint8Array> {
  return new Uint8Array(fs.readFileSync(rooted(key)));
}

async function fetchHex(key: string): Promise<string> {
  return fs.readFileSync(rooted(key), 'utf8');
}

function preset_file(name: string) {
  deposit_file(name, new Uint8Array(fs.readFileSync(rooted(name))));
}

interface SimpleMessage { msgno: number; msg: Uint8Array };

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

function describeThrown(e: unknown): string {
  if (e instanceof Error) {
    return `${e.name}: ${e.message}\n${e.stack ?? ''}`;
  }
  // Empty/undefined/non-Error rejections are exactly the opaque case that
  // produced blank CI failures, so record the shape explicitly.
  const shape = `typeof=${typeof e} ctor=${
    e && typeof e === 'object' ? ((e as { constructor?: { name?: string } }).constructor?.name ?? '?') : 'n/a'
  }`;
  try {
    return `non-Error thrown (${shape}): ${JSON.stringify(e)}`;
  } catch {
    return `non-Error thrown (${shape}): ${String(e)}`;
  }
}

// Durable diagnostic file.  Everything in CI dies the moment the test process
// is torn down, and a dying jest worker loses its buffered stderr -- so the one
// error we care about never reaches the GitHub log.  A *synchronous* file
// append lands on disk immediately and survives the worker dying; a later shell
// step `cat`s this file into the live Actions log.  The path is overridable so
// the workflow and the test agree on it.
const DIAG_FILE = process.env.LOAD_WASM_DIAG_FILE
  || resolve(__dirname, '../../..', 'load_wasm_diag.log');

function diagFileWrite(line: string): void {
  try {
    fs.appendFileSync(DIAG_FILE, line.endsWith('\n') ? line : line + '\n');
  } catch { /* never let logging throw */ }
}

// Write to the durable file first (must survive teardown), then to stderr for
// live visibility during the test.
function diagAll(line: string): void {
  diagFileWrite(line);
  try { process.stderr.write(line + '\n'); } catch { /* ignore */ }
}

function testLog(message: string): void {
  diagAll(`[load_wasm] ${message}`);
}

let lateRejection: string | null = null;

function onUnhandledRejection(reason: unknown): void {
  const desc = describeThrown(reason);
  diagAll(`DIAG_LOADWASM unhandledRejection: ${desc}`);
  lateRejection = desc;
}

function onUncaughtException(error: unknown): void {
  const desc = describeThrown(error);
  diagAll(`DIAG_LOADWASM uncaughtException: ${desc}`);
  lateRejection = desc;
}

// Records the final exit code so a hard worker crash (e.g. a wasm abort that
// throws no catchable JS error) is distinguishable from a clean exit -- the
// last lines in the diag file then show exactly how far execution got.
function onProcessExit(code: number): void {
  diagFileWrite(`DIAG_LOADWASM process exit code=${code}`);
}

beforeAll(() => {
  // Truncate any stale file from a previous run so the cat shows only this run.
  try { fs.writeFileSync(DIAG_FILE, `DIAG_LOADWASM diag file start ${new Date().toISOString()}\n`); } catch { /* ignore */ }
  // Route the cradle/poller/blockchain diagnostics (which go through the shared
  // log module's diagStack/diagNote) into the same durable file.
  setDiagSink(diagFileWrite);
  setTestGlobal('localStorage', makeStorage());
  process.on('unhandledRejection', onUnhandledRejection);
  process.on('uncaughtException', onUncaughtException);
  process.on('exit', onProcessExit);
});

beforeEach(async () => {
  resetSaveState();
  await new Promise<void>((resolve) => {
    const request = indexedDB.deleteDatabase(SESSION_DB_NAME);
    request.onsuccess = () => resolve();
    request.onerror = () => resolve();
    request.onblocked = () => resolve();
  });
});

afterAll(async () => {
  // Deliberately DO NOT remove the rejection handlers here.  The CI failure we
  // are chasing is a late async rejection that fires *after* afterAll runs;
  // with the handlers removed it reached jest's framework handler and produced
  // an opaque empty-message failure.  Leaving them installed (with the loud
  // DIAG_LOADWASM logging above) means the actual reason + stack always lands
  // in the CI output.  These are process-global handlers in a short-lived test
  // process, so leaving them attached is harmless.
  //
  // Drain a little here so a late rejection has a chance to fire and be logged
  // before the test process exits.
  await new Promise<void>((r) => setTimeout(r, 500));
  if (lateRejection) {
    diagAll(`DIAG_LOADWASM late rejection captured during run:\n${lateRejection}`);
  }
  diagAll('DIAG_LOADWASM afterAll complete');
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
    testLog('cleanup start');
    await cleanupActiveResources();
    testLog('cleanup after resources');
    resetSaveState();
    testLog('cleanup done');
    // Drain microtask queue to catch late async errors.  Widened from 50ms to
    // give in-flight teardown async (poller RPCs rejecting on disconnect, the
    // submit queue, reconnect loop) time to settle inside the test boundary so
    // it fails here with a real message instead of escaping past afterAll.
    await new Promise<void>((r) => setTimeout(r, 300));
    if (lateRejection) {
      const msg = lateRejection;
      lateRejection = null;
      throw new Error(`[load_wasm late async error]\n${msg}`);
    }
  } catch (e) {
    const desc = describeThrown(e);
    testLog(`CLEANUP FAILURE: ${desc}`);
    throw new Error(`[load_wasm cleanup failed]\n${desc}`);
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
    let w = this.waiting_messages;
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

function assertCradleRoundTrip(
  stage: string,
  controller: SessionController,
): Uint8Array {
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
  const protocolType = state.split('\n', 1)[0];
  try {
    const restoredId = WholeWasmObject.create_serialized_game(
      serialized,
      `reload-regression-${stage}`,
    );
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
      `protocol=${state}\n${describeThrown(e)}`,
    );
  }
  testLog(
    `${stage}: bytes=${serialized.byteLength} byteOffset=${serialized.byteOffset} ` +
    `protocol=${protocolType}`,
  );
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
  let cradles = [cradle1, cradle2];
  let subscriptions: Subscription[] = [];

  // The poller drives each cradle's coin polling directly via report_coin_states.
  cradles.forEach((c) => {
    if (c.blob) poller.attachGameSession(c.blob);
  });

  let evt_results: Array<boolean> = cradles.map((c) => c.observedActiveStatus());
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
    let iterations = 0;
    const startedAt = Date.now();
    while (!all_handshaked(cradles)) {
      iterations++;
      let deliveredOutbound = false;
      for (let c = 0; c < 2; c++) {
        let outbound = cradles[c].outbound_messages();
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
        await fakeBlockchainInfo.waitForNextBlock();
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
      throw new Error(`we expected running state in both cradles, got active=${evt_results.join(',')} ready=${cradles.map((c) => c.handshaked()).join(',')}`);
    }
  } finally {
    subscriptions.forEach((sub) => sub.unsubscribe());
    cradles.forEach((c) => {
      if (c.blob) poller.detachGameSession(c.blob);
    });
  }
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
  let gameObject = new SessionController(
    blockchain,
    uniqueId,
    myContribution,
    theirContribution,
    peer_conn,
  );

  let gameHexes = await loadGameHexes(fetchHex);
  await configSessionController(gameObject, iStarted, wasmStateInit, gameHexes, blockchain, uniqueId);

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
  'persists and reloads a live intermediate handshake cradle',
  async () => {
    lateRejection = null;
    const offConnectionLog = fakeBlockchainInfo.onConnectionChange((connected) => {
      testLog(`sim connection=${connected}`);
    });
    try {
      if (!(await isSimulatorAvailable())) {
        // In CI the sim is supposed to be up; treating "no sim" as a silent skip
        // means a broken harness reports green.  When LOAD_WASM_REQUIRE_SIM is
        // set (the workflow sets it), make it a hard failure instead.
        const msg = `Simulator not running at ${BLOCKCHAIN_SERVICE_URL}`;
        if (process.env.LOAD_WASM_REQUIRE_SIM) {
          testLog(`FATAL: ${msg} but LOAD_WASM_REQUIRE_SIM is set`);
          throw new Error(`[load_wasm] ${msg} (LOAD_WASM_REQUIRE_SIM set)`);
        }
        console.warn(msg, '- skipping load_wasm test. Run ./ct.sh for full suite.');
        return;
      }
      testLog('simulator available');
      const setup = await fakeBlockchainInfo.beginConnect('block-producer');
      await setup.finalize();
      testLog(`after finalize connected=${fakeBlockchainInfo.isConnected()}`);
      testPoller = new BlockchainPoller(fakeBlockchainInfo, 1000, 2000);
      testPoller.start();
      testLog(`after poller start connected=${fakeBlockchainInfo.isConnected()}`);
      const poller = testPoller;

      const cradle1 = addActiveCradle(new SessionControllerAdapter());
      const cradle2 = addActiveCradle(new SessionControllerAdapter());
      let peer_conn1: PeerConnectionResult = {
        sendMessage: (msgno: number, message: Uint8Array) => {
          cradle1.add_outbound_message(msgno, message);
        },
        sendAck: (_ackMsgno: number) => {},
        sendKeepalive: () => {},
        hostLog: (msg: string) => process.stderr.write(msg + '\n'),
        close: () => {},
      };
      let wasm_init1 = new WasmStateInit(fetchPreset);
      storeInitArgs(async () => {}, WholeWasmObject);
      let wasm_blob1 = await initSessionController(
        poller,
        'a11ce000',
        true,
        peer_conn1,
        wasm_init1
      );
      wasm_blob1.onSaveNeeded = () => {
        const fields = wasm_blob1.getWasmFields();
        if (!fields) {
          return Promise.reject(new Error('Cannot persist session: WASM cradle serialization failed'));
        }
        return saveSession({
          ...fields,
          pairingToken: 'reload-regression-p1',
        });
      };
      cradle1.set_blob(wasm_blob1);
      testLog('after cradle1 init');

      let peer_conn2: PeerConnectionResult = {
        sendMessage: (msgno: number, message: Uint8Array) => {
          cradle2.add_outbound_message(msgno, message);
        },
        sendAck: (_ackMsgno: number) => {},
        sendKeepalive: () => {},
        hostLog: (msg: string) => process.stderr.write(msg + '\n'),
        close: () => {},
      };
      let wasm_init2 = new WasmStateInit(fetchPreset);
      let wasm_blob2 = await initSessionController(
        poller,
        'b0b77777',
        false,
        peer_conn2,
        wasm_init2
      );
      wasm_blob2.onSaveNeeded = () => {
        const fields = wasm_blob2.getWasmFields();
        if (!fields) {
          return Promise.reject(new Error('Cannot persist session: WASM cradle serialization failed'));
        }
        return saveSession({
          ...fields,
          pairingToken: 'reload-regression-p2',
        });
      };
      cradle2.set_blob(wasm_blob2);
      testLog('after cradle2 init');

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
      await fakeBlockchainInfo.waitForNextBlock();
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
      await flushSessionState();

      // Simulate marker-only boot + preference patches while resume dialog is open.
      resetSaveState();
      assert.ok(hasSavedSessionMarker());
      void saveSession({ diagnosticLog: ['boot-before-resume'] });
      await flushSessionState();

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
      const restoredId = WholeWasmObject.create_serialized_game(
        reloaded.serializedGameSession,
        'reload-regression-seed',
      );
      assert.equal(typeof restoredId, 'number');

      await flushWrapperDrain([cradle2]);
      assertCradleRoundTrip('receiver-wallet-offer-complete-sent-f', wasm_blob2);
      testLog(
        `reload regression makingOfferAcceptance=${makingOfferAcceptanceBytes.byteLength}` +
        ` restored=${reloaded.serializedGameSession.byteLength}`,
      );

      testLog('before action_with_messages');
      await action_with_messages(poller, cradle1, cradle2);
      testLog('after action_with_messages');
    } catch (e) {
      const desc = describeThrown(e);
      testLog(`TEST FAILURE: ${desc}`);
      throw new Error(`[load_wasm loads failed]\n${desc}`);
    } finally {
      offConnectionLog();
    }
  },
  120 * 1000,
);
