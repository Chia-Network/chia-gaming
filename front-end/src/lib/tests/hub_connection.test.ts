import {
  decode as decodeBencodex,
  encode as encodeBencodex,
  isDictionary,
  type BencodexValue,
} from 'chia-gaming-bencodex';

// ---------------------------------------------------------------------------
// Mock WebSocket
// ---------------------------------------------------------------------------

type WSHandler = ((ev: any) => void) | null;

function arrayBufferOf(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.byteLength;
  }
  return result;
}

const SESSION_ID = '000102030405060708090a0b0c0d0e0f';
const SENDER_ID = 'p_101112131415161718191a1b1c1d1e1f';
const TARGET_ID = 'p_202122232425262728292a2b2c2d2e2f';

function playerBytes(playerId: string): Uint8Array {
  return Uint8Array.from(
    playerId
      .slice(2)
      .match(/../g)!
      .map((pair) => Number.parseInt(pair, 16)),
  );
}

function toPlainObject(value: BencodexValue): unknown {
  if (value instanceof Uint8Array) return value;
  if (Array.isArray(value)) return value.map(toPlainObject);
  if (isDictionary(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, item] of value.entries()) {
      out[typeof key === 'string' ? key : new TextDecoder().decode(key as Uint8Array)] =
        toPlainObject(item);
    }
    return out;
  }
  return value;
}

class MockWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  static instance: MockWebSocket | null = null;

  url: string;
  readyState = MockWebSocket.CONNECTING;
  binaryType: string = 'blob';
  onopen: WSHandler = null;
  onmessage: WSHandler = null;
  onerror: WSHandler = null;
  onclose: WSHandler = null;
  sentJson: unknown[] = [];
  sentControl: unknown[] = [];
  sentFrames: Uint8Array[] = [];
  closed = false;

  constructor(url: string) {
    this.url = url;
    MockWebSocket.instance = this;
    queueMicrotask(() => {
      if (this.closed) return;
      this.readyState = MockWebSocket.OPEN;
      this.onopen?.({ type: 'open' });
    });
  }

  send(data: string | Uint8Array | ArrayBuffer) {
    if (typeof data === 'string') {
      this.sentJson.push(JSON.parse(data));
    } else if (data instanceof Uint8Array) {
      this.sentFrames.push(data.slice());
      this.sentControl.push(toPlainObject(decodeBencodex(data) as BencodexValue));
    } else if (data instanceof ArrayBuffer) {
      const bytes = new Uint8Array(data);
      this.sentFrames.push(bytes.slice());
      this.sentControl.push(toPlainObject(decodeBencodex(bytes) as BencodexValue));
    }
  }

  close() {
    this.closed = true;
    this.readyState = MockWebSocket.CLOSED;
  }

  _fire(data: unknown) {
    const bytes = encodeBencodex(data as BencodexValue);
    this.onmessage?.({ data: arrayBufferOf(bytes) });
  }

  _fireRelay(fromId: string, payload: Uint8Array, fromAlias = 'Alice') {
    this._fire({
      type: 'relay',
      from: playerBytes(fromId),
      alias: fromAlias,
      payload,
    });
  }

  _fireError() {
    this.onerror?.({ type: 'error' });
  }

  _fireClose() {
    this.closed = true;
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.({ type: 'close' });
  }
}

const originalWebSocketDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'WebSocket');

// ---------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------

import { HubConnection, HubConnectionCallbacks } from '../../services/HubConnection';

let hubDisconnectCount = 0;
let expectedHubDisconnects = 0;
const activeConnections = new Set<HubConnection>();

beforeAll(() => {
  Object.defineProperty(globalThis, 'WebSocket', {
    configurable: true,
    writable: true,
    value: MockWebSocket,
  });
});

afterAll(() => {
  if (originalWebSocketDescriptor) {
    Object.defineProperty(globalThis, 'WebSocket', originalWebSocketDescriptor);
  } else {
    Reflect.deleteProperty(globalThis, 'WebSocket');
  }
});

function makeCallbacks(presence?: {
  busy: boolean;
}): HubConnectionCallbacks & Record<string, jest.Mock> {
  return {
    onAdvisoryStart: jest.fn(),
    onPeerMessage: jest.fn(),
    onDeliveryFailure: jest.fn(),
    onRegistered: jest.fn(),
    onAliasUpdated: jest.fn(),
    onPeerAvailable: jest.fn(),
    onHubAttention: jest.fn(),
    onHubDisconnected: jest.fn(() => {
      hubDisconnectCount++;
    }),
    onHubReconnected: jest.fn(),
    onHubActivity: jest.fn(),
    getPresence: jest.fn(() => presence ?? { busy: false }),
    onClosed: jest.fn(),
  };
}

function makeConnection(
  hubUrl: string,
  sessionId: string,
  callbacks: HubConnectionCallbacks,
): HubConnection {
  const conn = new HubConnection(hubUrl, sessionId === 's1' ? SESSION_ID : sessionId, callbacks);
  activeConnections.add(conn);
  return conn;
}

beforeEach(() => {
  hubDisconnectCount = 0;
  expectedHubDisconnects = 0;
  MockWebSocket.instance = null;
});

afterEach(() => {
  expect(hubDisconnectCount).toBe(expectedHubDisconnects);
  for (const conn of activeConnections) {
    conn.forceDisconnect();
  }
  activeConnections.clear();
});

// ---------------------------------------------------------------------------
// Connection setup
// ---------------------------------------------------------------------------

describe('connection setup', () => {
  it('sends identify with busy=false over ws on open', async () => {
    const cb = makeCallbacks();
    makeConnection('http://t', 's1', cb);
    await Promise.resolve();

    const ws = MockWebSocket.instance!;
    expect(ws.url).toBe('ws://t/ws/game');
    expect(ws.sentControl).toEqual([
      {
        type: 'identify',
        session_id: Uint8Array.from({ length: 16 }, (_, index) => index),
        busy: false,
      },
    ]);
    const ascii = new TextEncoder();
    expect(ws.sentFrames[0]).toEqual(
      concatBytes(
        ascii.encode('du4:busyfu10:session_id16:'),
        Uint8Array.from({ length: 16 }, (_, index) => index),
        ascii.encode('u4:typeu8:identifye'),
      ),
    );
  });

  it('sends identify with busy=true from getPresence over ws on open', async () => {
    const cb = makeCallbacks({ busy: true });
    makeConnection('http://t', 's1', cb);
    await Promise.resolve();

    const ws = MockWebSocket.instance!;
    expect(ws.sentControl).toEqual([
      {
        type: 'identify',
        session_id: Uint8Array.from({ length: 16 }, (_, index) => index),
        busy: true,
      },
    ]);
  });
});

// ---------------------------------------------------------------------------
// Event routing
// ---------------------------------------------------------------------------

describe('event routing', () => {
  it('routes advisory_start to onAdvisoryStart', async () => {
    const cb = makeCallbacks();
    makeConnection('http://t', 's1', cb);
    await Promise.resolve();

    MockWebSocket.instance!._fire({
      type: 'advisory_start',
      peer_id: playerBytes(SENDER_ID),
      peer_alias: 'Bob',
      my_amount: 100n,
      their_amount: 100n,
    });
    expect(cb.onAdvisoryStart).toHaveBeenCalledWith({
      peer_id: SENDER_ID,
      peer_alias: 'Bob',
      my_amount: '100',
      their_amount: '100',
      channel_timeout: undefined,
      unroll_timeout: undefined,
    });
  });

  it('routes registered to onRegistered', async () => {
    const cb = makeCallbacks();
    makeConnection('http://t', 's1', cb);
    await Promise.resolve();

    MockWebSocket.instance!._fire({ type: 'registered', player_id: playerBytes(SENDER_ID) });
    expect(cb.onRegistered).toHaveBeenCalledWith(SENDER_ID);
  });

  it('routes delivery_failure to onDeliveryFailure', async () => {
    const cb = makeCallbacks();
    makeConnection('http://t', 's1', cb);
    await Promise.resolve();

    MockWebSocket.instance!._fire({ type: 'delivery_failure', to: playerBytes(TARGET_ID) });
    expect(cb.onDeliveryFailure).toHaveBeenCalledWith(TARGET_ID);
  });

  it('routes alias and peer availability updates independently of registration', async () => {
    const cb = makeCallbacks();
    makeConnection('http://t', 's1', cb);
    await Promise.resolve();

    MockWebSocket.instance!._fire({ type: 'alias_updated', alias: 'Alice' });
    MockWebSocket.instance!._fire({
      type: 'peer_available',
      player_id: playerBytes(TARGET_ID),
    });
    expect(cb.onAliasUpdated).toHaveBeenCalledWith('Alice');
    expect(cb.onPeerAvailable).toHaveBeenCalledWith(TARGET_ID);
  });

  it('rejects malformed fixed-width ids and non-integer advisory amounts', async () => {
    const cb = makeCallbacks();
    makeConnection('http://t', 's1', cb);
    await Promise.resolve();

    MockWebSocket.instance!._fire({ type: 'registered', player_id: new Uint8Array(15) });
    MockWebSocket.instance!._fire({
      type: 'advisory_start',
      peer_id: playerBytes(SENDER_ID),
      peer_alias: 'Bob',
      my_amount: '100',
      their_amount: 100n,
    });
    expect(cb.onRegistered).not.toHaveBeenCalled();
    expect(cb.onAdvisoryStart).not.toHaveBeenCalled();
  });

  it('fires onHubDisconnected on ws error', async () => {
    expectedHubDisconnects = 1;
    const cb = makeCallbacks();
    makeConnection('http://t', 's1', cb);
    await Promise.resolve();

    MockWebSocket.instance!._fireError();
    expect(cb.onHubDisconnected).toHaveBeenCalled();
  });

  it('fires onHubReconnected on ws reopen after error', async () => {
    expectedHubDisconnects = 1;
    const cb = makeCallbacks();
    makeConnection('http://t', 's1', cb);
    await Promise.resolve();

    MockWebSocket.instance!._fireError();
    MockWebSocket.instance!.onopen?.({ type: 'open' });
    expect(cb.onHubReconnected).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Binary message relay
// ---------------------------------------------------------------------------

describe('binary message relay', () => {
  it('dispatches binary peer messages to onPeerMessage', async () => {
    const cb = makeCallbacks();
    makeConnection('http://t', 's1', cb);
    await Promise.resolve();

    const payload = new TextEncoder().encode('hello');
    MockWebSocket.instance!._fireRelay(SENDER_ID, payload);
    expect(cb.onPeerMessage).toHaveBeenCalledWith(SENDER_ID, 'Alice', payload);
  });

  it('keeps bencodex peer payloads opaque', async () => {
    const cb = makeCallbacks();
    makeConnection('http://t', 's1', cb);
    await Promise.resolve();

    const appMessage = {
      type: 'session_proposal',
      proposer_amount: '500',
      responder_amount: '500',
    };
    const payload = encodeBencodex(appMessage);
    MockWebSocket.instance!._fireRelay(SENDER_ID, payload);
    expect(cb.onPeerMessage).toHaveBeenCalledWith(SENDER_ID, 'Alice', payload);
  });

  it('does not decode semantic fields from relay payloads', async () => {
    const cb = makeCallbacks();
    makeConnection('http://t', 's1', cb);
    await Promise.resolve();

    const appMessage = {
      type: 'session_proposal',
      proposer_amount: '500',
      responder_amount: '500',
      network: 'testnet',
    };
    const payload = encodeBencodex(appMessage);
    MockWebSocket.instance!._fireRelay(SENDER_ID, payload);
    expect(cb.onPeerMessage).toHaveBeenCalledWith(SENDER_ID, 'Alice', payload);
  });

  it('passes distinct alias from binary frame header', async () => {
    const cb = makeCallbacks();
    makeConnection('http://t', 's1', cb);
    await Promise.resolve();

    const payload = new TextEncoder().encode('data');
    MockWebSocket.instance!._fireRelay(SENDER_ID, payload, 'Bob');
    expect(cb.onPeerMessage).toHaveBeenCalledWith(SENDER_ID, 'Bob', payload);
  });
});

// ---------------------------------------------------------------------------
// Outbound message format
// ---------------------------------------------------------------------------

describe('outbound message format', () => {
  it('sendToPeer returns false when ws is not open', async () => {
    const cb = makeCallbacks();
    const conn = makeConnection('http://t', 's1', cb);
    await Promise.resolve();
    const ws = MockWebSocket.instance!;
    ws.readyState = MockWebSocket.CONNECTING;

    const payload = new TextEncoder().encode('payload');
    expect(conn.sendToPeer(TARGET_ID, payload)).toBe(false);
    expect(ws.sentControl).toHaveLength(1);
  });

  it('sendToPeer posts a relay dictionary with a binary target and payload', async () => {
    const cb = makeCallbacks();
    const conn = makeConnection('http://t', 's1', cb);
    await Promise.resolve();
    const ws = MockWebSocket.instance!;
    ws.sentControl = [];

    const payload = new TextEncoder().encode('payload');
    expect(conn.sendToPeer(TARGET_ID, payload)).toBe(true);
    expect(ws.sentControl).toEqual([{ type: 'relay', to: playerBytes(TARGET_ID), payload }]);
  });

  it('sends already-framed semantic bytes without interpretation', async () => {
    const cb = makeCallbacks();
    const conn = makeConnection('http://t', 's1', cb);
    await Promise.resolve();
    const ws = MockWebSocket.instance!;
    ws.sentControl = [];

    const payloadBytes = encodeBencodex({
      type: 'session_proposal',
      proposer_amount: '100',
      responder_amount: '100',
    });
    conn.sendToPeer(TARGET_ID, payloadBytes);
    expect(ws.sentControl).toHaveLength(1);

    const relay = ws.sentControl[0] as {
      type: string;
      to: Uint8Array;
      payload: Uint8Array;
    };
    expect(relay.type).toBe('relay');
    expect(relay.to).toEqual(playerBytes(TARGET_ID));
    expect(relay.payload).toEqual(payloadBytes);
    const parsed = toPlainObject(decodeBencodex(relay.payload) as BencodexValue);
    expect(parsed).toEqual({
      type: 'session_proposal',
      proposer_amount: '100',
      responder_amount: '100',
    });
  });
});

// ---------------------------------------------------------------------------
// forceDisconnect lifecycle
// ---------------------------------------------------------------------------

describe('forceDisconnect lifecycle', () => {
  it('forceDisconnect closes underlying ws', async () => {
    const cb = makeCallbacks();
    const conn = makeConnection('http://t', 's1', cb);
    await Promise.resolve();
    conn.forceDisconnect();
    expect(MockWebSocket.instance!.closed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// setBusy
// ---------------------------------------------------------------------------

describe('setBusy', () => {
  it('sends set_busy with busy=false', async () => {
    const cb = makeCallbacks();
    const conn = makeConnection('http://t', 's1', cb);
    await Promise.resolve();
    const ws = MockWebSocket.instance!;
    ws.sentControl = [];
    conn.setBusy(false);
    expect(ws.sentControl).toEqual([{ type: 'set_busy', busy: false }]);
  });

  it('sends set_busy with busy=true', async () => {
    const cb = makeCallbacks();
    const conn = makeConnection('http://t', 's1', cb);
    await Promise.resolve();
    const ws = MockWebSocket.instance!;
    ws.sentControl = [];
    conn.setBusy(true);
    expect(ws.sentControl).toEqual([{ type: 'set_busy', busy: true }]);
  });

  it('uses getPresence for identify on reconnect', async () => {
    jest.useFakeTimers();
    const cb = makeCallbacks();
    (cb.getPresence as jest.Mock).mockReturnValue({ busy: true });
    makeConnection('http://t', 's1', cb);
    await Promise.resolve();
    expectedHubDisconnects = 1;

    const ws1 = MockWebSocket.instance!;
    ws1._fireClose();
    // First reconnect delay is 5000ms ± 25% jitter.
    jest.advanceTimersByTime(7500);
    await Promise.resolve();

    const ws2 = MockWebSocket.instance!;
    expect(ws2).not.toBe(ws1);
    const identifyMsg = ws2.sentControl.find((m: any) => m.type === 'identify') as any;
    expect(identifyMsg).toBeDefined();
    expect(identifyMsg.busy).toBe(true);
    jest.useRealTimers();
  });

  it('does not include an alias in identify on reconnect', async () => {
    jest.useFakeTimers();
    const cb = makeCallbacks();
    (cb.getPresence as jest.Mock).mockReturnValue({ busy: true });
    makeConnection('http://t', 's1', cb);
    await Promise.resolve();
    expectedHubDisconnects = 1;

    const ws1 = MockWebSocket.instance!;
    ws1._fireClose();
    jest.advanceTimersByTime(7500);
    await Promise.resolve();

    const ws2 = MockWebSocket.instance!;
    expect(ws2).not.toBe(ws1);
    const identifyMsg = ws2.sentControl.find((m: any) => m.type === 'identify') as any;
    expect(identifyMsg).toMatchObject({
      type: 'identify',
      session_id: Uint8Array.from({ length: 16 }, (_, index) => index),
      busy: true,
    });
    expect(identifyMsg).not.toHaveProperty('alias');
    jest.useRealTimers();
  });
});

// ---------------------------------------------------------------------------
// close
// ---------------------------------------------------------------------------

describe('close', () => {
  it('sends close without session_id', async () => {
    const cb = makeCallbacks();
    const conn = makeConnection('http://t', 's1', cb);
    await Promise.resolve();
    const ws = MockWebSocket.instance!;
    ws.sentControl = [];

    conn.close();

    expect(ws.sentControl).toEqual([{ type: 'close' }]);
  });
});

// ---------------------------------------------------------------------------
// Retry budget
// ---------------------------------------------------------------------------

describe('retry budget', () => {
  it('MAX_RECONNECT_ATTEMPTS is a positive number', () => {
    expect(HubConnection.MAX_RECONNECT_ATTEMPTS).toBeGreaterThan(0);
  });
});
