import 'fake-indexeddb/auto';
import { isBenignTransactionSubmitError, SessionController } from '../../hooks/SessionController';
import {
  ChiaGame,
  WasmConnection,
  WasmResult,
  InternalBlockchainInterface,
  PeerConnectionResult,
  SpendBundle,
} from '../../types/ChiaGaming';
import { BlockchainPoller } from '../../hooks/BlockchainPoller';
import { restoreSession } from '../../hooks/blobSingleton';
import { WasmStateInit } from '../../hooks/WasmStateInit';
import {
  _resetForTests as resetSaveState,
  flushSessionState,
  hasSavedSessionMarker,
  peekSession,
  saveSession,
  type SessionState,
} from '../../hooks/save';
import {
  DIAGNOSTIC_LOG_LIMIT,
  WASM_NOTIFICATION_HISTORY_LIMIT,
} from '../session/historyLimits';

const testIndexedDb = indexedDB;
const mockRpc = new Proxy({} as InternalBlockchainInterface, {
  get: () => () => Promise.resolve(undefined),
});
const mockBlockchain = new BlockchainPoller(mockRpc, 60000);

const mockWasmConnection = new Proxy({} as WasmConnection, {
  get: (_target, property) => property === 'cradle_serialization_schema'
    ? () => 1
    : () => undefined,
});

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

function enc(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

function testSpendBundle(coinHex: string): SpendBundle {
  return {
    spends: [{
      coin: coinHex,
      bundle: {
        puzzle: '80',
        solution: '80',
        signature: '',
      },
    }],
  };
}

function makeMockCradle(
  onDeliver: (msg: Uint8Array) => WasmResult | undefined = () => ({ events: [] }),
): ChiaGame {
  return {
    deliver_message: jest.fn((msg: Uint8Array) => onDeliver(msg)),
    new_block: jest.fn(() => ({ events: [] } as WasmResult)),
    report_coin_states: jest.fn(() => ({ events: [] } as WasmResult)),
    snapshot_watched_coins: jest.fn(() => []),
    drain_submissions: jest.fn(() => []),
    resubmit_submitted: jest.fn(),
    serialize: jest.fn(() => new Uint8Array([0])),
    go_on_chain: jest.fn(() => ({ events: [] } as WasmResult)),
    cradle: 0,
  } as unknown as ChiaGame;
}

function makePeerConn(
  sentMessages: Array<{ msgno: number; msg: Uint8Array }>,
  sentAcks: number[],
): PeerConnectionResult {
  return {
    sendMessage: (msgno, msg) => sentMessages.push({ msgno, msg }),
    sendAck: (ackMsgno) => sentAcks.push(ackMsgno),
    sendKeepalive: () => {},
    hostLog: () => {},
    close: () => {},
  };
}

interface TestHarness {
  blob: SessionController;
  cradle: ChiaGame;
  sentMessages: Array<{ msgno: number; msg: Uint8Array }>;
  sentAcks: number[];
}

/**
 * Returns a SessionController at qualifyingEvents=7 (system ready).
 * Setup: loadWasm → setGameCradle → kickSystem(2) → qe=7.
 */
function createReadyBlob(
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
  blob.setGameCradle(cradle);
  blob.kickSystem(2);
  blob.reportCoinStates(1n, []);
  blob.onSaveNeeded = () => saveSession({
    blockchainType: 'simulator',
    serializedCradle: cradle.serialize(),
    cradleSchemaVersion: 1n,
    messageNumber: blob.messageNumber,
    remoteNumber: blob.remoteNumber,
    unackedMessages: blob.unackedMessages,
  });

  (cradle.deliver_message as jest.Mock).mockClear();
  (cradle.report_coin_states as jest.Mock).mockClear();
  sentMessages.length = 0;
  sentAcks.length = 0;

  return { blob, cradle, sentMessages, sentAcks };
}

/** Returns a SessionController at qe=1 — messages will be buffered until kickSystem(2). */
function createUnreadyBlob(
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
  blob.setGameCradle(cradle);
  blob.onSaveNeeded = () => saveSession({
    blockchainType: 'simulator',
    serializedCradle: cradle.serialize(),
    cradleSchemaVersion: 1n,
    messageNumber: blob.messageNumber,
    remoteNumber: blob.remoteNumber,
    unackedMessages: blob.unackedMessages,
  });

  return { blob, cradle, sentMessages, sentAcks };
}

let activeBlob: SessionController | null = null;

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

beforeEach(() => {
  setTestGlobal('localStorage', makeStorage());
  setTestGlobal('sessionStorage', makeStorage());
  setTestGlobal('indexedDB', testIndexedDb);
});

afterEach(async () => {
  if (activeBlob) {
    await activeBlob.flushPendingWork();
    activeBlob.cleanup();
    activeBlob.onSaveNeeded = null;
  }
  activeBlob = null;
  resetSaveState();
  clearTestGlobal('localStorage');
  clearTestGlobal('sessionStorage');
});

function flushDeferredWork(blob: SessionController) {
  blob.flushDeferredWork();
}

function transactionSubmitQueue(blob: SessionController): Promise<void> {
  return (blob as unknown as { transactionSubmitQueue: Promise<void> }).transactionSubmitQueue;
}

async function flushPromiseJobs(): Promise<void> {
  await Promise.resolve();
}

describe('in-order delivery', () => {
  it('delivers messages 1, 2, 3 and ACKs each after durability flush', async () => {
    const { blob, cradle, sentAcks } = createReadyBlob();
    activeBlob = blob;

    blob.deliverMessage(1n, enc('a'));
    blob.deliverMessage(2n, enc('b'));
    blob.deliverMessage(3n, enc('c'));

    expect(blob.remoteNumber).toBe(3n);
    expect(sentAcks).toEqual([]);
    await blob.flushPendingWork();
    expect(sentAcks).toEqual([1, 2, 3]);
    expect((await peekSession())?.remoteNumber).toBe(3n);
    expect(cradle.deliver_message).toHaveBeenCalledTimes(3);
    expect(
      (cradle.deliver_message as jest.Mock).mock.calls.map((c: any[]) => c[0]),
    ).toEqual([enc('a'), enc('b'), enc('c')]);
  });
});

describe('lifecycle flush', () => {
  it('drains transient handshake events before resolving the save flush', async () => {
    const outbound = enc('next-handshake-message');
    const { blob, sentMessages } = createReadyBlob(() => ({
      events: [{ OutboundMessage: outbound }],
    }));
    activeBlob = blob;

    blob.deliverMessage(1n, enc('incoming-handshake-message'));
    await blob.flushPendingSave();

    expect(sentMessages).toEqual([{ msgno: 1, msg: outbound }]);
    const saved = await peekSession();
    expect(saved?.remoteNumber).toBe(1n);
    expect(saved?.messageNumber).toBe(2n);
    expect(saved?.unackedMessages).toEqual([{ msgno: 1n, msg: outbound }]);
  });
});

describe('duplicate detection', () => {
  it('delivers once but ACKs twice after pending durability flush', async () => {
    const { blob, cradle, sentAcks } = createReadyBlob();
    activeBlob = blob;

    blob.deliverMessage(1n, enc('a'));
    blob.deliverMessage(1n, enc('a'));

    expect(cradle.deliver_message).toHaveBeenCalledTimes(1);
    await blob.flushPendingWork();
    expect(sentAcks).toEqual([1, 1]);
  });

  it('retransmits unacked outbound when a duplicate inbound arrives (post-reload peer)', async () => {
    const { blob, sentMessages, sentAcks } = createReadyBlob();
    activeBlob = blob;
    const offer = enc('offer-sent-payload');
    blob.unackedMessages = [{ msgno: 2n, msg: offer }];

    blob.deliverMessage(1n, enc('first'));
    await blob.flushPendingWork();
    sentMessages.length = 0;
    sentAcks.length = 0;

    // Peer reloaded and resent msgno 1; we must replay our still-unacked offer.
    blob.deliverMessage(1n, enc('first-again'));
    await blob.flushPendingWork();

    expect(sentAcks).toEqual([1]);
    expect(sentMessages).toEqual([{ msgno: 2, msg: offer }]);
  });
});

describe('keepalive retransmission', () => {
  it('retransmits unacked outbound when a peer keepalive arrives', () => {
    const { blob, sentMessages } = createReadyBlob();
    activeBlob = blob;
    const pending = enc('pending-offer');
    blob.unackedMessages = [{ msgno: 3n, msg: pending }];

    blob.receiveKeepalive();

    expect(sentMessages).toEqual([{ msgno: 3, msg: pending }]);
  });

  it('does not send when there is nothing unacked', () => {
    const { blob, sentMessages } = createReadyBlob();
    activeBlob = blob;

    blob.receiveKeepalive();

    expect(sentMessages).toEqual([]);
  });
});

describe('out-of-order delivery with reorder queue', () => {
  it('delivers 3, 1, 2 → cradle sees a, b, c in order', async () => {
    const delivered: Uint8Array[] = [];
    const { blob, sentAcks } = createReadyBlob((msg) => {
      delivered.push(msg);
      return { events: [] };
    });
    activeBlob = blob;

    blob.deliverMessage(3n, enc('c'));
    blob.deliverMessage(1n, enc('a'));
    blob.deliverMessage(2n, enc('b'));

    expect(delivered).toEqual([enc('a'), enc('b'), enc('c')]);
    expect(blob.remoteNumber).toBe(3n);
    await blob.flushPendingWork();
    expect(sentAcks).toEqual([1, 2, 3]);
  });
});

describe('buffering before system ready, then spill', () => {
  it('buffers messages and delivers when system reaches qe=7', async () => {
    const { blob, cradle, sentAcks } = createUnreadyBlob();
    activeBlob = blob;

    blob.deliverMessage(1n, enc('a'));
    blob.deliverMessage(2n, enc('b'));
    expect(cradle.deliver_message).not.toHaveBeenCalled();

    blob.kickSystem(2);

    expect(cradle.deliver_message).toHaveBeenCalledTimes(2);
    expect(blob.remoteNumber).toBe(2n);
    await blob.flushPendingWork();
    expect(sentAcks).toEqual([1, 2]);
  });

  it('delivers out-of-order buffered messages in correct order', () => {
    const delivered: Uint8Array[] = [];
    const { blob, sentAcks } = createUnreadyBlob((msg) => {
      delivered.push(msg);
      return { events: [] };
    });
    activeBlob = blob;

    blob.deliverMessage(2n, enc('b'));
    blob.deliverMessage(1n, enc('a'));
    expect(delivered).toEqual([]);

    blob.kickSystem(2);

    expect(delivered).toEqual([enc('a'), enc('b')]);
    expect(blob.remoteNumber).toBe(2n);
  });
});

describe('ACK pruning', () => {
  it('removes messages ≤ ackMsgno from unackedMessages', () => {
    const { blob } = createReadyBlob();
    activeBlob = blob;

    blob.unackedMessages = [
      { msgno: 1n, msg: enc('a') },
      { msgno: 2n, msg: enc('b') },
      { msgno: 3n, msg: enc('c') },
    ];
    blob.receiveAck(2n);

    expect(blob.unackedMessages).toEqual([{ msgno: 3n, msg: enc('c') }]);
  });
});

describe('outbound message numbering', () => {
  it('assigns sequential numbers and tracks in unackedMessages', async () => {
    const helloBytes = enc('hello');
    const { blob, sentMessages } = createReadyBlob(() => ({
      events: [{ OutboundMessage: helloBytes }],
    }));
    activeBlob = blob;

    blob.deliverMessage(1n, enc('trigger'));
    blob.flushDeferredWork();
    await blob.flushPendingWork();

    expect(sentMessages).toEqual([{ msgno: 1, msg: helloBytes }]);
    expect(blob.unackedMessages).toContainEqual({ msgno: 1n, msg: helloBytes });

    blob.deliverMessage(2n, enc('trigger2'));
    blob.flushDeferredWork();
    await blob.flushPendingWork();

    expect(sentMessages[1]).toEqual({ msgno: 2, msg: helloBytes });
    expect(blob.messageNumber).toBe(3n);
  });
});

describe('bounded controller histories', () => {
  it('keeps only recent WASM notifications and diagnostic lines', () => {
    const { blob } = createReadyBlob();
    activeBlob = blob;
    blob.processResult({
      events: [
        ...Array.from(
          { length: WASM_NOTIFICATION_HISTORY_LIMIT + 2 },
          (_, i) => ({ Notification: { ActionFailed: { reason: `notification-${i}` } } }),
        ),
        ...Array.from(
          { length: DIAGNOSTIC_LOG_LIMIT + 2 },
          (_, i) => ({ Log: `diagnostic-${i}` }),
        ),
      ],
    });
    blob.flushDeferredWork();

    expect(blob.wasmNotificationHistory).toHaveLength(WASM_NOTIFICATION_HISTORY_LIMIT);
    expect(blob.wasmNotificationHistory[0]).toContain('notification-2');
    expect(blob.diagnosticLog).toHaveLength(DIAGNOSTIC_LOG_LIMIT);
    expect(blob.diagnosticLog[0]).toBe('diagnostic-2');
  });
});

describe('durability failures', () => {
  it('warns the user and retains messages and ACKs until a retry succeeds', async () => {
    const helloBytes = enc('hello');
    const { blob, sentMessages, sentAcks } = createReadyBlob(() => ({
      events: [{ OutboundMessage: helloBytes }],
    }));
    activeBlob = blob;
    const warnings: string[] = [];
    const sub = blob.getObservable().subscribe((event) => {
      if (event.type === 'durability-error') warnings.push(event.error);
    });
    clearTestGlobal('indexedDB');

    blob.deliverMessage(1n, enc('trigger'));
    blob.flushDeferredWork();
    await expect(blob.flushPendingWork()).rejects.toThrow('IndexedDB is unavailable');

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('remain queued');
    expect(sentMessages).toEqual([]);
    expect(sentAcks).toEqual([]);
    expect(blob.unackedMessages).toContainEqual({ msgno: 1n, msg: helloBytes });

    setTestGlobal('indexedDB', testIndexedDb);
    await blob.flushPendingSave();
    await blob.flushPendingWork();

    expect(sentMessages).toEqual([{ msgno: 1, msg: helloBytes }]);
    expect(sentAcks).toEqual([1]);
    sub.unsubscribe();
  });

  it('requires onSaveNeeded to update cached synchronously before returning', async () => {
    const { loadAppState } = await import('../../hooks/save');
    const outbound = enc('outbound');
    const { blob, cradle, sentMessages } = createReadyBlob(() => ({
      events: [{ OutboundMessage: outbound }],
    }));
    activeBlob = blob;

    const cradleBytes = new Uint8Array([7, 7, 7, 7]);
    (cradle.serialize as jest.Mock).mockReturnValue(cradleBytes);
    let saveReturned = false;
    blob.onSaveNeeded = () => {
      const pending = saveSession({
        serializedCradle: cradle.serialize(),
        cradleSchemaVersion: 1n,
        pairingToken: 'sync-cradle',
      });
      // Cached must already contain the cradle before the returned Promise
      // settles — durability flushes immediately after starting onSaveNeeded.
      expect(loadAppState().serializedCradle).toEqual(cradleBytes);
      saveReturned = true;
      return pending;
    };

    blob.deliverMessage(1n, enc('trigger'));
    await blob.flushPendingWork();

    expect(saveReturned).toBe(true);
    expect((await peekSession())?.serializedCradle).toEqual(cradleBytes);
    expect(sentMessages).toEqual([{ msgno: 1, msg: outbound }]);
  });

  it('blocks delivery and preserves the durable record when cradle serialization fails', async () => {
    const outbound = enc('outbound');
    const { blob, cradle, sentMessages, sentAcks } = createReadyBlob(() => ({
      events: [{ OutboundMessage: outbound }],
    }));
    activeBlob = blob;
    void saveSession({
      serializedCradle: new Uint8Array([9, 9, 9]),
      cradleSchemaVersion: 1n,
      pairingToken: 'previous-durable-record',
    });
    await flushSessionState();
    (cradle.serialize as jest.Mock).mockImplementation(() => {
      throw new Error('malformed cradle serialization');
    });
    blob.onSaveNeeded = () => {
      const fields = blob.getWasmFields();
      if (!fields) {
        return Promise.reject(new Error('Cannot persist session: WASM cradle serialization failed'));
      }
      return saveSession(fields);
    };

    blob.deliverMessage(1n, enc('trigger'));
    await expect(blob.flushPendingWork())
      .rejects
      .toThrow('WASM cradle serialization failed');

    expect(sentMessages).toEqual([]);
    expect(sentAcks).toEqual([]);
    blob.cleanup();
    activeBlob = null;
    expect((await peekSession())?.serializedCradle).toEqual(new Uint8Array([9, 9, 9]));
  });
});

describe('resendUnacked', () => {
  it('re-sends all un-acked messages via sendMessage', () => {
    const { blob, sentMessages } = createReadyBlob();
    activeBlob = blob;

    blob.unackedMessages = [
      { msgno: 1n, msg: enc('a') },
      { msgno: 2n, msg: enc('b') },
    ];
    blob.resendUnacked();

    expect(sentMessages).toEqual([
      { msgno: 1, msg: enc('a') },
      { msgno: 2, msg: enc('b') },
    ]);
  });
});

describe('restore ordering', () => {
  it('restores counters before spilling buffered messages and replaying unacked', async () => {
    const sentMessages: Array<{ msgno: number; msg: Uint8Array }> = [];
    const sentAcks: number[] = [];
    const blob = new SessionController(
      mockBlockchain,
      'test',
      100n,
      100n,
      makePeerConn(sentMessages, sentAcks),
    );
    activeBlob = blob;

    const cradle = makeMockCradle();
    const restoreWasmConnection = {
      cradle_serialization_schema: () => 1,
    } as unknown as WasmConnection;
    const wasmStateInit = {
      getWasmConnection: jest.fn(async () => restoreWasmConnection),
      deserializeGame: jest.fn(() => cradle),
    } as unknown as WasmStateInit;

    blob.kickSystem(2);
    blob.deliverMessage(1n, enc('already-processed'));
    await blob.flushPendingWork();
    const statuses: string[] = [];
    const unsubscribe = blob.onRestoreStatusChange((status) => statuses.push(status));

    await blob.beginRestore(
      restoreSession(
        blob,
        {
          version: 6n,
          playerId: 'p1',
          serializedCradle: new Uint8Array([1, 2, 3]),
          cradleSchemaVersion: 1n,
          messageNumber: 5n,
          remoteNumber: 1n,
          unackedMessages: [{ msgno: 4n, msg: enc('outbound') }],
          wasmNotificationHistory: ['notification'],
          diagnosticLog: ['diagnostic'],
        } as unknown as SessionState,
        wasmStateInit,
      ),
    );
    unsubscribe();

    expect(cradle.deliver_message).not.toHaveBeenCalled();
    expect(sentAcks).toEqual([1]);
    expect(sentMessages).toEqual([{ msgno: 4, msg: enc('outbound') }]);
    expect(cradle.resubmit_submitted).not.toHaveBeenCalled();
    expect(blob.messageNumber).toBe(5n);
    expect(blob.remoteNumber).toBe(1n);
    expect(blob.wasmNotificationHistory).toEqual(['notification']);
    expect(blob.diagnosticLog).toEqual(['diagnostic']);
    expect(statuses).toEqual(['idle', 'restoring', 'restored']);
    expect(blob.getRestoreStatus()).toBe('restored');
  });

  it('marks restore failures and emits an error event', async () => {
    const sentMessages: Array<{ msgno: number; msg: Uint8Array }> = [];
    const sentAcks: number[] = [];
    const blob = new SessionController(
      mockBlockchain,
      'test',
      100n,
      100n,
      makePeerConn(sentMessages, sentAcks),
    );
    activeBlob = blob;

    const errors: string[] = [];
    const sub = blob.getObservable().subscribe({
      next: (evt) => {
        if (evt.type === 'error') errors.push(evt.error);
      },
    });

    await expect(blob.beginRestore(Promise.reject(new Error('restore broke'))))
      .rejects
      .toThrow('restore broke');
    sub.unsubscribe();

    expect(blob.getRestoreStatus()).toBe('failed');
    expect(blob.getRestoreError()).toContain('restore broke');
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('restore broke');
  });

  it('does not expose stack frames in user-facing error events', async () => {
    const sentMessages: Array<{ msgno: number; msg: Uint8Array }> = [];
    const sentAcks: number[] = [];
    const blob = new SessionController(
      mockBlockchain,
      'test',
      100n,
      100n,
      makePeerConn(sentMessages, sentAcks),
    );
    activeBlob = blob;

    const errors: string[] = [];
    const sub = blob.getObservable().subscribe({
      next: (evt) => {
        if (evt.type === 'error') errors.push(evt.error);
      },
    });
    const err = new Error('wallet rejected spend');
    err.stack = 'spend@http://localhost:3002/app/17818440673N/index.js:50242:15';

    await expect(blob.beginRestore(Promise.reject(err)))
      .rejects
      .toThrow('wallet rejected spend');
    sub.unsubscribe();

    expect(errors).toEqual(['wallet rejected spend']);
    expect(blob.getRestoreError()).toBe('wallet rejected spend');
  });
});

describe('cradle serialization schema restore guard', () => {
  function makeRestoreHarness(deserializeGame: () => ChiaGame): {
    blob: SessionController;
    wasmStateInit: WasmStateInit;
    deserializeMock: jest.Mock;
  } {
    const blob = new SessionController(
      mockBlockchain,
      'test',
      100n,
      100n,
      makePeerConn([], []),
    );
    activeBlob = blob;
    const deserializeMock = jest.fn(deserializeGame);
    const wasmStateInit = {
      getWasmConnection: jest.fn(async () => ({
        cradle_serialization_schema: () => 1,
      } as unknown as WasmConnection)),
      deserializeGame: deserializeMock,
    } as unknown as WasmStateInit;
    return { blob, wasmStateInit, deserializeMock };
  }

  it.each([
    ['missing', undefined],
    ['mismatched', 2n],
  ])('rejects and deletes a record with a %s cradle schema', async (_label, cradleSchemaVersion) => {
    void saveSession({
      serializedCradle: new Uint8Array([1, 2, 3]),
      cradleSchemaVersion,
      pairingToken: 'restore-schema-test',
    });
    await flushSessionState();
    const { blob, wasmStateInit, deserializeMock } = makeRestoreHarness(makeMockCradle);
    const save = (await peekSession())!;

    await expect(restoreSession(blob, save, wasmStateInit))
      .rejects
      .toThrow('Unsupported saved game format');

    expect(deserializeMock).not.toHaveBeenCalled();
    expect(hasSavedSessionMarker()).toBe(true);
    expect(await peekSession()).toBeNull();
  });

  it('does not delete same-schema records that fail deserialization', async () => {
    void saveSession({
      serializedCradle: new Uint8Array([1, 2, 3]),
      cradleSchemaVersion: 1n,
      pairingToken: 'restore-corruption-test',
    });
    await flushSessionState();
    const { blob, wasmStateInit, deserializeMock } = makeRestoreHarness(() => {
      throw new Error('corrupt current-schema cradle');
    });
    const save = (await peekSession())!;

    await expect(restoreSession(blob, save, wasmStateInit))
      .rejects
      .toThrow('corrupt current-schema cradle');

    expect(deserializeMock).toHaveBeenCalledTimes(1);
    expect((await peekSession())?.serializedCradle).toEqual(new Uint8Array([1, 2, 3]));
  });
});

describe('cleanShutdown calls shut_down on cradle', () => {
  it('calls shut_down on cradle', () => {
    const sentMessages: Array<{ msgno: number; msg: Uint8Array }> = [];
    const sentAcks: number[] = [];
    const blob = new SessionController(mockBlockchain, 'test', 100n, 100n, makePeerConn(sentMessages, sentAcks));
    activeBlob = blob;

    const cradle = {
      ...makeMockCradle(),
      shut_down: jest.fn(() => ({ events: [] } as WasmResult)),
    } as unknown as ChiaGame;

    blob.loadWasm(mockWasmConnection);
    blob.setGameCradle(cradle);
    blob.kickSystem(2);
    blob.reportCoinStates(1n, []);

    blob.cleanShutdown();

    expect((cradle as any).shut_down).toHaveBeenCalled();
  });
});

describe('transaction submission', () => {
  it('applies watchCoins deltas without resampling the cradle snapshot', async () => {
    const queriedNames: string[][] = [];
    const blockchain = new BlockchainPoller(new Proxy(
      {
        getHeightInfo: () => Promise.resolve(1n),
        registerCoins: () => Promise.resolve(),
        getCoinRecordsByNames: (names: string[]) => {
          queriedNames.push(names);
          return Promise.resolve([]);
        },
      } as unknown as InternalBlockchainInterface,
      {
        get: (target, prop) =>
          (target as Record<string, unknown>)[prop as string] ??
          (() => Promise.resolve(undefined)),
      },
    ), 60000);
    const sentMessages: Array<{ msgno: number; msg: Uint8Array }> = [];
    const sentAcks: number[] = [];
    const blob = new SessionController(blockchain, 'test', 100n, 100n, makePeerConn(sentMessages, sentAcks));
    activeBlob = blob;
    const cradle = makeMockCradle();

    blob.loadWasm(mockWasmConnection);
    blob.setGameCradle(cradle);
    blob.attachBlockchain(blockchain);
    (cradle.snapshot_watched_coins as jest.Mock).mockClear();

    blob.processResult({
      events: [],
      watchCoins: [{ coin_name: 'aa', coin_string: 'coin-a' }],
    });
    await (blockchain as unknown as { pollOnce: () => Promise<void> }).pollOnce();

    expect(cradle.snapshot_watched_coins).not.toHaveBeenCalled();
    expect(queriedNames).toEqual([['aa']]);
    blob.detachBlockchain(blockchain);
  });

  it('refreshes watched coins when a hydrated cradle receives a later blockchain attach', async () => {
    const queriedNames: string[][] = [];
    const blockchain = new BlockchainPoller(new Proxy(
      {
        getHeightInfo: () => Promise.resolve(1n),
        registerCoins: () => Promise.resolve(),
        getCoinRecordsByNames: (names: string[]) => {
          queriedNames.push(names);
          return Promise.resolve([]);
        },
      } as unknown as InternalBlockchainInterface,
      {
        get: (target, prop) =>
          (target as Record<string, unknown>)[prop as string] ??
          (() => Promise.resolve(undefined)),
      },
    ), 60000);
    const sentMessages: Array<{ msgno: number; msg: Uint8Array }> = [];
    const sentAcks: number[] = [];
    const blob = new SessionController(null, 'test', 100n, 100n, makePeerConn(sentMessages, sentAcks));
    activeBlob = blob;
    const cradle = {
      ...makeMockCradle(),
      snapshot_watched_coins: jest.fn(() => [{ coin_name: 'bb', coin_string: 'coin-b' }]),
    } as unknown as ChiaGame;

    blob.loadWasm(mockWasmConnection);
    blob.setGameCradle(cradle);
    expect(queriedNames).toEqual([]);

    blob.attachBlockchain(blockchain);
    await (blockchain as unknown as { pollOnce: () => Promise<void> }).pollOnce();

    expect(cradle.snapshot_watched_coins).toHaveBeenCalledTimes(1);
    expect(queriedNames).toEqual([['bb']]);

    blob.attachBlockchain(blockchain);
    expect(cradle.snapshot_watched_coins).toHaveBeenCalledTimes(2);
    blob.detachBlockchain(blockchain);
  });

  it('hydrates without blockchain and replays retained submissions on later attach', async () => {
    const spend = jest.fn().mockResolvedValue('');
    const blockchain = new BlockchainPoller({
      ...mockRpc,
      spend,
      getHeightInfo: () => Promise.resolve(1n),
      registerCoins: () => Promise.resolve(),
      getCoinRecordsByNames: () => Promise.resolve([]),
    } as InternalBlockchainInterface, 60000);
    const sentMessages: Array<{ msgno: number; msg: Uint8Array }> = [];
    const sentAcks: number[] = [];
    const blob = new SessionController(null, 'test', 100n, 100n, makePeerConn(sentMessages, sentAcks));
    activeBlob = blob;
    const cradle = {
      ...makeMockCradle(),
      snapshot_watched_coins: jest.fn(() => [{ coin_name: 'cc', coin_string: 'coin-c' }]),
      drain_submissions: jest.fn(() => [testSpendBundle('05')]),
    } as unknown as ChiaGame;

    blob.loadWasm(mockWasmConnection);
    blob.setGameCradle(cradle);
    blob.processResult({ events: [] });

    expect(cradle.drain_submissions).not.toHaveBeenCalled();
    expect(spend).not.toHaveBeenCalled();

    blob.attachBlockchain(blockchain);
    await transactionSubmitQueue(blob);

    expect(cradle.resubmit_submitted).toHaveBeenCalledTimes(1);
    expect(cradle.drain_submissions).toHaveBeenCalledTimes(1);
    expect(spend).toHaveBeenCalledTimes(1);
    blob.detachBlockchain(blockchain);
  });

  it('submits drained transactions sequentially', async () => {
    let resolveFirst: (() => void) | null = null;
    const spend = jest.fn()
      .mockImplementationOnce(() => new Promise<string>((resolve) => {
        resolveFirst = () => resolve('');
      }))
      .mockResolvedValue('');
    const blockchain = new BlockchainPoller({
      ...mockRpc,
      spend,
    } as InternalBlockchainInterface, 60000);
    const sentMessages: Array<{ msgno: number; msg: Uint8Array }> = [];
    const sentAcks: number[] = [];
    const blob = new SessionController(blockchain, 'test', 100n, 100n, makePeerConn(sentMessages, sentAcks));
    activeBlob = blob;
    const cradle = {
      ...makeMockCradle(),
      drain_submissions: jest.fn(() => [testSpendBundle('01'), testSpendBundle('02')]),
    } as unknown as ChiaGame;

    blob.loadWasm(mockWasmConnection);
    blob.setGameCradle(cradle);
    blob.processResult({ events: [] });

    await flushPromiseJobs();
    expect(spend).toHaveBeenCalledTimes(1);
    resolveFirst?.();
    await transactionSubmitQueue(blob);
    expect(spend).toHaveBeenCalledTimes(2);
  });

  it('does not emit user-facing errors for benign stale spend rejections', async () => {
    expect(isBenignTransactionSubmitError(
      'spend rejected: status=[3,9] Conflicting transaction: overlapping spends [CoinID(Hash(a))]',
    )).toBe(true);
    expect(isBenignTransactionSubmitError(
      'spend rejected: status=[3,5] Coin not found: CoinID(Hash(b))',
    )).toBe(true);
    expect(isBenignTransactionSubmitError('spend rejected: status=[3,99] something else')).toBe(false);

    const spend = jest.fn()
      .mockRejectedValueOnce(new Error('spend rejected: status=[3,9] Conflicting transaction: overlapping spends []'))
      .mockRejectedValueOnce(new Error('spend rejected: status=[3,5] Coin not found: CoinID(Hash(c))'));
    const blockchain = new BlockchainPoller({
      ...mockRpc,
      spend,
    } as InternalBlockchainInterface, 60000);
    const sentMessages: Array<{ msgno: number; msg: Uint8Array }> = [];
    const sentAcks: number[] = [];
    const blob = new SessionController(blockchain, 'test', 100n, 100n, makePeerConn(sentMessages, sentAcks));
    activeBlob = blob;
    const errors: string[] = [];
    blob.getObservable().subscribe((evt) => {
      if (evt.type === 'error') errors.push(evt.error);
    });
    const cradle = {
      ...makeMockCradle(),
      drain_submissions: jest.fn(() => [testSpendBundle('03'), testSpendBundle('04')]),
    } as unknown as ChiaGame;

    blob.loadWasm(mockWasmConnection);
    blob.setGameCradle(cradle);
    blob.processResult({ events: [] });

    await transactionSubmitQueue(blob);
    expect(spend).toHaveBeenCalledTimes(2);
    expect(errors).toEqual([]);
  });
});
