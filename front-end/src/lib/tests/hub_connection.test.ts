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

function toPlainObject(value: BencodexValue): unknown {
  if (value instanceof Uint8Array) return value;
  if (Array.isArray(value)) return value.map(toPlainObject);
  if (isDictionary(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, item] of value.entries()) {
      out[typeof key === 'string' ? key : new TextDecoder().decode(key as Uint8Array)] = toPlainObject(item);
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
      if (data[0] === 0x64) this.sentControl.push(toPlainObject(decodeBencodex(data) as BencodexValue));
      else this.sentBinary.push(data);
    } else if (data instanceof ArrayBuffer) {
      const bytes = new Uint8Array(data);
      if (bytes[0] === 0x64) this.sentControl.push(toPlainObject(decodeBencodex(bytes) as BencodexValue));
      else this.sentBinary.push(bytes);
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

  _fireBinaryInbound(fromId: string, payload: Uint8Array, fromAlias?: string) {
    // Inbound binary format: [4B from_id_len BE][from_id][4B from_alias_len BE][from_alias][payload]
    const fromIdBuf = new TextEncoder().encode(fromId);
    const aliasBuf = new TextEncoder().encode(fromAlias ?? fromId);
    const frame = new ArrayBuffer(4 + fromIdBuf.byteLength + 4 + aliasBuf.byteLength + payload.byteLength);
    const view = new DataView(frame);
    const bytes = new Uint8Array(frame);
    let offset = 0;
    view.setUint32(offset, fromIdBuf.byteLength, false); offset += 4;
    bytes.set(fromIdBuf, offset); offset += fromIdBuf.byteLength;
    view.setUint32(offset, aliasBuf.byteLength, false); offset += 4;
    bytes.set(aliasBuf, offset); offset += aliasBuf.byteLength;
    bytes.set(payload, offset);
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
  HubConnection,
  HubConnectionCallbacks,
} from '../../services/HubConnection';

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

function makeCallbacks(presence?: { busy: boolean; alias?: string }): HubConnectionCallbacks & Record<string, jest.Mock> {
  return {
    onAdvisoryStart: jest.fn(),
    onPeerMessage: jest.fn(),
    onPeerAppMessage: jest.fn(),
    onDeliveryFailure: jest.fn(),
    onRegistered: jest.fn(),
    onHubAttention: jest.fn(),
    onHubDisconnected: jest.fn(() => { hubDisconnectCount++; }),
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
  const conn = new HubConnection(hubUrl, sessionId, callbacks);
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
    expect(ws.sentControl).toEqual([{ type: 'identify', session_id: 's1', busy: false }]);
  });

  it('sends identify with busy=true from getPresence over ws on open', async () => {
    const cb = makeCallbacks({ busy: true });
    makeConnection('http://t', 's1', cb);
    await Promise.resolve();

    const ws = MockWebSocket.instance!;
    expect(ws.sentControl).toEqual([{ type: 'identify', session_id: 's1', busy: true }]);
  });

  it('sends identify with alias from getPresence over ws on open', async () => {
    const cb = makeCallbacks({ busy: true, alias: 'Alice' });
    makeConnection('http://t', 's1', cb);
    await Promise.resolve();

    const ws = MockWebSocket.instance!;
    expect(ws.sentControl).toEqual([{ type: 'identify', session_id: 's1', busy: true, alias: 'Alice' }]);
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
      peer_id: 'p2',
      peer_alias: 'Bob',
      my_amount: '100',
      their_amount: '100',
    });
    expect(cb.onAdvisoryStart).toHaveBeenCalledWith({
      peer_id: 'p2',
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

    MockWebSocket.instance!._fire({ type: 'registered', player_id: 'p_abc' });
    expect(cb.onRegistered).toHaveBeenCalledWith('p_abc');
  });

  it('routes delivery_failure to onDeliveryFailure', async () => {
    const cb = makeCallbacks();
    makeConnection('http://t', 's1', cb);
    await Promise.resolve();

    MockWebSocket.instance!._fire({ type: 'delivery_failure', to: 'p_target' });
    expect(cb.onDeliveryFailure).toHaveBeenCalledWith('p_target');
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
    MockWebSocket.instance!._fireBinaryInbound('p_sender', payload);
    expect(cb.onPeerMessage).toHaveBeenCalledWith('p_sender', 'p_sender', payload);
  });

  it('dispatches bencodex peer app messages to onPeerAppMessage', async () => {
    const cb = makeCallbacks();
    makeConnection('http://t', 's1', cb);
    await Promise.resolve();

    const appMessage = { type: 'session_proposal', proposer_amount: '500', responder_amount: '500' };
    const payload = encodeBencodex(appMessage);
    MockWebSocket.instance!._fireBinaryInbound('p_sender', payload);
    expect(cb.onPeerAppMessage).toHaveBeenCalledWith('p_sender', 'p_sender', appMessage);
  });

  it('passes distinct alias from binary frame header', async () => {
    const cb = makeCallbacks();
    makeConnection('http://t', 's1', cb);
    await Promise.resolve();

    const payload = new TextEncoder().encode('data');
    MockWebSocket.instance!._fireBinaryInbound('p_sender', payload, 'Alice');
    expect(cb.onPeerMessage).toHaveBeenCalledWith('p_sender', 'Alice', payload);
  });
});

// ---------------------------------------------------------------------------
// Outbound message format
// ---------------------------------------------------------------------------

describe('outbound message format', () => {
  it('sendToPeer posts addressed binary frame', async () => {
    const cb = makeCallbacks();
    const conn = makeConnection('http://t', 's1', cb);
    await Promise.resolve();
    const ws = MockWebSocket.instance!;
    ws.sentBinary = [];

    const payload = new TextEncoder().encode('payload');
    conn.sendToPeer('p_target', payload);
    expect(ws.sentBinary).toHaveLength(1);

    const frame = ws.sentBinary[0];
    const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
    const targetIdLen = view.getUint32(0, false);
    expect(targetIdLen).toBe(8); // 'p_target'.length
    const targetId = new TextDecoder().decode(frame.slice(4, 4 + targetIdLen));
    expect(targetId).toBe('p_target');
    const data = frame.slice(4 + targetIdLen);
    expect(data).toEqual(payload);
  });

  it('sendPeerAppMessage encodes bencodex as binary frame', async () => {
    const cb = makeCallbacks();
    const conn = makeConnection('http://t', 's1', cb);
    await Promise.resolve();
    const ws = MockWebSocket.instance!;
    ws.sentBinary = [];

    conn.sendPeerAppMessage('p_target', { type: 'session_proposal', proposer_amount: '100', responder_amount: '100' });
    expect(ws.sentBinary).toHaveLength(1);

    const frame = ws.sentBinary[0];
    const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
    const targetIdLen = view.getUint32(0, false);
    const targetId = new TextDecoder().decode(frame.slice(4, 4 + targetIdLen));
    expect(targetId).toBe('p_target');
    const payloadBytes = frame.slice(4 + targetIdLen);
    const parsed = toPlainObject(decodeBencodex(payloadBytes) as BencodexValue);
    expect(parsed).toEqual({ type: 'session_proposal', proposer_amount: '100', responder_amount: '100' });
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
    expect(ws.sentControl).toEqual([{ type: 'set_busy', session_id: 's1', busy: false }]);
  });

  it('sends set_busy with busy=true', async () => {
    const cb = makeCallbacks();
    const conn = makeConnection('http://t', 's1', cb);
    await Promise.resolve();
    const ws = MockWebSocket.instance!;
    ws.sentControl = [];
    conn.setBusy(true);
    expect(ws.sentControl).toEqual([{ type: 'set_busy', session_id: 's1', busy: true }]);
  });

  it('sends set_busy with alias', async () => {
    const cb = makeCallbacks();
    const conn = makeConnection('http://t', 's1', cb);
    await Promise.resolve();
    const ws = MockWebSocket.instance!;
    ws.sentControl = [];

    conn.setBusy(true, 'Alice');

    expect(ws.sentControl).toEqual([
      { type: 'set_busy', session_id: 's1', busy: true, alias: 'Alice' },
    ]);
  });

  it('uses getPresence for identify on reconnect', async () => {
    jest.useFakeTimers();
    const cb = makeCallbacks();
    (cb.getPresence as jest.Mock).mockReturnValue({ busy: true });
    const conn = makeConnection('http://t', 's1', cb);
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

  it('includes alias from getPresence in identify on reconnect', async () => {
    jest.useFakeTimers();
    const cb = makeCallbacks();
    (cb.getPresence as jest.Mock).mockReturnValue({ busy: true, alias: 'Alice' });
    const conn = makeConnection('http://t', 's1', cb);
    await Promise.resolve();
    expectedHubDisconnects = 1;

    const ws1 = MockWebSocket.instance!;
    ws1._fireClose();
    jest.advanceTimersByTime(7500);
    await Promise.resolve();

    const ws2 = MockWebSocket.instance!;
    expect(ws2).not.toBe(ws1);
    const identifyMsg = ws2.sentControl.find((m: any) => m.type === 'identify') as any;
    expect(identifyMsg).toMatchObject({ type: 'identify', session_id: 's1', busy: true, alias: 'Alice' });
    jest.useRealTimers();
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
