import { getGameSocket } from './GameSocket';

const socketHandlers: Record<string, Function> = {};
const ioHandlers: Record<string, Function> = {};

const mockSocket = {
  on: jest.fn((event: string, handler: Function) => {
    socketHandlers[event] = handler;
  }),
  emit: jest.fn(),
  io: {
    on: jest.fn((event: string, handler: Function) => {
      ioHandlers[event] = handler;
    }),
  },
};

jest.mock('socket.io-client', () => ({
  __esModule: true,
  default: jest.fn(() => mockSocket),
}));

jest.mock('uuid', () => ({
  v4: jest.fn(() => 'test-beacon-id'),
}));

const defaultSearchParams = { token: 'test-token', iStarted: 'true' };
const defaultLobbyUrl = 'http://localhost:3000';
const noop = jest.fn();

function createGameSocket(onConnectionError?: (msg: string) => void) {
  return getGameSocket(
    defaultSearchParams,
    defaultLobbyUrl,
    noop,
    noop,
    () => [],
    onConnectionError,
  );
}

describe('GameSocket connection error handling', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    for (const k of Object.keys(socketHandlers)) delete socketHandlers[k];
    for (const k of Object.keys(ioHandlers)) delete ioHandlers[k];
    mockSocket.on.mockClear();
    mockSocket.emit.mockClear();
    mockSocket.io.on.mockClear();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('registers connect_error, disconnect, and reconnect listeners', () => {
    createGameSocket(noop);

    expect(socketHandlers['connect_error']).toBeDefined();
    expect(socketHandlers['disconnect']).toBeDefined();
    expect(ioHandlers['reconnect']).toBeDefined();
  });

  it('calls onConnectionError with formatted message on connect_error', () => {
    const onConnectionError = jest.fn();
    createGameSocket(onConnectionError);

    socketHandlers['connect_error'](new Error('net::ERR_CONNECTION_REFUSED'));

    expect(onConnectionError).toHaveBeenCalledTimes(1);
    expect(onConnectionError).toHaveBeenCalledWith(
      'Connection error: net::ERR_CONNECTION_REFUSED',
    );
  });

  it('calls onConnectionError with reason on disconnect', () => {
    const onConnectionError = jest.fn();
    createGameSocket(onConnectionError);

    socketHandlers['disconnect']('transport close');

    expect(onConnectionError).toHaveBeenCalledTimes(1);
    expect(onConnectionError).toHaveBeenCalledWith('Disconnected: transport close');
  });

  it('calls onConnectionError with empty string on reconnect (clears error)', () => {
    const onConnectionError = jest.fn();
    createGameSocket(onConnectionError);

    ioHandlers['reconnect']();

    expect(onConnectionError).toHaveBeenCalledTimes(1);
    expect(onConnectionError).toHaveBeenCalledWith('');
  });

  it('handles full disconnect-then-reconnect cycle', () => {
    const onConnectionError = jest.fn();
    createGameSocket(onConnectionError);

    socketHandlers['connect_error'](new Error('server down'));
    socketHandlers['disconnect']('transport close');
    ioHandlers['reconnect']();

    expect(onConnectionError).toHaveBeenCalledTimes(3);
    expect(onConnectionError.mock.calls).toEqual([
      ['Connection error: server down'],
      ['Disconnected: transport close'],
      [''],
    ]);
  });

  it('does not crash when onConnectionError is omitted', () => {
    createGameSocket(undefined);

    expect(() => {
      socketHandlers['connect_error'](new Error('fail'));
      socketHandlers['disconnect']('transport close');
      ioHandlers['reconnect']();
    }).not.toThrow();
  });
});
