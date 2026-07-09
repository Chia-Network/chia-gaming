jest.mock('../../hooks/WalletConnectRpc', () => ({
  rpc: {
    createOfferForIds: jest.fn(),
    createNewRemoteWallet: jest.fn(),
    getNextAddress: jest.fn(),
    getCoinRecordsByNames: jest.fn(),
    getWallets: jest.fn(),
    pushTransactions: jest.fn(),
    registerRemoteCoins: jest.fn(),
    selectCoins: jest.fn(),
  },
}));

const mockWalletListeners = new Set<(evt: any) => void>();
let mockWalletSession: unknown;
const mockWalletConnectState = {
  getObservable: () => ({
    subscribe: ({ next }: { next: (evt: any) => void }) => {
      mockWalletListeners.add(next);
      return { unsubscribe: () => { mockWalletListeners.delete(next); } };
    },
  }),
  init: jest.fn(async () => {}),
  getSession: jest.fn(() => mockWalletSession),
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
const mockRegisterRemoteCoins = rpc.registerRemoteCoins as jest.Mock;
const mockSelectCoins = rpc.selectCoins as jest.Mock;

function encodedWalletConnectError(payload: unknown): string {
  const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64');
  return `[wc:-32603|${encoded}]`;
}

describe('RealBlockchainInterface', () => {
  beforeEach(() => {
    mockCreateOfferForIds.mockReset();
    mockCreateNewRemoteWallet.mockReset();
    mockGetNextAddress.mockReset();
    mockGetCoinRecordsByNames.mockReset();
    mockGetWallets.mockReset();
    mockPushTransactions.mockReset();
    mockRegisterRemoteCoins.mockReset();
    mockSelectCoins.mockReset();
    mockWalletListeners.clear();
    mockWalletSession = undefined;
    mockWalletConnectState.init.mockClear();
    mockWalletConnectState.getSession.mockClear();
    mockWalletConnectState.disconnect.mockClear();
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

      mockWalletSession = { topic: 'wallet-1' };
      for (const next of mockWalletListeners) {
        next({ stateName: 'connected', connected: true, sessions: 1 });
      }
      await Promise.resolve();
      await Promise.resolve();
      jest.advanceTimersByTime(500);
      await Promise.resolve();

      expect(events).toEqual([true]);
      expect(mockGetNextAddress).toHaveBeenCalledTimes(1);

      mockWalletSession = undefined;
      for (const next of mockWalletListeners) {
        next({ stateName: 'initialized', connected: false, sessions: 0 });
      }
      expect(events).toEqual([true, false]);

      mockWalletSession = { topic: 'wallet-2' };
      for (const next of mockWalletListeners) {
        next({ stateName: 'connected', connected: true, sessions: 1 });
      }
      await Promise.resolve();
      await Promise.resolve();
      jest.advanceTimersByTime(500);
      await Promise.resolve();

      expect(events).toEqual([true, false, true]);
      expect(mockGetNextAddress).toHaveBeenCalledTimes(2);
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
        throw new Error(encodedWalletConnectError({
          error: `Coin ID ${missingName} not found`,
        }));
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

  it('uses only local non-ephemeral coins as pushTransactions removal metadata', async () => {
    const parentCoinInfo = '11'.repeat(32);
    const puzzleHash = '22'.repeat(32);
    const amount = 100n;
    const rootCoinId = await coinIdFromBytes(toUint8(`${parentCoinInfo}${puzzleHash}64`));
    const peerParentCoinInfo = '44'.repeat(32);
    const peerPuzzleHash = '55'.repeat(32);
    const peerAmount = 80n;
    const blockchain = new RealBlockchainInterface();
    mockPushTransactions.mockResolvedValue({ success: true });

    await blockchain.rememberLocalRemovals({
      coin_spends: [{
        coin: {
          parent_coin_info: `0x${parentCoinInfo}`,
          puzzle_hash: `0x${puzzleHash}`,
          amount,
        },
        puzzle_reveal: '0x80',
        solution: '0x80',
      }, {
        coin: {
          parent_coin_info: `0x${rootCoinId}`,
          puzzle_hash: `0x${'33'.repeat(32)}`,
          amount: 50n,
        },
        puzzle_reveal: '0x80',
        solution: '0x80',
      }],
      aggregated_signature: '0x00',
    });

    const submittedBundle = {
      coin_spends: [{
        coin: {
          parent_coin_info: `0x${parentCoinInfo}`,
          puzzle_hash: `0x${puzzleHash}`,
          amount,
        },
        puzzle_reveal: '0x80',
        solution: '0x80',
      }, {
        coin: {
          parent_coin_info: `0x${rootCoinId}`,
          puzzle_hash: `0x${'33'.repeat(32)}`,
          amount: 50n,
        },
        puzzle_reveal: '0x80',
        solution: '0x80',
      }, {
        coin: {
          parent_coin_info: `0x${peerParentCoinInfo}`,
          puzzle_hash: `0x${peerPuzzleHash}`,
          amount: peerAmount,
        },
        puzzle_reveal: '0x80',
        solution: '0x80',
      }],
      aggregated_signature: '0x00',
    };
    await expect(
      blockchain.spend('80', submittedBundle, 'submitTransaction', 10n),
    ).resolves.toEqual({ success: true });

    expect(mockPushTransactions).toHaveBeenCalledWith(expect.objectContaining({
      fee: 10n,
      transactions: [
        expect.objectContaining({
          removals: [{
            parent_coin_info: `0x${parentCoinInfo}`,
            puzzle_hash: `0x${puzzleHash}`,
            amount,
          }],
        }),
      ],
    }));
  });
});
