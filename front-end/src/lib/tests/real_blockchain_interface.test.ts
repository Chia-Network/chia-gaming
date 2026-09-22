import 'fake-indexeddb/auto';
import { storageRepository } from '../session/storageRepository';
import type { WalletOfferProvider } from '../../types/ChiaGaming';

jest.mock('../../hooks/WalletConnectRpc', () => ({
  WalletConnectTransportError: class WalletConnectTransportError extends Error {},
  WalletConnectResponseError: class WalletConnectResponseError extends Error {},
  rpc: {
    createOfferForIds: jest.fn(),
    cancelOffer: jest.fn(),
    createNewRemoteWallet: jest.fn(),
    getNextAddress: jest.fn(),
    getCoinRecordsByNames: jest.fn(),
    getWallets: jest.fn(),
    pushTransactions: jest.fn(),
    registerRemoteCoins: jest.fn(),
    selectCoins: jest.fn(),
    getFullNodePeerCount: jest.fn(async () => 1n),
  },
}));

const mockWalletListeners = new Set<(evt: any) => void>();
let mockWalletSession: unknown;
let mockWalletFingerprint = '123456';
let mockSupportsPeerCount = true;
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
  supportsMethod: jest.fn(() => mockSupportsPeerCount),
  startConnect: jest.fn(async () => ({
    uri: 'wc:pairingtopic@2?relay-protocol=irn&symKey=deadbeef',
    approval: async () => ({}),
  })),
  connect: jest.fn(async () => {}),
  forgetSessions: jest.fn(async () => {
    mockWalletSession = undefined;
  }),
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

import {
  rpc,
  WalletConnectResponseError,
  WalletConnectTransportError,
} from '../../hooks/WalletConnectRpc';
import { RealBlockchainInterface } from '../../hooks/RealBlockchainInterface';
import { FeeAttachmentRuntime } from '../session/feeAttachmentRuntime';
import { WalletProviderRegistry } from '../session/walletProviderRegistry';
import {
  classifyFakeBlockchainSubmitError,
  classifyFakeBlockchainSubmitResult,
  FakeBlockchainInterface,
  SimulatorTransportError,
  SyntheticFeeOfferTracker,
} from '../../hooks/FakeBlockchainInterface';
import { BlockchainPoller } from '../../hooks/BlockchainPoller';
import { CoinRecord } from '../../types/rpc/CoinRecord';
import { coinIdFromBytes, toUint8 } from '../../util';
import { encodePuzzleHashToBech32m } from '../../util/bech32m';
import { subscribeLog } from '../../services/log';

const offerOperation = {
  owner: {
    installationPlayerId: 'player',
    peerSessionId: 'session',
    providerScope: { provider: 'simulator' as const, identity: 'player' },
  },
  purpose: { kind: 'funding' as const, operationId: 'operation' },
};

const mockCreateOfferForIds = rpc.createOfferForIds as jest.Mock;
const mockCancelOffer = rpc.cancelOffer as jest.Mock;
const mockCreateNewRemoteWallet = rpc.createNewRemoteWallet as jest.Mock;
const mockGetNextAddress = rpc.getNextAddress as jest.Mock;
const mockGetCoinRecordsByNames = rpc.getCoinRecordsByNames as jest.Mock;
const mockGetWallets = rpc.getWallets as jest.Mock;
const mockPushTransactions = rpc.pushTransactions as jest.Mock;
const mockRegisterRemoteCoins = rpc.registerRemoteCoins as jest.Mock;
const mockSelectCoins = rpc.selectCoins as jest.Mock;
const mockGetFullNodePeerCount = rpc.getFullNodePeerCount as jest.Mock;

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
  beforeEach(async () => {
    setTestGlobal('localStorage', makeStorage());
    mockCreateOfferForIds.mockReset();
    mockCancelOffer.mockReset();
    mockCreateNewRemoteWallet.mockReset();
    mockGetNextAddress.mockReset();
    mockGetCoinRecordsByNames.mockReset();
    mockGetWallets.mockReset();
    mockPushTransactions.mockReset();
    mockRegisterRemoteCoins.mockReset();
    mockSelectCoins.mockReset();
    mockGetFullNodePeerCount.mockReset();
    mockGetFullNodePeerCount.mockResolvedValue(1n);
    mockWalletListeners.clear();
    mockWalletSession = undefined;
    mockWalletFingerprint = '123456';
    mockSupportsPeerCount = true;
    mockWalletConnectState.init.mockClear();
    mockWalletConnectState.getSession.mockClear();
    mockWalletConnectState.getAddress.mockClear();
    mockWalletConnectState.supportsMethod.mockClear();
    mockWalletConnectState.startConnect.mockClear();
    mockWalletConnectState.connect.mockClear();
    storageRepository._resetForTests();
    await storageRepository.claimApplicationState();
    const empty = {
      ...storageRepository.loadState(),
      walletContext: null,
      channelFundingOperations: [],
      feeAttachments: [],
    };
    storageRepository._replaceApplicationStateForTests(empty);
    await storageRepository.write(storageRepository.patchApplicationState(() => empty));
    mockWalletConnectState.forgetSessions.mockClear();
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

  it('reissues a QR on repeated fresh Link Wallet without wiping IndexedDB', async () => {
    const deleteDatabase = jest.fn();
    const priorIndexedDb = (globalThis as { indexedDB?: unknown }).indexedDB;
    setTestGlobal('indexedDB', { deleteDatabase });
    try {
      const blockchain = new RealBlockchainInterface();

      const first = await blockchain.beginConnect('id', true);
      expect(first.qrUri).toBe('wc:pairingtopic@2?relay-protocol=irn&symKey=deadbeef');

      // Cancelling the pairing tears down through disconnect(), not a storage wipe.
      await blockchain.disconnect();

      const second = await blockchain.beginConnect('id', true);
      expect(second.qrUri).toBe('wc:pairingtopic@2?relay-protocol=irn&symKey=deadbeef');

      expect(mockWalletConnectState.forgetSessions).toHaveBeenCalledTimes(2);
      expect(deleteDatabase).not.toHaveBeenCalled();
    } finally {
      if (priorIndexedDb === undefined) {
        Reflect.deleteProperty(globalThis, 'indexedDB');
      } else {
        setTestGlobal('indexedDB', priorIndexedDb);
      }
    }
  });

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

  it('assumes enough peers when the wallet does not support the peer-count method', async () => {
    jest.useFakeTimers();
    try {
      mockSupportsPeerCount = false;
      mockGetNextAddress.mockResolvedValue(encodePuzzleHashToBech32m('11'.repeat(32)));
      mockGetWallets.mockResolvedValue([{ type: 205, id: 7n }]);

      const blockchain = new RealBlockchainInterface();
      const ready: boolean[] = [];
      blockchain.onPlayReadinessChange((r) => ready.push(r));

      await connectAndWait(blockchain);
      for (let i = 0; i < 10; i++) await Promise.resolve();

      expect(blockchain.isReadyForPlay()).toBe(true);
      expect(ready).toEqual([true]);
      expect(mockGetFullNodePeerCount).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

  it('assumes enough peers when an advertised peer-count method never responds', async () => {
    jest.useFakeTimers();
    try {
      mockGetNextAddress.mockResolvedValue(encodePuzzleHashToBech32m('11'.repeat(32)));
      mockGetWallets.mockResolvedValue([{ type: 205, id: 7n }]);
      mockGetFullNodePeerCount.mockImplementation(() => new Promise(() => {}));

      const blockchain = new RealBlockchainInterface();
      blockchain.onPlayReadinessChange(() => {});

      await connectAndWait(blockchain);
      for (let i = 0; i < 10; i++) await Promise.resolve();
      expect(blockchain.isReadyForPlay()).toBe(false);

      jest.advanceTimersByTime(7_000);
      for (let i = 0; i < 10; i++) await Promise.resolve();

      expect(blockchain.isReadyForPlay()).toBe(true);
      expect(mockGetFullNodePeerCount).toHaveBeenCalledTimes(1);
    } finally {
      jest.useRealTimers();
    }
  });

  it('assumes enough peers when the wallet rejects peer count as unsupported', async () => {
    jest.useFakeTimers();
    try {
      mockGetNextAddress.mockResolvedValue(encodePuzzleHashToBech32m('11'.repeat(32)));
      mockGetWallets.mockResolvedValue([{ type: 205, id: 7n }]);
      mockGetFullNodePeerCount.mockRejectedValue(new Error('Method not found (code=-32601)'));

      const blockchain = new RealBlockchainInterface();
      blockchain.onPlayReadinessChange(() => {});

      await connectAndWait(blockchain);
      for (let i = 0; i < 10; i++) await Promise.resolve();

      expect(blockchain.isReadyForPlay()).toBe(true);
      expect(mockGetFullNodePeerCount).toHaveBeenCalledTimes(1);
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

  it('reuses the change address but verifies monitoring wallet existence across reloads', async () => {
    jest.useFakeTimers();
    try {
      const puzzleHash = '11'.repeat(32);
      mockGetNextAddress.mockResolvedValue(encodePuzzleHashToBech32m(puzzleHash));
      mockGetWallets.mockResolvedValue([{ type: 205, id: 7n }]);

      const first = new RealBlockchainInterface();
      first.onConnectionChange(() => {});
      await connectAndWait(first);
      const firstScope = first.getWalletOfferProvider()?.scope;
      expect(mockGetNextAddress).toHaveBeenCalledTimes(1);
      expect(mockGetWallets).toHaveBeenCalledTimes(1);

      // Simulate a page reload: new adapter instance, same fingerprint + cache.
      const second = new RealBlockchainInterface();
      const events: boolean[] = [];
      second.onConnectionChange((connected) => events.push(connected));
      await connectAndWait(second);

      expect(mockGetNextAddress).toHaveBeenCalledTimes(1);
      expect(mockGetWallets).toHaveBeenCalledTimes(2);
      expect((await second.getAddress()).puzzleHash).toBe(puzzleHash);
      expect(events).toEqual([true]);
      expect(second.getRegistrationScopeKey()).toBe('7');
      expect(second.getWalletOfferProvider()?.scope).toEqual(firstScope);
      expect(second.getWalletOfferProvider()?.scope).toEqual({
        provider: 'walletconnect',
        fingerprint: '123456',
        chainId: expect.any(String),
      });
    } finally {
      jest.useRealTimers();
    }
  });

  it('recreates a missing monitoring wallet without changing offer ownership scope', async () => {
    jest.useFakeTimers();
    try {
      mockGetNextAddress.mockResolvedValue(encodePuzzleHashToBech32m('11'.repeat(32)));
      mockGetWallets.mockResolvedValue([]);
      mockCreateNewRemoteWallet.mockResolvedValue({ walletId: 9n });

      const blockchain = new RealBlockchainInterface();
      blockchain.onConnectionChange(() => {});
      await connectAndWait(blockchain);

      expect(mockCreateNewRemoteWallet).toHaveBeenCalledTimes(1);
      expect(blockchain.getRegistrationScopeKey()).toBe('9');
      expect(blockchain.getWalletOfferProvider()?.scope).toEqual({
        provider: 'walletconnect',
        fingerprint: '123456',
        chainId: expect.any(String),
      });
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

  it('silently treats every wallet coin-record error as absent and continues the batch', async () => {
    const opaqueErrorName = 'opaque-error-coin-id';
    const daemonErrorName = 'daemon-error-coin-id';
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
      if (names[0] === opaqueErrorName) {
        throw new Error('Internal Error');
      }
      if (names[0] === daemonErrorName) {
        throw new Error('totally unexpected daemon failure');
      }
      return { coinRecords: [record] };
    });

    const logLines: string[] = [];
    const unsubscribe = subscribeLog((line) => logLines.push(line));
    logLines.length = 0;
    try {
      await expect(
        new RealBlockchainInterface().getCoinRecordsByNames([
          opaqueErrorName,
          daemonErrorName,
          presentName,
        ]),
      ).resolves.toEqual([record]);
    } finally {
      unsubscribe();
    }

    expect(mockGetCoinRecordsByNames).toHaveBeenNthCalledWith(1, {
      names: [opaqueErrorName],
      includeSpentCoins: true,
      allowUnsynced: true,
    });
    expect(mockGetCoinRecordsByNames).toHaveBeenNthCalledWith(2, {
      names: [daemonErrorName],
      includeSpentCoins: true,
      allowUnsynced: true,
    });
    expect(mockGetCoinRecordsByNames).toHaveBeenNthCalledWith(3, {
      names: [presentName],
      includeSpentCoins: true,
      allowUnsynced: true,
    });
    expect(logLines.some((line) => line.includes('getCoinRecordsByNames error'))).toBe(false);
  });

  it('preserves the last successful coin record across a transient lookup failure', async () => {
    const name = 'previously-live-coin-id';
    const liveRecord: CoinRecord = {
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
    const spentRecord: CoinRecord = {
      ...liveRecord,
      spentBlockIndex: 15n,
      spent: true,
    };
    mockGetCoinRecordsByNames
      .mockResolvedValueOnce({ coinRecords: [liveRecord] })
      .mockRejectedValueOnce(new Error('Internal Error'))
      .mockResolvedValueOnce({ coinRecords: [spentRecord] });

    const blockchain = new RealBlockchainInterface();
    await expect(blockchain.getCoinRecordsByNames([name])).resolves.toEqual([liveRecord]);
    await expect(blockchain.getCoinRecordsByNames([name])).resolves.toEqual([liveRecord]);
    await expect(blockchain.getCoinRecordsByNames([name])).resolves.toEqual([spentRecord]);
  });

  it('keeps exact pushTransactions rebroadcast idempotent and outside orphan state', async () => {
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
    ).resolves.toMatchObject({ status: 'acknowledged' });

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
    await expect(
      blockchain.spend('80', submittedBundle, puzzleHash, 'submitTransaction', 10n),
    ).resolves.toMatchObject({ status: 'acknowledged' });
    expect(mockPushTransactions).toHaveBeenCalledTimes(2);
    expect(mockPushTransactions.mock.calls[1][0]).toEqual(call);
    expect(storageRepository.channelFundingOperations()).toEqual([]);
  });

  it('persists initiator funding offers without unsupported coin-selection fields', async () => {
    const blockchain = new RealBlockchainInterface();
    const fundingCoinId = 'ab'.repeat(32);
    mockCreateOfferForIds.mockResolvedValue({
      offer: 'offer1signed',
      tradeRecord: { tradeId: 'trade-id' },
    });

    await expect(
      blockchain.beginWalletOffer(offerOperation, {
        kind: 'funding',
        uniqueId: 'test',
        offer: { '1': -100n },
        coinIds: [fundingCoinId],
      }),
    ).resolves.toEqual({
      kind: 'created-reserved',
      material: { kind: 'offer', offer: 'offer1signed' },
      tradeId: 'trade-id',
    });

    expect(mockSelectCoins).not.toHaveBeenCalled();
    expect(mockCreateOfferForIds).toHaveBeenCalledWith({
      offer: { '1': -100n },
      driverDict: {},
      validateOnly: false,
      extraConditions: undefined,
      allowUnsynced: true,
    });
  });

  it('keeps a persisted funding offer without a trade ID uncertain', async () => {
    const blockchain = new RealBlockchainInterface();
    mockCreateOfferForIds.mockResolvedValue({ offer: 'offer1signed' });

    await expect(
      blockchain.beginWalletOffer(offerOperation, {
        kind: 'funding',
        uniqueId: 'test',
        offer: { '1': -100n },
        coinIds: ['ab'.repeat(32)],
      }),
    ).resolves.toEqual({
      kind: 'unavailable',
      reason: expect.stringMatching(/tradeRecord\.tradeId/),
    });

    expect(mockCreateOfferForIds).toHaveBeenCalledWith(
      expect.objectContaining({ validateOnly: false }),
    );
  });

  it('cancels rejected persisted offers off-chain', async () => {
    const blockchain = new RealBlockchainInterface();
    mockCancelOffer.mockResolvedValue({ success: true });

    await expect(blockchain.beginWalletOfferCancellation('trade-id')).resolves.toEqual({
      status: 'cancelled',
    });

    expect(mockCancelOffer).toHaveBeenCalledWith({
      tradeId: 'trade-id',
      secure: false,
      fee: 0n,
    });
  });

  it('preserves already-spent cancellation detail and converges the ledger', async () => {
    const blockchain = new RealBlockchainInterface();
    mockCancelOffer.mockResolvedValue({
      success: false,
      error: {
        structuredError: {
          code: 'OFFER_ALREADY_SPENT',
          message: 'Offer trade already spent on chain',
        },
      },
    });
    const provider = {
      capability: 'best-effort',
      scope: {
        provider: 'walletconnect',
        fingerprint: '123456',
        chainId: 'chia:testnet11',
      },
      beginCreation: (operation, request) => blockchain.beginWalletOffer(operation, request),
      cancel: (tradeId) => blockchain.beginWalletOfferCancellation(tradeId),
    } satisfies WalletOfferProvider;
    const owner = {
      installationPlayerId: 'installation',
      peerSessionId: 'peer-session',
      providerScope: {
        provider: 'walletconnect' as const,
        fingerprint: '123456',
        chainId: 'chia:testnet11',
      },
    };
    storageRepository.ensureWalletContext(owner.providerScope);
    storageRepository.replaceFeeAttachments([
      {
        owner,
        submissionId: 'submission',
        stage: 'retained-for-replay',
        providerReservationId: 'trade-already-spent',
        reason: 'fee-source-attached',
      },
    ]);
    const providers = new WalletProviderRegistry();
    providers.attach(provider);
    const runtime = new FeeAttachmentRuntime(
      {
        isRetired: () => false,
        getOwner: () => owner,
        requestCommit: jest.fn(),
        reportWarning: jest.fn(),
      },
      providers,
    );
    runtime.retire(owner, 'submission');
    await runtime.awaitIdle();

    expect(storageRepository.feeAttachments()).toEqual([]);
    expect(mockCancelOffer).toHaveBeenCalledWith({
      tradeId: 'trade-already-spent',
      secure: false,
      fee: 0n,
    });
    runtime.detach();
  });

  it('does not hide an uncertain cancellation response', async () => {
    const blockchain = new RealBlockchainInterface();
    mockCancelOffer.mockResolvedValue({
      success: false,
      detail: 'temporary wallet database failure',
    });

    await expect(blockchain.beginWalletOfferCancellation('trade-uncertain')).resolves.toEqual({
      status: 'rejected',
      detail: expect.stringMatching(/temporary wallet database failure/),
    });
  });

  it('classifies WalletConnect transport cancellation failures as unavailable', async () => {
    const blockchain = new RealBlockchainInterface();
    mockCancelOffer.mockRejectedValue(
      new WalletConnectTransportError('WalletConnect cancellation transport failed'),
    );

    await expect(blockchain.beginWalletOfferCancellation('trade-offline')).resolves.toEqual({
      status: 'unavailable',
      detail: expect.stringMatching(/transport failed/),
    });
  });

  it('accepts a structured exact-trade not-found code as already terminal', async () => {
    const blockchain = new RealBlockchainInterface();
    mockCancelOffer.mockRejectedValue({
      message: 'trade missing',
      code: 'TRADE_NOT_FOUND',
      tradeId: 'trade-missing',
    });

    await expect(blockchain.beginWalletOfferCancellation('trade-missing')).resolves.toEqual({
      status: 'already-terminal',
      detail: expect.stringMatching(/trade missing/),
    });
  });

  it('persists receiver funding offers to reserve wallet-selected inputs', async () => {
    const blockchain = new RealBlockchainInterface();
    mockCreateOfferForIds.mockResolvedValue({
      offer: 'offer1signed',
      tradeRecord: { tradeId: 'receiver-trade-id' },
    });

    await expect(
      blockchain.beginWalletOffer(offerOperation, {
        kind: 'funding',
        uniqueId: 'test',
        offer: { '1': -100n },
      }),
    ).resolves.toEqual({
      kind: 'created-reserved',
      material: { kind: 'offer', offer: 'offer1signed' },
      tradeId: 'receiver-trade-id',
    });

    expect(mockSelectCoins).not.toHaveBeenCalled();
    expect(mockCreateOfferForIds).toHaveBeenCalledWith(
      expect.objectContaining({ validateOnly: false }),
    );
  });

  it('encodes RESERVE_FEE as a WalletConnect amount condition', async () => {
    const blockchain = new RealBlockchainInterface();
    mockCreateOfferForIds.mockResolvedValue({
      offer: 'offer1signed',
      tradeRecord: { tradeId: 'reserve-fee-trade' },
    });

    await blockchain.beginWalletOffer(offerOperation, {
      kind: 'funding',
      uniqueId: 'test',
      offer: { '1': -110n },
      extraConditions: [{ opcode: 52n, args: ['0a'] }],
      coinIds: ['ab'.repeat(32)],
    });

    expect(mockCreateOfferForIds).toHaveBeenCalledWith(
      expect.objectContaining({
        offer: { '1': -110n },
        extraConditions: [{ opcode: 52n, args: { amount: 10n } }],
      }),
    );
  });

  it('lets funding offer creation select its own wallet inputs', async () => {
    const blockchain = new RealBlockchainInterface();
    mockSelectCoins.mockRejectedValue(new Error('Internal error'));
    mockCreateOfferForIds.mockResolvedValue({
      offer: 'offer1signed',
      tradeRecord: { tradeId: 'selected-trade' },
    });

    await expect(
      blockchain.beginWalletOffer(offerOperation, {
        kind: 'funding',
        uniqueId: 'test',
        offer: { '1': -100n },
      }),
    ).resolves.toEqual({
      kind: 'created-reserved',
      material: { kind: 'offer', offer: 'offer1signed' },
      tradeId: 'selected-trade',
    });

    expect(mockSelectCoins).not.toHaveBeenCalled();
    expect(mockCreateOfferForIds).toHaveBeenCalledWith(
      expect.objectContaining({ validateOnly: false }),
    );
  });

  it('persists a wallet-signed fee offer to reserve its selected input', async () => {
    const blockchain = new RealBlockchainInterface();
    mockCreateOfferForIds.mockResolvedValue({
      offer: 'offer1signed',
      tradeRecord: { tradeId: 'fee-trade' },
    });

    const bindCoinId = 'ab'.repeat(32);
    await expect(
      blockchain.beginWalletOffer(
        { ...offerOperation, purpose: { kind: 'fee', operationId: 'fee' } },
        { kind: 'fee', uniqueId: 'test', fee: 10n, concurrentSpendCoinId: bindCoinId },
      ),
    ).resolves.toEqual({
      kind: 'created-reserved',
      material: { kind: 'offer', offer: 'offer1signed' },
      tradeId: 'fee-trade',
    });

    expect(mockSelectCoins).not.toHaveBeenCalled();
    expect(mockCreateOfferForIds).toHaveBeenCalledWith({
      offer: { '1': -10n },
      driverDict: {},
      validateOnly: false,
      allowUnsynced: true,
      extraConditions: [
        { opcode: 64n, args: { coin_id: `0x${bindCoinId}` } },
        { opcode: 52n, args: { amount: 10n } },
      ],
    });
  });

  it('keeps a persisted fee offer without a trade ID uncertain', async () => {
    const blockchain = new RealBlockchainInterface();
    mockCreateOfferForIds.mockResolvedValue({ offer: 'offer1signed' });

    await expect(
      blockchain.beginWalletOffer(
        { ...offerOperation, purpose: { kind: 'fee', operationId: 'fee' } },
        {
          kind: 'fee',
          uniqueId: 'test',
          fee: 10n,
          concurrentSpendCoinId: 'cd'.repeat(32),
        },
      ),
    ).resolves.toEqual({
      kind: 'unavailable',
      reason: expect.stringMatching(/tradeRecord\.tradeId/),
    });
  });

  it('reports wallet rejection when it cannot build a fee offer', async () => {
    const blockchain = new RealBlockchainInterface();
    mockCreateOfferForIds.mockRejectedValue(new Error('wallet not synced'));
    await expect(
      blockchain.beginWalletOffer(
        { ...offerOperation, purpose: { kind: 'fee', operationId: 'fee' } },
        {
          kind: 'fee',
          uniqueId: 'test',
          fee: 10n,
          concurrentSpendCoinId: 'cd'.repeat(32),
        },
      ),
    ).resolves.toEqual({
      kind: 'failure',
      reason: 'wallet not synced',
    });
  });

  it('reports fee-offer transport failure as unavailable', async () => {
    const blockchain = new RealBlockchainInterface();
    mockCreateOfferForIds.mockRejectedValue(
      new WalletConnectTransportError('WalletConnect relayer disconnected'),
    );
    await expect(
      blockchain.beginWalletOffer(
        { ...offerOperation, purpose: { kind: 'fee', operationId: 'fee' } },
        {
          kind: 'fee',
          uniqueId: 'test',
          fee: 10n,
          concurrentSpendCoinId: 'cd'.repeat(32),
        },
      ),
    ).resolves.toEqual({
      kind: 'unavailable',
      reason: 'WalletConnect relayer disconnected',
    });
  });

  it('does not preselect or pin a fee parent coin', async () => {
    const blockchain = new RealBlockchainInterface();
    mockCreateOfferForIds.mockResolvedValue({
      offer: 'offer1signed',
      tradeRecord: { tradeId: 'fee-parent-trade' },
    });
    await expect(
      blockchain.beginWalletOffer(
        { ...offerOperation, purpose: { kind: 'fee', operationId: 'fee' } },
        {
          kind: 'fee',
          uniqueId: 'test',
          fee: 10n,
          concurrentSpendCoinId: 'cd'.repeat(32),
        },
      ),
    ).resolves.toEqual({
      kind: 'created-reserved',
      material: { kind: 'offer', offer: 'offer1signed' },
      tradeId: 'fee-parent-trade',
    });
    expect(mockSelectCoins).not.toHaveBeenCalled();
  });

  it('does not contact the wallet for a zero fee', async () => {
    const blockchain = new RealBlockchainInterface();
    await expect(
      blockchain.beginWalletOffer(
        { ...offerOperation, purpose: { kind: 'fee', operationId: 'fee' } },
        {
          kind: 'fee',
          uniqueId: 'test',
          fee: 0n,
          concurrentSpendCoinId: 'cd'.repeat(32),
        },
      ),
    ).resolves.toEqual({ kind: 'failure', reason: 'fee must be positive' });
    expect(mockSelectCoins).not.toHaveBeenCalled();
    expect(mockCreateOfferForIds).not.toHaveBeenCalled();
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

  it('classifies a WalletConnect transport failure as unavailable without recursion', async () => {
    jest.useFakeTimers();
    try {
      const blockchain = new RealBlockchainInterface();
      mockPushTransactions.mockRejectedValue(
        new WalletConnectTransportError('WalletConnect relayer disconnected'),
      );

      await expect(
        blockchain.spend(
          '80',
          { coin_spends: [], aggregated_signature: '0x00' },
          '11'.repeat(32),
          'submitTransaction',
        ),
      ).resolves.toEqual({
        status: 'unavailable',
        detail: 'WalletConnect relayer disconnected',
      });

      expect(mockPushTransactions).toHaveBeenCalledTimes(1);
      expect(jest.getTimerCount()).toBe(0);
    } finally {
      jest.useRealTimers();
    }
  });

  it.each([
    [{ success: true }, 'acknowledged'],
    [{ success: false }, 'rejected'],
    [undefined, 'rejected'],
    [{ result: 'ok' }, 'rejected'],
  ])('classifies resolved WalletConnect result %# as %s', async (result, status) => {
    mockPushTransactions.mockResolvedValue(result);
    await expect(
      new RealBlockchainInterface().spend(
        '80',
        { coin_spends: [], aggregated_signature: '0x00' },
        '11'.repeat(32),
      ),
    ).resolves.toMatchObject({ status });
  });

  it('does not infer a full-node verdict from fields outside the resolved contract', async () => {
    mockPushTransactions.mockResolvedValue({
      success: false,
      error: { message: 'full node rejected spend: INVALID_FEE_TOO_CLOSE_TO_ZERO' },
    });
    await expect(
      new RealBlockchainInterface().spend(
        '80',
        { coin_spends: [], aggregated_signature: '0x00' },
        '11'.repeat(32),
      ),
    ).resolves.toMatchObject({
      status: 'rejected',
      detail: expect.stringContaining('INVALID_FEE_TOO_CLOSE_TO_ZERO'),
    });
  });

  it('acknowledges an exact duplicate reported in a resolved wallet payload', async () => {
    mockPushTransactions.mockResolvedValue({
      success: false,
      error: { message: 'ALREADY_INCLUDING_TRANSACTION' },
    });
    await expect(
      new RealBlockchainInterface().spend(
        '80',
        { coin_spends: [], aggregated_signature: '0x00' },
        '11'.repeat(32),
      ),
    ).resolves.toMatchObject({ status: 'acknowledged' });
  });

  it.each([
    [new WalletConnectResponseError('ALREADY_INCLUDING_TRANSACTION'), 'acknowledged'],
    [new WalletConnectResponseError('transaction already included'), 'acknowledged'],
    [new WalletConnectResponseError('arbitrary wallet refusal'), 'rejected'],
    [new WalletConnectResponseError('full node rejected spend: UNKNOWN_UNSPENT'), 'rejected'],
    [new WalletConnectTransportError('request timed out'), 'unavailable'],
  ])('classifies thrown WalletConnect error %# as %s', async (error, status) => {
    mockPushTransactions.mockRejectedValue(error);
    await expect(
      new RealBlockchainInterface().spend(
        '80',
        { coin_spends: [], aggregated_signature: '0x00' },
        '11'.repeat(32),
      ),
    ).resolves.toMatchObject({ status });
  });

  it('terminalizes only the synthetic fee offer included in the acknowledged bundle', async () => {
    const walletBundle = (parentByte: string) => ({
      coin_spends: [
        {
          coin: {
            parent_coin_info: `0x${parentByte.repeat(32)}`,
            puzzle_hash: `0x${'ab'.repeat(32)}`,
            amount: 100n,
          },
          puzzle_reveal: '0x80',
          solution: '0x80',
        },
      ],
      aggregated_signature: '0x',
    });
    const tracker = new SyntheticFeeOfferTracker();
    tracker.reserve('trade-a', walletBundle('11'));
    tracker.reserve('trade-b', walletBundle('22'));

    tracker.markSubmitted(walletBundle('11'));

    expect(tracker.cancel('trade-a')).toBe('submitted');
    expect(tracker.cancel('trade-b')).toBe('reserved');
  });

  it('rejects a second synthetic fee offer that reuses an exact reserved input', () => {
    const bundle = {
      coin_spends: [
        {
          coin: {
            parent_coin_info: `0x${'11'.repeat(32)}`,
            puzzle_hash: `0x${'ab'.repeat(32)}`,
            amount: 100n,
          },
          puzzle_reveal: '0x80',
          solution: '0x80',
        },
      ],
      aggregated_signature: '0x',
    };
    const tracker = new SyntheticFeeOfferTracker();
    tracker.reserve('trade-a', bundle);

    expect(() => tracker.reserve('trade-b', bundle)).toThrow(/reuses an input reserved/);
    expect(tracker.cancel('trade-a')).toBe('reserved');
    expect(tracker.cancel('trade-b')).toBeUndefined();
  });

  it('applies conservative simulator outcome defaults', () => {
    expect(classifyFakeBlockchainSubmitResult([1])).toEqual({ status: 'acknowledged' });
    expect(classifyFakeBlockchainSubmitResult([1n])).toEqual({ status: 'acknowledged' });
    expect(classifyFakeBlockchainSubmitResult([3, 5])).toMatchObject({
      status: 'rejected',
    });
    expect(classifyFakeBlockchainSubmitResult([3n, 5n])).toMatchObject({
      status: 'rejected',
    });
    expect(classifyFakeBlockchainSubmitResult([3, 9])).toMatchObject({
      status: 'rejected',
    });
    expect(classifyFakeBlockchainSubmitResult([3, 99, 'INVALID_FEE_LOW_FEE'])).toMatchObject({
      status: 'rejected',
    });
    expect(classifyFakeBlockchainSubmitResult(null)).toMatchObject({ status: 'rejected' });
    expect(
      classifyFakeBlockchainSubmitError(new Error('full node rejected spend: UNKNOWN_UNSPENT')),
    ).toMatchObject({ status: 'rejected' });
    expect(
      classifyFakeBlockchainSubmitError(new Error('full node rejected spend: INVALID_FEE_LOW_FEE')),
    ).toMatchObject({ status: 'rejected' });
    expect(
      classifyFakeBlockchainSubmitError(new SimulatorTransportError('WebSocket closed')),
    ).toEqual({
      status: 'unavailable',
      detail: 'WebSocket closed',
    });
    expect(classifyFakeBlockchainSubmitError(new Error('unexpected simulator failure'))).toEqual({
      status: 'rejected',
      detail: 'unexpected simulator failure',
    });
  });
});

describe('simulator wallet scope', () => {
  it('uses the exact stable simulator identity', async () => {
    const blockchain = new FakeBlockchainInterface('ws://simulator.invalid');
    await blockchain.beginConnect('player-exact-identity');
    expect(blockchain.getWalletOfferProvider()?.scope).toEqual({
      provider: 'simulator',
      identity: 'player-exact-identity',
    });
  });

  it('scopes a shared simulator adapter to the operation owner', async () => {
    const blockchain = new FakeBlockchainInterface('ws://simulator.invalid');
    await blockchain.beginConnect('last-registered-player');
    const poller = new BlockchainPoller(blockchain, 60_000);

    expect(poller.rpc.getWalletOfferProvider(offerOperation.owner)?.scope).toEqual({
      provider: 'simulator',
      identity: 'player',
    });
  });
});
