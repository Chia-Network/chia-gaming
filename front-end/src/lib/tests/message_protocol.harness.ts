import 'fake-indexeddb/auto';
import { SessionController } from '../../hooks/SessionController';
import type {
  ChiaGame,
  WasmConnection,
  WasmResult,
  InternalBlockchainInterface,
  PeerConnectionResult,
  SpendBundle,
  ChannelStatusPayload,
} from '../../types/ChiaGaming';
import { BlockchainPoller } from '../../hooks/BlockchainPoller';
import { _resetForTests as resetSaveState, saveSession } from '../../hooks/save';
import { liveSave } from './session_save_envelope.fixtures';
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

export const mockWasmConnection = new Proxy({} as WasmConnection, {
  get: (_target, property) =>
    property === 'game_session_serialization_schema' ? () => 1 : () => undefined,
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
  onDeliver: (msg: Uint8Array) => WasmResult | undefined = () => ({ events: [] }),
): ChiaGame {
  return {
    deliver_message: jest.fn((msg: Uint8Array) => onDeliver(msg)),
    report_coin_states: jest.fn(() => ({ events: [] }) as WasmResult),
    report_height: jest.fn(() => ({ events: [] }) as WasmResult),
    snapshot_watched_coins: jest.fn(() => []),
    drain_submissions: jest.fn(() => []),
    resubmit_submitted: jest.fn(),
    serialize: jest.fn(() => new Uint8Array([0])),
    go_on_chain: jest.fn(() => ({ events: [] }) as WasmResult),
    abandon: jest.fn(() => ({ events: [] }) as WasmResult),
    completeOutboundTerminalHandoff: jest.fn(() => ({ events: [] }) as WasmResult),
    pendingTerminalHandoff: jest.fn(() => null),
    provide_coin_spend_bundle: jest.fn(() => ({ events: [] }) as WasmResult),
    cradle: 0,
  } as unknown as ChiaGame;
}

export function makePeerConn(
  sentMessages: Array<{ msgno: number; msg: Uint8Array }>,
  sentAcks: number[],
): PeerConnectionResult {
  return {
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
  };
}

export interface TestHarness {
  blob: SessionController;
  cradle: ChiaGame;
  sentMessages: Array<{ msgno: number; msg: Uint8Array }>;
  sentAcks: number[];
}

/**
 * Returns a SessionController at qualifyingEvents=7 (system ready).
 * Setup: loadWasm → setGameSession → kickSystem(2) → qe=7.
 */
export function createReadyBlob(
  onDeliver?: (msg: Uint8Array) => WasmResult | undefined,
): TestHarness {
  const sentMessages: Array<{ msgno: number; msg: Uint8Array }> = [];
  const sentAcks: number[] = [];
  const blob = new SessionController(
    mockBlockchain,
    'test',
    100n,
    100n,
    makePeerConn(sentMessages, sentAcks),
  );
  const cradle = makeMockCradle(onDeliver);

  blob.loadWasm(mockWasmConnection);
  blob.setGameSession(cradle);
  blob.pairingToken = 'test-pairing';
  blob.rewardPuzzleHash = '11'.repeat(32);
  blob.kickSystem(2);
  blob.reportCoinStates(1n, []);
  blob.onSaveNeeded = () =>
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
    });

  (cradle.deliver_message as jest.Mock).mockClear();
  (cradle.report_coin_states as jest.Mock).mockClear();
  sentMessages.length = 0;
  sentAcks.length = 0;
  trackedBlobs.push(blob);

  return { blob, cradle, sentMessages, sentAcks };
}

/** Returns a SessionController at qe=1 — messages will be buffered until kickSystem(2). */
export function createUnreadyBlob(
  onDeliver?: (msg: Uint8Array) => WasmResult | undefined,
): TestHarness {
  const sentMessages: Array<{ msgno: number; msg: Uint8Array }> = [];
  const sentAcks: number[] = [];
  const blob = new SessionController(
    mockBlockchain,
    'test',
    100n,
    100n,
    makePeerConn(sentMessages, sentAcks),
  );
  const cradle = makeMockCradle(onDeliver);

  blob.loadWasm(mockWasmConnection);
  blob.setGameSession(cradle);
  blob.pairingToken = 'test-pairing';
  blob.rewardPuzzleHash = '11'.repeat(32);
  blob.onSaveNeeded = () =>
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
    });

  trackedBlobs.push(blob);

  return { blob, cradle, sentMessages, sentAcks };
}

let activeBlob: SessionController | null = null;

export function setActiveBlob(blob: SessionController | null): void {
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
    clearTestGlobal('localStorage');
    clearTestGlobal('sessionStorage');
  }
});

export function transactionSubmitQueue(blob: SessionController): Promise<void> {
  return (blob as unknown as { transactionSubmitQueue: Promise<void> }).transactionSubmitQueue;
}

export function submitTransaction(blob: SessionController, tx: SpendBundle): void {
  if (!blob.rewardPuzzleHash) {
    blob.rewardPuzzleHash = '11'.repeat(32);
  }
  (blob as unknown as { submitTransaction: (tx: SpendBundle) => void }).submitTransaction(tx);
}

export async function flushPromiseJobs(): Promise<void> {
  await Promise.resolve();
}
