import 'fake-indexeddb/auto';
import { SessionController } from '../../hooks/SessionController';
import type {
  ChiaGame,
  WasmConnection,
  WasmResult,
  InternalBlockchainInterface,
  PeerConnectionResult,
  SpendBundle,
  TransactionSubmission,
  ChannelStatusPayload,
} from '../../types/ChiaGaming';
import { BlockchainPoller } from '../../hooks/BlockchainPoller';
import { _resetForTests as resetSaveState, saveSession } from '../../hooks/save';
import { _resetGameIdentityWarmupForTests } from '../gameIdentities';
import { liveSave } from './session_save_envelope.fixtures';
import { TEST_PROTOCOL_IDS } from './protocolIdentities';
import type { ReadonlySessionReceivePolicy } from '../session/receivePolicy';
export const testIndexedDb = indexedDB;
export const mockRpc = new Proxy({ isConnected: () => true } as InternalBlockchainInterface, {
  get: (target, property) =>
    property in target ? Reflect.get(target, property) : () => Promise.resolve(undefined),
});

export function saveLiveSession(fields: Record<string, unknown>): Promise<void> {
  const save = liveSave(fields);
  return saveSession({
    scope: 'live',
    pairing: save.pairing,
    live: save.live,
    presentation: save.presentation,
    history: save.history,
  });
}
export const mockBlockchain = new BlockchainPoller(mockRpc, 60000);

export function wasmResult(overrides: Partial<WasmResult> = {}): WasmResult {
  return {
    events: [],
    watchCoins: [],
    unwatchCoins: [],
    actionSucceeded: true,
    disposition: { kind: 'active' },
    ...overrides,
  };
}

export function processWasmResult(
  controller: SessionController,
  overrides: Partial<WasmResult>,
): void {
  controller.processResult(wasmResult(overrides));
}

export const mockWasmConnection = new Proxy({} as WasmConnection, {
  get: (_target, property) => {
    if (property === 'game_session_serialization_schema') return () => 1;
    if (property === 'registered_game_packages') {
      return () => [...TEST_PROTOCOL_IDS];
    }
    return () => undefined;
  },
});

export function channelStatus(
  fields: Pick<ChannelStatusPayload, 'state'> & Partial<ChannelStatusPayload>,
): ChannelStatusPayload {
  return {
    advisory: null,
    coin: null,
    our_balance: null,
    their_balance: null,
    game_allocated: null,
    ...fields,
  };
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

export function enc(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

export function testSpendBundle(coinHex: string): SpendBundle {
  return {
    spends: [
      {
        coin: coinHex,
        bundle: {
          puzzle: '80',
          solution: '80',
          signature: '',
        },
      },
    ],
  };
}

export function makeMockCradle(
  onDeliver: (msg: Uint8Array) => Partial<WasmResult> | undefined = () => wasmResult(),
): ChiaGame {
  return {
    deliver_message: jest.fn((msg: Uint8Array) => {
      const result = onDeliver(msg);
      return result === undefined ? undefined : wasmResult(result);
    }),
    report_coin_states: jest.fn(() => wasmResult()),
    report_height: jest.fn(() => wasmResult()),
    snapshot_watched_coins: jest.fn(() => []),
    drain_submissions: jest.fn(() => []),
    configure_submission_fee: jest.fn(),
    finalize_submission: jest.fn(() => ({
      protocol_bundle: testSpendBundle('00'),
      bundle: {},
      applied_fee: '0',
      warning: null,
    })),
    acknowledge_submission: jest.fn(),
    reject_submission: jest.fn(),
    resubmit_submitted: jest.fn(),
    serialize: jest.fn(() => new Uint8Array([0])),
    go_on_chain: jest.fn(() => wasmResult()),
    abandon: jest.fn(() => wasmResult()),
    completeOutboundTerminalHandoff: jest.fn(() => wasmResult()),
    pendingTerminalHandoff: jest.fn(() => null),
    provide_coin_spend_bundle: jest.fn(() => wasmResult()),
    cradle: 0,
  } as unknown as ChiaGame;
}

export function makePeerConn(
  sentMessages: Array<{ msgno: number; msg: Uint8Array }>,
  sentAcks: number[],
  receivePolicy?: ReadonlySessionReceivePolicy,
): PeerConnectionResult {
  return {
    reliableState: {
      sessionId: '00'.repeat(16),
      messageNumber: 1n,
      remoteNumber: 0n,
      unackedMessages: [],
      disposition: 'active',
    },
    sendMessage: (msgno, msg) => {
      sentMessages.push({ msgno, msg });
      return true;
    },
    sendAck: (ackMsgno) => {
      sentAcks.push(ackMsgno);
      return true;
    },
    sendKeepalive: () => true,
    hostLog: () => {},
    close: () => {},
    receivePolicy,
  };
}

export interface TestHarness {
  blob: SessionController;
  cradle: ChiaGame;
  sentMessages: Array<{ msgno: number; msg: Uint8Array }>;
  sentAcks: number[];
}

const testPersistence = new WeakMap<SessionController, () => void | Promise<void>>();
const coordinatedControllers = new WeakSet<SessionController>();

export function setTestPersistence(
  blob: SessionController,
  persist: () => void | Promise<void>,
): void {
  testPersistence.set(blob, persist);
}

/**
 * Protocol unit tests intentionally isolate SessionController from React. Give
 * them an explicit coordinator instead of reviving the removed production
 * controller-owned persistence fallback.
 */
export function attachTestCommitCoordinator(blob: SessionController): void {
  if (coordinatedControllers.has(blob)) return;
  coordinatedControllers.add(blob);
  let dirty = false;
  const pendingExternalEffects = new Map<string, () => void>();
  let flushing: Promise<void> = Promise.resolve();
  let timer: ReturnType<typeof setTimeout> | null = null;
  const schedule = () => {
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      void coordinator.flush().catch(() => {});
    }, 0);
  };
  const coordinator = {
    requestCommit: () => {
      dirty = true;
      schedule();
    },
    enqueue: (work: () => void) => {
      work();
    },
    releaseAfterPersistence: (key: string, effect: () => void) => {
      if (pendingExternalEffects.has(key)) return;
      pendingExternalEffects.set(key, effect);
      dirty = true;
      schedule();
    },
    flush: (): Promise<void> => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      flushing = flushing
        .catch(() => {})
        .then(async () => {
          while (dirty) {
            try {
              dirty = false;
              blob.flushDeferredWork();
              const commit = blob.prepareReliableCommit();
              const externalEffects = [...pendingExternalEffects.entries()];
              const releaseExternalEffects = () => {
                for (const [key, effect] of externalEffects) {
                  if (pendingExternalEffects.get(key) !== effect) continue;
                  pendingExternalEffects.delete(key);
                  effect();
                }
              };
              try {
                const rejection = blob.prepareInboundSessionRejectPersistence();
                if (rejection) {
                  await rejection.write();
                } else {
                  await Promise.resolve(testPersistence.get(blob)?.());
                }
              } catch (error) {
                blob.completeReliableCommit(commit, false);
                releaseExternalEffects();
                throw error;
              }
              blob.completeReliableCommit(commit, true);
              releaseExternalEffects();
            } catch (error) {
              dirty = true;
              blob.reportDurabilityError(error);
              throw error;
            }
          }
        });
      return flushing;
    },
  };
  blob.attachTransactionCoordinator(coordinator);
}

/**
 * Returns a SessionController at qualifyingEvents=7 (system ready).
 * Setup: loadWasm → setGameSession → kickSystem(2) → qe=7.
 */
export function createReadyBlob(
  onDeliver?: (msg: Uint8Array) => Partial<WasmResult> | undefined,
  receivePolicy?: ReadonlySessionReceivePolicy,
): TestHarness {
  const sentMessages: Array<{ msgno: number; msg: Uint8Array }> = [];
  const sentAcks: number[] = [];
  const blob = new SessionController(
    mockBlockchain,
    'test',
    100n,
    100n,
    makePeerConn(sentMessages, sentAcks, receivePolicy),
  );
  const cradle = makeMockCradle(onDeliver);

  blob.loadWasm(mockWasmConnection);
  blob.setGameSession(cradle);
  blob.pairingToken = 'test-pairing';
  blob.rewardPuzzleHash = '11'.repeat(32);
  blob.kickSystem(2);
  attachTestCommitCoordinator(blob);
  blob.reportCoinStates(1n, []);
  setTestPersistence(blob, () =>
    saveLiveSession({
      blockchainType: 'simulator',
      serializedGameSession: cradle.serialize(),
      gameSessionSchemaVersion: 4n,
      pairingToken: blob.pairingToken,
      messageNumber: blob.messageNumber,
      remoteNumber: blob.remoteNumber,
      iStarted: blob.iStarted,
      myContribution: blob.myContribution.toString(),
      theirContribution: blob.theirContribution.toString(),
      perGameAmount: blob.perGameAmount.toString(),
      rewardPuzzleHash: blob.rewardPuzzleHash,
      activeGameIds: [],
      unackedMessages: blob.unackedMessages,
    }),
  );

  (cradle.deliver_message as jest.Mock).mockClear();
  (cradle.report_coin_states as jest.Mock).mockClear();
  sentMessages.length = 0;
  sentAcks.length = 0;
  trackedBlobs.push(blob);

  return { blob, cradle, sentMessages, sentAcks };
}

/** Returns a SessionController at qe=1 — messages will be buffered until kickSystem(2). */
export function createUnreadyBlob(
  onDeliver?: (msg: Uint8Array) => Partial<WasmResult> | undefined,
  receivePolicy?: ReadonlySessionReceivePolicy,
): TestHarness {
  const sentMessages: Array<{ msgno: number; msg: Uint8Array }> = [];
  const sentAcks: number[] = [];
  const blob = new SessionController(
    mockBlockchain,
    'test',
    100n,
    100n,
    makePeerConn(sentMessages, sentAcks, receivePolicy),
  );
  const cradle = makeMockCradle(onDeliver);

  blob.loadWasm(mockWasmConnection);
  blob.setGameSession(cradle);
  blob.pairingToken = 'test-pairing';
  blob.rewardPuzzleHash = '11'.repeat(32);
  attachTestCommitCoordinator(blob);
  setTestPersistence(blob, () =>
    saveLiveSession({
      blockchainType: 'simulator',
      serializedGameSession: cradle.serialize(),
      gameSessionSchemaVersion: 4n,
      pairingToken: blob.pairingToken,
      messageNumber: blob.messageNumber,
      remoteNumber: blob.remoteNumber,
      iStarted: blob.iStarted,
      myContribution: blob.myContribution.toString(),
      theirContribution: blob.theirContribution.toString(),
      perGameAmount: blob.perGameAmount.toString(),
      rewardPuzzleHash: blob.rewardPuzzleHash,
      activeGameIds: [],
      unackedMessages: blob.unackedMessages,
    }),
  );

  trackedBlobs.push(blob);

  return { blob, cradle, sentMessages, sentAcks };
}

let activeBlob: SessionController | null = null;

export function setActiveBlob(blob: SessionController | null): void {
  if (blob) attachTestCommitCoordinator(blob);
  activeBlob = blob;
}
const trackedBlobs: SessionController[] = [];

export function setTestGlobal(key: string, value: unknown) {
  Object.defineProperty(globalThis, key, {
    configurable: true,
    writable: true,
    value,
  });
}

export function clearTestGlobal(key: string) {
  Reflect.deleteProperty(globalThis, key);
}

beforeEach(() => {
  setTestGlobal('localStorage', makeStorage());
  setTestGlobal('sessionStorage', makeStorage());
  setTestGlobal('indexedDB', testIndexedDb);
});

afterEach(async () => {
  const toFlush = activeBlob;
  activeBlob = null;
  const tracked = [...trackedBlobs];
  trackedBlobs.length = 0;
  try {
    if (toFlush) {
      try {
        await toFlush.flushPendingWork();
      } finally {
        toFlush.cleanup();
      }
    }
    for (const blob of tracked) {
      if (blob === toFlush) continue;
      try {
        await blob.flushPendingWork();
      } finally {
        blob.cleanup();
      }
    }
  } finally {
    resetSaveState();
    _resetGameIdentityWarmupForTests();
    clearTestGlobal('localStorage');
    clearTestGlobal('sessionStorage');
  }
});

export async function transactionSubmitQueue(blob: SessionController): Promise<void> {
  await blob.flushPendingSave();
  await (blob as unknown as { transactionSubmitQueue: Promise<void> }).transactionSubmitQueue;
  await blob.flushPendingSave();
}

export function submitTransaction(
  blob: SessionController,
  bundle: SpendBundle,
  fee_request: { target: string; amount: string } | null = null,
): void {
  if (!blob.rewardPuzzleHash) {
    blob.rewardPuzzleHash = '11'.repeat(32);
  }
  const submission: TransactionSubmission = {
    id: `test-${Math.random()}`,
    bundle,
    fee_request,
  };
  (
    blob as unknown as { submitTransaction: (submission: TransactionSubmission) => void }
  ).submitTransaction(submission);
}

export async function flushPromiseJobs(): Promise<void> {
  await Promise.resolve();
}
