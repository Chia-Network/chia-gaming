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
    const frame = new ArrayBuffer(4 + payload.byteLength);
    const view = new DataView(frame);
    view.setUint32(0, msgno, false);
    new Uint8Array(frame, 4).set(payload);
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

(globalThis as any).WebSocket = MockWebSocket;

// ---------------------------------------------------------------------------
// Imports (after mocks are installed)
// ---------------------------------------------------------------------------

import {
  TrackerConnection,
  TrackerConnectionCallbacks,
  MatchedParams,
  ConnectionStatus,
} from '../../services/TrackerConnection';

let trackerDisconnectCount = 0;
let expectedTrackerDisconnects = 0;

function makeCallbacks(): TrackerConnectionCallbacks {
  return {
    onMatched: jest.fn(),
    onConnectionStatus: jest.fn(),
    onPeerReconnected: jest.fn(),
    onMessage: jest.fn(),
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

beforeEach(() => {
  trackerDisconnectCount = 0;
  expectedTrackerDisconnects = 0;
  MockWebSocket.instance = null;
});

afterEach(() => {
  expect(trackerDisconnectCount).toBe(expectedTrackerDisconnects);
});

// ---------------------------------------------------------------------------
// Connection setup
// ---------------------------------------------------------------------------

describe('connection setup', () => {
  it('sends identify over ws on open', async () => {
    const cb = makeCallbacks();
    new TrackerConnection('http://t', 's1', cb);
    await Promise.resolve(); // flush microtasks

    const ws = MockWebSocket.instance!;
    expect(ws.url).toBe('ws://t/ws/game');
    expect(ws.sentJson).toEqual([{ type: 'identify', session_id: 's1' }]);
  });
});

// ---------------------------------------------------------------------------
// Event routing
// ---------------------------------------------------------------------------

describe('event routing', () => {
  it('routes matched to onMatched', async () => {
    const cb = makeCallbacks();
    new TrackerConnection('http://t', 's1', cb);
    await Promise.resolve();

    const params: MatchedParams = {
      token: 'tok',
      game_type: 'calpoker',
      amount: '100',
      per_game: '10',
      i_am_initiator: true,
    };
    MockWebSocket.instance!._fire({ type: 'matched', ...params });
    expect(cb.onMatched).toHaveBeenCalledWith(params);
  });

  it('routes connection_status to onConnectionStatus', async () => {
    const cb = makeCallbacks();
    new TrackerConnection('http://t', 's1', cb);
    await Promise.resolve();

    const status: ConnectionStatus = { has_pairing: true, token: 'tok', peer_connected: true };
    MockWebSocket.instance!._fire({ type: 'connection_status', ...status });
    expect(cb.onConnectionStatus).toHaveBeenCalledWith(status);
  });

  it('routes peer_reconnected to onPeerReconnected', async () => {
    const cb = makeCallbacks();
    new TrackerConnection('http://t', 's1', cb);
    await Promise.resolve();

    MockWebSocket.instance!._fire({ type: 'peer_reconnected' });
    expect(cb.onPeerReconnected).toHaveBeenCalled();
  });

  it('routes closed to onClosed', async () => {
    const cb = makeCallbacks();
    new TrackerConnection('http://t', 's1', cb);
    await Promise.resolve();

    MockWebSocket.instance!._fire({ type: 'closed' });
    expect(cb.onClosed).toHaveBeenCalled();
  });

  it('fires onTrackerDisconnected on ws error', async () => {
    expectedTrackerDisconnects = 1;
    const cb = makeCallbacks();
    new TrackerConnection('http://t', 's1', cb);
    await Promise.resolve();

    MockWebSocket.instance!._fireError();
    expect(cb.onTrackerDisconnected).toHaveBeenCalled();
  });

  it('fires onTrackerReconnected on ws reopen after error', async () => {
    expectedTrackerDisconnects = 1;
    const cb = makeCallbacks();
    new TrackerConnection('http://t', 's1', cb);
    await Promise.resolve();

    MockWebSocket.instance!._fireError();
    MockWebSocket.instance!.onopen?.({ type: 'open' });
    expect(cb.onTrackerReconnected).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Message discrimination (keepalive vs ack vs data)
// ---------------------------------------------------------------------------

describe('message discrimination', () => {
  it('routes keepalive messages to onKeepalive, not onMessage', async () => {
    const cb = makeCallbacks();
    new TrackerConnection('http://t', 's1', cb);
    await Promise.resolve();

    MockWebSocket.instance!._fire({ type: 'message', data: { keepalive: true } });
    expect(cb.onKeepalive).toHaveBeenCalled();
    expect(cb.onMessage).not.toHaveBeenCalled();
  });

  it('routes ack messages to onAck', async () => {
    const cb = makeCallbacks();
    new TrackerConnection('http://t', 's1', cb);
    await Promise.resolve();

    MockWebSocket.instance!._fire({ type: 'message', data: { ack: 5 } });
    expect((cb.onAck as jest.Mock)).toHaveBeenCalledWith(5);
    expect(cb.onMessage).not.toHaveBeenCalled();
  });

  it('routes data messages to handler after registerMessageHandler', async () => {
    const cb = makeCallbacks();
    const conn = new TrackerConnection('http://t', 's1', cb);
    await Promise.resolve();

    const handler = jest.fn();
    conn.registerMessageHandler(handler, jest.fn(), jest.fn());

    const payload = new TextEncoder().encode('hello');
    MockWebSocket.instance!._fireBinary(1, payload);
    expect(handler).toHaveBeenCalledWith(1, payload);
  });

  it('ignores legacy string-encoded data payloads', async () => {
    const cb = makeCallbacks();
    const conn = new TrackerConnection('http://t', 's1', cb);
    await Promise.resolve();

    const handler = jest.fn();
    conn.registerMessageHandler(handler, jest.fn(), jest.fn());

    MockWebSocket.instance!._fire({ type: 'message', data: '{"msgno":9,"msg":"legacy"}' });
    expect(handler).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Message buffering before registerMessageHandler
// ---------------------------------------------------------------------------

describe('message buffering before registerMessageHandler', () => {
  it('buffers data messages then delivers them on registration', async () => {
    const cb = makeCallbacks();
    const conn = new TrackerConnection('http://t', 's1', cb);
    await Promise.resolve();

    const first = new TextEncoder().encode('first');
    const second = new TextEncoder().encode('second');
    MockWebSocket.instance!._fireBinary(1, first);
    MockWebSocket.instance!._fireBinary(2, second);
    expect(cb.onMessage).not.toHaveBeenCalled();

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
    const conn = new TrackerConnection('http://t', 's1', cb);
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
  it('sendMessage posts numbered payload as binary frame', async () => {
    const cb = makeCallbacks();
    const conn = new TrackerConnection('http://t', 's1', cb);
    await Promise.resolve();
    const ws = MockWebSocket.instance!;
    ws.sentBinary = [];
    const payload = new TextEncoder().encode('payload');
    conn.sendMessage(3, payload);
    expect(ws.sentBinary).toHaveLength(1);
    const frame = ws.sentBinary[0];
    const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
    expect(view.getUint32(0, false)).toBe(3);
    expect(new Uint8Array(frame.buffer, frame.byteOffset + 4)).toEqual(payload);
  });

  it('sendAck posts ack payload', async () => {
    const cb = makeCallbacks();
    const conn = new TrackerConnection('http://t', 's1', cb);
    await Promise.resolve();
    const ws = MockWebSocket.instance!;
    ws.sentJson = [];
    conn.sendAck(5);
    expect(ws.sentJson).toEqual([{ type: 'message', session_id: 's1', data: { ack: 5 } }]);
  });

  it('sendKeepalive posts keepalive payload', async () => {
    const cb = makeCallbacks();
    const conn = new TrackerConnection('http://t', 's1', cb);
    await Promise.resolve();
    const ws = MockWebSocket.instance!;
    ws.sentJson = [];
    conn.sendKeepalive();
    expect(ws.sentJson).toEqual([{ type: 'message', session_id: 's1', data: { keepalive: true } }]);
  });
});

// ---------------------------------------------------------------------------
// forceDisconnect does not post close
// ---------------------------------------------------------------------------

describe('forceDisconnect lifecycle', () => {
  it('forceDisconnect does not post close', async () => {
    const cb = makeCallbacks();
    const conn = new TrackerConnection('http://t', 's1', cb);
    await Promise.resolve();
    conn.forceDisconnect();
    expect(MockWebSocket.instance!.sentJson.some((m) => (m as any).type === 'close')).toBe(false);
    expect(MockWebSocket.instance!.closed).toBe(true);
  });
});
