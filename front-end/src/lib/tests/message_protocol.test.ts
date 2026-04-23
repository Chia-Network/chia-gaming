import { WasmBlobWrapper } from '../../hooks/WasmBlobWrapper';
import {
  ChiaGame,
  WasmConnection,
  WasmResult,
  WatchReport,
  InternalBlockchainInterface,
  PeerConnectionResult,
} from '../../types/ChiaGaming';
import { BlockchainPoller } from '../../hooks/BlockchainPoller';
import { _resetForTests as resetSaveState } from '../../hooks/save';

const emptyReport: WatchReport = {
  created_watched: [],
  deleted_watched: [],
  timed_out: [],
};

const mockRpc = new Proxy({} as InternalBlockchainInterface, {
  get: () => () => Promise.resolve(undefined),
});
const mockBlockchain = new BlockchainPoller(mockRpc, 60000);

const mockWasmConnection = new Proxy({} as WasmConnection, {
  get: () => () => undefined,
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

function makeMockCradle(
  onDeliver: (msg: Uint8Array) => WasmResult | undefined = () => ({ events: [] }),
): ChiaGame {
  return {
    deliver_message: jest.fn((msg: Uint8Array) => onDeliver(msg)),
    block_data: jest.fn(() => ({ events: [] } as WasmResult)),
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
  blob: WasmBlobWrapper;
  cradle: ChiaGame;
  sentMessages: Array<{ msgno: number; msg: Uint8Array }>;
  sentAcks: number[];
}

/**
 * Returns a WasmBlobWrapper at qualifyingEvents=7 (system ready).
 * Setup: loadWasm → setGameCradle → kickSystem(2) → qe=7.
 */
function createReadyBlob(
  onDeliver?: (msg: Uint8Array) => WasmResult | undefined,
): TestHarness {
  const sentMessages: Array<{ msgno: number; msg: Uint8Array }> = [];
  const sentAcks: number[] = [];
  const blob = new WasmBlobWrapper(
    mockBlockchain,
    'test',
    100n,
    makePeerConn(sentMessages, sentAcks),
  );
  const cradle = makeMockCradle(onDeliver);

  blob.loadWasm(mockWasmConnection);
  blob.setGameCradle(cradle);
  blob.kickSystem(2);
  blob.blockNotification(1, [], emptyReport);

  (cradle.deliver_message as jest.Mock).mockClear();
  (cradle.block_data as jest.Mock).mockClear();
  sentMessages.length = 0;
  sentAcks.length = 0;

  return { blob, cradle, sentMessages, sentAcks };
}

/** Returns a WasmBlobWrapper at qe=1 — messages will be buffered until kickSystem(2). */
function createUnreadyBlob(
  onDeliver?: (msg: Uint8Array) => WasmResult | undefined,
): TestHarness {
  const sentMessages: Array<{ msgno: number; msg: Uint8Array }> = [];
  const sentAcks: number[] = [];
  const blob = new WasmBlobWrapper(
    mockBlockchain,
    'test',
    100n,
    makePeerConn(sentMessages, sentAcks),
  );
  const cradle = makeMockCradle(onDeliver);

  blob.loadWasm(mockWasmConnection);
  blob.setGameCradle(cradle);

  return { blob, cradle, sentMessages, sentAcks };
}

let activeBlob: WasmBlobWrapper | null = null;

beforeEach(() => {
  (global as any).localStorage = makeStorage();
});

afterEach(() => {
  activeBlob?.cleanup();
  activeBlob = null;
  resetSaveState();
  delete (global as any).localStorage;
});

describe('in-order delivery', () => {
  it('delivers messages 1, 2, 3 and ACKs each', () => {
    const { blob, cradle, sentAcks } = createReadyBlob();
    activeBlob = blob;

    blob.deliverMessage(1, enc('a'));
    blob.deliverMessage(2, enc('b'));
    blob.deliverMessage(3, enc('c'));

    expect(blob.remoteNumber).toBe(3);
    expect(sentAcks).toEqual([1, 2, 3]);
    expect(cradle.deliver_message).toHaveBeenCalledTimes(3);
    expect(
      (cradle.deliver_message as jest.Mock).mock.calls.map((c: any[]) => c[0]),
    ).toEqual([enc('a'), enc('b'), enc('c')]);
  });
});

describe('duplicate detection', () => {
  it('delivers once but ACKs twice', () => {
    const { blob, cradle, sentAcks } = createReadyBlob();
    activeBlob = blob;

    blob.deliverMessage(1, enc('a'));
    blob.deliverMessage(1, enc('a'));

    expect(cradle.deliver_message).toHaveBeenCalledTimes(1);
    expect(sentAcks).toEqual([1, 1]);
  });
});

describe('out-of-order delivery with reorder queue', () => {
  it('delivers 3, 1, 2 → cradle sees a, b, c in order', () => {
    const delivered: Uint8Array[] = [];
    const { blob, sentAcks } = createReadyBlob((msg) => {
      delivered.push(msg);
      return { events: [] };
    });
    activeBlob = blob;

    blob.deliverMessage(3, enc('c'));
    blob.deliverMessage(1, enc('a'));
    blob.deliverMessage(2, enc('b'));

    expect(delivered).toEqual([enc('a'), enc('b'), enc('c')]);
    expect(blob.remoteNumber).toBe(3);
    expect(sentAcks).toEqual([1, 2, 3]);
  });
});

describe('buffering before system ready, then spill', () => {
  it('buffers messages and delivers when system reaches qe=7', () => {
    const { blob, cradle, sentAcks } = createUnreadyBlob();
    activeBlob = blob;

    blob.deliverMessage(1, enc('a'));
    blob.deliverMessage(2, enc('b'));
    expect(cradle.deliver_message).not.toHaveBeenCalled();

    blob.kickSystem(2);

    expect(cradle.deliver_message).toHaveBeenCalledTimes(2);
    expect(blob.remoteNumber).toBe(2);
    expect(sentAcks).toEqual([1, 2]);
  });

  it('delivers out-of-order buffered messages in correct order', () => {
    const delivered: Uint8Array[] = [];
    const { blob, sentAcks } = createUnreadyBlob((msg) => {
      delivered.push(msg);
      return { events: [] };
    });
    activeBlob = blob;

    blob.deliverMessage(2, enc('b'));
    blob.deliverMessage(1, enc('a'));
    expect(delivered).toEqual([]);

    blob.kickSystem(2);

    expect(delivered).toEqual([enc('a'), enc('b')]);
    expect(blob.remoteNumber).toBe(2);
  });
});

describe('ACK pruning', () => {
  it('removes messages ≤ ackMsgno from unackedMessages', () => {
    const { blob } = createReadyBlob();
    activeBlob = blob;

    blob.unackedMessages = [
      { msgno: 1, msg: enc('a') },
      { msgno: 2, msg: enc('b') },
      { msgno: 3, msg: enc('c') },
    ];
    blob.receiveAck(2);

    expect(blob.unackedMessages).toEqual([{ msgno: 3, msg: enc('c') }]);
  });
});

describe('outbound message numbering', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('assigns sequential numbers and tracks in unackedMessages', () => {
    const helloBytes = enc('hello');
    const { blob, sentMessages } = createReadyBlob(() => ({
      events: [{ OutboundMessage: helloBytes }],
    }));
    activeBlob = blob;

    blob.deliverMessage(1, enc('trigger'));
    jest.runAllTimers();

    expect(sentMessages).toEqual([{ msgno: 1, msg: helloBytes }]);
    expect(blob.unackedMessages).toContainEqual({ msgno: 1, msg: helloBytes });

    blob.deliverMessage(2, enc('trigger2'));
    jest.runAllTimers();

    expect(sentMessages[1]).toEqual({ msgno: 2, msg: helloBytes });
    expect(blob.messageNumber).toBe(3);
  });
});

describe('resendUnacked', () => {
  it('re-sends all un-acked messages via sendMessage', () => {
    const { blob, sentMessages } = createReadyBlob();
    activeBlob = blob;

    blob.unackedMessages = [
      { msgno: 1, msg: enc('a') },
      { msgno: 2, msg: enc('b') },
    ];
    blob.resendUnacked();

    expect(sentMessages).toEqual([
      { msgno: 1, msg: enc('a') },
      { msgno: 2, msg: enc('b') },
    ]);
  });
});

describe('cleanShutdown calls shut_down on cradle', () => {
  it('calls shut_down on cradle', () => {
    const sentMessages: Array<{ msgno: number; msg: Uint8Array }> = [];
    const sentAcks: number[] = [];
    const blob = new WasmBlobWrapper(mockBlockchain, 'test', 100n, makePeerConn(sentMessages, sentAcks));
    activeBlob = blob;

    const cradle = {
      ...makeMockCradle(),
      shut_down: jest.fn(() => ({ events: [] } as WasmResult)),
    } as unknown as ChiaGame;

    blob.loadWasm(mockWasmConnection);
    blob.setGameCradle(cradle);
    blob.kickSystem(2);
    blob.blockNotification(1, [], emptyReport);

    blob.cleanShutdown();

    expect((cradle as any).shut_down).toHaveBeenCalled();
  });
});
