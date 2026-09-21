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
  SubmissionDrainFailure,
  ChannelStatusPayload,
} from '../../types/ChiaGaming';
import { BlockchainPoller } from '../../hooks/BlockchainPoller';
import { storageRepository } from '../session/storageRepository';
import { _resetGameIdentityWarmupForTests } from '../gameIdentities';
import { liveSave } from './session_save_envelope.fixtures';
import { TEST_PROTOCOL_IDS } from './protocolIdentities';
import type { ReadonlySessionReceivePolicy } from '../session/receivePolicy';
import { createCoordinatorOnlySessionMachineRuntime } from './session_machine.harness';
import { storageRepository } from '../session/storageRepository';

export const testIndexedDb = indexedDB;
export const mockRpc = new Proxy(
  {
    isConnected: () => true,
    getWalletOfferProvider(this: Record<string, any>) {
      return {
        capability: 'best-effort' as const,
        scope: {
          provider: 'simulator' as const,
          identity: 'submission-handoff',
        },
        beginCreation: (operation, request) => this.beginWalletOffer(operation, request),
        cancel: (tradeId) => this.beginWalletOfferCancellation(tradeId),
      };
    },
  } as InternalBlockchainInterface,
  {
    get: (target, property) =>
      property in target ? Reflect.get(target, property) : () => Promise.resolve(undefined),
  },
);

export function saveLiveSession(fields: Record<string, unknown>): Promise<void> {
  const save = liveSave(fields);
  return storageRepository.saveSession({
    scope: 'live',
    walletProviderScope: (fields.walletProviderScope as
      | typeof save.walletProviderScope
      | undefined) ?? {
      provider: 'simulator',
      identity: 'submission-handoff',
    },
    pairing: save.pairing,
    live: save.live,
    presentation: save.presentation,
    history: save.history,
  });
}
export const mockBlockchain = new BlockchainPoller(mockRpc, 60000);

export function setTestBlockchain(blob: SessionController, blockchain: BlockchainPoller): void {
  blockchain.refreshWalletOperationProvider();
  blob.blockchain = blockchain;
}

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

export function submissionDrain(
  submissions: Array<
    Omit<TransactionSubmission, 'attempt_token' | 'predecessor_attempt_token' | 'relationship'> &
      Partial<
        Pick<TransactionSubmission, 'attempt_token' | 'predecessor_attempt_token' | 'relationship'>
      >
  > = [],
  retired_submission_ids: string[] = [],
  failures: SubmissionDrainFailure[] = [],
) {
  return {
    submissions: submissions.map((submission) => ({
      attempt_token: submission.id,
      predecessor_attempt_token: null,
      relationship: 'initial' as const,
      ...submission,
    })),
    retired_submission_ids,
    failures,
  };
}

export function makeMockCradle(
  onDeliver: (msg: Uint8Array) => Partial<WasmResult> | undefined = () => wasmResult(),
): ChiaGame {
  const finalizeSubmissionAttempt = jest.fn((_attemptToken: string, feeSourceJson?: string) => ({
    protocol_bundle: testSpendBundle('00'),
    bundle: {},
    applied_fee: '0',
    warning: null,
    fee_source_disposition: feeSourceJson === undefined ? 'not-requested' : 'attached',
    variant_fingerprint: 'bb'.repeat(32),
    should_broadcast: true,
  }));
  const acknowledgeSubmissionAttempt = jest.fn();
  const rejectSubmissionAttempt = jest.fn();
  const cradle = {
    deliver_message: jest.fn((msg: Uint8Array) => {
      const result = onDeliver(msg);
      return result === undefined ? undefined : wasmResult(result);
    }),
    report_coin_states: jest.fn(() => wasmResult()),
    report_height: jest.fn(() => wasmResult()),
    report_puzzle_and_solution: jest.fn(() => wasmResult()),
    snapshot_watched_coins: jest.fn(() => []),
    snapshot_pending_coin_solution_requests: jest.fn(() => []),
    coins_of_interest: jest.fn(() => []),
    drain_submissions: jest.fn(() => submissionDrain()),
    configure_submission_fee: jest.fn(),
    finalize_submission_attempt: finalizeSubmissionAttempt,
    acknowledge_submission_attempt: acknowledgeSubmissionAttempt,
    reject_submission_attempt: rejectSubmissionAttempt,
    submission_attempt_unavailable: jest.fn(),
    relinquish_submission_attempt: jest.fn(),
    chain_snapshot_ready: jest.fn(),
    request_fee_upgrades: jest.fn(),
    serialize: jest.fn(() => new Uint8Array([0])),
    go_on_chain: jest.fn(() => wasmResult()),
    abandon: jest.fn(() => wasmResult()),
    completeOutboundTerminalHandoff: jest.fn(() => wasmResult()),
    pendingTerminalHandoff: jest.fn(() => null),
    provide_coin_spend_bundle: jest.fn(() => wasmResult()),
    cradle: 0,
  } as unknown as ChiaGame;
  // Test-only aliases keep older assertion helpers readable while the
  // production ChiaGame/WASM surface remains token-only.
  const legacy = cradle as unknown as Record<string, unknown>;
  Object.defineProperties(legacy, {
    finalize_submission: {
      enumerable: true,
      get: () => cradle.finalize_submission_attempt,
      set: (value) => {
        legacy.finalize_submission_attempt = value;
      },
    },
    acknowledge_submission: {
      enumerable: true,
      get: () => cradle.acknowledge_submission_attempt,
      set: (value) => {
        legacy.acknowledge_submission_attempt = value;
      },
    },
    reject_submission: {
      enumerable: true,
      get: () => cradle.reject_submission_attempt,
      set: (value) => {
        legacy.reject_submission_attempt = value;
      },
    },
  });
  return cradle;
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
  createCoordinatorOnlySessionMachineRuntime(blob, () => testPersistence.get(blob)?.());
}

/**
 * Returns a SessionController at qualifyingEvents=7 (system ready).
 * Setup: loadWasm → setGameSession → kickSystem(2) → qe=7.
 */
export function createReadyBlob(
  onDeliver?: (msg: Uint8Array) => Partial<WasmResult> | undefined,
  receivePolicy?: ReadonlySessionReceivePolicy,
): TestHarness {
  if (trackedBlobs.length === 0) mockBlockchain.refreshWalletOperationProvider();
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
      walletProviderScope: blob.getWalletProviderScope(),
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
  if (trackedBlobs.length === 0) mockBlockchain.refreshWalletOperationProvider();
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
      walletProviderScope: blob.getWalletProviderScope(),
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

beforeEach(async () => {
  setTestGlobal('localStorage', makeStorage());
  setTestGlobal('sessionStorage', makeStorage());
  setTestGlobal('indexedDB', testIndexedDb);
  mockBlockchain.detachWalletOperationProvider();
  storageRepository._resetForTests();
  await storageRepository.claimLease();
  await storageRepository.saveWalletOperations([]);
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
    storageRepository._resetForTests();
    _resetGameIdentityWarmupForTests();
    clearTestGlobal('localStorage');
    clearTestGlobal('sessionStorage');
  }
});

export async function transactionSubmitQueue(blob: SessionController): Promise<void> {
  await blob.flushPendingSave();
  await blob.flushTransactionSubmissions();
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
    attempt_token: `attempt-${Math.random()}`,
    predecessor_attempt_token: null,
    relationship: 'initial',
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
