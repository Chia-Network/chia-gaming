import type { WalletOfferRequest } from '../../types/ChiaGaming';

jest.mock('../../services/log', () => ({ log: jest.fn() }));

jest.mock('../../constants/currency', () => ({ isTestnet: () => false }));

jest.mock('../../hooks/WalletConnectRpc', () => ({
  WalletConnectTransportError: class WalletConnectTransportError extends Error {},
  sageRpc: {
    getAddress: jest.fn(),
    getAssetBalance: jest.fn(),
    getAssetCoins: jest.fn(),
    signCoinSpends: jest.fn(),
    sendTransaction: jest.fn(),
  },
}));

const mockWalletConnectState = {
  getObservable: () => ({ subscribe: () => ({ unsubscribe: () => {} }) }),
  getAddress: jest.fn(() => '424242'),
  getChainId: jest.fn(() => 'chia:mainnet'),
  getSession: jest.fn(() => ({ topic: 'sage-topic' })),
  getProfile: jest.fn(() => 'sage'),
};

jest.mock('../../hooks/useWalletConnect', () => ({
  walletConnectState: mockWalletConnectState,
}));

const mockBuildWalletSpend = jest.fn();
jest.mock('../../hooks/WasmStateInit', () => ({
  ensureWasmLoaded: async () => ({ build_wallet_spend: mockBuildWalletSpend }),
}));

import { sageRpc, WalletConnectTransportError } from '../../hooks/WalletConnectRpc';
import { SageBlockchainInterface } from '../../hooks/SageBlockchainInterface';
import { encodePuzzleHashToBech32m } from '../../util/bech32m';
import { jsonStringify } from '../../util/jsonSafe';

const CHANGE_PH = '11'.repeat(32);
const WALLET_PH = '22'.repeat(32);
const SIGNATURE = 'ab'.repeat(96);

function walletCoin(parentByte: string, amount: bigint, locked = false) {
  return {
    coin: { parent_coin_info: parentByte.repeat(32), puzzle_hash: WALLET_PH, amount },
    coinName: `${parentByte}`.repeat(32),
    puzzle: 'ff02ffff01',
    confirmedBlockIndex: 10n,
    locked,
  };
}

/** Stand-in for Rust: spend the first offered coin. */
function spendFirstOfferedCoin(requestJson: string): string {
  const request = JSON.parse(requestJson);
  const coin = request.coins[0].coin;
  return jsonStringify({
    aggregated_signature: `0xc0${'00'.repeat(95)}`,
    coin_spends: [
      {
        coin: {
          parent_coin_info: `0x${coin.parent_coin_info}`,
          puzzle_hash: `0x${coin.puzzle_hash}`,
          amount: BigInt(coin.amount),
        },
        puzzle_reveal: '0xff02ffff01',
        solution: '0xff80ff8080',
      },
    ],
  });
}

const fundingRequest: WalletOfferRequest = {
  kind: 'funding',
  uniqueId: 'player',
  offer: { '1': -600n },
  extraConditions: [{ opcode: 67n, args: ['10', 'abcd', '33'.repeat(32)] }],
  maxHeight: 1234n,
  openingFee: 5n,
};

const feeRequest: WalletOfferRequest = {
  kind: 'fee',
  uniqueId: 'player',
  fee: 100n,
  concurrentSpendCoinId: '44'.repeat(32),
};

async function connectedSage(): Promise<SageBlockchainInterface> {
  jest.mocked(sageRpc.getAddress).mockResolvedValue({
    address: encodePuzzleHashToBech32m(CHANGE_PH),
  });
  const sage = new SageBlockchainInterface();
  await sage.startMonitoring();
  return sage;
}

function mockFetchJson(body: unknown) {
  const fetchMock = jest.fn(async () => ({ status: 200, json: async () => body }));
  global.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

describe('SageBlockchainInterface', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockBuildWalletSpend.mockImplementation(spendFirstOfferedCoin);
    jest.mocked(sageRpc.signCoinSpends).mockResolvedValue(SIGNATURE);
  });

  it('exposes a terminal provider scoped to the Sage fingerprint and chain', async () => {
    const sage = await connectedSage();
    const provider = sage.getWalletOfferProvider();
    expect(provider?.capability).toBe('terminal');
    expect(provider?.scope).toEqual({
      provider: 'sage',
      fingerprint: '424242',
      chainId: 'chia:mainnet',
    });
    expect(sage.isReadyForPlay()).toBe(true);
  });

  it('builds funding spends in Rust from unlocked coins and has Sage sign them', async () => {
    jest
      .mocked(sageRpc.getAssetCoins)
      .mockResolvedValue([walletCoin('aa', 1000n, true), walletCoin('bb', 900n)] as never);
    const sage = await connectedSage();
    const provider = sage.getWalletOfferProvider()!;
    const owner = { installationPlayerId: 'p', peerSessionId: 's', providerScope: provider.scope };

    const outcome = await provider.beginCreation(
      { owner, purpose: { kind: 'funding', operationId: 'op' } },
      fundingRequest,
    );

    const request = JSON.parse(mockBuildWalletSpend.mock.calls[0][0]);
    expect(request.change_puzzle_hash).toBe(CHANGE_PH);
    expect(request.coins).toEqual([
      {
        coin: { parent_coin_info: 'bb'.repeat(32), puzzle_hash: WALLET_PH, amount: '900' },
        puzzle_reveal: 'ff02ffff01',
      },
    ]);
    expect(request.purpose).toEqual({
      kind: 'funding',
      amount: '600',
      conditions: [{ opcode: 67, args: ['10', 'abcd', '33'.repeat(32)] }],
      max_height: '1234',
    });
    expect(sageRpc.signCoinSpends).toHaveBeenCalledWith([
      {
        coin: {
          parent_coin_info: `0x${'bb'.repeat(32)}`,
          puzzle_hash: `0x${WALLET_PH}`,
          amount: '900',
        },
        puzzle_reveal: '0xff02ffff01',
        solution: '0xff80ff8080',
      },
    ]);
    expect(outcome).toMatchObject({
      kind: 'created-reserved',
      material: {
        kind: 'bundle',
        bundle: { aggregated_signature: `0x${SIGNATURE}` },
      },
    });
  });

  it('keeps reserved coins out of later spends until the reservation is cancelled', async () => {
    jest.mocked(sageRpc.getAssetCoins).mockResolvedValue([walletCoin('bb', 900n)] as never);
    const sage = await connectedSage();
    const provider = sage.getWalletOfferProvider()!;
    if (provider.capability !== 'terminal') throw new Error('expected terminal provider');
    const owner = { installationPlayerId: 'p', peerSessionId: 's', providerScope: provider.scope };
    const operation = { owner, purpose: { kind: 'fee' as const, operationId: 'fee' } };

    const first = await provider.beginCreation(operation, feeRequest);
    if (first.kind !== 'created-reserved') throw new Error(`unexpected ${first.kind}`);

    mockBuildWalletSpend.mockImplementation(() => {
      throw new Error('wallet has 0 spendable mojos in standard coins, needs 100');
    });
    await expect(provider.beginCreation(operation, feeRequest)).resolves.toEqual({
      kind: 'failure',
      reason: 'wallet has 0 spendable mojos in standard coins, needs 100',
    });
    expect(JSON.parse(mockBuildWalletSpend.mock.calls[1][0]).coins).toEqual([]);

    await expect(provider.cancel(first.tradeId)).resolves.toEqual({ status: 'cancelled' });
    await expect(provider.cancel(first.tradeId)).resolves.toMatchObject({
      status: 'already-terminal',
    });
    mockBuildWalletSpend.mockImplementation(spendFirstOfferedCoin);
    await expect(provider.beginCreation(operation, feeRequest)).resolves.toMatchObject({
      kind: 'created-reserved',
    });
  });

  it('never reselects a coin it broadcast, even after its reservation is released', async () => {
    jest.mocked(sageRpc.getAssetCoins).mockResolvedValue([walletCoin('bb', 900n)] as never);
    const sage = await connectedSage();
    const provider = sage.getWalletOfferProvider()!;
    if (provider.capability !== 'terminal') throw new Error('expected terminal provider');
    const owner = { installationPlayerId: 'p', peerSessionId: 's', providerScope: provider.scope };
    const operation = { owner, purpose: { kind: 'fee' as const, operationId: 'fee' } };
    const created = await provider.beginCreation(operation, feeRequest);
    if (created.kind !== 'created-reserved') throw new Error(`unexpected ${created.kind}`);

    jest.mocked(sageRpc.sendTransaction).mockResolvedValue({ status: 1n, error: null });
    const fetchMock = mockFetchJson({});
    await expect(
      sage.spend(
        '',
        created.material.kind === 'bundle' ? created.material.bundle : null,
        '',
        'test',
      ),
    ).resolves.toEqual({ status: 'acknowledged', detail: 'SUCCESS' });
    expect(sageRpc.sendTransaction).toHaveBeenCalledWith({
      coin_spends: [
        {
          coin: {
            parent_coin_info: `0x${'bb'.repeat(32)}`,
            puzzle_hash: `0x${WALLET_PH}`,
            amount: '900',
          },
          puzzle_reveal: '0xff02ffff01',
          solution: '0xff80ff8080',
        },
      ],
      aggregated_signature: `0x${SIGNATURE}`,
    });
    expect(fetchMock).not.toHaveBeenCalled();

    await provider.cancel(created.tradeId);
    mockBuildWalletSpend.mockImplementation(() => {
      throw new Error('no coins');
    });
    await provider.beginCreation(operation, feeRequest);
    expect(JSON.parse(mockBuildWalletSpend.mock.calls.at(-1)![0]).coins).toEqual([]);
  });

  it('reports a lost WalletConnect signing call as unavailable', async () => {
    jest.mocked(sageRpc.getAssetCoins).mockResolvedValue([walletCoin('bb', 900n)] as never);
    jest
      .mocked(sageRpc.signCoinSpends)
      .mockRejectedValue(new WalletConnectTransportError('relayer closed'));
    const sage = await connectedSage();
    const provider = sage.getWalletOfferProvider()!;
    const owner = { installationPlayerId: 'p', peerSessionId: 's', providerScope: provider.scope };
    await expect(
      provider.beginCreation({ owner, purpose: { kind: 'fee', operationId: 'fee' } }, feeRequest),
    ).resolves.toEqual({
      kind: 'unavailable',
      reason: 'Sage could not sign spend: relayer closed',
    });
  });

  describe('broadcast', () => {
    const bundle = {
      aggregated_signature: '0xc0',
      coin_spends: [
        {
          coin: { parent_coin_info: 'bb'.repeat(32), puzzle_hash: WALLET_PH, amount: 1n },
          puzzle_reveal: '01',
          solution: '80',
        },
      ],
    };

    it('treats a peer mempool failure reported by Sage as final', async () => {
      jest
        .mocked(sageRpc.sendTransaction)
        .mockResolvedValue({ status: 3n, error: 'Err.DOUBLE_SPEND' });
      const fetchMock = mockFetchJson({});
      const sage = await connectedSage();
      await expect(sage.spend('', bundle, '', 'test')).resolves.toEqual({
        status: 'rejected',
        detail: 'Sage sendTransaction rejected: Err.DOUBLE_SPEND',
      });
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('acknowledges a bundle the mempool already includes', async () => {
      jest
        .mocked(sageRpc.sendTransaction)
        .mockResolvedValue({ status: 3n, error: 'Err.ALREADY_INCLUDING_TRANSACTION' });
      const sage = await connectedSage();
      await expect(sage.spend('', bundle, '', 'test')).resolves.toMatchObject({
        status: 'acknowledged',
      });
    });

    it('falls back to Coinset when no Sage peer answered', async () => {
      jest.mocked(sageRpc.sendTransaction).mockResolvedValue({ status: 3n, error: null });
      const fetchMock = mockFetchJson({ success: true, status: 'SUCCESS' });
      const sage = await connectedSage();
      await expect(sage.spend('', bundle, '', 'test')).resolves.toEqual({
        status: 'acknowledged',
        detail: 'SUCCESS',
      });
      expect(fetchMock).toHaveBeenCalledWith(
        'https://api.coinset.org/push_tx',
        expect.objectContaining({ method: 'POST' }),
      );
    });

    it('falls back to Coinset when Sage errors, which can follow a successful broadcast', async () => {
      jest
        .mocked(sageRpc.sendTransaction)
        .mockRejectedValue(new Error('failed to record transaction'));
      mockFetchJson({ success: false, error: 'Err.ALREADY_INCLUDING_TRANSACTION' });
      const sage = await connectedSage();
      await expect(sage.spend('', bundle, '', 'test')).resolves.toMatchObject({
        status: 'acknowledged',
      });
    });

    it('is unavailable when neither Sage nor Coinset can be reached', async () => {
      jest
        .mocked(sageRpc.sendTransaction)
        .mockRejectedValue(new WalletConnectTransportError('relayer closed'));
      global.fetch = jest.fn(async () => {
        throw new TypeError('Failed to fetch');
      }) as unknown as typeof fetch;
      const sage = await connectedSage();
      await expect(sage.spend('', bundle, '', 'test')).resolves.toMatchObject({
        status: 'unavailable',
      });
    });
  });

  it('reads chain state from coinset.org and treats unknown coins as absent', async () => {
    const sage = await connectedSage();
    mockFetchJson({ success: true, blockchain_state: { peak: { height: 777 } } });
    await expect(sage.getHeightInfo()).resolves.toBe(777n);

    const notFound = {
      success: false,
      error: 'Coin record not found',
      structuredError: { code: 'COIN_RECORD_NOT_FOUND' },
    };
    const fetchMock = mockFetchJson(notFound);
    await expect(sage.getCoinRecordsByNames(['55'.repeat(32)])).resolves.toEqual([]);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.coinset.org/get_coin_record_by_name',
      expect.anything(),
    );
    await expect(sage.getPuzzleAndSolution('66'.repeat(72))).resolves.toBeNull();
  });
});
