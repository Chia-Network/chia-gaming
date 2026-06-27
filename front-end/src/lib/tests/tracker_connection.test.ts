// ---------------------------------------------------------------------------
// Mock WebSocket
// ---------------------------------------------------------------------------

type WSHandler = ((ev: any) => void) | null;

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
  sentBinary: Uint8Array[] = [];
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
      this.sentBinary.push(data);
    } else if (data instanceof ArrayBuffer) {
      this.sentBinary.push(new Uint8Array(data));
    }
  }

  close() {
    this.closed = true;
    this.readyState = MockWebSocket.CLOSED;
  }

  _fire(data: unknown) {
    this.onmessage?.({ data: JSON.stringify(data) });
  }

  _fireBinary(msgno: number, payload: Uint8Array) {
    const frame = new ArrayBuffer(1 + 4 + payload.byteLength);
    const bytes = new Uint8Array(frame);
    const view = new DataView(frame);
    bytes[0] = 0x01;
    view.setUint32(1, msgno, false);
    bytes.set(payload, 5);
    this.onmessage?.({ data: frame });
  }

  _fireAck(ackMsgno: number) {
    const frame = new ArrayBuffer(1 + 4);
    const bytes = new Uint8Array(frame);
    const view = new DataView(frame);
    bytes[0] = 0x02;
    view.setUint32(1, ackMsgno, false);
    this.onmessage?.({ data: frame });
  }

  _fireKeepaliveBinary() {
    const frame = new ArrayBuffer(1);
    new Uint8Array(frame)[0] = 0x03;
    this.onmessage?.({ data: frame });
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

import {
  TrackerConnection,
  TrackerConnectionCallbacks,
  MatchedParams,
  ConnectionStatus,
} from '../../services/TrackerConnection';

let trackerDisconnectCount = 0;
let expectedTrackerDisconnects = 0;
const activeConnections = new Set<TrackerConnection>();

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

function makeCallbacks(): TrackerConnectionCallbacks {
  return {
    onMatched: jest.fn(),
    onConnectionStatus: jest.fn(),
    onPeerReconnected: jest.fn(),
    onDataMessage: jest.fn(),
    onAck: jest.fn(),
    onKeepalive: jest.fn(),
    onClosed: jest.fn(),
    onTrackerDisconnected: jest.fn(() => { trackerDisconnectCount++; }),
    onTrackerReconnected: jest.fn(),
    onTrackerActivity: jest.fn(),
    onChat: jest.fn(),
    onLobbyAttention: jest.fn(),
  };
}

function makeConnection(
  trackerUrl: string,
  sessionId: string,
  callbacks: TrackerConnectionCallbacks,
  options?: ConstructorParameters<typeof TrackerConnection>[3],
): TrackerConnection {
  const conn = new TrackerConnection(trackerUrl, sessionId, callbacks, options);
  activeConnections.add(conn);
  return conn;
}

beforeEach(() => {
  trackerDisconnectCount = 0;
  expectedTrackerDisconnects = 0;
  MockWebSocket.instance = null;
});

afterEach(() => {
  expect(trackerDisconnectCount).toBe(expectedTrackerDisconnects);
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
    await Promise.resolve(); // flush microtasks

    const ws = MockWebSocket.instance!;
    expect(ws.url).toBe('ws://t/ws/game');
    expect(ws.sentJson).toEqual([{ type: 'identify', session_id: 's1', busy: false }]);
  });

  it('sends identify with initial busy=true over ws on open', async () => {
    const cb = makeCallbacks();
    makeConnection('http://t', 's1', cb, { initialBusy: true });
    await Promise.resolve(); // flush microtasks

    const ws = MockWebSocket.instance!;
    expect(ws.sentJson).toEqual([{ type: 'identify', session_id: 's1', busy: true }]);
  });

  it('sends identify with initial alias over ws on open', async () => {
    const cb = makeCallbacks();
    makeConnection('http://t', 's1', cb, { initialBusy: true, initialAlias: 'Alice' });
    await Promise.resolve(); // flush microtasks

    const ws = MockWebSocket.instance!;
    expect(ws.sentJson).toEqual([{ type: 'identify', session_id: 's1', busy: true, alias: 'Alice' }]);
  });
});

// ---------------------------------------------------------------------------
// Event routing
// ---------------------------------------------------------------------------

describe('event routing', () => {
  it('routes matched to onMatched', async () => {
    const cb = makeCallbacks();
    makeConnection('http://t', 's1', cb);
    await Promise.resolve();

    const params: MatchedParams = {
      token: 'tok',
      amount: '100',
      i_am_initiator: true,
    };
    MockWebSocket.instance!._fire({ type: 'matched', ...params });
    expect(cb.onMatched).toHaveBeenCalledWith(params);
  });

  it('routes connection_status to onConnectionStatus', async () => {
    const cb = makeCallbacks();
    makeConnection('http://t', 's1', cb);
    await Promise.resolve();

    const status: ConnectionStatus = { has_pairing: true, token: 'tok', peer_connected: true };
    MockWebSocket.instance!._fire({ type: 'connection_status', ...status });
    expect(cb.onConnectionStatus).toHaveBeenCalledWith(status);
  });

  it('routes peer_reconnected to onPeerReconnected', async () => {
    const cb = makeCallbacks();
    makeConnection('http://t', 's1', cb);
    await Promise.resolve();

    MockWebSocket.instance!._fire({ type: 'peer_reconnected' });
    expect(cb.onPeerReconnected).toHaveBeenCalled();
  });

  it('routes closed to onClosed', async () => {
    const cb = makeCallbacks();
    makeConnection('http://t', 's1', cb);
    await Promise.resolve();

    MockWebSocket.instance!._fire({ type: 'closed' });
    expect(cb.onClosed).toHaveBeenCalled();
  });

  it('sends close immediately when the websocket is open', async () => {
    const cb = makeCallbacks();
    const conn = makeConnection('http://t', 's1', cb);
    await Promise.resolve();

    conn.close();

    expect(MockWebSocket.instance!.sentJson).toContainEqual({ type: 'close', session_id: 's1' });
  });

  it('sends a pending close after the websocket opens', async () => {
    const cb = makeCallbacks();
    const conn = makeConnection('http://t', 's1', cb);

    conn.close();
    expect(MockWebSocket.instance!.sentJson).toEqual([]);

    await Promise.resolve();

    expect(MockWebSocket.instance!.sentJson).toContainEqual({ type: 'identify', session_id: 's1', busy: false });
    expect(MockWebSocket.instance!.sentJson).toContainEqual({ type: 'close', session_id: 's1' });
  });

  it('fires onTrackerDisconnected on ws error', async () => {
    expectedTrackerDisconnects = 1;
    const cb = makeCallbacks();
    makeConnection('http://t', 's1', cb);
    await Promise.resolve();

    MockWebSocket.instance!._fireError();
    expect(cb.onTrackerDisconnected).toHaveBeenCalled();
  });

  it('fires onTrackerReconnected on ws reopen after error', async () => {
    expectedTrackerDisconnects = 1;
    const cb = makeCallbacks();
    makeConnection('http://t', 's1', cb);
    await Promise.resolve();

    MockWebSocket.instance!._fireError();
    MockWebSocket.instance!.onopen?.({ type: 'open' });
    expect(cb.onTrackerReconnected).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Message discrimination (keepalive vs ack vs data)
// ---------------------------------------------------------------------------

describe('binary frame discrimination', () => {
  it('routes keepalive binary frames to onKeepalive', async () => {
    const cb = makeCallbacks();
    const conn = makeConnection('http://t', 's1', cb);
    await Promise.resolve();

    conn.registerMessageHandler(jest.fn(), jest.fn(), jest.fn());
    MockWebSocket.instance!._fireKeepaliveBinary();
    expect(cb.onKeepalive).toHaveBeenCalled();
    expect(cb.onDataMessage).not.toHaveBeenCalled();
  });

  it('routes ack binary frames to onAck', async () => {
    const cb = makeCallbacks();
    const conn = makeConnection('http://t', 's1', cb);
    await Promise.resolve();

    conn.registerMessageHandler(jest.fn(), jest.fn(), jest.fn());
    MockWebSocket.instance!._fireAck(5);
    expect((cb.onAck as jest.Mock)).toHaveBeenCalledWith(5);
    expect(cb.onDataMessage).not.toHaveBeenCalled();
  });

  it('routes data binary frames to handler after registerMessageHandler', async () => {
    const cb = makeCallbacks();
    const conn = makeConnection('http://t', 's1', cb);
    await Promise.resolve();

    const handler = jest.fn();
    conn.registerMessageHandler(handler, jest.fn(), jest.fn());

    const payload = new TextEncoder().encode('hello');
    MockWebSocket.instance!._fireBinary(1, payload);
    expect(handler).toHaveBeenCalledWith(1, payload);
  });
});

// ---------------------------------------------------------------------------
// Message buffering before registerMessageHandler
// ---------------------------------------------------------------------------

describe('message buffering before registerMessageHandler', () => {
  it('buffers data messages then delivers them on registration', async () => {
    const cb = makeCallbacks();
    const conn = makeConnection('http://t', 's1', cb);
    await Promise.resolve();

    const first = new TextEncoder().encode('first');
    const second = new TextEncoder().encode('second');
    MockWebSocket.instance!._fireBinary(1, first);
    MockWebSocket.instance!._fireBinary(2, second);
    expect(cb.onDataMessage).not.toHaveBeenCalled();

    const handler = jest.fn();
    conn.registerMessageHandler(handler, jest.fn(), jest.fn());

    expect(handler).toHaveBeenCalledTimes(2);
    expect(handler).toHaveBeenCalledWith(1, first);
    expect(handler).toHaveBeenCalledWith(2, second);
  });
});

// ---------------------------------------------------------------------------
// Close-pending suppresses messages
// ---------------------------------------------------------------------------

describe('close-pending suppresses messages', () => {
  it('suppresses messages while close is pending, resumes after closed event', async () => {
    const cb = makeCallbacks();
    const conn = makeConnection('http://t', 's1', cb);
    await Promise.resolve();

    const handler = jest.fn();
    conn.registerMessageHandler(handler, jest.fn(), jest.fn());

    conn.close();
    expect(MockWebSocket.instance!.sentJson).toContainEqual({ type: 'close', session_id: 's1' });

    MockWebSocket.instance!._fireBinary(1, new TextEncoder().encode('suppressed'));
    expect(handler).not.toHaveBeenCalled();

    MockWebSocket.instance!._fire({ type: 'closed' });
    expect(cb.onClosed).toHaveBeenCalled();

    const delivered = new TextEncoder().encode('delivered');
    MockWebSocket.instance!._fireBinary(2, delivered);
    expect(handler).toHaveBeenCalledWith(2, delivered);
  });
});

// ---------------------------------------------------------------------------
// Outbound message format
// ---------------------------------------------------------------------------

describe('outbound message format', () => {
  it('sendMessage posts type-tagged binary frame', async () => {
    const cb = makeCallbacks();
    const conn = makeConnection('http://t', 's1', cb);
    await Promise.resolve();
    const ws = MockWebSocket.instance!;
    ws.sentBinary = [];
    const payload = new TextEncoder().encode('payload');
    conn.sendMessage(3, payload);
    expect(ws.sentBinary).toHaveLength(1);
    const frame = ws.sentBinary[0];
    expect(frame[0]).toBe(0x01);
    const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
    expect(view.getUint32(1, false)).toBe(3);
    expect(new Uint8Array(frame.buffer, frame.byteOffset + 5)).toEqual(payload);
  });

  it('sendAck posts ack as binary frame', async () => {
    const cb = makeCallbacks();
    const conn = makeConnection('http://t', 's1', cb);
    await Promise.resolve();
    const ws = MockWebSocket.instance!;
    ws.sentBinary = [];
    conn.sendAck(5);
    expect(ws.sentBinary).toHaveLength(1);
    const frame = ws.sentBinary[0];
    expect(frame[0]).toBe(0x02);
    const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
    expect(view.getUint32(1, false)).toBe(5);
  });

  it('sendKeepalive posts keepalive as binary frame', async () => {
    const cb = makeCallbacks();
    const conn = makeConnection('http://t', 's1', cb);
    await Promise.resolve();
    const ws = MockWebSocket.instance!;
    ws.sentBinary = [];
    conn.sendKeepalive();
    expect(ws.sentBinary).toHaveLength(1);
    expect(ws.sentBinary[0]).toEqual(new Uint8Array([0x03]));
  });
});

// ---------------------------------------------------------------------------
// forceDisconnect does not post close
// ---------------------------------------------------------------------------

describe('forceDisconnect lifecycle', () => {
  it('forceDisconnect does not post close', async () => {
    const cb = makeCallbacks();
    const conn = makeConnection('http://t', 's1', cb);
    await Promise.resolve();
    conn.forceDisconnect();
    expect(MockWebSocket.instance!.sentJson.some((m) => (m as any).type === 'close')).toBe(false);
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
    ws.sentJson = [];
    conn.setBusy(false);
    expect(ws.sentJson).toEqual([{ type: 'set_busy', session_id: 's1', busy: false }]);
  });

  it('sends set_busy with busy=true', async () => {
    const cb = makeCallbacks();
    const conn = makeConnection('http://t', 's1', cb);
    await Promise.resolve();
    const ws = MockWebSocket.instance!;
    ws.sentJson = [];
    conn.setBusy(true);
    expect(ws.sentJson).toEqual([{ type: 'set_busy', session_id: 's1', busy: true }]);
  });

  it('sends set_busy with alias and keeps it for later refreshes', async () => {
    const cb = makeCallbacks();
    const conn = makeConnection('http://t', 's1', cb);
    await Promise.resolve();
    const ws = MockWebSocket.instance!;
    ws.sentJson = [];

    conn.setBusy(true, 'Alice');
    conn.refreshPresence();

    expect(ws.sentJson).toEqual([
      { type: 'set_busy', session_id: 's1', busy: true, alias: 'Alice' },
      { type: 'set_busy', session_id: 's1', busy: true, alias: 'Alice' },
    ]);
  });

  it('includes busy=true in identify on reconnect', async () => {
    jest.useFakeTimers();
    const cb = makeCallbacks();
    const conn = makeConnection('http://t', 's1', cb);
    await Promise.resolve();
    expectedTrackerDisconnects = 1;
    conn.setBusy(true);

    const ws1 = MockWebSocket.instance!;
    ws1._fireClose();
    jest.advanceTimersByTime(5000);
    await Promise.resolve();

    const ws2 = MockWebSocket.instance!;
    expect(ws2).not.toBe(ws1);
    const identifyMsg = ws2.sentJson.find((m: any) => m.type === 'identify') as any;
    expect(identifyMsg).toBeDefined();
    expect(identifyMsg.busy).toBe(true);
    jest.useRealTimers();
  });

  it('includes alias in identify on reconnect', async () => {
    jest.useFakeTimers();
    const cb = makeCallbacks();
    const conn = makeConnection('http://t', 's1', cb);
    await Promise.resolve();
    expectedTrackerDisconnects = 1;
    conn.setBusy(true, 'Alice');

    const ws1 = MockWebSocket.instance!;
    ws1._fireClose();
    jest.advanceTimersByTime(1000);

    const ws2 = MockWebSocket.instance!;
    expect(ws2).not.toBe(ws1);
    const identifyMsg = ws2.sentJson.find((m: any) => m.type === 'identify') as any;
    expect(identifyMsg).toMatchObject({ type: 'identify', session_id: 's1', busy: true, alias: 'Alice' });
    jest.useRealTimers();
  });
});

// ---------------------------------------------------------------------------
// Retry budget
// ---------------------------------------------------------------------------

describe('retry budget', () => {
  it('MAX_RECONNECT_ATTEMPTS is a positive number', () => {
    expect(TrackerConnection.MAX_RECONNECT_ATTEMPTS).toBeGreaterThan(0);
  });

  it('does not fire onClosed on a normal single close', async () => {
    const cb = makeCallbacks();
    expectedTrackerDisconnects = 1;
    makeConnection('http://t', 's1', cb);
    await Promise.resolve();
    MockWebSocket.instance!._fireClose();
    expect(cb.onClosed).not.toHaveBeenCalled();
  });
});
