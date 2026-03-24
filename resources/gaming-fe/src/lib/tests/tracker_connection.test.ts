let mockSocket: any;

jest.mock('socket.io-client', () => ({
  __esModule: true,
  default: jest.fn(() => {
    const handlers = new Map<string, Function[]>();
    const managerHandlers = new Map<string, Function[]>();

    mockSocket = {
      on: jest.fn((event: string, handler: Function) => {
        if (!handlers.has(event)) handlers.set(event, []);
        handlers.get(event)!.push(handler);
        return mockSocket;
      }),
      emit: jest.fn(),
      disconnect: jest.fn(),
      io: {
        on: jest.fn((event: string, handler: Function) => {
          if (!managerHandlers.has(event)) managerHandlers.set(event, []);
          managerHandlers.get(event)!.push(handler);
        }),
        _fire: (event: string, ...args: any[]) => {
          for (const h of managerHandlers.get(event) || []) h(...args);
        },
      },
      _fire: (event: string, ...args: any[]) => {
        for (const h of handlers.get(event) || []) h(...args);
      },
    };

    return mockSocket;
  }),
}));

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
  };
}

beforeEach(() => {
  jest.useFakeTimers();
  trackerDisconnectCount = 0;
  expectedTrackerDisconnects = 0;
});

afterEach(() => {
  expect(trackerDisconnectCount).toBe(expectedTrackerDisconnects);
  jest.clearAllTimers();
  jest.useRealTimers();
});

// ---------------------------------------------------------------------------
// Event routing
// ---------------------------------------------------------------------------

describe('event routing', () => {
  it('routes matched to onMatched', () => {
    const cb = makeCallbacks();
    new TrackerConnection('http://t', 's1', cb);

    const params: MatchedParams = {
      token: 'tok',
      game_type: 'calpoker',
      amount: '100',
      per_game: '10',
      i_am_initiator: true,
    };
    mockSocket._fire('matched', params);
    expect(cb.onMatched).toHaveBeenCalledWith(params);
  });

  it('routes connection_status to onConnectionStatus', () => {
    const cb = makeCallbacks();
    new TrackerConnection('http://t', 's1', cb);

    const status: ConnectionStatus = { has_pairing: true, token: 'tok', peer_connected: true };
    mockSocket._fire('connection_status', status);
    expect(cb.onConnectionStatus).toHaveBeenCalledWith(status);
  });

  it('routes peer_reconnected to onPeerReconnected', () => {
    const cb = makeCallbacks();
    new TrackerConnection('http://t', 's1', cb);
    mockSocket._fire('peer_reconnected');
    expect(cb.onPeerReconnected).toHaveBeenCalled();
  });

  it('routes closed to onClosed', () => {
    const cb = makeCallbacks();
    new TrackerConnection('http://t', 's1', cb);
    mockSocket._fire('closed');
    expect(cb.onClosed).toHaveBeenCalled();
  });

  it('routes disconnect to onTrackerDisconnected', () => {
    expectedTrackerDisconnects = 1;
    const cb = makeCallbacks();
    new TrackerConnection('http://t', 's1', cb);
    mockSocket._fire('disconnect');
    expect(cb.onTrackerDisconnected).toHaveBeenCalled();
  });

  it('routes manager reconnect to onTrackerReconnected', () => {
    const cb = makeCallbacks();
    new TrackerConnection('http://t', 's1', cb);
    mockSocket.io._fire('reconnect');
    expect(cb.onTrackerReconnected).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Message discrimination (ping vs ack vs data)
// ---------------------------------------------------------------------------

describe('message discrimination', () => {
  it('routes ping messages to onPing, not onMessage', () => {
    const cb = makeCallbacks();
    new TrackerConnection('http://t', 's1', cb);

    mockSocket._fire('message', { data: '{"ping":true}' });
    expect(cb.onPing).toHaveBeenCalled();
    expect(cb.onMessage).not.toHaveBeenCalled();
  });

  it('routes ack messages to onAck', () => {
    const cb = makeCallbacks();
    new TrackerConnection('http://t', 's1', cb);

    mockSocket._fire('message', { data: '{"ack":5}' });
    expect((cb.onAck as jest.Mock)).toHaveBeenCalledWith(5);
    expect(cb.onMessage).not.toHaveBeenCalled();
  });

  it('routes data messages to handler after registerMessageHandler', () => {
    const cb = makeCallbacks();
    const conn = new TrackerConnection('http://t', 's1', cb);
    const handler = jest.fn();
    conn.registerMessageHandler(handler, jest.fn(), jest.fn());

    mockSocket._fire('message', { data: '{"msgno":1,"msg":"hello"}' });
    expect(handler).toHaveBeenCalledWith(1, 'hello');
  });
});

// ---------------------------------------------------------------------------
// Message buffering before registerMessageHandler
// ---------------------------------------------------------------------------

describe('message buffering before registerMessageHandler', () => {
  it('buffers data messages then delivers them on registration', () => {
    const cb = makeCallbacks();
    const conn = new TrackerConnection('http://t', 's1', cb);

    mockSocket._fire('message', { data: '{"msgno":1,"msg":"first"}' });
    mockSocket._fire('message', { data: '{"msgno":2,"msg":"second"}' });
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
  it('suppresses messages while close is pending, resumes after closed event', () => {
    const cb = makeCallbacks();
    const conn = new TrackerConnection('http://t', 's1', cb);
    const handler = jest.fn();
    conn.registerMessageHandler(handler, jest.fn(), jest.fn());

    conn.close();
    expect(mockSocket.emit).toHaveBeenCalledWith('close', {});

    mockSocket._fire('message', { data: '{"msgno":1,"msg":"suppressed"}' });
    expect(handler).not.toHaveBeenCalled();

    mockSocket._fire('closed');
    expect(cb.onClosed).toHaveBeenCalled();

    mockSocket._fire('message', { data: '{"msgno":2,"msg":"delivered"}' });
    expect(handler).toHaveBeenCalledWith(2, 'delivered');
  });
});

// ---------------------------------------------------------------------------
// Ping timer lifecycle
// ---------------------------------------------------------------------------

describe('ping timer lifecycle', () => {
  it('emits tracker_ping every 15s after connect, stops on disconnect', () => {
    expectedTrackerDisconnects = 1;
    const cb = makeCallbacks();
    new TrackerConnection('http://t', 's1', cb);

    mockSocket._fire('connect');
    expect(mockSocket.emit).toHaveBeenCalledWith('identify', { session_id: 's1' });

    mockSocket.emit.mockClear();
    jest.advanceTimersByTime(15_000);
    expect(mockSocket.emit).toHaveBeenCalledWith('tracker_ping');

    mockSocket._fire('disconnect');
    mockSocket.emit.mockClear();
    jest.advanceTimersByTime(15_000);
    expect(mockSocket.emit).not.toHaveBeenCalledWith('tracker_ping');
  });
});

// ---------------------------------------------------------------------------
// Ping timeout forces disconnect
// ---------------------------------------------------------------------------

describe('ping timeout forces disconnect', () => {
  it('disconnects when no tracker activity for >60s', () => {
    const cb = makeCallbacks();
    new TrackerConnection('http://t', 's1', cb);

    mockSocket._fire('connect');
    mockSocket.disconnect.mockClear();

    // At 60s the check is 60000 > 60000 → false (not strictly greater)
    jest.advanceTimersByTime(60_000);
    expect(mockSocket.disconnect).not.toHaveBeenCalled();

    // At 75s (next interval) the check is 75000 > 60000 → true
    jest.advanceTimersByTime(15_000);
    expect(mockSocket.disconnect).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Outbound message format
// ---------------------------------------------------------------------------

describe('outbound message format', () => {
  it('sendMessage emits numbered payload', () => {
    const cb = makeCallbacks();
    const conn = new TrackerConnection('http://t', 's1', cb);

    conn.sendMessage(3, 'payload');
    expect(mockSocket.emit).toHaveBeenCalledWith('message', {
      data: '{"msgno":3,"msg":"payload"}',
    });
  });

  it('sendAck emits ack payload', () => {
    const cb = makeCallbacks();
    const conn = new TrackerConnection('http://t', 's1', cb);

    conn.sendAck(5);
    expect(mockSocket.emit).toHaveBeenCalledWith('message', {
      data: '{"ack":5}',
    });
  });

  it('sendPing emits ping payload', () => {
    const cb = makeCallbacks();
    const conn = new TrackerConnection('http://t', 's1', cb);

    conn.sendPing();
    expect(mockSocket.emit).toHaveBeenCalledWith('message', {
      data: '{"ping":true}',
    });
  });
});

// ---------------------------------------------------------------------------
// forceDisconnect does not emit close
// ---------------------------------------------------------------------------

describe('forceDisconnect lifecycle', () => {
  it('forceDisconnect does not emit close event', () => {
    const cb = makeCallbacks();
    const conn = new TrackerConnection('http://t', 's1', cb);
    conn.forceDisconnect();
    expect(mockSocket.emit).not.toHaveBeenCalledWith('close', expect.anything());
    expect(mockSocket.disconnect).toHaveBeenCalled();
  });
});
