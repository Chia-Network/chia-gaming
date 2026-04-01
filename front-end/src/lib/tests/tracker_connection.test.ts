// ---------------------------------------------------------------------------
// Mock EventSource
// ---------------------------------------------------------------------------

type ESListener = (e: MessageEvent) => void;

class MockEventSource {
  static instance: MockEventSource | null = null;

  url: string;
  listeners = new Map<string, ESListener[]>();
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  readyState = 0; // CONNECTING
  closed = false;

  constructor(url: string) {
    this.url = url;
    MockEventSource.instance = this;
    // Simulate async open
    queueMicrotask(() => {
      if (!this.closed) {
        this.readyState = 1; // OPEN
        this.onopen?.();
      }
    });
  }

  addEventListener(event: string, handler: ESListener) {
    if (!this.listeners.has(event)) this.listeners.set(event, []);
    this.listeners.get(event)!.push(handler);
  }

  removeEventListener(event: string, handler: ESListener) {
    const arr = this.listeners.get(event);
    if (arr) {
      const idx = arr.indexOf(handler);
      if (idx >= 0) arr.splice(idx, 1);
    }
  }

  close() {
    this.closed = true;
    this.readyState = 2; // CLOSED
  }

  _fire(event: string, data?: unknown) {
    const json = data !== undefined ? JSON.stringify(data) : '';
    const me = new MessageEvent(event, { data: json });
    for (const h of this.listeners.get(event) || []) {
      h(me);
    }
  }

  _fireError() {
    this.readyState = 0;
    this.onerror?.();
  }
}

(globalThis as any).EventSource = MockEventSource;

// ---------------------------------------------------------------------------
// Mock fetch
// ---------------------------------------------------------------------------

const fetchCalls: { url: string; body: any }[] = [];

(globalThis as any).fetch = jest.fn(async (url: string, init?: RequestInit) => {
  const body = init?.body ? JSON.parse(init.body as string) : undefined;
  fetchCalls.push({ url, body });
  return { ok: true, json: async () => ({ ok: true, player_id: null }) };
});

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
    onPing: jest.fn(),
    onClosed: jest.fn(),
    onTrackerDisconnected: jest.fn(() => { trackerDisconnectCount++; }),
    onTrackerReconnected: jest.fn(),
    onChat: jest.fn(),
  };
}

function getMockES(): MockEventSource {
  return MockEventSource.instance!;
}

beforeEach(() => {
  trackerDisconnectCount = 0;
  expectedTrackerDisconnects = 0;
  fetchCalls.length = 0;
  MockEventSource.instance = null;
  (fetch as jest.Mock).mockClear();
});

afterEach(() => {
  expect(trackerDisconnectCount).toBe(expectedTrackerDisconnects);
});

// ---------------------------------------------------------------------------
// Connection setup
// ---------------------------------------------------------------------------

describe('connection setup', () => {
  it('posts identify and opens EventSource on construction', async () => {
    const cb = makeCallbacks();
    new TrackerConnection('http://t', 's1', cb);
    await Promise.resolve(); // flush microtasks

    expect(fetchCalls.some(c => c.url === 'http://t/game/identify' && c.body.session_id === 's1')).toBe(true);
    expect(getMockES().url).toBe('http://t/game/events?session_id=s1');
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
    getMockES()._fire('matched', params);
    expect(cb.onMatched).toHaveBeenCalledWith(params);
  });

  it('routes connection_status to onConnectionStatus', async () => {
    const cb = makeCallbacks();
    new TrackerConnection('http://t', 's1', cb);
    await Promise.resolve();

    const status: ConnectionStatus = { has_pairing: true, token: 'tok', peer_connected: true };
    getMockES()._fire('connection_status', status);
    expect(cb.onConnectionStatus).toHaveBeenCalledWith(status);
  });

  it('routes peer_reconnected to onPeerReconnected', async () => {
    const cb = makeCallbacks();
    new TrackerConnection('http://t', 's1', cb);
    await Promise.resolve();

    getMockES()._fire('peer_reconnected', {});
    expect(cb.onPeerReconnected).toHaveBeenCalled();
  });

  it('routes closed to onClosed', async () => {
    const cb = makeCallbacks();
    new TrackerConnection('http://t', 's1', cb);
    await Promise.resolve();

    getMockES()._fire('closed');
    expect(cb.onClosed).toHaveBeenCalled();
  });

  it('fires onTrackerDisconnected on SSE error', async () => {
    expectedTrackerDisconnects = 1;
    const cb = makeCallbacks();
    new TrackerConnection('http://t', 's1', cb);
    await Promise.resolve();

    getMockES()._fireError();
    expect(cb.onTrackerDisconnected).toHaveBeenCalled();
  });

  it('fires onTrackerReconnected on SSE reopen after error', async () => {
    expectedTrackerDisconnects = 1;
    const cb = makeCallbacks();
    new TrackerConnection('http://t', 's1', cb);
    await Promise.resolve();

    getMockES()._fireError();
    getMockES().onopen?.();
    expect(cb.onTrackerReconnected).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Message discrimination (ping vs ack vs data)
// ---------------------------------------------------------------------------

describe('message discrimination', () => {
  it('routes ping messages to onPing, not onMessage', async () => {
    const cb = makeCallbacks();
    new TrackerConnection('http://t', 's1', cb);
    await Promise.resolve();

    getMockES()._fire('message', { data: { ping: true } });
    expect(cb.onPing).toHaveBeenCalled();
    expect(cb.onMessage).not.toHaveBeenCalled();
  });

  it('routes ack messages to onAck', async () => {
    const cb = makeCallbacks();
    new TrackerConnection('http://t', 's1', cb);
    await Promise.resolve();

    getMockES()._fire('message', { data: { ack: 5 } });
    expect((cb.onAck as jest.Mock)).toHaveBeenCalledWith(5);
    expect(cb.onMessage).not.toHaveBeenCalled();
  });

  it('routes data messages to handler after registerMessageHandler', async () => {
    const cb = makeCallbacks();
    const conn = new TrackerConnection('http://t', 's1', cb);
    await Promise.resolve();

    const handler = jest.fn();
    conn.registerMessageHandler(handler, jest.fn(), jest.fn());

    getMockES()._fire('message', { data: { msgno: 1, msg: 'hello' } });
    expect(handler).toHaveBeenCalledWith(1, 'hello');
  });

  it('ignores legacy string-encoded data payloads', async () => {
    const cb = makeCallbacks();
    const conn = new TrackerConnection('http://t', 's1', cb);
    await Promise.resolve();

    const handler = jest.fn();
    conn.registerMessageHandler(handler, jest.fn(), jest.fn());

    getMockES()._fire('message', { data: '{"msgno":9,"msg":"legacy"}' });
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

    getMockES()._fire('message', { data: { msgno: 1, msg: 'first' } });
    getMockES()._fire('message', { data: { msgno: 2, msg: 'second' } });
    expect(cb.onMessage).not.toHaveBeenCalled();

    const handler = jest.fn();
    conn.registerMessageHandler(handler, jest.fn(), jest.fn());

    expect(handler).toHaveBeenCalledTimes(2);
    expect(handler).toHaveBeenCalledWith(1, 'first');
    expect(handler).toHaveBeenCalledWith(2, 'second');
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
    expect(fetchCalls.some(c => c.url === 'http://t/game/close')).toBe(true);

    getMockES()._fire('message', { data: { msgno: 1, msg: 'suppressed' } });
    expect(handler).not.toHaveBeenCalled();

    getMockES()._fire('closed');
    expect(cb.onClosed).toHaveBeenCalled();

    getMockES()._fire('message', { data: { msgno: 2, msg: 'delivered' } });
    expect(handler).toHaveBeenCalledWith(2, 'delivered');
  });
});

// ---------------------------------------------------------------------------
// Outbound message format
// ---------------------------------------------------------------------------

describe('outbound message format', () => {
  it('sendMessage posts numbered payload', async () => {
    const cb = makeCallbacks();
    const conn = new TrackerConnection('http://t', 's1', cb);
    await Promise.resolve();
    fetchCalls.length = 0;

    conn.sendMessage(3, 'payload');
    expect(fetchCalls).toEqual([
      { url: 'http://t/game/send', body: { session_id: 's1', data: { msgno: 3, msg: 'payload' } } },
    ]);
  });

  it('sendAck posts ack payload', async () => {
    const cb = makeCallbacks();
    const conn = new TrackerConnection('http://t', 's1', cb);
    await Promise.resolve();
    fetchCalls.length = 0;

    conn.sendAck(5);
    expect(fetchCalls).toEqual([
      { url: 'http://t/game/send', body: { session_id: 's1', data: { ack: 5 } } },
    ]);
  });

  it('sendPing posts ping payload', async () => {
    const cb = makeCallbacks();
    const conn = new TrackerConnection('http://t', 's1', cb);
    await Promise.resolve();
    fetchCalls.length = 0;

    conn.sendPing();
    expect(fetchCalls).toEqual([
      { url: 'http://t/game/send', body: { session_id: 's1', data: { ping: true } } },
    ]);
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
    fetchCalls.length = 0;

    conn.forceDisconnect();
    expect(fetchCalls.some(c => c.url.includes('/game/close'))).toBe(false);
    expect(getMockES().closed).toBe(true);
  });
});
