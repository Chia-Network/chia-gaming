import 'fake-indexeddb/auto';

const mockSessionHandlers = new Map<string, (value: unknown) => void>();
const mockClient = {
  session: { keys: [] as string[], get: jest.fn(), length: 0 },
  on: jest.fn((event: string, listener: (value: unknown) => void) => {
    mockSessionHandlers.set(event, listener);
  }),
  connect: jest.fn(),
  request: jest.fn(),
  disconnect: jest.fn(async () => {}),
  core: {
    pairing: { disconnect: jest.fn(async () => {}) },
    relayer: {
      connected: true,
      transportClose: jest.fn(async () => {}),
      transportOpen: jest.fn(async () => {}),
    },
  },
};

const mockInit = jest.fn(async () => mockClient);

jest.mock('@walletconnect/sign-client', () => ({
  __esModule: true,
  default: { init: (...args: unknown[]) => mockInit(...args) },
}));

jest.mock('../../services/log', () => ({ log: jest.fn(), diagStack: jest.fn() }));

jest.mock('../../hooks/saveHardReset', () => ({
  startPendingWalletConnectWipe: jest.fn(async () => {}),
}));

jest.mock('../../constants/wallet-connect', () => ({
  ...jest.requireActual('../../constants/wallet-connect'),
  getChainId: () => 'chia:mainnet',
  getRequiredNamespaces: () => ({
    chia: { methods: [], chains: ['chia:mainnet'], events: [] },
  }),
  getOptionalNamespaces: () => ({
    chia: {
      methods: ['chia_getFullNodePeerCount'],
      chains: ['chia:mainnet'],
      events: [],
    },
  }),
}));

jest.mock('../../util/walletConnectMetadata', () => ({
  walletConnectDappMetadata: () => ({
    name: 'test',
    description: 'test',
    url: 'https://example.test',
    icons: [],
  }),
}));

import { expectConsoleError } from '../../../scripts/testSetup';
import { walletConnectState } from '../../hooks/useWalletConnect';
import type { SessionTypes } from '@walletconnect/types';
import { ChiaMethod } from '../../constants/wallet-connect';
import { BlockchainPoller } from '../../hooks/BlockchainPoller';
import { RealBlockchainInterface } from '../../hooks/RealBlockchainInterface';
import { encodePuzzleHashToBech32m } from '../../util/bech32m';
import { rpc } from '../../hooks/WalletConnectRpc';

const connectedSession = {
  topic: 'session-topic',
  pairingTopic: 'pairing-topic',
  namespaces: { chia: { accounts: ['chia:mainnet:123'], chains: ['chia:mainnet'], methods: [] } },
} as unknown as SessionTypes.Struct;

async function establishSession(session = connectedSession): Promise<void> {
  await walletConnectState.init();
  await walletConnectState.connect(async () => session);
}

async function expectRestorableSession(): Promise<void> {
  const oldHandlers = new Map(mockSessionHandlers);
  try {
    mockClient.session.keys = [connectedSession.topic];
    mockClient.session.length = 1;
    mockClient.session.get.mockReturnValue(connectedSession);
    let reloaded!: typeof walletConnectState;
    jest.isolateModules(() => {
      reloaded = jest.requireActual('../../hooks/useWalletConnect').walletConnectState;
    });
    await reloaded.init();
    expect(reloaded.getSession()?.topic).toBe(connectedSession.topic);
  } finally {
    mockClient.session.keys = [];
    mockClient.session.length = 0;
    mockSessionHandlers.clear();
    for (const [event, handler] of oldHandlers) mockSessionHandlers.set(event, handler);
  }
}

describe('WalletConnect pairing teardown', () => {
  beforeEach(async () => {
    mockClient.session.keys = [];
    mockClient.connect.mockReset();
    // The wallet state is a singleton; drop any pairing left pending by an
    // earlier test so each case starts with nothing outstanding.
    await walletConnectState.disconnect();
    await walletConnectState.selectProfile('chia-wallet');
    localStorage.clear();
    mockClient.on.mockClear();
    mockClient.disconnect.mockClear();
    mockClient.core.pairing.disconnect.mockClear();
    mockClient.request.mockReset();
    mockClient.core.relayer.transportClose.mockReset().mockResolvedValue();
    mockClient.core.relayer.transportOpen.mockReset().mockResolvedValue();
  });

  it('cancels a pending pairing on disconnect when no session exists', async () => {
    await walletConnectState.init();
    mockClient.connect.mockResolvedValue({
      uri: 'wc:abc123def@2?relay-protocol=irn&symKey=deadbeef',
      approval: async () => ({}),
    });

    const { uri } = await walletConnectState.startConnect();
    expect(uri).toContain('wc:abc123def@2');
    expect(mockClient.connect).toHaveBeenCalledWith({
      optionalNamespaces: {
        chia: {
          methods: ['chia_getFullNodePeerCount'],
          chains: ['chia:mainnet'],
          events: [],
        },
      },
    });

    await walletConnectState.disconnect();

    expect(mockClient.core.pairing.disconnect).toHaveBeenCalledWith({ topic: 'abc123def' });
    // No session was ever established, so the session-level disconnect is skipped.
    expect(mockClient.disconnect).not.toHaveBeenCalled();
  });

  it('cancels the pairing when the wallet rejects the approval', async () => {
    await walletConnectState.init();
    mockClient.connect.mockResolvedValue({
      uri: 'wc:abc123def@2?relay-protocol=irn&symKey=deadbeef',
      approval: async () => ({}),
    });

    await walletConnectState.startConnect();
    expectConsoleError('connect() approval FAILED or rejected');
    await expect(
      walletConnectState.connect(async () => {
        throw new Error('User rejected');
      }),
    ).rejects.toThrow('User rejected');

    expect(mockClient.core.pairing.disconnect).toHaveBeenCalledWith({ topic: 'abc123def' });
  });

  it('cancels the abandoned pairing when Link Wallet is retried after a rejection', async () => {
    await walletConnectState.init();
    mockClient.connect.mockResolvedValue({
      uri: 'wc:aaa111@2?relay-protocol=irn&symKey=deadbeef',
      approval: async () => ({}),
    });

    await walletConnectState.startConnect();
    expectConsoleError('connect() approval FAILED or rejected');
    await expect(
      walletConnectState.connect(async () => {
        throw new Error('User rejected');
      }),
    ).rejects.toThrow('User rejected');

    // Retrying Link Wallet goes through the fresh path: forget sessions, then
    // start a second pairing.
    mockClient.connect.mockResolvedValue({
      uri: 'wc:bbb222@2?relay-protocol=irn&symKey=deadbeef',
      approval: async () => ({}),
    });
    await walletConnectState.forgetSessions();
    await walletConnectState.startConnect();

    expect(mockClient.core.pairing.disconnect).toHaveBeenCalledTimes(1);
    expect(mockClient.core.pairing.disconnect).toHaveBeenCalledWith({ topic: 'aaa111' });

    // The retry's pairing is the one now tracked for teardown.
    await walletConnectState.disconnect();
    expect(mockClient.core.pairing.disconnect).toHaveBeenCalledWith({ topic: 'bbb222' });
  });

  it('cancels a pairing abandoned without any approval response before starting another', async () => {
    await walletConnectState.init();
    mockClient.connect.mockResolvedValue({
      uri: 'wc:ccc333@2?relay-protocol=irn&symKey=deadbeef',
      // The user never scans the QR, so this approval never settles.
      approval: () => new Promise<never>(() => {}),
    });

    await walletConnectState.startConnect();

    mockClient.connect.mockResolvedValue({
      uri: 'wc:ddd444@2?relay-protocol=irn&symKey=deadbeef',
      approval: async () => ({}),
    });
    await walletConnectState.startConnect();

    expect(mockClient.core.pairing.disconnect).toHaveBeenCalledWith({ topic: 'ccc333' });
  });

  it('leaves a retry alone when a superseded approval rejects late', async () => {
    await walletConnectState.init();
    mockClient.connect.mockResolvedValue({
      uri: 'wc:eee555@2?relay-protocol=irn&symKey=deadbeef',
      approval: async () => ({}),
    });
    await walletConnectState.startConnect();

    let rejectFirst: (err: Error) => void = () => {};
    expectConsoleError('connect() approval FAILED or rejected');
    const firstAttempt = walletConnectState.connect(
      () =>
        new Promise<never>((_resolve, reject) => {
          rejectFirst = reject;
        }),
    );

    // The user gives up on that QR and links again before the wallet answers.
    mockClient.connect.mockResolvedValue({
      uri: 'wc:fff666@2?relay-protocol=irn&symKey=deadbeef',
      approval: async () => ({}),
    });
    await walletConnectState.startConnect();
    mockClient.core.pairing.disconnect.mockClear();

    const states: string[] = [];
    const subscription = walletConnectState
      .getObservable()
      .subscribe((state) => states.push(state.stateName));

    // Only now does the abandoned proposal expire, with the retry waiting.
    rejectFirst(new Error('Proposal expired'));
    await expect(firstAttempt).rejects.toThrow('Proposal expired');
    subscription.unsubscribe();

    expect(mockClient.core.pairing.disconnect).toHaveBeenCalledWith({ topic: 'eee555' });
    expect(mockClient.core.pairing.disconnect).not.toHaveBeenCalledWith({ topic: 'fff666' });
    // The retry is still waiting for its wallet; the stale failure says nothing.
    expect(states).toEqual([]);

    // And the retry's pairing is still the one tracked for teardown.
    await walletConnectState.disconnect();
    expect(mockClient.core.pairing.disconnect).toHaveBeenCalledWith({ topic: 'fff666' });
  });

  it("disconnects the selected profile's stored sessions on forgetSessions", async () => {
    await walletConnectState.init();
    mockClient.session.keys = ['topic-1', 'topic-2', 'sage-topic'];
    const methods: Record<string, string[]> = {
      'topic-1': ['chia_createOfferForIds'],
      'topic-2': ['chia_createOfferForIds'],
      'sage-topic': ['chip0002_signCoinSpends'],
    };
    mockClient.session.get.mockImplementation((topic: string) => ({
      topic,
      namespaces: { chia: { methods: methods[topic], accounts: [], events: [] } },
    }));

    // A fresh Chia-wallet pairing must not drop the stored Sage session.
    await walletConnectState.forgetSessions();

    expect(mockClient.disconnect.mock.calls.map(([args]) => args.topic)).toEqual([
      'topic-1',
      'topic-2',
    ]);
  });

  it('switches profiles while approval is pending and discards a late approval', async () => {
    await walletConnectState.init();
    let approve!: (session: SessionTypes.Struct) => void;
    const approval = new Promise<SessionTypes.Struct>((resolve) => {
      approve = resolve;
    });
    mockClient.connect.mockResolvedValue({
      uri: 'wc:aaa111@2?relay-protocol=irn&symKey=deadbeef',
      approval: () => approval,
    });
    const setup = await walletConnectState.startConnect();
    expectConsoleError('connect() approval FAILED or rejected');
    const connecting = walletConnectState.connect(setup.approval);
    const rejected = expect(connecting).rejects.toThrow('connection attempt was cancelled');

    await walletConnectState.selectProfile('sage');
    expect(walletConnectState.getProfile()).toBe('sage');
    expect(walletConnectState.getSession()).toBeUndefined();
    expect(mockClient.core.pairing.disconnect).toHaveBeenCalledWith({ topic: 'aaa111' });

    approve(connectedSession);
    await rejected;
    expect(walletConnectState.getSession()).toBeUndefined();
    expect(mockClient.disconnect).toHaveBeenCalledWith(
      expect.objectContaining({ topic: connectedSession.topic }),
    );
  });

  it('restores each profile independently and forgets only the selected wallet', async () => {
    await establishSession();
    const sageSession = {
      ...connectedSession,
      topic: 'sage-topic',
      namespaces: {
        chia: {
          ...connectedSession.namespaces.chia,
          accounts: ['chia:mainnet:sage-address'],
          methods: ['chip0002_signCoinSpends'],
        },
      },
    } as SessionTypes.Struct;
    const sessions = new Map([
      [connectedSession.topic, connectedSession],
      [sageSession.topic, sageSession],
    ]);
    mockClient.session.keys = [...sessions.keys()];
    mockClient.session.get.mockImplementation((topic: string) => sessions.get(topic));

    await walletConnectState.selectProfile('sage');
    expect(walletConnectState.getSession()?.topic).toBe(sageSession.topic);
    await walletConnectState.selectProfile('chia-wallet');
    expect(walletConnectState.getSession()?.topic).toBe(connectedSession.topic);
    await walletConnectState.forgetSessions();
    expect(walletConnectState.getSession()).toBeUndefined();
    expect(mockClient.disconnect).toHaveBeenCalledWith(
      expect.objectContaining({ topic: connectedSession.topic }),
    );
    expect(mockClient.disconnect).not.toHaveBeenCalledWith(
      expect.objectContaining({ topic: sageSession.topic }),
    );
    await walletConnectState.selectProfile('sage');
    expect(walletConnectState.getSession()?.topic).toBe(sageSession.topic);
    await walletConnectState.selectProfile('chia-wallet');
    expect(walletConnectState.getSession()).toBeUndefined();
  });

  it('waits for relay replacement before restoring a different wallet profile', async () => {
    await establishSession();
    let finishClose!: () => void;
    mockClient.core.relayer.transportClose.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishClose = resolve;
        }),
    );
    const recovery = walletConnectState.recoverRelay(
      walletConnectState.getClient()!,
      connectedSession.topic,
    );
    const rejected = expect(recovery).rejects.toThrow('session changed during relay recovery');
    const sageSession = {
      ...connectedSession,
      topic: 'sage-topic',
      namespaces: {
        chia: { ...connectedSession.namespaces.chia, methods: ['chip0002_signCoinSpends'] },
      },
    } as SessionTypes.Struct;
    mockClient.session.keys = [sageSession.topic];
    mockClient.session.get.mockReturnValue(sageSession);
    const switched = walletConnectState.selectProfile('sage');
    expect(walletConnectState.getSession()).toBeUndefined();
    finishClose();
    await rejected;
    await switched;
    expect(mockClient.core.relayer.transportOpen).toHaveBeenCalledTimes(1);
    expect(walletConnectState.getSession()?.topic).toBe(sageSession.topic);
  });

  it('replaces the relay in order while preserving the approved session and pairing', async () => {
    await establishSession();
    let finishClose!: () => void;
    let finishOpen!: () => void;
    mockClient.core.relayer.transportClose.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishClose = resolve;
        }),
    );
    mockClient.core.relayer.transportOpen.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishOpen = resolve;
        }),
    );
    const states: boolean[] = [];
    const subscription = walletConnectState.getObservable().subscribe((state) => {
      if (state.connected !== undefined) states.push(state.connected);
    });
    try {
      const epoch = walletConnectState.getRequestEpoch();
      const recovery = walletConnectState.recoverRelay(
        walletConnectState.getClient()!,
        connectedSession.topic,
      );
      expect(walletConnectState.getSession()).toBeUndefined();
      expect(walletConnectState.getRequestEpoch()).toBe(epoch + 1);
      expect(mockClient.core.relayer.transportOpen).not.toHaveBeenCalled();
      finishClose();
      await Promise.resolve();
      expect(mockClient.core.relayer.transportOpen).toHaveBeenCalledTimes(1);
      expect(walletConnectState.getSession()).toBeUndefined();

      // An SDK session update during reconnect must not unmask the transport.
      mockClient.session.get.mockReturnValue(connectedSession);
      mockSessionHandlers.get('session_update')!({
        topic: connectedSession.topic,
        params: { namespaces: connectedSession.namespaces },
      });
      expect(walletConnectState.getSession()).toBeUndefined();
      finishOpen();
      await recovery;
      expect(walletConnectState.getSession()?.topic).toBe(connectedSession.topic);
      expect(walletConnectState.getSession()?.pairingTopic).toBe('pairing-topic');
      expect(walletConnectState.getAddress()).toBe('123');
      expect(states).toEqual([false, true]);
      expect(mockClient.disconnect).not.toHaveBeenCalled();
      expect(mockClient.core.pairing.disconnect).not.toHaveBeenCalled();
    } finally {
      subscription.unsubscribe();
    }
  });

  it('leaves the wallet unavailable when relay replacement fails', async () => {
    await establishSession();
    const states: string[] = [];
    const subscription = walletConnectState
      .getObservable()
      .subscribe((state) => states.push(state.stateName));
    mockClient.core.relayer.transportOpen.mockRejectedValueOnce(new Error('relay unavailable'));
    await expect(
      walletConnectState.recoverRelay(walletConnectState.getClient()!, connectedSession.topic),
    ).rejects.toThrow('relay unavailable');
    subscription.unsubscribe();
    expect(states).toEqual(['reconnecting', 'disconnected']);
    expect(walletConnectState.getSession()).toBeUndefined();
    expect(walletConnectState.isConnected).toBe(false);
    expect(mockClient.disconnect).not.toHaveBeenCalled();
    await expect(rpc.getHeightInfo({})).rejects.toThrow('Session is not connected');
    expect(mockClient.request).not.toHaveBeenCalled();
  });

  it('does not reconnect a session the user disconnects during relay replacement', async () => {
    await establishSession();
    let finishClose!: () => void;
    mockClient.core.relayer.transportClose.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishClose = resolve;
        }),
    );
    const recovery = walletConnectState.recoverRelay(
      walletConnectState.getClient()!,
      connectedSession.topic,
    );
    const rejected = expect(recovery).rejects.toThrow('session changed during relay recovery');
    const disconnect = walletConnectState.disconnect();
    finishClose();
    await rejected;
    await disconnect;
    expect(mockClient.core.relayer.transportOpen).toHaveBeenCalledTimes(1);
    expect(walletConnectState.getSession()).toBeUndefined();
  });

  it('finishes old relay replacement before publishing a replacement session', async () => {
    await establishSession();
    let finishClose!: () => void;
    mockClient.core.relayer.transportClose.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishClose = resolve;
        }),
    );
    const recovery = walletConnectState.recoverRelay(
      walletConnectState.getClient()!,
      connectedSession.topic,
    );
    const rejected = expect(recovery).rejects.toThrow('session changed during relay recovery');
    await Promise.resolve();
    const disconnect = walletConnectState.disconnect();
    const replacementSession = { ...connectedSession, topic: 'replacement-topic' };
    const replacement = walletConnectState.connect(async () => replacementSession);
    try {
      for (let i = 0; i < 10; i++) await Promise.resolve();
      expect(walletConnectState.getSession()).toBeUndefined();
      expect(mockClient.disconnect).not.toHaveBeenCalled();
      finishClose();
      await rejected;
      await disconnect;
      await replacement;
      expect(mockClient.core.relayer.transportOpen).toHaveBeenCalledTimes(1);
      expect(walletConnectState.getSession()?.topic).toBe('replacement-topic');
      for (const event of ['session_delete', 'session_expire']) {
        mockSessionHandlers.get(event)!({ topic: connectedSession.topic });
        expect(walletConnectState.getSession()?.topic).toBe('replacement-topic');
      }
    } finally {
      finishClose();
      await Promise.allSettled([recovery, disconnect, replacement]);
    }
  });

  it.each(['transportClose', 'transportOpen'] as const)(
    'bounds a hung %s without allowing later work to race its eventual completion',
    async (phase) => {
      jest.useFakeTimers();
      let finish!: () => void;
      let recovery: Promise<void> | undefined;
      try {
        await establishSession();
        mockClient.core.relayer[phase].mockImplementationOnce(
          () =>
            new Promise<void>((resolve) => {
              finish = resolve;
            }),
        );
        recovery = walletConnectState.recoverRelay(
          walletConnectState.getClient()!,
          connectedSession.topic,
        );
        let failed = false;
        const outcome = recovery.catch((error) => {
          failed = true;
          return error;
        });
        await jest.advanceTimersByTimeAsync(30000);
        expect(failed).toBe(true);
        expect((await outcome).message).toContain('timed out');
        expect(walletConnectState.getSession()).toBeUndefined();

        mockClient.connect.mockResolvedValue({
          uri: 'wc:abc123@2?relay-protocol=irn&symKey=deadbeef',
          approval: async () => connectedSession,
        });
        expectConsoleError('startConnect() FAILED');
        const attempt = walletConnectState.startConnect();
        const attemptRejected = expect(attempt).rejects.toThrow('timed out');
        await jest.advanceTimersByTimeAsync(30000);
        await attemptRejected;
        expect(mockClient.connect).not.toHaveBeenCalled();
        finish();
        await jest.advanceTimersByTimeAsync(0);
        expect(mockClient.connect).not.toHaveBeenCalled();
        expect(walletConnectState.getSession()).toBeUndefined();
        expectConsoleError('startConnect() FAILED');
        await expect(walletConnectState.startConnect()).rejects.toThrow('reload');
        expect(mockClient.connect).not.toHaveBeenCalled();
        await expectRestorableSession();
        await walletConnectState.disconnect();
        await walletConnectState.startConnect();
        expect(mockClient.connect).toHaveBeenCalledTimes(1);
      } finally {
        finish?.();
        await recovery?.catch(() => {});
        await jest.advanceTimersByTimeAsync(0);
        jest.useRealTimers();
      }
    },
  );

  it.each(['transportClose', 'transportOpen'] as const)(
    'preserves the approved session across reconnect and reload after %s rejects',
    async (phase) => {
      await establishSession();
      mockClient.core.relayer[phase].mockRejectedValueOnce(new Error('relay failed'));
      await expect(
        walletConnectState.recoverRelay(walletConnectState.getClient()!, connectedSession.topic),
      ).rejects.toThrow('relay failed');
      mockClient.connect.mockResolvedValue({
        uri: 'wc:abc123@2?relay-protocol=irn&symKey=deadbeef',
        approval: async () => connectedSession,
      });
      expectConsoleError('startConnect() FAILED');
      await expect(walletConnectState.startConnect()).rejects.toThrow('reload');
      expect(mockClient.connect).not.toHaveBeenCalled();
      expect(walletConnectState.getSession()).toBeUndefined();
      await expectRestorableSession();
    },
  );

  it('retains ownership of an active pairing creation beyond the lifecycle wait deadline', async () => {
    jest.useFakeTimers();
    let finish!: (value: unknown) => void;
    try {
      await walletConnectState.init();
      mockClient.connect.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      );
      let completed = false;
      const pairing = walletConnectState.startConnect().then((result) => {
        completed = true;
        return result;
      });
      await jest.advanceTimersByTimeAsync(60000);
      expect(completed).toBe(false);
      finish({
        uri: 'wc:abc123@2?relay-protocol=irn&symKey=deadbeef',
        approval: async () => connectedSession,
      });
      await pairing;
      await walletConnectState.disconnect();
      expect(mockClient.core.pairing.disconnect).toHaveBeenCalledWith({ topic: 'abc123' });
    } finally {
      jest.useRealTimers();
    }
  });

  it('cancels a pairing whose creation completes after disconnect', async () => {
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});
    let finish!: (value: unknown) => void;
    try {
      await walletConnectState.init();
      mockClient.connect.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      );
      const creation = walletConnectState.startConnect().then(
        (value) => ({ value }),
        (error) => ({ error }),
      );
      for (let i = 0; i < 10; i++) await Promise.resolve();
      const disconnect = walletConnectState.disconnect();
      finish({
        uri: 'wc:abc123@2?relay-protocol=irn&symKey=deadbeef',
        approval: async () => connectedSession,
      });
      const outcome = await creation;
      await disconnect;
      expect(outcome).toHaveProperty('error');
      expect(mockClient.core.pairing.disconnect).toHaveBeenCalledWith({ topic: 'abc123' });
      expect(walletConnectState.getSession()).toBeUndefined();
      for (let i = 0; i < 20; i++) await Promise.resolve();
      expect(mockClient.disconnect).toHaveBeenCalledWith(
        expect.objectContaining({ topic: connectedSession.topic }),
      );
    } finally {
      await walletConnectState.disconnect();
      consoleError.mockRestore();
    }
  });

  it('rejects and removes an old approval delivered after disconnect', async () => {
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});
    let finishApproval!: (session: SessionTypes.Struct) => void;
    try {
      await walletConnectState.init();
      mockClient.connect.mockResolvedValue({
        uri: 'wc:abc123@2?relay-protocol=irn&symKey=deadbeef',
        approval: () =>
          new Promise<SessionTypes.Struct>((resolve) => {
            finishApproval = resolve;
          }),
      });
      const setup = await walletConnectState.startConnect();
      const connecting = walletConnectState.connect(setup.approval);
      const rejected = expect(connecting).rejects.toThrow('connection attempt was cancelled');
      await walletConnectState.disconnect();
      finishApproval({ ...connectedSession, topic: 'late-approved-topic' });
      await rejected;
      expect(walletConnectState.getSession()).toBeUndefined();
      expect(mockClient.disconnect).toHaveBeenCalledWith(
        expect.objectContaining({ topic: 'late-approved-topic' }),
      );
    } finally {
      consoleError.mockRestore();
    }
  });

  it('reports a disconnect authority persistence failure before changing the live connection', async () => {
    await establishSession();
    const write = jest.spyOn(localStorage, 'setItem').mockImplementationOnce(() => {
      throw new Error('storage unavailable');
    });
    try {
      await expect(walletConnectState.disconnect()).rejects.toThrow('storage unavailable');
      expect(walletConnectState.getSession()?.topic).toBe(connectedSession.topic);
      expect(mockClient.disconnect).not.toHaveBeenCalled();
    } finally {
      write.mockRestore();
    }
  });

  it('restores only the explicitly accepted session when an abandoned session remains in SDK storage', async () => {
    await establishSession();
    const oldHandlers = new Map(mockSessionHandlers);
    try {
      mockClient.session.keys = [connectedSession.topic, 'abandoned-topic'];
      mockClient.session.length = 2;
      mockClient.session.get.mockImplementation((topic: string) => ({
        ...connectedSession,
        topic,
      }));
      let reloaded!: typeof walletConnectState;
      jest.isolateModules(() => {
        reloaded = jest.requireActual('../../hooks/useWalletConnect').walletConnectState;
      });
      await reloaded.init();
      expect(reloaded.getSession()?.topic).toBe(connectedSession.topic);
    } finally {
      mockClient.session.length = 0;
      mockSessionHandlers.clear();
      for (const [event, handler] of oldHandlers) mockSessionHandlers.set(event, handler);
    }
  });

  it('reuses the restored session when connection setup waits for recovery', async () => {
    jest.useFakeTimers();
    mockClient.request.mockImplementation(({ request }) =>
      Promise.resolve(
        request.method === ChiaMethod.GetNextAddress
          ? encodePuzzleHashToBech32m('11'.repeat(32))
          : [{ id: 2, type: 205 }],
      ),
    );
    await establishSession();
    let finishClose!: () => void;
    mockClient.core.relayer.transportClose.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishClose = resolve;
        }),
    );
    mockClient.connect.mockResolvedValue({
      uri: 'wc:abc123@2?relay-protocol=irn&symKey=deadbeef',
      approval: async () => connectedSession,
    });
    const recovery = walletConnectState.recoverRelay(
      walletConnectState.getClient()!,
      connectedSession.topic,
    );
    const blockchain = new RealBlockchainInterface();
    const setup = blockchain.beginConnect('wallet');
    for (let i = 0; i < 10; i++) await Promise.resolve();
    finishClose();
    await recovery;
    try {
      await jest.advanceTimersByTimeAsync(1000);
      expect((await setup).skipQr).toBe(true);
      expect(mockClient.connect).not.toHaveBeenCalled();
      await blockchain.startMonitoring();
    } finally {
      await blockchain.disconnect();
      await jest.advanceTimersByTimeAsync(1000);
      jest.useRealTimers();
    }
  });

  it('retains expired disconnect teardown and prevents restoration after reload', async () => {
    jest.useFakeTimers();
    const oldHandlers = new Map(mockSessionHandlers);
    let finishClose!: () => void;
    try {
      await establishSession();
      mockClient.core.relayer.transportClose.mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            finishClose = resolve;
          }),
      );
      const recovery = walletConnectState
        .recoverRelay(walletConnectState.getClient()!, connectedSession.topic)
        .catch(() => {});
      const disconnect = walletConnectState.disconnect();
      const rejected = expect(disconnect).rejects.toThrow('timed out');
      await jest.advanceTimersByTimeAsync(30000);
      await rejected;
      mockClient.session.keys = [connectedSession.topic];
      mockClient.session.length = 1;
      mockClient.session.get.mockReturnValue(connectedSession);
      let reloaded!: typeof walletConnectState;
      jest.isolateModules(() => {
        reloaded = jest.requireActual('../../hooks/useWalletConnect').walletConnectState;
      });
      await reloaded.init();
      expect(reloaded.getSession()).toBeUndefined();
      finishClose();
      await recovery;
      await jest.advanceTimersByTimeAsync(0);
      expect(mockClient.disconnect).toHaveBeenCalledWith(
        expect.objectContaining({ topic: connectedSession.topic }),
      );
    } finally {
      finishClose?.();
      await jest.advanceTimersByTimeAsync(0);
      mockClient.session.length = 0;
      mockSessionHandlers.clear();
      for (const [event, handler] of oldHandlers) mockSessionHandlers.set(event, handler);
      jest.useRealTimers();
    }
  });

  it('releases the RPC consumer after a hung relay lifecycle deadline while keeping the wallet unavailable', async () => {
    jest.useFakeTimers();
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});
    let finishClose!: () => void;
    try {
      await establishSession();
      mockClient.request.mockImplementationOnce(() => new Promise(() => {}));
      mockClient.core.relayer.transportClose.mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            finishClose = resolve;
          }),
      );
      const request = rpc.getHeightInfo({});
      const requestRejected = expect(request).rejects.toThrow('relay recovery failed');
      const queued = rpc.getHeightInfo({});
      const queuedRejected = expect(queued).rejects.toThrow('Wallet context changed');
      await jest.advanceTimersByTimeAsync(60200);
      await requestRejected;
      await queuedRejected;
      expect(mockClient.request).toHaveBeenCalledTimes(1);
      await expect(rpc.getHeightInfo({})).rejects.toThrow('Session is not connected');
      finishClose();
      await jest.advanceTimersByTimeAsync(0);
      expect(walletConnectState.getSession()).toBeUndefined();
    } finally {
      finishClose?.();
      await jest.advanceTimersByTimeAsync(0);
      consoleError.mockRestore();
      jest.useRealTimers();
    }
  });

  it.each([
    ChiaMethod.GetHeightInfo,
    ChiaMethod.GetCoinRecordsByNames,
    ChiaMethod.GetFullNodePeerCount,
  ])(
    'resumes actual chain polling after replacing a relay with a stalled %s',
    async (stalledMethod) => {
      jest.useFakeTimers();
      const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});
      let finishOld!: (value: unknown) => void;
      let stalled = false;
      mockClient.request.mockImplementation(({ request }) => {
        if (request.method === stalledMethod && !stalled) {
          stalled = true;
          return new Promise((resolve) => {
            finishOld = resolve;
          });
        }
        switch (request.method) {
          case ChiaMethod.GetNextAddress:
            return Promise.resolve(encodePuzzleHashToBech32m('11'.repeat(32)));
          case ChiaMethod.GetWallets:
            return Promise.resolve([{ id: 2, type: 205 }]);
          case ChiaMethod.GetHeightInfo:
            return Promise.resolve({ height: 100 });
          case ChiaMethod.GetCoinRecordsByNames:
            return Promise.resolve({ coinRecords: [] });
          default:
            return Promise.resolve({ success: true });
        }
      });
      await establishSession(
        stalledMethod === ChiaMethod.GetFullNodePeerCount
          ? {
              ...connectedSession,
              namespaces: {
                chia: {
                  ...connectedSession.namespaces.chia,
                  methods: [ChiaMethod.GetFullNodePeerCount],
                },
              },
            }
          : connectedSession,
      );
      const blockchain = new RealBlockchainInterface();
      const poller = new BlockchainPoller(blockchain, 1000);
      const heights: bigint[] = [];
      const snapshots: bigint[] = [];
      poller.attachGameSession({
        snapshotWatchedCoins: () => [{ coin_name: 'aa', coin_string: 'coin-a' }],
        reportNewBlock: (height) => {
          heights.push(height);
        },
        reportCoinStates: (height) => {
          snapshots.push(height);
        },
      });
      try {
        const monitoring = blockchain.startMonitoring();
        await jest.advanceTimersByTimeAsync(1000);
        await monitoring;
        poller.start();
        await jest.advanceTimersByTimeAsync(10000);
        expect(stalled).toBe(true);
        expect(snapshots).toEqual([]);
        await jest.advanceTimersByTimeAsync(30000);
        expect(mockClient.core.relayer.transportClose).toHaveBeenCalledTimes(1);
        expect(mockClient.core.relayer.transportOpen).toHaveBeenCalledTimes(1);
        expect(heights.length).toBeGreaterThan(0);
        expect(snapshots.length).toBeGreaterThan(0);
        expect(walletConnectState.getSession()?.topic).toBe(connectedSession.topic);
        if (stalledMethod === ChiaMethod.GetFullNodePeerCount) {
          expect(
            mockClient.request.mock.calls.filter(
              ([call]) => call.request.method === ChiaMethod.GetFullNodePeerCount,
            ),
          ).toHaveLength(1);
          expect(blockchain.isReadyForPlay()).toBe(true);
        }
        finishOld({ height: 999, coinRecords: [] });
        await jest.advanceTimersByTimeAsync(0);
        expect(poller.getPeak()).toBe(100n);
      } finally {
        poller.stop();
        await blockchain.disconnect();
        await jest.advanceTimersByTimeAsync(1000);
        consoleError.mockRestore();
        jest.useRealTimers();
      }
    },
  );
});
