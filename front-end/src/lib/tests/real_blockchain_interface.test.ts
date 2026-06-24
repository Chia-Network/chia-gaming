jest.mock('../../hooks/JsonRpcContext', () => ({
  rpc: {
    getCoinRecordsByNames: jest.fn(),
  },
}));

import { rpc } from '../../hooks/JsonRpcContext';
import { RealBlockchainInterface } from '../../hooks/RealBlockchainInterface';
import { CoinRecord } from '../../types/rpc/CoinRecord';

const mockGetCoinRecordsByNames = rpc.getCoinRecordsByNames as jest.Mock;

function encodedWalletConnectError(payload: unknown): string {
  const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64');
  return `[wc:-32603|${encoded}]`;
}

describe('RealBlockchainInterface', () => {
  beforeEach(() => {
    mockGetCoinRecordsByNames.mockReset();
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
});
