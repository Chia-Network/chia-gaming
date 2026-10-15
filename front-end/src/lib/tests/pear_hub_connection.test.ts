import type { HubConnectionCallbacks } from '../../services/HubConnection';
import { PearHubConnection } from '../../services/PearHubConnection';

const SESSION_ID = '000102030405060708090a0b0c0d0e0f';
const ME = 'p_101112131415161718191a1b1c1d1e1f';
const PEER = 'p_202122232425262728292a2b2c2d2e2f';

type Bridge = NonNullable<Window['__chiaPear']>;

function installBridge() {
  const sent: Record<string, unknown>[] = [];
  let listener: ((message: string) => void) | null = null;
  const bridge: Bridge = {
    send: async (message) => {
      sent.push(JSON.parse(message) as Record<string, unknown>);
      return true;
    },
    onMessage: (fn) => {
      listener = fn;
      return () => {
        listener = null;
      };
    },
  };
  (globalThis as { window?: unknown }).window = { __chiaPear: bridge };
  return {
    sent,
    fromWorker: (message: Record<string, unknown>) => listener?.(JSON.stringify(message)),
    subscribed: () => listener !== null,
  };
}

function callbacks(): jest.Mocked<HubConnectionCallbacks> {
  return {
    onAdvisoryStart: jest.fn(),
    onPeerMessage: jest.fn(),
    onDeliveryFailure: jest.fn(),
    onRegistered: jest.fn(),
    onAliasUpdated: jest.fn(),
    onPeerAvailable: jest.fn(),
    onPeerUnavailable: jest.fn(),
    onClosed: jest.fn(),
    onHubAttention: jest.fn(),
    onHubDisconnected: jest.fn(),
    onHubReconnected: jest.fn(),
    onHubActivity: jest.fn(),
    onHubKeepalive: jest.fn(),
    getPresence: jest.fn(() => ({ busy: true })),
  };
}

describe('PearHubConnection', () => {
  afterEach(() => {
    jest.useRealTimers();
    delete (globalThis as { window?: unknown }).window;
  });

  it('identifies with the session credential, topic, presence and alias', () => {
    const bridge = installBridge();
    new PearHubConnection(SESSION_ID, 'testnet', 'alice', callbacks());
    expect(bridge.sent).toEqual([
      { t: 'identify', session_id: SESSION_ID, network: 'testnet', busy: true, alias: 'alice' },
    ]);
  });

  it('maps worker messages onto the hub callbacks', () => {
    const bridge = installBridge();
    const cb = callbacks();
    new PearHubConnection(SESSION_ID, 'mainnet', undefined, cb);

    bridge.fromWorker({ t: 'registered', player_id: ME });
    bridge.fromWorker({
      t: 'advisory_start',
      peer_id: PEER,
      peer_alias: 'bob',
      my_amount: '200',
      their_amount: '100',
      channel_timeout: '15',
      unroll_timeout: '15',
    });
    bridge.fromWorker({ t: 'relay', from: PEER, alias: 'bob', payload: 'AQID' });
    bridge.fromWorker({ t: 'delivery_failure', to: PEER });
    bridge.fromWorker({ t: 'peer_available', player_id: PEER });
    bridge.fromWorker({ t: 'peer_unavailable', player_id: PEER });

    expect(cb.onRegistered).toHaveBeenCalledWith(ME);
    expect(cb.onHubReconnected).not.toHaveBeenCalled();
    expect(cb.onAdvisoryStart).toHaveBeenCalledWith({
      peer_id: PEER,
      peer_alias: 'bob',
      my_amount: '200',
      their_amount: '100',
      channel_timeout: '15',
      unroll_timeout: '15',
    });
    expect(cb.onPeerMessage).toHaveBeenCalledWith(PEER, 'bob', new Uint8Array([1, 2, 3]));
    expect(cb.onDeliveryFailure).toHaveBeenCalledWith(PEER);
    expect(cb.onPeerAvailable).toHaveBeenCalledWith(PEER);
    expect(cb.onPeerUnavailable).toHaveBeenCalledWith(PEER);
  });

  it('relays peer frames base64-encoded only once registered', () => {
    const bridge = installBridge();
    const conn = new PearHubConnection(SESSION_ID, 'mainnet', undefined, callbacks());

    expect(conn.sendToPeer(PEER, new Uint8Array([1, 2, 3]))).toBe(false);
    bridge.fromWorker({ t: 'registered', player_id: ME });
    expect(conn.sendToPeer(PEER, new Uint8Array([1, 2, 3]))).toBe(true);
    expect(bridge.sent.at(-1)).toEqual({ t: 'relay', to: PEER, payload: 'AQID' });
    expect(conn.getPlayerId()).toBe(ME);
  });

  it('re-identifies after the worker exits and reports the reconnect', () => {
    jest.useFakeTimers();
    const bridge = installBridge();
    const cb = callbacks();
    new PearHubConnection(SESSION_ID, 'mainnet', undefined, cb);
    bridge.fromWorker({ t: 'registered', player_id: ME });

    bridge.fromWorker({ t: 'worker_exit' });
    expect(cb.onHubDisconnected).toHaveBeenCalledTimes(1);
    jest.advanceTimersByTime(2_000);
    expect(bridge.sent.filter((m) => m.t === 'identify')).toHaveLength(2);

    bridge.fromWorker({ t: 'registered', player_id: ME });
    expect(cb.onHubReconnected).toHaveBeenCalledTimes(1);
    expect(cb.onRegistered).toHaveBeenCalledTimes(2);
  });

  it('drives the peer keepalive while registered', () => {
    jest.useFakeTimers();
    const bridge = installBridge();
    const cb = callbacks();
    new PearHubConnection(SESSION_ID, 'mainnet', undefined, cb);
    bridge.fromWorker({ t: 'registered', player_id: ME });
    jest.advanceTimersByTime(30_000);
    expect(cb.onHubKeepalive).toHaveBeenCalledTimes(2);
  });

  it('publishes lobby state and errors to subscribers', () => {
    const bridge = installBridge();
    const conn = new PearHubConnection(SESSION_ID, 'mainnet', undefined, callbacks());
    const seen = jest.fn();
    conn.subscribeLobby(seen);

    const players = [{ id: PEER, alias: 'bob', busy: false, stake: '100' }];
    bridge.fromWorker({
      t: 'lobby',
      me: { id: ME, alias: 'alice', busy: false, stake: null },
      online: 2,
      players,
      challenges: [],
    });
    bridge.fromWorker({ t: 'error', error: 'nope' });

    expect(conn.getLobby()).toEqual({
      me: { id: ME, alias: 'alice', busy: false, stake: null },
      online: 2,
      players,
      challenges: [],
      error: 'nope',
    });
    expect(seen).toHaveBeenCalledTimes(2);
    conn.clearLobbyError();
    expect(conn.getLobby().error).toBeNull();
  });

  it('leaves the lobby and stops listening on disconnect', () => {
    const bridge = installBridge();
    const cb = callbacks();
    const conn = new PearHubConnection(SESSION_ID, 'mainnet', undefined, cb);
    conn.disconnect();
    expect(bridge.sent.at(-1)).toEqual({ t: 'close' });
    expect(bridge.subscribed()).toBe(false);
  });
});
