import 'fake-indexeddb/auto';

const requestMock = jest.fn();

const relayerMock = {
  connected: true,
  on: jest.fn(),
  off: jest.fn(),
};
let mockClientAvailable = true;
let mockSessionAvailable = true;
let mockTopic = 'topic-1';
let mockFingerprint = '123';
let mockChainId = 'chia:mainnet';
let mockUseReplacementClient = false;
let mockEpoch = 0;
const mockRecoverRelay = jest.fn(async (..._args: unknown[]) => {
  mockEpoch++;
});
const mockClient = {
  core: { relayer: relayerMock },
  request: requestMock,
  session: { keys: ['topic-1'] },
};
const mockReplacementClient = { ...mockClient };

jest.mock('../wallet/WalletConnectClient', () => ({
  walletConnectState: {
    getClient: () =>
      mockClientAvailable
        ? mockUseReplacementClient
          ? mockReplacementClient
          : mockClient
        : undefined,
    getSession: () => (mockSessionAvailable ? { topic: mockTopic } : undefined),
    getAddress: () => mockFingerprint,
    getChainId: () => mockChainId,
    getRequestEpoch: () => mockEpoch,
    recoverRelay: (...args: unknown[]) => mockRecoverRelay(...args),
  },
}));

jest.mock('../../services/log', () => ({
  log: jest.fn(),
}));

import { ChiaMethod } from '../../constants/wallet-connect';
import { BlockchainPoller } from '../wallet/BlockchainPoller';
import { RealBlockchainInterface } from '../wallet/RealBlockchainInterface';
import type { PushTransactionsRequest } from '../../types/rpc/PushTransactions';
import {
  rpc,
  WalletConnectResponseError,
  WalletConnectTransportError,
} from '../wallet/WalletConnectRpc';

async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 12; i++) await Promise.resolve();
}

describe('WalletConnect RPC adapter', () => {
  beforeEach(() => {
    requestMock.mockReset();
    mockClientAvailable = true;
    mockSessionAvailable = true;
    relayerMock.connected = true;
    mockTopic = 'topic-1';
    mockFingerprint = '123';
    mockChainId = 'chia:mainnet';
    mockUseReplacementClient = false;
    mockEpoch = 0;
    mockRecoverRelay.mockReset().mockImplementation(async () => {
      mockEpoch++;
    });
  });

  it('formats WalletConnect requests with fingerprint and chain context', async () => {
    requestMock.mockResolvedValueOnce({ height: 7n, success: true });

    await expect(rpc.getHeightInfo({ usePeakHeight: true })).resolves.toMatchObject({ height: 7n });

    expect(requestMock).toHaveBeenCalledTimes(1);
    expect(requestMock.mock.calls[0][0]).toMatchObject({
      topic: 'topic-1',
      chainId: 'chia:mainnet',
      request: {
        method: ChiaMethod.GetHeightInfo,
        params: {
          usePeakHeight: true,
          fingerprint: 123,
        },
      },
    });
  });

  it('unwraps WalletConnect data payloads', async () => {
    requestMock.mockResolvedValueOnce({
      data: { confirmedWalletBalance: 11n },
      success: true,
    });

    await expect(rpc.getWalletBalance({ walletId: 1n })).resolves.toMatchObject({
      confirmedWalletBalance: 11n,
    });

    expect(requestMock.mock.calls[0][0].request.params).toMatchObject({
      walletId: 1n,
      fingerprint: 123,
    });
  });

  it('rewrites only negative request bigints to decimal strings for the WC wire', async () => {
    requestMock.mockResolvedValueOnce({ success: true });

    await rpc.createOfferForIds({
      offer: { '1': 100n, '2': -50n },
      fee: 1n,
      driverDict: {},
    });

    expect(requestMock.mock.calls[0][0].request.params).toEqual({
      offer: { '1': 100n, '2': '-50' },
      fee: 1n,
      driverDict: {},
      fingerprint: 123,
    });
  });

  it('requests off-chain offer cancellation with wallet context', async () => {
    requestMock.mockResolvedValueOnce({ success: true });

    await rpc.cancelOffer({ tradeId: 'trade-id', secure: false, fee: 0n });

    expect(requestMock.mock.calls[0][0].request).toEqual({
      method: ChiaMethod.CancelOffer,
      params: {
        tradeId: 'trade-id',
        secure: false,
        fee: 0n,
        fingerprint: 123,
      },
    });
  });

  it('rejects WalletConnect error payloads with method context', async () => {
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});
    requestMock.mockResolvedValueOnce({
      error: { message: 'boom', code: 123 },
    });

    await expect(rpc.getHeightInfo({})).rejects.toBeInstanceOf(WalletConnectResponseError);
    consoleError.mockRestore();
  });

  it('treats a rejected request while connected as a wallet response', async () => {
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});
    requestMock.mockRejectedValueOnce(new Error('arbitrary wallet refusal'));

    await expect(rpc.pushTransactions({ transactions: [] })).rejects.toBeInstanceOf(
      WalletConnectResponseError,
    );
    consoleError.mockRestore();
  });

  it('tags missing session and disconnected relayer failures as transport', async () => {
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});
    mockSessionAvailable = false;
    await expect(rpc.getHeightInfo({})).rejects.toBeInstanceOf(WalletConnectTransportError);

    mockSessionAvailable = true;
    requestMock.mockImplementationOnce(async () => {
      relayerMock.connected = false;
      throw new Error('request failed');
    });
    await expect(rpc.getHeightInfo({})).rejects.toBeInstanceOf(WalletConnectTransportError);
    consoleError.mockRestore();
  });

  it('serializes poller reads, wallet mutations, and direct readiness queries at the transport', async () => {
    jest.useFakeTimers();
    try {
      let finishHeight!: (value: unknown) => void;
      const heightResponse = new Promise((resolve) => {
        finishHeight = resolve;
      });
      let active = 0;
      let maximumActive = 0;
      const methods: ChiaMethod[] = [];
      requestMock.mockImplementation(({ request }) => {
        methods.push(request.method);
        active++;
        maximumActive = Math.max(maximumActive, active);
        const response =
          request.method === ChiaMethod.GetHeightInfo
            ? heightResponse
            : Promise.resolve(request.method === ChiaMethod.SelectCoins ? { coins: [] } : 2);
        return response.finally(() => {
          active--;
        });
      });
      const poller = new BlockchainPoller(new RealBlockchainInterface(), 1000);
      const height = poller.rpc.getHeightInfo();
      await jest.advanceTimersByTimeAsync(100);
      const readiness = rpc.getFullNodePeerCount({});
      const mutation = poller.rpc.selectCoins('wallet', 1n);
      await jest.advanceTimersByTimeAsync(100);
      expect(methods).toEqual([ChiaMethod.GetHeightInfo]);

      finishHeight({ height: 100 });
      await jest.advanceTimersByTimeAsync(200);
      await expect(height).resolves.toBe(100n);
      await expect(mutation).resolves.toBeNull();
      await expect(readiness).resolves.toBe(2n);
      expect(methods).toEqual([
        ChiaMethod.GetHeightInfo,
        ChiaMethod.SelectCoins,
        ChiaMethod.GetFullNodePeerCount,
      ]);
      expect(maximumActive).toBe(1);
    } finally {
      jest.useRealTimers();
    }
  });

  it.each(['read', 'mutation'])(
    'releases the transport queue after a rejected %s',
    async (kind) => {
      const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});
      try {
        requestMock
          .mockRejectedValueOnce(new Error('wallet refused'))
          .mockResolvedValueOnce({ height: 8 });
        const first =
          kind === 'read' ? rpc.getHeightInfo({}) : rpc.pushTransactions({ transactions: [] });
        const second = rpc.getHeightInfo({});
        await expect(first).rejects.toBeInstanceOf(WalletConnectResponseError);
        await expect(second).resolves.toEqual({ height: 8n });
        expect(requestMock).toHaveBeenCalledTimes(2);
      } finally {
        consoleError.mockRestore();
      }
    },
  );

  it.each(['client', 'topic', 'fingerprint', 'chain'] as const)(
    'rejects queued work when its %s context changes',
    async (context) => {
      jest.useFakeTimers();
      const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});
      let finish!: (value: unknown) => void;
      requestMock.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      );
      try {
        const first = rpc.getHeightInfo({});
        await jest.advanceTimersByTimeAsync(100);
        const queued = rpc.getHeightInfo({});
        const rejected = expect(queued).rejects.toThrow(
          'Wallet context changed before request could start',
        );
        if (context === 'client') mockUseReplacementClient = true;
        if (context === 'topic') mockTopic = 'topic-2';
        if (context === 'fingerprint') mockFingerprint = '456';
        if (context === 'chain') mockChainId = 'chia:testnet11';
        finish({ height: 7 });
        await jest.advanceTimersByTimeAsync(100);
        await first;
        await rejected;
        expect(requestMock).toHaveBeenCalledTimes(1);
      } finally {
        consoleError.mockRestore();
        jest.useRealTimers();
      }
    },
  );

  it.each(['resolve', 'reject'] as const)(
    'holds the request slot through relay replacement after a late read %s',
    async (completion) => {
      jest.useFakeTimers();
      const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});
      let finishOld!: (value: unknown) => void;
      let rejectOld!: (error: Error) => void;
      let finishRecovery!: () => void;
      const recovery = new Promise<void>((resolve) => {
        finishRecovery = resolve;
      });
      const events: string[] = [];
      mockRecoverRelay.mockImplementation(async () => {
        mockEpoch++;
        events.push('close');
        await recovery;
        events.push('open');
      });
      requestMock
        .mockImplementationOnce(
          () =>
            new Promise((resolve, reject) => {
              finishOld = resolve;
              rejectOld = reject;
            }),
        )
        .mockImplementation(() => {
          events.push('send');
          return Promise.resolve({ height: 8 });
        });
      try {
        const first = rpc.getHeightInfo({});
        const firstRejected = expect(first).rejects.toThrow('Request timed out; relay restarted');
        await jest.advanceTimersByTimeAsync(100);
        const queued = rpc.getHeightInfo({});
        const queuedRejected = expect(queued).rejects.toThrow('Wallet context changed');
        await jest.advanceTimersByTimeAsync(30000);
        expect(events).toEqual(['close']);
        if (completion === 'resolve') finishOld({ height: 999 });
        else rejectOld(new Error('late SDK rejection'));
        await flushMicrotasks();
        expect(requestMock).toHaveBeenCalledTimes(1);
        finishRecovery();
        await jest.advanceTimersByTimeAsync(100);
        await firstRejected;
        await queuedRejected;
        const nextRead = rpc.getHeightInfo({});
        await jest.advanceTimersByTimeAsync(100);
        await expect(nextRead).resolves.toEqual({ height: 8n });
        expect(events).toEqual(['close', 'open', 'send']);
        expect(jest.getTimerCount()).toBe(0);
      } finally {
        consoleError.mockRestore();
        jest.useRealTimers();
      }
    },
  );

  it('recovers a stalled coin registration and permits registration retry and chain reads', async () => {
    jest.useFakeTimers();
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});
    let finishRegistration!: (value: unknown) => void;
    requestMock
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishRegistration = resolve;
          }),
      )
      .mockResolvedValueOnce({ success: true })
      .mockResolvedValueOnce({ height: 4878844 });
    const registration = { walletId: 2n, coinIds: ['50'.repeat(32)] };
    try {
      const first = rpc.registerRemoteCoins(registration);
      // Attach the handler immediately so timeout rejection is observed.
      const failed = first.catch((error: unknown) => error);
      await jest.advanceTimersByTimeAsync(30100);
      expect(mockRecoverRelay).toHaveBeenCalledWith(
        mockClient,
        'topic-1',
        ChiaMethod.RegisterRemoteCoins,
      );
      expect(await failed).toBeInstanceOf(WalletConnectTransportError);
      const retry = rpc.registerRemoteCoins(registration);
      const height = rpc.getHeightInfo({});
      await jest.advanceTimersByTimeAsync(200);
      await expect(retry).resolves.toEqual({ success: true });
      await expect(height).resolves.toEqual({ height: 4878844n });
      expect(requestMock.mock.calls[1][0].request).toEqual(requestMock.mock.calls[0][0].request);
      finishRegistration({ success: true });
      await flushMicrotasks();
      expect(mockRecoverRelay).toHaveBeenCalledTimes(1);
    } finally {
      // Let the old SDK operation settle even when the regression assertion fails.
      finishRegistration?.({ success: true });
      await jest.advanceTimersByTimeAsync(100);
      consoleError.mockRestore();
      jest.useRealTimers();
    }
  });

  it('keeps waiting for reserved offer creation beyond the retryable request deadline', async () => {
    jest.useFakeTimers();
    let finish!: (value: unknown) => void;
    requestMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    try {
      const mutation = rpc.createOfferForIds({ offer: { '1': -1n } });
      await jest.advanceTimersByTimeAsync(60000);
      expect(mockRecoverRelay).not.toHaveBeenCalled();
      finish({ success: true });
      await expect(mutation).resolves.toEqual({ success: true });
    } finally {
      jest.useRealTimers();
    }
  });

  it('replaces the relay after a stalled transaction post and permits replay of the exact transaction', async () => {
    jest.useFakeTimers();
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});
    const request: PushTransactionsRequest = {
      transactions: [
        {
          confirmed_at_height: 0n,
          created_at_time: 1n,
          to_puzzle_hash: '11'.repeat(32),
          amount: 0n,
          fee_amount: 0n,
          confirmed: false,
          sent: 0n,
          spend_bundle: { aggregated_signature: '22'.repeat(96), coin_spends: [] },
          additions: [],
          removals: [],
          wallet_id: 0n,
          sent_to: [],
          trade_id: null,
          type: 1n,
          name: '33'.repeat(32),
          memos: {},
          valid_times: {},
          to_address: 'address',
        },
      ],
      push: true,
      sign: false,
      allowUnsynced: true,
    };
    requestMock
      .mockImplementationOnce(() => new Promise(() => {}))
      .mockResolvedValue({ success: true });
    try {
      const first = rpc.pushTransactions(request);
      const rejected = expect(first).rejects.toBeInstanceOf(WalletConnectTransportError);
      await jest.advanceTimersByTimeAsync(30100);
      await rejected;
      expect(mockRecoverRelay).toHaveBeenCalledWith(
        mockClient,
        'topic-1',
        ChiaMethod.PushTransactions,
      );
      const replay = rpc.pushTransactions(request);
      await jest.advanceTimersByTimeAsync(100);
      await expect(replay).resolves.toEqual({ success: true });
      expect(requestMock).toHaveBeenCalledTimes(2);
      expect(requestMock.mock.calls[1][0].request).toEqual(requestMock.mock.calls[0][0].request);
    } finally {
      consoleError.mockRestore();
      jest.useRealTimers();
    }
  });
});
