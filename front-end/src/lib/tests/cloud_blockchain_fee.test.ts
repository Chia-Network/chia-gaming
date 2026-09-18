function makeStorage() {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    key(i: number) {
      return [...map.keys()][i] ?? null;
    },
    getItem(k: string) {
      return map.has(k) ? map.get(k)! : null;
    },
    setItem(k: string, v: string) {
      map.set(k, String(v));
    },
    removeItem(k: string) {
      map.delete(k);
    },
    clear() {
      map.clear();
    },
  };
}

function setTestGlobal(key: string, value: unknown) {
  Object.defineProperty(globalThis, key, {
    configurable: true,
    writable: true,
    value,
  });
}

setTestGlobal('localStorage', makeStorage());
setTestGlobal('sessionStorage', makeStorage());
setTestGlobal('window', globalThis);

// The Cloud Wallet fee comes from the global preference. Mock it so the test
// controls the fee without exercising the persistence/IndexedDB layer.
let mockFee = 0n;
jest.mock('../../hooks/save', () => ({
  getDefaultFee: () => mockFee,
  setDefaultFee: (fee: bigint) => {
    mockFee = fee;
  },
}));

import { CloudBlockchainInterface } from '../../hooks/CloudBlockchainInterface';
import { clearCloudWalletAuth, saveCloudWalletAuth } from '../../hooks/cloudWalletAuth';

/** Capture GraphQL bodies and return canned data keyed by query text. */
function mockGraphql(handler: (query: string, variables: Record<string, unknown>) => unknown) {
  const calls: Array<{ query: string; variables: Record<string, unknown> }> = [];
  const fetchMock = jest.fn(async (_url: string, init?: { body?: string }) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as {
      query?: string;
      variables?: Record<string, unknown>;
    };
    const query = body.query ?? '';
    const variables = body.variables ?? {};
    calls.push({ query, variables });
    return {
      status: 200,
      ok: true,
      text: async () => JSON.stringify({ data: handler(query, variables) }),
    };
  });
  setTestGlobal('fetch', fetchMock);
  return calls;
}

describe('CloudBlockchainInterface fee support', () => {
  beforeEach(() => {
    setTestGlobal('localStorage', makeStorage());
    setTestGlobal('sessionStorage', makeStorage());
    clearCloudWalletAuth();
    mockFee = 0n;
    saveCloudWalletAuth({
      accessToken: 'access-token',
      refreshToken: 'refresh-token',
      expiresAt: Date.now() + 10 * 60_000,
      walletId: 'Wallet_1',
    });
    // openApprovePopup runs right after the mutation; returning null makes
    // createOfferForIds reject there, after the variables we assert on are sent.
    setTestGlobal('window', globalThis);
    (globalThis as unknown as { open: () => unknown }).open = () => null;
  });

  afterEach(() => {
    setTestGlobal('fetch', undefined);
  });

  function findOfferMutation(calls: Array<{ query: string; variables: Record<string, unknown> }>) {
    const call = calls.find((c) => c.query.includes('createOffer'));
    expect(call).toBeDefined();
    return (call!.variables.input ?? {}) as Record<string, unknown>;
  }

  it('serializes each funding condition as one CLVM program', async () => {
    const calls = mockGraphql((query) => {
      if (query.includes('createOffer')) {
        return {
          createOffer: { signatureRequest: { id: 'SR_1', status: 'PENDING' } },
        };
      }
      return {};
    });
    const iface = new CloudBlockchainInterface();
    const preLauncherPuzzleHash = 'ab'.repeat(32);
    await expect(
      iface.createOfferForIds(
        'uid',
        { '1': -1000n },
        [{ opcode: 67n, args: ['10', '', preLauncherPuzzleHash] }],
        undefined,
        undefined,
        500n,
      ),
    ).rejects.toThrow(/popup/i);
    const input = findOfferMutation(calls);
    expect(input.offered).toEqual([{ amount: '1000' }]);
    expect(input.requested).toEqual([]);
    expect(input.fee).toBeUndefined();
    expect(input.extraConditions).toEqual([
      `ff43ff10ff80ffa0${preLauncherPuzzleHash}80`,
    ]);
  });

  it('adds ASSERT_BEFORE_HEIGHT_ABSOLUTE as a serialized condition', async () => {
    const calls = mockGraphql((query) => {
      if (query.includes('createOffer')) {
        return {
          createOffer: { signatureRequest: { id: 'SR_1', status: 'PENDING' } },
        };
      }
      return {};
    });
    const iface = new CloudBlockchainInterface();
    await expect(
      iface.createOfferForIds('uid', { '1': -1000n }, undefined, undefined, 500n),
    ).rejects.toThrow(/popup/i);
    expect(findOfferMutation(calls).extraConditions).toEqual(['ff57ff8201f480']);
  });

  it('createFeeSpend uses a fee-only offer bound to the protocol coin', async () => {
    const calls = mockGraphql((query) => {
      if (query.includes('createOffer')) {
        return {
          createOffer: { signatureRequest: { id: 'SR_1', status: 'PENDING' } },
        };
      }
      return {};
    });
    const iface = new CloudBlockchainInterface();
    const protocolCoinId = 'ab'.repeat(32);
    await expect(iface.createFeeSpend(500n, protocolCoinId)).resolves.toEqual({
      kind: 'failure',
      reason: expect.stringMatching(/popup/i),
    });
    const input = findOfferMutation(calls);
    expect(input.offered).toEqual([]);
    expect(input.requested).toEqual([]);
    expect(input.fee).toBe('500');
    expect(input.extraConditions).toEqual([`ff40ffa0${protocolCoinId}80`]);
  });

  it('reports fee-spend transport failure as unavailable', async () => {
    setTestGlobal('fetch', jest.fn().mockRejectedValue(new TypeError('network disconnected')));
    const iface = new CloudBlockchainInterface();

    await expect(iface.createFeeSpend(500n, 'ab'.repeat(32))).resolves.toEqual({
      kind: 'unavailable',
      reason: expect.stringMatching(/network disconnected/i),
    });
  });

  it('returns the signed persisted offer after the request is submitted', async () => {
    const offer = `offer1${'a'.repeat(80)}`;
    (globalThis as unknown as { open: () => unknown }).open = () => ({ close: jest.fn() });
    setTestGlobal('addEventListener', jest.fn());
    setTestGlobal('removeEventListener', jest.fn());
    const calls = mockGraphql((query) => {
      if (query.includes('createOffer')) {
        return { createOffer: { signatureRequest: { id: 'SR_1', status: 'PENDING' } } };
      }
      if (query.includes('signatureRequest')) {
        return {
          signatureRequest: {
            id: 'SR_1',
            status: 'SUBMITTED',
            transaction: { offer: { bech32: offer, offerId: 'Offer_1' } },
          },
        };
      }
      return {};
    });

    await expect(
      new CloudBlockchainInterface().createOfferForIds('uid', { '1': -1000n }),
    ).resolves.toEqual({ offer, tradeId: 'Offer_1' });
    const pollQuery = calls.find((call) => call.query.includes('transaction'))!.query;
    expect(pollQuery.replace(/\s+/g, ' ')).toContain(
      'transaction { offer { bech32 offerId } }',
    );
  });

  it('cancels a persisted offer off chain by offerId', async () => {
    const calls = mockGraphql(() => ({ cancelOffer: { id: 'SR_cancel' } }));
    await new CloudBlockchainInterface().cancelOffer('Offer_1');
    const input = calls[0]!.variables.input as Record<string, unknown>;
    expect(input).toEqual({
      walletId: 'Wallet_1',
      offerId: 'Offer_1',
      fee: '0',
      cancelOffChain: true,
    });
  });

  it('does not preselect or pin Cloud wallet coins', async () => {
    const calls = mockGraphql(() => ({}));
    await expect(new CloudBlockchainInterface().selectCoins('uid', 100n)).resolves.toBeNull();
    expect(calls).toEqual([]);
  });

  it('rejects coin-record batches when the Cloud query fails', async () => {
    mockGraphql((_query, variables) => {
      if ((variables.input as { endpoint?: string })?.endpoint === 'get_coin_record_by_name') {
        throw new Error('cloud unavailable');
      }
      return {};
    });
    await expect(
      new CloudBlockchainInterface().getCoinRecordsByNames(['aa'.repeat(32)]),
    ).rejects.toThrow(/coin-record batch failed/i);
  });

  it('rejects coin-record batches containing incomplete identities', async () => {
    mockGraphql((_query, variables) => {
      if ((variables.input as { endpoint?: string })?.endpoint === 'get_coin_record_by_name') {
        return {
          coinset: {
            response: {
              success: true,
              coin_record: {
                coin: {
                  amount: '1',
                  puzzle_hash: 'bb',
                  parent_coin_info: 'cc'.repeat(32),
                },
                confirmed_block_index: 1,
                spent_block_index: 0,
                spent: false,
                coinbase: false,
                timestamp: 0,
              },
            },
          },
        };
      }
      return {};
    });
    await expect(
      new CloudBlockchainInterface().getCoinRecordsByNames(['aa'.repeat(32)]),
    ).rejects.toThrow(/incomplete coin record/i);
  });

  it('reads peak height from get_blockchain_state', async () => {
    const calls = mockGraphql(() => ({
      coinset: {
        response: {
          success: true,
          blockchain_state: { peak: { height: 1234 } },
        },
      },
    }));
    await expect(new CloudBlockchainInterface().getHeightInfo()).resolves.toBe(1234n);
    expect(calls[0]!.variables.input).toEqual({
      walletId: 'Wallet_1',
      endpoint: 'get_blockchain_state',
      request: {},
    });
  });

  it('uses singular and batch Coinset coin-record requests without reshaping the request', async () => {
    const record = {
      coin: {
        parent_coin_info: '11'.repeat(32),
        puzzle_hash: '22'.repeat(32),
        amount: '50',
      },
      confirmed_block_index: 10,
      spent_block_index: 0,
      spent: false,
      coinbase: false,
      timestamp: 123,
    };
    const calls = mockGraphql((_query, variables) => {
      const endpoint = (variables.input as { endpoint: string }).endpoint;
      return {
        coinset: {
          response:
            endpoint === 'get_coin_record_by_name'
              ? { success: true, coin_record: record }
              : { success: true, coin_records: [record] },
        },
      };
    });
    const iface = new CloudBlockchainInterface();
    await expect(iface.getCoinRecordsByNames(['aa'.repeat(32)])).resolves.toHaveLength(1);
    await expect(
      iface.getCoinRecordsByNames(['aa'.repeat(32), 'bb'.repeat(32)]),
    ).resolves.toHaveLength(1);
    expect((calls[0]!.variables.input as any).request).toEqual({ name: 'aa'.repeat(32) });
    expect((calls[1]!.variables.input as any).request).toEqual({
      names: ['aa'.repeat(32), 'bb'.repeat(32)],
      include_spent_coins: true,
    });
  });

  it('resolves spent height before requesting puzzle and solution', async () => {
    const calls = mockGraphql((_query, variables) => {
      const endpoint = (variables.input as { endpoint: string }).endpoint;
      if (endpoint === 'get_coin_record_by_name') {
        return {
          coinset: {
            response: {
              success: true,
              coin_record: {
                coin: {
                  parent_coin_info: '11'.repeat(32),
                  puzzle_hash: '22'.repeat(32),
                  amount: '50',
                },
                confirmed_block_index: 10,
                spent_block_index: 25,
                spent: true,
                coinbase: false,
                timestamp: 123,
              },
            },
          },
        };
      }
      return {
        coinset: {
          response: {
            success: true,
            coin_solution: { puzzle_reveal: '0xaa', solution: '0xbb' },
          },
        },
      };
    });
    await expect(
      new CloudBlockchainInterface().getPuzzleAndSolution('00'.repeat(72)),
    ).resolves.toEqual(['aa', 'bb']);
    expect((calls[1]!.variables.input as any).endpoint).toBe('get_puzzle_and_solution');
    expect((calls[1]!.variables.input as any).request.height).toBe(25);
  });

  function sampleBundle() {
    return {
      aggregated_signature: '0x' + 'ab'.repeat(96),
      coin_spends: [
        {
          coin: {
            parent_coin_info: '0x' + '11'.repeat(32),
            puzzle_hash: '0x' + '22'.repeat(32),
            amount: 1n,
          },
          puzzle_reveal: '0x' + 'aa',
          solution: '0x' + 'bb',
        },
      ],
    };
  }

  it('classifies a non-accepted broadcast status as rejected', async () => {
    mockGraphql(() => ({
      coinset: { response: { success: false, status: 'FAILED' } },
    }));
    const iface = new CloudBlockchainInterface();
    await expect(iface.spend('', sampleBundle(), '', 'test')).resolves.toEqual({
      status: 'rejected',
      detail: expect.stringMatching(/rejected: status=FAILED/),
    });
  });

  it.each([
    [undefined, 'rejected'],
    ['MYSTERY', 'rejected'],
    ['REJECTED', 'rejected'],
  ])('classifies Cloud broadcast status %# as %s', async (status, expected) => {
    mockGraphql(() => ({
      coinset: {
        response:
          status === undefined
            ? {}
            : { success: false, status },
      },
    }));
    await expect(
      new CloudBlockchainInterface().spend('', sampleBundle(), '', 'test'),
    ).resolves.toMatchObject({ status: expected });
  });

  it.each([
    ['duplicate transaction already in mempool', 'acknowledged'],
    ['ALREADY_INCLUDING_TRANSACTION', 'acknowledged'],
    ['this transaction is already in the mempool', 'acknowledged'],
    ['transaction already included', 'acknowledged'],
    ['conflicts with an existing transaction in the mempool', 'rejected'],
    ['full node rejected spend: UNKNOWN_UNSPENT', 'rejected'],
    ['full node rejected spend: INVALID_FEE_LOW_FEE', 'rejected'],
    ['opaque Cloud Wallet failure', 'rejected'],
  ])('classifies Cloud service error "%s" as %s', async (message, expected) => {
    mockGraphql(() => ({
      coinset: { response: { success: false, error: message } },
    }));
    await expect(
      new CloudBlockchainInterface().spend('', sampleBundle(), '', 'test'),
    ).resolves.toMatchObject({ status: expected });
  });

  it('classifies a Cloud GraphQL transport failure as unavailable', async () => {
    setTestGlobal(
      'fetch',
      jest.fn(async () => Promise.reject(new Error('network down'))),
    );
    await expect(
      new CloudBlockchainInterface().spend('', sampleBundle(), '', 'test'),
    ).resolves.toMatchObject({
      status: 'unavailable',
      detail: expect.stringContaining('network down'),
    });
  });

  it('spend submits the finalized bundle through Coinset', async () => {
    mockGraphql(() => ({
      coinset: { response: { success: true, status: 'SUCCESS' } },
    }));
    const iface = new CloudBlockchainInterface();
    await expect(iface.spend('', sampleBundle(), '', 'test', 500n)).resolves.toEqual({
      status: 'acknowledged',
      detail: 'SUCCESS',
    });
  });
});
