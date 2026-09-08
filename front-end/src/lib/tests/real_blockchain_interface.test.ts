jest.mock('../../hooks/WalletConnectRpc', () => ({
  rpc: {
    createOfferForIds: jest.fn(),
    createNewRemoteWallet: jest.fn(),
    getNextAddress: jest.fn(),
    getCoinRecordsByNames: jest.fn(),
    getWallets: jest.fn(),
    pushTransactions: jest.fn(),
    sendTransaction: jest.fn(),
    registerRemoteCoins: jest.fn(),
    selectCoins: jest.fn(),
    getFullNodePeerCount: jest.fn(async () => 1n),
  },
}));

const mockWalletListeners = new Set<(evt: any) => void>();
let mockWalletSession: unknown;
let mockWalletFingerprint = '123456';
const mockWalletConnectState = {
  getObservable: () => ({
    subscribe: ({ next }: { next: (evt: any) => void }) => {
      mockWalletListeners.add(next);
      return {
        unsubscribe: () => {
          mockWalletListeners.delete(next);
        },
      };
    },
  }),
  init: jest.fn(async () => {}),
  getSession: jest.fn(() => mockWalletSession),
  getAddress: jest.fn(() => mockWalletFingerprint),
  disconnect: jest.fn(async () => {
    mockWalletSession = undefined;
    for (const next of mockWalletListeners) {
      next({ stateName: 'initialized', connected: false, sessions: 0 });
    }
  }),
};

jest.mock('../../hooks/useWalletConnect', () => ({
  walletConnectState: mockWalletConnectState,
}));

import { rpc } from '../../hooks/WalletConnectRpc';
import { RealBlockchainInterface } from '../../hooks/RealBlockchainInterface';
import { CoinRecord } from '../../types/rpc/CoinRecord';
import { coinIdFromBytes, toUint8 } from '../../util';
import { encodePuzzleHashToBech32m } from '../../util/bech32m';

const mockCreateOfferForIds = rpc.createOfferForIds as jest.Mock;
const mockCreateNewRemoteWallet = rpc.createNewRemoteWallet as jest.Mock;
const mockGetNextAddress = rpc.getNextAddress as jest.Mock;
const mockGetCoinRecordsByNames = rpc.getCoinRecordsByNames as jest.Mock;
const mockGetWallets = rpc.getWallets as jest.Mock;
const mockPushTransactions = rpc.pushTransactions as jest.Mock;
const mockSendTransaction = rpc.sendTransaction as jest.Mock;
const mockRegisterRemoteCoins = rpc.registerRemoteCoins as jest.Mock;
const mockSelectCoins = rpc.selectCoins as jest.Mock;
const mockGetFullNodePeerCount = rpc.getFullNodePeerCount as jest.Mock;

function encodedWalletConnectError(payload: unknown): string {
  const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64');
  return `[wc:-32603|${encoded}]`;
}

function makeStorage(): Storage {
  const store = new Map<string, string>();
  return {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => {
      store.set(key, value);
    },
    removeItem: (key: string) => {
      store.delete(key);
    },
    clear: () => {
      store.clear();
    },
    get length() {
      return store.size;
    },
    key: (i: number) => [...store.keys()][i] ?? null,
  };
}

function setTestGlobal(key: string, value: unknown) {
  Object.defineProperty(globalThis, key, {
    configurable: true,
    writable: true,
    value,
  });
}

describe('RealBlockchainInterface', () => {
  beforeEach(() => {
    setTestGlobal('localStorage', makeStorage());
    mockCreateOfferForIds.mockReset();
    mockCreateNewRemoteWallet.mockReset();
    mockGetNextAddress.mockReset();
    mockGetCoinRecordsByNames.mockReset();
    mockGetWallets.mockReset();
    mockPushTransactions.mockReset();
    mockSendTransaction.mockReset();
    mockRegisterRemoteCoins.mockReset();
    mockSelectCoins.mockReset();
    mockGetFullNodePeerCount.mockReset();
    mockGetFullNodePeerCount.mockResolvedValue(1n);
    mockWalletListeners.clear();
    mockWalletSession = undefined;
    mockWalletFingerprint = '123456';
    mockWalletConnectState.init.mockClear();
    mockWalletConnectState.getSession.mockClear();
    mockWalletConnectState.getAddress.mockClear();
    mockWalletConnectState.disconnect.mockClear();
  });

  async function connectAndWait(_blockchain: RealBlockchainInterface) {
    mockWalletSession = { topic: 'wallet-1' };
    for (const next of mockWalletListeners) {
      next({ stateName: 'connected', connected: true, sessions: 1 });
    }
    await Promise.resolve();
    await Promise.resolve();
    jest.advanceTimersByTime(500);
    await Promise.resolve();
  }

  it('notifies blockchain readiness after WalletConnect reconnect events', async () => {
    jest.useFakeTimers();
    try {
      const address = encodePuzzleHashToBech32m('11'.repeat(32));
      mockGetNextAddress.mockResolvedValue(address);
      mockGetWallets.mockResolvedValue([{ type: 205, id: 7n }]);
      const blockchain = new RealBlockchainInterface();
      const events: boolean[] = [];
      blockchain.onConnectionChange((connected) => events.push(connected));

      await connectAndWait(blockchain);

      expect(events).toEqual([true]);
      expect(mockGetNextAddress).toHaveBeenCalledTimes(1);
      expect(mockGetNextAddress).toHaveBeenCalledWith({ walletId: 1n, newAddress: true });

      mockWalletSession = undefined;
      for (const next of mockWalletListeners) {
        next({ stateName: 'initialized', connected: false, sessions: 0 });
      }
      expect(events).toEqual([true, false]);

      // Same wallet fingerprint: reuse the cached change address.
      await connectAndWait(blockchain);

      expect(events).toEqual([true, false, true]);
      expect(mockGetNextAddress).toHaveBeenCalledTimes(1);
      expect((await blockchain.getAddress()).puzzleHash).toBe('11'.repeat(32));
    } finally {
      jest.useRealTimers();
    }
  });

  it('reports ready for play once a full node peer is verified and drops on disconnect', async () => {
    jest.useFakeTimers();
    try {
      mockGetNextAddress.mockResolvedValue(encodePuzzleHashToBech32m('11'.repeat(32)));
      mockGetWallets.mockResolvedValue([{ type: 205, id: 7n }]);
      mockGetFullNodePeerCount.mockResolvedValue(2n);

      const blockchain = new RealBlockchainInterface();
      const ready: boolean[] = [];
      blockchain.onPlayReadinessChange((r) => ready.push(r));
      expect(blockchain.isReadyForPlay()).toBe(false);

      await connectAndWait(blockchain);
      for (let i = 0; i < 10; i++) await Promise.resolve();

      expect(blockchain.isReadyForPlay()).toBe(true);
      expect(ready).toEqual([true]);

      // Wallet disconnect: the backend can no longer vouch for a peer.
      mockWalletSession = undefined;
      for (const next of mockWalletListeners) {
        next({ stateName: 'initialized', connected: false, sessions: 0 });
      }
      expect(blockchain.isReadyForPlay()).toBe(false);
      expect(ready).toEqual([true, false]);
    } finally {
      jest.useRealTimers();
    }
  });

  it('stays not-ready for play while no full node peer is present', async () => {
    jest.useFakeTimers();
    try {
      mockGetNextAddress.mockResolvedValue(encodePuzzleHashToBech32m('11'.repeat(32)));
      mockGetWallets.mockResolvedValue([{ type: 205, id: 7n }]);
      mockGetFullNodePeerCount.mockResolvedValue(0n);

      const blockchain = new RealBlockchainInterface();
      expect(blockchain.isReadyForPlay()).toBe(false);

      await connectAndWait(blockchain);
      for (let i = 0; i < 10; i++) await Promise.resolve();

      expect(blockchain.isReadyForPlay()).toBe(false);
    } finally {
      jest.useRealTimers();
    }
  });

  it('reuses cached change address and remote wallet id across reloads', async () => {
    jest.useFakeTimers();
    try {
      const puzzleHash = '11'.repeat(32);
      mockGetNextAddress.mockResolvedValue(encodePuzzleHashToBech32m(puzzleHash));
      mockGetWallets.mockResolvedValue([{ type: 205, id: 7n }]);

      const first = new RealBlockchainInterface();
      first.onConnectionChange(() => {});
      await connectAndWait(first);
      expect(mockGetNextAddress).toHaveBeenCalledTimes(1);
      expect(mockGetWallets).toHaveBeenCalledTimes(1);

      // Simulate a page reload: new adapter instance, same fingerprint + cache.
      const second = new RealBlockchainInterface();
      const events: boolean[] = [];
      second.onConnectionChange((connected) => events.push(connected));
      await connectAndWait(second);

      expect(mockGetNextAddress).toHaveBeenCalledTimes(1);
      expect(mockGetWallets).toHaveBeenCalledTimes(1);
      expect((await second.getAddress()).puzzleHash).toBe(puzzleHash);
      expect(events).toEqual([true]);
      expect(second.getRegistrationScopeKey()).toBe('7');
    } finally {
      jest.useRealTimers();
    }
  });

  it('asks for a new change address when the wallet fingerprint changes', async () => {
    jest.useFakeTimers();
    try {
      mockGetNextAddress
        .mockResolvedValueOnce(encodePuzzleHashToBech32m('11'.repeat(32)))
        .mockResolvedValueOnce(encodePuzzleHashToBech32m('22'.repeat(32)));
      mockGetWallets.mockResolvedValue([{ type: 205, id: 7n }]);

      const blockchain = new RealBlockchainInterface();
      blockchain.onConnectionChange(() => {});
      await connectAndWait(blockchain);
      expect(mockGetNextAddress).toHaveBeenCalledTimes(1);

      mockWalletSession = undefined;
      for (const next of mockWalletListeners) {
        next({ stateName: 'initialized', connected: false, sessions: 0 });
      }

      mockWalletFingerprint = '999999';
      await connectAndWait(blockchain);

      expect(mockGetNextAddress).toHaveBeenCalledTimes(2);
      expect((await blockchain.getAddress()).puzzleHash).toBe('22'.repeat(32));
    } finally {
      jest.useRealTimers();
    }
  });

  it('retries remote-wallet setup after a transient getWallets failure', async () => {
    jest.useFakeTimers();
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const address = encodePuzzleHashToBech32m('11'.repeat(32));
      mockGetNextAddress.mockResolvedValue(address);
      mockGetWallets
        .mockRejectedValueOnce(new Error('wallet busy'))
        .mockResolvedValueOnce([{ type: 205, id: 7n }]);

      const blockchain = new RealBlockchainInterface();
      const events: boolean[] = [];
      blockchain.onConnectionChange((connected) => events.push(connected));

      mockWalletSession = { topic: 'wallet-1' };
      for (const next of mockWalletListeners) {
        next({ stateName: 'connected', connected: true, sessions: 1 });
      }
      // Settle getNextAddress + the failing getWallets before the retry tick.
      for (let i = 0; i < 10; i++) await Promise.resolve();
      expect(mockGetWallets).toHaveBeenCalledTimes(1);
      expect(events).toEqual([]);
      expect(warnSpy).toHaveBeenCalled();

      // Retry tick starts getWallets #2; the following tick observes remoteWalletId.
      jest.advanceTimersByTime(500);
      for (let i = 0; i < 10; i++) await Promise.resolve();
      expect(mockGetWallets).toHaveBeenCalledTimes(2);

      jest.advanceTimersByTime(500);
      for (let i = 0; i < 10; i++) await Promise.resolve();
      expect(events).toEqual([true]);
    } finally {
      warnSpy.mockRestore();
      jest.useRealTimers();
    }
  });

  it('does not stack duplicate getWallets while one request is still in flight', async () => {
    jest.useFakeTimers();
    try {
      const address = encodePuzzleHashToBech32m('11'.repeat(32));
      mockGetNextAddress.mockResolvedValue(address);
      let resolveWallets!: (value: unknown) => void;
      mockGetWallets.mockImplementation(
        () =>
          new Promise((resolve) => {
            resolveWallets = resolve;
          }),
      );

      const blockchain = new RealBlockchainInterface();
      blockchain.onConnectionChange(() => {});
      mockWalletSession = { topic: 'wallet-1' };
      for (const next of mockWalletListeners) {
        next({ stateName: 'connected', connected: true, sessions: 1 });
      }
      for (let i = 0; i < 10; i++) await Promise.resolve();
      expect(mockGetWallets).toHaveBeenCalledTimes(1);

      // Reconnect finalize used to clear pending and fire another RPC each click.
      const setup = await blockchain.beginConnect('id');
      void setup.finalize();
      for (let i = 0; i < 10; i++) await Promise.resolve();
      expect(mockGetWallets).toHaveBeenCalledTimes(1);

      resolveWallets([{ type: 205, id: 7n }]);
      for (let i = 0; i < 10; i++) await Promise.resolve();
      jest.advanceTimersByTime(500);
      for (let i = 0; i < 10; i++) await Promise.resolve();
      expect(blockchain.getRegistrationScopeKey()).toBe('7');
    } finally {
      jest.useRealTimers();
    }
  });

  it('treats encoded WalletConnect coin record misses as absent coins', async () => {
    const missingName = 'missing-coin-id';
    const presentName = 'present-coin-id';
    const record: CoinRecord = {
      coin: {
        parentCoinInfo: 'parent',
        puzzleHash: 'puzzle',
        amount: 100n,
      },
      confirmedBlockIndex: 10n,
      spentBlockIndex: 0n,
      spent: false,
      coinbase: false,
      timestamp: 123n,
    };

    mockGetCoinRecordsByNames.mockImplementation(async ({ names }: { names: string[] }) => {
      if (names[0] === missingName) {
        throw new Error(
          encodedWalletConnectError({
            error: `Coin ID ${missingName} not found`,
          }),
        );
      }
      return { coinRecords: [record] };
    });

    await expect(
      new RealBlockchainInterface().getCoinRecordsByNames([missingName, presentName]),
    ).resolves.toEqual([record]);

    expect(mockGetCoinRecordsByNames).toHaveBeenNthCalledWith(1, {
      names: [missingName],
      includeSpentCoins: true,
      allowUnsynced: true,
    });
    expect(mockGetCoinRecordsByNames).toHaveBeenNthCalledWith(2, {
      names: [presentName],
      includeSpentCoins: true,
      allowUnsynced: true,
    });
  });

  it('skips a coin whose lookup error is unrecognized instead of aborting the batch', async () => {
    const unrecognizedName = 'unrecognized-coin-id';
    const presentName = 'present-coin-id';
    const record: CoinRecord = {
      coin: {
        parentCoinInfo: 'parent',
        puzzleHash: 'puzzle',
        amount: 100n,
      },
      confirmedBlockIndex: 10n,
      spentBlockIndex: 0n,
      spent: false,
      coinbase: false,
      timestamp: 123n,
    };

    mockGetCoinRecordsByNames.mockImplementation(async ({ names }: { names: string[] }) => {
      if (names[0] === unrecognizedName) {
        throw new Error('totally unexpected daemon failure');
      }
      return { coinRecords: [record] };
    });

    await expect(
      new RealBlockchainInterface().getCoinRecordsByNames([unrecognizedName, presentName]),
    ).resolves.toEqual([record]);
  });

  it('records non-ephemeral root removals and never asks the wallet to add a fee', async () => {
    const parentCoinInfo = '11'.repeat(32);
    const puzzleHash = '22'.repeat(32);
    const amount = 100n;
    // Coin id of the first (root) coin below; the second coin's parent equals
    // this, making it ephemeral and therefore excluded from removals.
    const coinAId = await coinIdFromBytes(toUint8(`${parentCoinInfo}${puzzleHash}64`));
    const peerParentCoinInfo = '44'.repeat(32);
    const peerPuzzleHash = '55'.repeat(32);
    const peerAmount = 80n;
    const blockchain = new RealBlockchainInterface();
    blockchain.blockchainAddressData = { puzzleHash };
    mockPushTransactions.mockResolvedValue({ success: true });

    // The bundle handed to spend is now the (possibly fee-aggregated) bundle
    // itself; removals are derived from its own non-ephemeral coin spends.
    const submittedBundle = {
      coin_spends: [
        {
          coin: {
            parent_coin_info: `0x${parentCoinInfo}`,
            puzzle_hash: `0x${puzzleHash}`,
            amount,
          },
          puzzle_reveal: '0x80',
          solution: '0x80',
        },
        {
          // Ephemeral: parent is the coin spent above.
          coin: {
            parent_coin_info: `0x${coinAId}`,
            puzzle_hash: `0x${'33'.repeat(32)}`,
            amount: 50n,
          },
          puzzle_reveal: '0x80',
          solution: '0x80',
        },
        {
          coin: {
            parent_coin_info: `0x${peerParentCoinInfo}`,
            puzzle_hash: `0x${peerPuzzleHash}`,
            amount: peerAmount,
          },
          puzzle_reveal: '0x80',
          solution: '0x80',
        },
      ],
      aggregated_signature: '0x00',
    };
    await expect(
      blockchain.spend('80', submittedBundle, puzzleHash, 'submitTransaction', 10n),
    ).resolves.toEqual({ success: true });

    const call = mockPushTransactions.mock.calls[0][0];
    // The fee-paying spend is aggregated in by the caller; chia_pushTransactions
    // must not add its own fee. `fee` is surfaced only as fee_amount for display.
    expect(call.fee).toBeUndefined();
    expect(call.transactions[0].fee_amount).toBe(10n);
    expect(call.transactions[0].removals).toEqual([
      {
        parent_coin_info: `0x${parentCoinInfo}`,
        puzzle_hash: `0x${puzzleHash}`,
        amount,
      },
      {
        parent_coin_info: `0x${peerParentCoinInfo}`,
        puzzle_hash: `0x${peerPuzzleHash}`,
        amount: peerAmount,
      },
    ]);
  });

  it('builds a wallet-signed fee spend bound with ASSERT_CONCURRENT_SPEND', async () => {
    const puzzleHash = '11'.repeat(32);
    const blockchain = new RealBlockchainInterface();
    blockchain.blockchainAddressData = { puzzleHash };
    // The wallet returns the signed bundle over WalletConnect in camelCase,
    // including nested coin fields. createFeeSpend must normalize this into the
    // canonical snake_case coinset shape the aggregator/removal code consume.
    const walletFeeBundle = {
      coinSpends: [
        {
          coin: {
            parentCoinInfo: `0x${'99'.repeat(32)}`,
            puzzleHash: `0x${'88'.repeat(32)}`,
            amount: 1000n,
          },
          puzzleReveal: '0x80',
          solution: '0x80',
        },
      ],
      aggregatedSignature: '0xfee',
    };
    mockSendTransaction.mockResolvedValue({ transactions: [{ spendBundle: walletFeeBundle }] });

    const bindCoinId = 'ab'.repeat(32);
    const result = await blockchain.createFeeSpend(10n, bindCoinId);

    expect(result).toEqual({
      coin_spends: [
        {
          coin: {
            parent_coin_info: `0x${'99'.repeat(32)}`,
            puzzle_hash: `0x${'88'.repeat(32)}`,
            amount: 1000n,
          },
          puzzle_reveal: '0x80',
          solution: '0x80',
        },
      ],
      aggregated_signature: '0xfee',
    });
    expect(mockSendTransaction).toHaveBeenCalledWith({
      walletId: 1n,
      amount: 1n,
      address: encodePuzzleHashToBech32m(puzzleHash),
      fee: 10n,
      push: false,
      allowUnsynced: true,
      extraConditions: [{ opcode: 64n, args: { coin_id: `0x${bindCoinId}` } }],
    });
  });

  it('returns null when the wallet cannot build a fee spend', async () => {
    const blockchain = new RealBlockchainInterface();
    blockchain.blockchainAddressData = { puzzleHash: '11'.repeat(32) };
    mockSendTransaction.mockRejectedValue(new Error('wallet not synced'));
    await expect(blockchain.createFeeSpend(10n, 'cd'.repeat(32))).resolves.toBeNull();
  });

  it('does not contact the wallet for a zero fee', async () => {
    const blockchain = new RealBlockchainInterface();
    blockchain.blockchainAddressData = { puzzleHash: '11'.repeat(32) };
    await expect(blockchain.createFeeSpend(0n, 'cd'.repeat(32))).resolves.toBeNull();
    expect(mockSendTransaction).not.toHaveBeenCalled();
  });

  it('uses the provided change puzzle hash in the transaction record', async () => {
    const blockchain = new RealBlockchainInterface();
    blockchain.blockchainAddressData = { puzzleHash: '11'.repeat(32) };
    const sessionPuzzleHash = '22'.repeat(32);
    mockPushTransactions.mockResolvedValue({ success: true });

    await blockchain.spend(
      '80',
      { coin_spends: [], aggregated_signature: '0x00' },
      sessionPuzzleHash,
      'submitTransaction',
      0n,
    );

    expect(mockPushTransactions).toHaveBeenCalledWith(
      expect.objectContaining({
        transactions: [
          expect.objectContaining({
            to_puzzle_hash: sessionPuzzleHash,
            to_address: encodePuzzleHashToBech32m(sessionPuzzleHash),
          }),
        ],
      }),
    );
  });
});
