import 'fake-indexeddb/auto';
import { isBenignTransactionSubmitError, SessionController } from '../../hooks/SessionController';
import {
  ChiaGame,
  WasmConnection,
  WasmResult,
  InternalBlockchainInterface,
  PeerConnectionResult,
  SpendBundle,
  NeedCoinSpendRequest,
} from '../../types/ChiaGaming';
import { BlockchainPoller } from '../../hooks/BlockchainPoller';
import {
  destroySessionController,
  getOrCreateSessionController,
  isTransactionPublishNerfed,
  restoreSession,
  setTransactionPublishNerfed,
  subscribeTransactionPublishNerfed,
} from '../../hooks/blobSingleton';
import { WasmStateInit } from '../../hooks/WasmStateInit';
import {
  _resetForTests as resetSaveState,
  flushSessionSave,
  hasSavedSessionMarker,
  peekSession,
  saveSession,
  type SessionSave,
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
  get: (_target, property) => property === 'game_session_serialization_schema'
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
    report_coin_states: jest.fn(() => ({ events: [] } as WasmResult)),
    report_height: jest.fn(() => ({ events: [] } as WasmResult)),
    snapshot_watched_coins: jest.fn(() => []),
    drain_submissions: jest.fn(() => []),
    resubmit_submitted: jest.fn(),
    serialize: jest.fn(() => new Uint8Array([0])),
    go_on_chain: jest.fn(() => ({ events: [] } as WasmResult)),
    abandon: jest.fn(() => ({ events: [] } as WasmResult)),
    completeOutboundTerminalHandoff: jest.fn(() => ({ events: [] } as WasmResult)),
    pendingTerminalHandoff: jest.fn(() => null),
    provide_coin_spend_bundle: jest.fn(() => ({ events: [] } as WasmResult)),
    cradle: 0,
  } as unknown as ChiaGame;
}

function makePeerConn(
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

interface TestHarness {
  blob: SessionController;
  cradle: ChiaGame;
  sentMessages: Array<{ msgno: number; msg: Uint8Array }>;
  sentAcks: number[];
}

/**
 * Returns a SessionController at qualifyingEvents=7 (system ready).
 * Setup: loadWasm → setGameSession → kickSystem(2) → qe=7.
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
  blob.setGameSession(cradle);
  blob.kickSystem(2);
  blob.reportCoinStates(1n, []);
  blob.onSaveNeeded = () => saveSession({
    blockchainType: 'simulator',
    serializedGameSession: cradle.serialize(),
    gameSessionSchemaVersion: 1n,
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
  blob.setGameSession(cradle);
  blob.onSaveNeeded = () => saveSession({
    blockchainType: 'simulator',
    serializedGameSession: cradle.serialize(),
    gameSessionSchemaVersion: 1n,
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

function submitTransaction(blob: SessionController, tx: SpendBundle): void {
  (blob as unknown as { submitTransaction: (tx: SpendBundle) => void }).submitTransaction(tx);
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

describe('active game tracking', () => {
  it('retires only the settled member of an atomic hand', () => {
    const { blob } = createReadyBlob();
    activeBlob = blob;
    blob.activeGameIds = ['1', '3'];

    blob.processResult({
      events: [{
        Notification: {
          GameSettled: {
            id: '1',
            outcome: 'accept_settlement',
            on_chain: false,
            our_share: '100',
            coin_id: null,
          },
        },
      }],
    });
    blob.flushDeferredWork();
    expect(blob.activeGameIds).toEqual(['3']);

    blob.processResult({
      events: [{
        Notification: {
          GameSettled: {
            id: '3',
            outcome: 'accept_settlement',
            on_chain: false,
            our_share: '100',
            coin_id: null,
          },
        },
      }],
    });
    blob.flushDeferredWork();
    expect(blob.activeGameIds).toEqual([]);
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

describe('WASM wallet funding requests', () => {
  it('forwards a typed NeedCoinSpend payload to createOfferForIds', async () => {
    const createOfferForIds = jest.fn().mockResolvedValue(testSpendBundle('coin-spend'));
    const blockchain = new BlockchainPoller({ ...mockRpc, createOfferForIds }, 60000);
    const { blob, cradle } = createReadyBlob();
    activeBlob = blob;
    blob.blockchain = blockchain;
    const request: NeedCoinSpendRequest = {
      amount: 100,
      conditions: [{ opcode: 60, args: ['launcher'] }],
      coin_id: 'funding-coin',
      max_height: 123,
    };

    blob.processResult({ events: [{ NeedCoinSpend: request }] });
    await blob.flushPendingWork();

    expect(createOfferForIds).toHaveBeenCalledWith(
      'test',
      { '1': -100n },
      [{ opcode: 60n, args: ['launcher'] }],
      ['funding-coin'],
      123n,
    );
    expect(cradle.provide_coin_spend_bundle).toHaveBeenCalledWith(
      JSON.stringify(testSpendBundle('coin-spend')),
    );
  });
});

describe('durability failures', () => {
  it('warns the user and keeps messages and ACKs queued', async () => {
    const helloBytes = enc('hello');
    const { blob, sentMessages, sentAcks } = createReadyBlob(() => ({
      events: [{ OutboundMessage: helloBytes }],
    }));
    activeBlob = blob;
    const warnings: string[] = [];
    const sub = blob.getObservable().subscribe((event) => {
      if (event.type === 'durability-error') warnings.push(event.error);
    });
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    clearTestGlobal('indexedDB');
    try {
      blob.deliverMessage(1n, enc('trigger'));
      blob.flushDeferredWork();
      await expect(blob.flushPendingWork()).rejects.toThrow();

      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain('remain queued');
      expect(sentMessages).toEqual([]);
      expect(sentAcks).toEqual([]);
      expect(blob.unackedMessages).toContainEqual({ msgno: 1n, msg: helloBytes });
      expect(errorSpy).toHaveBeenCalled();
    } finally {
      errorSpy.mockRestore();
      setTestGlobal('indexedDB', testIndexedDb);
    }

    await blob.flushPendingSave();
    await blob.flushPendingWork();

    expect(sentMessages).toEqual([{ msgno: 1, msg: helloBytes }]);
    expect(sentAcks).toEqual([1]);
    sub.unsubscribe();
  });

  it('requires onSaveNeeded to update cached synchronously before returning', async () => {
    const { loadState } = await import('../../hooks/save');
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
        serializedGameSession: cradle.serialize(),
        gameSessionSchemaVersion: 1n,
        pairingToken: 'sync-cradle',
      });
      // Cached must already contain the cradle before the returned Promise
      // settles — durability flushes immediately after starting onSaveNeeded.
      expect(loadState().serializedGameSession).toEqual(cradleBytes);
      saveReturned = true;
      return pending;
    };

    blob.deliverMessage(1n, enc('trigger'));
    await blob.flushPendingWork();

    expect(saveReturned).toBe(true);
    expect((await peekSession())?.serializedGameSession).toEqual(cradleBytes);
    expect(sentMessages).toEqual([{ msgno: 1, msg: outbound }]);
  });

  it('does not send when cradle serialization fails', async () => {
    const outbound = enc('outbound');
    const { blob, cradle, sentMessages, sentAcks } = createReadyBlob(() => ({
      events: [{ OutboundMessage: outbound }],
    }));
    activeBlob = blob;
    void saveSession({
      serializedGameSession: new Uint8Array([9, 9, 9]),
      gameSessionSchemaVersion: 1n,
      pairingToken: 'previous-durable-record',
    });
    await flushSessionSave();
    (cradle.serialize as jest.Mock).mockImplementation(() => {
      throw new Error('malformed cradle serialization');
    });
    blob.onSaveNeeded = () => {
      // Serialize failures throw from getWasmFields; null means not ready yet.
      const fields = blob.getWasmFields();
      if (!fields) return Promise.resolve();
      return saveSession(fields);
    };

    blob.deliverMessage(1n, enc('trigger'));
    await expect(blob.flushPendingWork()).rejects.toThrow('malformed cradle serialization');

    expect(sentMessages).toEqual([]);
    expect(sentAcks).toEqual([]);
    blob.cleanup();
    activeBlob = null;
    expect((await peekSession())?.serializedGameSession).toEqual(new Uint8Array([9, 9, 9]));
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
  it('replays buffered height and coin observations in arrival order after restore', () => {
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
    const firstSnapshot = [{ coin: 'first', created_height: 10n, spent_height: null }];
    const secondSnapshot = [{ coin: 'second', created_height: 11n, spent_height: 11n }];

    blob.loadWasm(mockWasmConnection);
    blob.reportNewBlock(10n);
    blob.reportCoinStates(10n, firstSnapshot);
    blob.reportNewBlock(11n);
    blob.reportCoinStates(11n, secondSnapshot);
    blob.setGameSession(cradle);

    expect(cradle.report_height).toHaveBeenNthCalledWith(1, 10n);
    expect(cradle.report_coin_states).toHaveBeenNthCalledWith(1, 10n, firstSnapshot);
    expect(cradle.report_height).toHaveBeenNthCalledWith(2, 11n);
    expect(cradle.report_coin_states).toHaveBeenNthCalledWith(2, 11n, secondSnapshot);
  });

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
      game_session_serialization_schema: () => 1,
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
          version: 8n,
          playerId: 'p1',
          serializedGameSession: new Uint8Array([1, 2, 3]),
          gameSessionSchemaVersion: 1n,
          messageNumber: 5n,
          remoteNumber: 1n,
          iStarted: true,
          pairingToken: 'tok',
          activeGameIds: [],
          unackedMessages: [{ msgno: 4n, msg: enc('outbound') }],
          wasmNotificationHistory: ['notification'],
          diagnosticLog: ['diagnostic'],
        } as unknown as SessionSave,
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
        game_session_serialization_schema: () => 1,
      } as unknown as WasmConnection)),
      deserializeGame: deserializeMock,
    } as unknown as WasmStateInit;
    return { blob, wasmStateInit, deserializeMock };
  }

  it.each([
    ['missing', undefined],
    ['mismatched', 2n],
  ])('rejects and deletes a record with a %s cradle schema', async (_label, gameSessionSchemaVersion) => {
    void saveSession({
      serializedGameSession: new Uint8Array([1, 2, 3]),
      gameSessionSchemaVersion,
      pairingToken: 'restore-schema-test',
    });
    await flushSessionSave();
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
      serializedGameSession: new Uint8Array([1, 2, 3]),
      gameSessionSchemaVersion: 1n,
      pairingToken: 'restore-corruption-test',
      messageNumber: 1n,
      remoteNumber: 0n,
      iStarted: true,
      activeGameIds: [],
      unackedMessages: [],
    });
    await flushSessionSave();
    const { blob, wasmStateInit, deserializeMock } = makeRestoreHarness(() => {
      throw new Error('corrupt current-schema cradle');
    });
    const save = (await peekSession())!;

    await expect(restoreSession(blob, save, wasmStateInit))
      .rejects
      .toThrow('corrupt current-schema cradle');

    expect(deserializeMock).toHaveBeenCalledTimes(1);
    expect((await peekSession())?.serializedGameSession).toEqual(new Uint8Array([1, 2, 3]));
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
    blob.setGameSession(cradle);
    blob.kickSystem(2);
    blob.reportCoinStates(1n, []);

    blob.cleanShutdown();

    expect((cradle as any).shut_down).toHaveBeenCalled();
  });
});

describe('abandon calls Rust through cradle', () => {
  it('delegates abandonment to the cradle', () => {
    const sentMessages: Array<{ msgno: number; msg: Uint8Array }> = [];
    const sentAcks: number[] = [];
    const blob = new SessionController(mockBlockchain, 'test', 100n, 100n, makePeerConn(sentMessages, sentAcks));
    activeBlob = blob;

    const cradle = makeMockCradle();
    blob.loadWasm(mockWasmConnection);
    blob.setGameSession(cradle);

    blob.abandon();

    expect((cradle as any).abandon).toHaveBeenCalled();
  });

  it('keeps the controller available when Rust rejects abandonment', () => {
    const sentMessages: Array<{ msgno: number; msg: Uint8Array }> = [];
    const sentAcks: number[] = [];
    const blob = new SessionController(mockBlockchain, 'test', 100n, 100n, makePeerConn(sentMessages, sentAcks));
    activeBlob = blob;
    const cradle = {
      ...makeMockCradle(),
      abandon: jest.fn(() => {
        throw new Error('terminal handoff awaits acknowledgement');
      }),
    } as unknown as ChiaGame;
    const errors: string[] = [];
    blob.getObservable().subscribe(event => {
      if (event.type === 'error') errors.push(event.error);
    });
    blob.loadWasm(mockWasmConnection);
    blob.setGameSession(cradle);

    blob.abandon();

    expect((cradle as any).abandon).toHaveBeenCalledTimes(1);
    expect((blob as any).cradle).toBe(cradle);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('terminal handoff awaits acknowledgement');
  });
});

describe('go-on-chain terminal remap', () => {
  it('reports a successful go-on-chain transition before its notification drains', () => {
    const sentMessages: Array<{ msgno: number; msg: Uint8Array }> = [];
    const sentAcks: number[] = [];
    const blob = new SessionController(mockBlockchain, 'test', 100n, 100n, makePeerConn(sentMessages, sentAcks));
    activeBlob = blob;
    const cradle = {
      ...makeMockCradle(),
      go_on_chain: jest.fn(() => ({
        disposition: { kind: 'active' },
        events: [],
      } as WasmResult)),
    } as unknown as ChiaGame;
    blob.loadWasm(mockWasmConnection);
    blob.setGameSession(cradle);

    expect(blob.goOnChain()).toBe(true);
    expect(blob.onChain).toBe(true);
  });

  it('does not enter on-chain mode when Rust abandons terminally', () => {
    const sentMessages: Array<{ msgno: number; msg: Uint8Array }> = [];
    const sentAcks: number[] = [];
    const blob = new SessionController(mockBlockchain, 'test', 100n, 100n, makePeerConn(sentMessages, sentAcks));
    activeBlob = blob;
    const cradle = {
      ...makeMockCradle(),
      go_on_chain: jest.fn(() => ({
        disposition: { kind: 'terminal' },
        events: [{
          Notification: {
            ChannelStatus: { state: 'ShuttingDown', session_disposition: 'Abandoned' },
          },
        }],
      } as WasmResult)),
    } as unknown as ChiaGame;
    blob.loadWasm(mockWasmConnection);
    blob.setGameSession(cradle);

    expect(blob.goOnChain()).toBe(false);
    expect((blob as any).onChain).toBe(false);
  });
});

describe('terminal protocol cleanup', () => {
  it('completes a restored cooperative terminal handoff', () => {
    const sentMessages: Array<{ msgno: number; msg: Uint8Array }> = [];
    const sentAcks: number[] = [];
    const blob = new SessionController(mockBlockchain, 'test', 100n, 100n, makePeerConn(sentMessages, sentAcks));
    activeBlob = blob;
    const cradle = {
      ...makeMockCradle(),
      pendingTerminalHandoff: jest.fn(() => ({ id: '1', message: enc('complete clean close') })),
      completeOutboundTerminalHandoff: jest.fn(() => ({
        disposition: { kind: 'terminal' },
        events: [{ Notification: { ChannelStatus: { state: 'ShutdownTransactionPending', session_disposition: 'Abandoned', zero_payout: true } } }],
      } as WasmResult)),
    } as unknown as ChiaGame;
    blob.loadWasm(mockWasmConnection);
    blob.onSaveNeeded = jest.fn();
    blob.markRestored();
    blob.setGameSession(cradle);
    blob.kickSystem(2);

    expect((cradle.completeOutboundTerminalHandoff as jest.Mock)).not.toHaveBeenCalled();
    blob.receiveAck(1n);
    expect((cradle.completeOutboundTerminalHandoff as jest.Mock)).toHaveBeenCalledTimes(1);
    expect((blob as any).lastChannelStatus).toMatchObject({ state: 'ShutdownTransactionPending', session_disposition: 'Abandoned' });
  });

  it('does not complete a restored handoff when replaying its close message fails', () => {
    const blob = new SessionController(mockBlockchain, 'test', 100n, 100n, {
      ...makePeerConn([], []),
      sendMessage: () => false,
    });
    activeBlob = blob;
    const cradle = {
      ...makeMockCradle(),
      pendingTerminalHandoff: jest.fn(() => ({ id: '1', message: enc('complete clean close') })),
      completeOutboundTerminalHandoff: jest.fn(() => ({
        disposition: { kind: 'terminal' },
        events: [{ Notification: { ChannelStatus: { state: 'ShutdownTransactionPending', session_disposition: 'Abandoned', zero_payout: true } } }],
      } as WasmResult)),
    } as unknown as ChiaGame;
    blob.unackedMessages = [{ msgno: 1n, msg: enc('complete clean close') }];
    blob.loadWasm(mockWasmConnection);
    blob.markRestored();
    blob.setGameSession(cradle);
    blob.kickSystem(2);

    expect((cradle.completeOutboundTerminalHandoff as jest.Mock)).not.toHaveBeenCalled();
    expect((blob as any).protocolStopped).toBe(false);
  });

  it('does not complete a terminal handoff before its message is acknowledged', () => {
    const { blob, cradle } = createReadyBlob();
    (cradle.completeOutboundTerminalHandoff as jest.Mock).mockReturnValue({ events: [] } as WasmResult);

    blob.processResult({
      disposition: { kind: 'await-outbound-terminal', command: { id: '1', message: enc('complete clean close') } },
      events: [],
    });

    expect((cradle.completeOutboundTerminalHandoff as jest.Mock)).not.toHaveBeenCalled();
    expect(() => blob.receiveAck(1n)).not.toThrow();
    expect((blob as any).terminalHandoff).toMatchObject({ id: '1', msgno: 1n });
  });

  it('requires a successful terminal close send before its ACK can complete Rust abandonment', async () => {
    const sentMessages: Array<{ msgno: number; msg: Uint8Array }> = [];
    const sentAcks: number[] = [];
    const sendMessage = jest.fn(() => false);
    const blob = new SessionController(mockBlockchain, 'test', 100n, 100n, {
      ...makePeerConn(sentMessages, sentAcks),
      sendMessage,
    });
    activeBlob = blob;
    const cradle = {
      ...makeMockCradle(),
      completeOutboundTerminalHandoff: jest.fn(() => ({
        disposition: { kind: 'terminal' },
        events: [],
      } as WasmResult)),
    } as unknown as ChiaGame;
    blob.loadWasm(mockWasmConnection);
    blob.setGameSession(cradle);
    blob.kickSystem(2);
    blob.onSaveNeeded = jest.fn();
    blob.processResult({
      disposition: { kind: 'await-outbound-terminal', command: { id: '1', message: enc('complete clean close') } },
      events: [],
    });
    await (blob as any).flushDurabilityAndSend();

    blob.receiveAck(1n);

    expect((cradle.completeOutboundTerminalHandoff as jest.Mock)).not.toHaveBeenCalled();
    expect((blob as any).terminalHandoff).toMatchObject({ sent: false, acknowledged: false });

    sendMessage.mockReturnValue(true);
    blob.resendUnacked();
    blob.receiveAck(1n);

    expect((cradle.completeOutboundTerminalHandoff as jest.Mock)).toHaveBeenCalledTimes(1);
  });

  it('leaves a failed terminal completion recoverable without scheduling retries', async () => {
    const { blob, cradle } = createReadyBlob();
    (cradle.completeOutboundTerminalHandoff as jest.Mock)
      .mockImplementationOnce(() => { throw new Error('temporary completion failure'); })
      .mockReturnValueOnce({ disposition: { kind: 'terminal' }, events: [] } as WasmResult);
    blob.onSaveNeeded = jest.fn();
    blob.processResult({
      disposition: { kind: 'await-outbound-terminal', command: { id: '1', message: enc('complete clean close') } },
      events: [],
    });
    await blob.flushPendingWork();

    blob.receiveAck(1n);

    expect((cradle.completeOutboundTerminalHandoff as jest.Mock)).toHaveBeenCalledTimes(1);
    expect((blob as any).terminalCompletionRetryTimer).toBeUndefined();
    expect((blob as any).protocolStopped).toBe(false);

    blob.receiveAck(1n);

    expect((cradle.completeOutboundTerminalHandoff as jest.Mock)).toHaveBeenCalledTimes(2);
    expect((blob as any).protocolStopped).toBe(true);
  });

  it('hands off the final clean-close message before Rust terminalizes locally', async () => {
    const { blob, cradle, sentMessages } = createReadyBlob();
    (cradle.completeOutboundTerminalHandoff as jest.Mock).mockReturnValue({
      disposition: { kind: 'terminal' },
      events: [{
        Notification: {
          ChannelStatus: { state: 'ShutdownTransactionPending', session_disposition: 'Abandoned', zero_payout: true },
        },
      }],
    } as WasmResult);

    blob.processResult({
      disposition: { kind: 'await-outbound-terminal', command: { id: '1', message: enc('complete clean close') } },
      events: [
        { OutboundMessage: enc('advisory before clean close') },
        { Notification: { ChannelStatus: { state: 'ShutdownTransactionPending', zero_payout: true } } },
      ],
    });
    await blob.flushPendingWork();
    await blob.flushPendingSave();
    blob.resendUnacked();

    expect(sentMessages.map(message => new TextDecoder().decode(message.msg)))
      .toContain('complete clean close');
    expect((cradle.completeOutboundTerminalHandoff as jest.Mock)).not.toHaveBeenCalled();
    blob.receiveAck(2n);
    expect((cradle.completeOutboundTerminalHandoff as jest.Mock)).toHaveBeenCalledTimes(1);
    expect((blob as any).lastChannelStatus).toMatchObject({
      state: 'ShutdownTransactionPending',
      session_disposition: 'Abandoned',
      zero_payout: true,
    });
  });

  it('replaces queued protocol and presentation work with terminal notifications', () => {
    const sentMessages: Array<{ msgno: number; msg: Uint8Array }> = [];
    const sentAcks: number[] = [];
    const blob = new SessionController(mockBlockchain, 'test', 100n, 100n, makePeerConn(sentMessages, sentAcks));
    activeBlob = blob;
    const cradle = makeMockCradle();
    blob.loadWasm(mockWasmConnection);
    blob.setGameSession(cradle);

    blob.processResult({
      events: [
        { OutboundMessage: enc('stale protocol message') },
        { Notification: { ChannelStatus: { state: 'Active' } } },
      ],
    });
    blob.processResult({
      disposition: { kind: 'terminal' },
      events: [{
        Notification: {
          ChannelStatus: {
            state: 'Active',
            session_disposition: 'Abandoned',
          },
        },
      }],
    });

    expect(sentMessages).toEqual([]);
    expect((blob as any).lastChannelStatus).toMatchObject({ state: 'Active', session_disposition: 'Abandoned' });

    blob.processResult({
      events: [{ Notification: { ChannelStatus: { state: 'Active' } } }],
      watchCoins: [{ coin_name: 'late', coin_string: 'late-coin' }],
    });

    expect((blob as any).lastChannelStatus).toMatchObject({ state: 'Active', session_disposition: 'Abandoned' });
  });
});

describe('transaction submission', () => {
  it('routes controller nerfs through the singleton policy and notifies subscribers', () => {
    const sentMessages: Array<{ msgno: number; msg: Uint8Array }> = [];
    const sentAcks: number[] = [];
    const updates: boolean[] = [];
    const unsubscribe = subscribeTransactionPublishNerfed((nerfed) => updates.push(nerfed));
    const { sessionController: blob } = getOrCreateSessionController(
      null,
      makePeerConn(sentMessages, sentAcks),
      () => {},
      'test',
      100n,
      100n,
      true,
    );

    expect(isTransactionPublishNerfed()).toBe(false);
    blob.nerf();
    expect(isTransactionPublishNerfed()).toBe(true);
    expect(blob.isTransactionPublishNerfed()).toBe(true);
    setTransactionPublishNerfed(false);
    expect(isTransactionPublishNerfed()).toBe(false);
    expect(blob.isTransactionPublishNerfed()).toBe(false);
    expect(updates).toEqual([false, true, false]);

    unsubscribe();
    destroySessionController();
  });

  it('drops queued publishes after nerfing and resumes newly queued publishes when re-enabled', async () => {
    const spend = jest.fn().mockResolvedValue('');
    const blockchain = new BlockchainPoller({
      ...mockRpc,
      spend,
    } as InternalBlockchainInterface, 60000);
    const sentMessages: Array<{ msgno: number; msg: Uint8Array }> = [];
    const sentAcks: number[] = [];
    const blob = new SessionController(blockchain, 'test', 100n, 100n, makePeerConn(sentMessages, sentAcks));
    activeBlob = blob;
    blob.loadWasm(mockWasmConnection);

    submitTransaction(blob, testSpendBundle('07'));
    blob.setTransactionPublishNerfed(true);
    await transactionSubmitQueue(blob);
    expect(spend).not.toHaveBeenCalled();

    blob.setTransactionPublishNerfed(false);
    submitTransaction(blob, testSpendBundle('08'));
    await transactionSubmitQueue(blob);
    expect(spend).toHaveBeenCalledTimes(1);
  });

  it('drops queued publishes after controller cleanup without cancelling an in-flight publish', async () => {
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
    blob.loadWasm(mockWasmConnection);

    submitTransaction(blob, testSpendBundle('09'));
    submitTransaction(blob, testSpendBundle('0a'));
    await flushPromiseJobs();
    expect(spend).toHaveBeenCalledTimes(1);

    blob.cleanup();
    resolveFirst?.();
    await transactionSubmitQueue(blob);
    expect(spend).toHaveBeenCalledTimes(1);
    activeBlob = null;
  });

  it('applies watch and unwatch deltas without resampling the cradle snapshot', async () => {
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
    blob.setGameSession(cradle);
    blob.attachBlockchain(blockchain);
    (cradle.snapshot_watched_coins as jest.Mock).mockClear();

    blob.processResult({
      events: [],
      watchCoins: [{ coin_name: 'aa', coin_string: 'coin-a' }],
    });
    await (blockchain as unknown as { pollOnce: () => Promise<void> }).pollOnce();

    expect(cradle.snapshot_watched_coins).not.toHaveBeenCalled();
    expect(queriedNames).toEqual([['aa']]);

    blob.processResult({
      events: [],
      unwatchCoins: [{ coin_name: 'aa', coin_string: 'coin-a' }],
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
    blob.setGameSession(cradle);
    expect(queriedNames).toEqual([]);

    blob.attachBlockchain(blockchain);
    await (blockchain as unknown as { pollOnce: () => Promise<void> }).pollOnce();

    expect(cradle.snapshot_watched_coins).toHaveBeenCalledTimes(2);
    expect(queriedNames).toEqual([['bb']]);

    blob.attachBlockchain(blockchain);
    expect(cradle.snapshot_watched_coins).toHaveBeenCalledTimes(4);
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
      drain_submissions: jest.fn()
        .mockReturnValueOnce([])
        .mockReturnValueOnce([testSpendBundle('05')]),
    } as unknown as ChiaGame;

    blob.loadWasm(mockWasmConnection);
    blob.setGameSession(cradle);
    blob.processResult({ events: [] });

    expect(cradle.drain_submissions).not.toHaveBeenCalled();
    expect(spend).not.toHaveBeenCalled();

    blob.attachBlockchain(blockchain);
    await (blockchain as unknown as { pollOnce: () => Promise<void> }).pollOnce();
    await transactionSubmitQueue(blob);

    expect(cradle.resubmit_submitted).toHaveBeenCalledTimes(1);
    expect(cradle.drain_submissions).toHaveBeenCalledTimes(3);
    expect(spend).toHaveBeenCalledTimes(1);
    blob.detachBlockchain(blockchain);
  });

  it('waits for the restored manager coin snapshot before resubmitting after early attach', () => {
    const blockchain = new BlockchainPoller(mockRpc, 60000);
    const sentMessages: Array<{ msgno: number; msg: Uint8Array }> = [];
    const sentAcks: number[] = [];
    const blob = new SessionController(null, 'test', 100n, 100n, makePeerConn(sentMessages, sentAcks));
    activeBlob = blob;
    const cradle = {
      ...makeMockCradle(),
      snapshot_watched_coins: jest.fn(() => [{ coin_name: 'restored', coin_string: 'coin-restored' }]),
    } as unknown as ChiaGame;

    blob.loadWasm(mockWasmConnection);
    // Blockchain attachment can complete while restore is still deserializing
    // the cradle, so this height must remain buffered.
    blob.attachBlockchain(blockchain);
    blob.reportNewBlock(1n);
    blob.setGameSession(cradle);

    expect(cradle.report_height).toHaveBeenCalledWith(1n);
    expect(cradle.resubmit_submitted).not.toHaveBeenCalled();

    blob.reportCoinStates(1n, []);

    expect(cradle.resubmit_submitted).toHaveBeenCalledTimes(1);
    blob.detachBlockchain(blockchain);
  });

  it('uses height-only sync to resubmit only restored sessions with no watches', () => {
    const blockchain = new BlockchainPoller(mockRpc, 60000);
    const sentMessages: Array<{ msgno: number; msg: Uint8Array }> = [];
    const sentAcks: number[] = [];
    const blob = new SessionController(null, 'test', 100n, 100n, makePeerConn(sentMessages, sentAcks));
    activeBlob = blob;
    const cradle = makeMockCradle();

    blob.loadWasm(mockWasmConnection);
    blob.attachBlockchain(blockchain);
    blob.reportNewBlock(1n);
    blob.setGameSession(cradle);

    expect(cradle.resubmit_submitted).toHaveBeenCalledTimes(1);
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
    blob.setGameSession(cradle);
    blob.processResult({ events: [] });

    await flushPromiseJobs();
    expect(spend).toHaveBeenCalledTimes(1);
    resolveFirst?.();
    await transactionSubmitQueue(blob);
    expect(spend).toHaveBeenCalledTimes(2);
  });

  it('submits transactions already queued when a manager result is terminal', async () => {
    const spend = jest.fn().mockResolvedValue('');
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
      drain_submissions: jest.fn(() => [testSpendBundle('06')]),
    } as unknown as ChiaGame;

    blob.loadWasm(mockWasmConnection);
    blob.setGameSession(cradle);
    blob.processResult({
      disposition: { kind: 'terminal' },
      events: [{ Notification: { ChannelStatus: { state: 'ResolvedClean' } } }],
    });
    await transactionSubmitQueue(blob);

    expect(cradle.drain_submissions).toHaveBeenCalledTimes(1);
    expect(spend).toHaveBeenCalledTimes(1);
    blob.detachBlockchain(blockchain);
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
    blob.setGameSession(cradle);
    blob.processResult({ events: [] });

    await transactionSubmitQueue(blob);
    expect(spend).toHaveBeenCalledTimes(2);
    expect(errors).toEqual([]);
  });
});
